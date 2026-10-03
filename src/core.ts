import type { Client } from "./opencode";
import { EventBus, type OcEvent } from "./events";
import type { components } from "./api";
import type { ChatState } from "./state";

type AgentInfo = components["schemas"]["Agent.Info"];
type ModelInfo = components["schemas"]["Model.Info"];
type ModelRef = components["schemas"]["Model.Ref"];
type CommandInfo = components["schemas"]["Command.Info"];

export interface PermissionReq {
  id: string;
  sessionID: string;
  action: string;
  resources: string[];
  message?: string;
  chatId?: number;
}

export interface CoreHandlers {
  onPermission: (chatId: number, req: PermissionReq) => void;
  onProgress: (chatId: number, text: string) => void;
  onDone: (chatId: number, text: string) => void;
  onError: (chatId: number, text: string) => void;
}

export class Core {
  sessionChat = new Map<string, number>();
  private busySessions = new Set<string>();
  private queues = new Map<string, string[]>(); // sessionID -> queued prompts
  private pendingExecution = new Map<string, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();

  constructor(
    private client: Client,
    private events: EventBus,
    public getState: (chatId: number) => ChatState,
    public setState: (chatId: number, s: ChatState) => void,
    private handlersInit: CoreHandlers,
  ) {
    this.handlers = handlersInit;
  }

  private handlers: CoreHandlers;

  setHandlers(h: CoreHandlers) {
    this.handlers = h;
  }

  restoreSessions(chatIds: Iterable<number>): void {
    for (const chatId of chatIds) {
      const sessionID = this.getState(chatId).sessionID;
      if (sessionID) this.sessionChat.set(sessionID, chatId);
    }
  }

  attach() {
    this.events.on((e) => this.route(e));
  }

  private route(e: OcEvent) {
    const sid: string | undefined = e.data?.sessionID;
    switch (e.type) {
      case "session.execution.succeeded":
        this.finishExecution(sid, true);
        break;
      case "session.execution.failed":
        this.finishExecution(sid, false);
        break;
      case "session.text.ended":
        if (sid && e.data?.text) this.lastText.set(sid, e.data.text);
        break;
      case "session.step.started":
      case "session.tool.called":
        if (sid) {
          const chatId = this.sessionChat.get(sid);
          if (chatId != null) {
            const label =
              e.type === "session.tool.called" && e.data?.tool ? `tool: ${e.data.tool}` : "working…";
            this.handlers.onProgress(chatId, label);
          }
        }
        break;
      case "permission.asked":
        this.handlePermission(e.data);
        break;
      case "session.created":
        if (e.data?.id && e.data?.sessionID) {
          // no-op, sessions tracked via state
        }
        break;
      case "server.connected":
        // (re)surface anything pending while we were down
        void this.reconcilePermissions();
        break;
      default:
        if (e.type.startsWith("permission.") && e.type !== "permission.asked") {
          console.log(`[ignored permission event family] ${e.type}`);
        }
    }
  }

  private async reconcilePermissions() {
    try {
      const pending = await this.getPendingPermissions();
      for (const req of pending) {
        const chatId = this.sessionChat.get(req.sessionID);
        if (chatId != null) {
          req.chatId = chatId;
          this.handlers.onPermission(chatId, req);
        }
      }
    } catch (err) {
      console.error("reconcile permissions failed", err);
    }
  }

  private lastText = new Map<string, string>();

  private async handlePermission(data: any) {
    // Payload shapes vary; accept anything with an id + sessionID.
    const req: PermissionReq | null = (() => {
      if (!data) return null;
      const id = data.id ?? data.requestID ?? data.permissionID;
      const sessionID = data.sessionID;
      if (typeof id !== "string" || typeof sessionID !== "string") return null;
      return {
        id,
        sessionID,
        action: data.action ?? "unknown",
        resources: Array.isArray(data.resources) ? data.resources : [],
        message: data.message,
      } as PermissionReq;
    })();
    if (!req) {
      console.log("[permission.asked] unparsable payload:", JSON.stringify(data).slice(0, 300));
      return;
    }
    const chatId = this.sessionChat.get(req.sessionID);
    if (chatId == null) {
      console.log(`[permission.asked] no chat for session ${req.sessionID}, leaving pending in web UI`);
      return;
    }
    req.chatId = chatId;
    this.handlers.onPermission(chatId, req);
  }

  private finishExecution(sid: string | undefined, ok: boolean) {
    if (!sid) return;
    const p = this.pendingExecution.get(sid);
    if (p) {
      clearTimeout(p.timer);
      this.pendingExecution.delete(sid);
      p.resolve(ok);
    }
  }

  async ensureSession(chatId: number): Promise<string> {
    const st = this.getState(chatId);
    if (st.sessionID) {
      this.sessionChat.set(st.sessionID, chatId);
      return st.sessionID;
    }
    return this.createSession(chatId, st);
  }

  async newSession(chatId: number): Promise<string> {
    const st = this.getState(chatId);
    return this.createSession(chatId, st);
  }

  private async createSession(chatId: number, state: ChatState): Promise<string> {
    const created = await this.client.POST("/api/session", {
      body: {
        title: `tg-${chatId}`,
        location: { directory: state.projectDir },
        ...(state.agent ? { agent: state.agent } : {}),
        ...(state.model ? { model: state.model } : {}),
      },
    });
    if (created.error || !created.data?.data) {
      throw new Error(`session create failed: ${JSON.stringify(created.error)}`);
    }
    const sessionID = created.data.data.id;
    this.setState(chatId, { ...state, sessionID });
    this.sessionChat.set(sessionID, chatId);
    return sessionID;
  }

  async listAgents(chatId: number): Promise<AgentInfo[]> {
    const state = this.getState(chatId);
    const response = await this.client.GET("/api/agent", {
      params: { query: { location: { directory: state.projectDir } } },
    });
    return response.data?.data ?? [];
  }

  async listModels(chatId: number): Promise<ModelInfo[]> {
    const state = this.getState(chatId);
    const response = await this.client.GET("/api/model", {
      params: { query: { location: { directory: state.projectDir } } },
    });
    return response.data?.data ?? [];
  }

  async listCommands(chatId: number): Promise<CommandInfo[]> {
    const state = this.getState(chatId);
    const response = await this.client.GET("/api/command", {
      params: { query: { location: { directory: state.projectDir } } },
    });
    return response.data?.data ?? [];
  }

  async setAgent(chatId: number, agent: string): Promise<boolean> {
    const sessionID = await this.ensureSession(chatId);
    const response = await this.client.POST("/api/session/{sessionID}/agent", {
      params: { path: { sessionID } },
      body: { agent },
    });
    if (response.error) return false;
    this.setState(chatId, { ...this.getState(chatId), agent });
    return true;
  }

  async setModel(chatId: number, model: ModelRef): Promise<boolean> {
    const sessionID = await this.ensureSession(chatId);
    const response = await this.client.POST("/api/session/{sessionID}/model", {
      params: { path: { sessionID } },
      body: { model },
    });
    if (response.error) return false;
    this.setState(chatId, { ...this.getState(chatId), model });
    return true;
  }

  async openSession(chatId: number, sessionID: string): Promise<boolean> {
    const response = await this.client.GET("/api/session/{sessionID}", {
      params: { path: { sessionID } },
    });
    const session = response.data?.data;
    if (response.error || !session) return false;
    this.setState(chatId, {
      ...this.getState(chatId),
      sessionID,
      projectDir: session.location.directory,
      agent: session.agent,
      model: session.model,
    });
    this.sessionChat.set(sessionID, chatId);
    return true;
  }

  async compact(chatId: number): Promise<boolean> {
    const sessionID = this.getState(chatId).sessionID;
    if (!sessionID) return false;
    const response = await this.client.POST("/api/session/{sessionID}/compact", {
      params: { path: { sessionID } },
      body: {},
    });
    return !response.error;
  }

  async runCommand(chatId: number, name: string, text: string): Promise<"completed" | "busy" | "failed"> {
    const sessionID = await this.ensureSession(chatId);
    if (this.busySessions.has(sessionID)) return "busy";
    this.busySessions.add(sessionID);
    try {
      const done = this.waitForExecution(sessionID);
      this.lastText.delete(sessionID);
      try {
        const response = await this.client.POST("/api/session/{sessionID}/command", {
          params: { path: { sessionID } },
          body: { name, text },
        });
        if (response.error) {
          this.cancelExecution(sessionID);
          this.handlers.onError(chatId, `command failed: ${JSON.stringify(response.error).slice(0, 300)}`);
          return "failed";
        }
        const succeeded = await done;
        if (!succeeded) {
          this.handlers.onError(chatId, "command execution timed out or failed");
          return "failed";
        }
        this.handlers.onDone(chatId, this.lastText.get(sessionID) ?? `/${name} completed.`);
        return "completed";
      } catch (error) {
        this.cancelExecution(sessionID);
        if (!(error instanceof Error)) throw error;
        this.handlers.onError(chatId, `command failed: ${error.message}`);
        return "failed";
      }
    } finally {
      this.busySessions.delete(sessionID);
      this.drainPromptQueue(chatId, sessionID);
    }
  }

  private waitForExecution(sessionID: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingExecution.delete(sessionID);
        resolve(false);
      }, 10 * 60 * 1000);
      this.pendingExecution.set(sessionID, { resolve, timer });
    });
  }

  private cancelExecution(sessionID: string): void {
    const pending = this.pendingExecution.get(sessionID);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingExecution.delete(sessionID);
    pending.resolve(false);
  }

  private drainPromptQueue(chatId: number, sessionID: string): void {
    const next = (this.queues.get(sessionID) ?? []).shift();
    if (!next) return;
    this.queues.set(sessionID, this.queues.get(sessionID) ?? []);
    void this.sendPrompt(chatId, next);
  }

  async sendPrompt(chatId: number, text: string): Promise<string | null> {
    const sessionID = await this.ensureSession(chatId);
    this.sessionChat.set(sessionID, chatId);

    if (this.busySessions.has(sessionID)) {
      const q = this.queues.get(sessionID) ?? [];
      q.push(text);
      this.queues.set(sessionID, q);
      return "queued";
    }
    this.busySessions.add(sessionID);
    try {
      await this.runPrompt(sessionID, chatId, text);
    } finally {
      this.busySessions.delete(sessionID);
      this.drainPromptQueue(chatId, sessionID);
    }
    return null;
  }

  private async runPrompt(sessionID: string, chatId: number, text: string) {
    const done = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingExecution.delete(sessionID);
        resolve(false);
      }, 10 * 60 * 1000);
      this.pendingExecution.set(sessionID, { resolve, timer });
    });

    const sent = await this.client.POST("/api/session/{sessionID}/prompt", {
      params: { path: { sessionID } },
      body: { text } as any,
    });
    if (sent.error) {
      this.pendingExecution.delete(sessionID);
      this.handlers.onError(chatId, `prompt failed: ${JSON.stringify(sent.error).slice(0, 300)}`);
      return;
    }

    const ok = await done;
    if (!ok) {
      this.handlers.onError(chatId, "execution timed out or failed");
      return;
    }

    // fetch final assistant text
    try {
      const msgs = await this.client.GET("/api/session/{sessionID}/message", {
        params: { path: { sessionID } },
      });
      const list = (msgs.data as any)?.data ?? msgs.data ?? [];
      const assistant = list.find((m: any) => m.type === "assistant");
      const textOut = extractText(assistant) ?? this.lastText.get(sessionID) ?? "(no text)";
      this.handlers.onDone(chatId, textOut);
    } catch (err: any) {
      this.handlers.onError(chatId, `fetch messages failed: ${err?.message ?? err}`);
    }
  }

  async permissionReply(sessionID: string, requestID: string, decision: "once" | "always" | "reject") {
    const res = await this.client.POST("/api/session/{sessionID}/permission/{requestID}/reply", {
      params: { path: { sessionID, requestID } },
      body: { decision } as any,
    });
    return !res.error;
  }

  async interrupt(chatId: number) {
    const st = this.getState(chatId);
    if (!st.sessionID) return false;
    const res = await this.client.POST("/api/session/{sessionID}/interrupt", {
      params: { path: { sessionID: st.sessionID } },
    } as any);
    return !res.error;
  }

  setProject(chatId: number, projectDir: string) {
    const st = this.getState(chatId);
    this.setState(chatId, { projectDir });
  }

  listProjects(allowlist: string[]) {
    return allowlist;
  }

  async listSessions(_chatId: number) {
    const state = this.getState(_chatId);
    const res = await this.client.GET("/api/session", {
      params: { query: { directory: state.projectDir, limit: "50", order: "desc" } },
    });
    return res.data?.data ?? [];
  }

  async getPendingPermissions(chatId?: number): Promise<PermissionReq[]> {
    const res = await this.client.GET("/api/permission/request");
    const list = (res.data as any)?.data ?? res.data ?? [];
    const requests: PermissionReq[] = (Array.isArray(list) ? list : []).map((d: any) => ({
      id: d.id,
      sessionID: d.sessionID,
      action: d.action,
      resources: d.resources ?? [],
      message: d.message,
    }));
    return chatId === undefined ? requests : requests.filter((request) => this.sessionChat.get(request.sessionID) === chatId);
  }
}

function extractText(msg: any): string | undefined {
  if (!msg) return undefined;
  if (typeof msg.text === "string") return msg.text;
  const content = msg.content ?? msg.payload?.content;
  if (Array.isArray(content)) {
    const t = content.find((c: any) => c.type === "text");
    if (t) return t.text;
  }
  return undefined;
}
