import { Client } from "./opencode";
import { EventBus, OcEvent } from "./events";

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

interface ChatStateLite {
  sessionID?: string;
  projectDir: string;
}

export class Core {
  sessionChat = new Map<string, number>();
  private busySessions = new Set<string>();
  private queues = new Map<string, string[]>(); // sessionID -> queued prompts
  private pendingExecution = new Map<string, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();

  constructor(
    private client: Client,
    private events: EventBus,
    public getState: (chatId: number) => ChatStateLite,
    public setState: (chatId: number, s: ChatStateLite) => void,
    private handlersInit: CoreHandlers,
  ) {
    this.handlers = handlersInit;
  }

  private handlers: CoreHandlers;

  setHandlers(h: CoreHandlers) {
    this.handlers = h;
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
    const created = await this.client.POST("/api/session", {
      body: { title: `tg-${chatId}`, location: { directory: st.projectDir } } as any,
    });
    const data = (created.data as any)?.data ?? created.data;
    if (!data?.id) throw new Error(`session create failed: ${JSON.stringify(created.error)}`);
    this.setState(chatId, { ...st, sessionID: data.id });
    this.sessionChat.set(data.id, chatId);
    return data.id;
  }

  async newSession(chatId: number): Promise<string> {
    const st = this.getState(chatId);
    const created = await this.client.POST("/api/session", {
      body: { title: `tg-${chatId}`, location: { directory: st.projectDir } } as any,
    });
    const data = (created.data as any)?.data ?? created.data;
    if (!data?.id) throw new Error(`session create failed: ${JSON.stringify(created.error)}`);
    this.setState(chatId, { ...st, sessionID: data.id });
    this.sessionChat.set(data.id, chatId);
    return data.id;
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
      const next = (this.queues.get(sessionID) ?? []).shift();
      if (next) {
        const rest = this.queues.get(sessionID) ?? [];
        this.queues.set(sessionID, rest);
        // run next without blocking caller
        void this.sendPrompt(chatId, next);
      }
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
    this.setState(chatId, { ...st, projectDir, sessionID: undefined });
  }

  listProjects(allowlist: string[]) {
    return allowlist;
  }

  async listSessions(_chatId: number) {
    const res = await this.client.GET("/api/session");
    return (res.data as any)?.data ?? res.data ?? [];
  }

  async listModels() {
    const res = await this.client.GET("/api/model");
    return (res.data as any)?.data ?? res.data ?? [];
  }

  async getPendingPermissions(): Promise<PermissionReq[]> {
    const res = await this.client.GET("/api/permission/request");
    const list = (res.data as any)?.data ?? res.data ?? [];
    return (Array.isArray(list) ? list : []).map((d: any) => ({
      id: d.id,
      sessionID: d.sessionID,
      action: d.action,
      resources: d.resources ?? [],
      message: d.message,
    }));
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
