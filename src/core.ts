import type { Client } from "./opencode";
import { EventBus, type OcEvent } from "./events";
import { FreeModelSelector } from "./models";
import type { components } from "./api";
import type { ChatState } from "./state";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

function resolvePath(value: string): string {
  return resolve(value);
}

export type QueueEntry =
  | { kind: "text"; text: string }
  | { kind: "attachment"; name: string; mime?: string; caption?: string; bytes: Uint8Array };

export interface AttachmentInput {
  name: string;
  mime?: string;
  caption?: string;
  bytes: Uint8Array;
}

export type AttachWrite = (directory: string, name: string, bytes: Uint8Array) => Promise<void>;

/**
 * "auto-free"  - chats without an explicit model pick the newest free model that reads
 *                text and images; a pinned model that vanished upstream is dropped and
 *                re-selected. This keeps the bridge off metered models (a paid default can
 *                fail with "Insufficient account funds" when the Zen account has no credit).
 * "server"     - never set a model; let OpenCode use its own configured default.
 */
export type ModelPolicy = "auto-free" | "server";

const EXECUTION_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_QUEUED_ENTRIES = 5;

async function defaultAttachWrite(directory: string, name: string, bytes: Uint8Array): Promise<void> {
  // Fallback: the bridge runs on the same host as the OpenCode server, so the
  // project directory is the same filesystem. Production wiring prefers the
  // server-side write endpoint (see opencode.ts / index.ts).
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), bytes);
}

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
}

export interface CoreHandlers {
  onPermission: (chatId: number, req: PermissionReq) => void;
  onProgress: (chatId: number, text: string) => void;
  onDone: (chatId: number, text: string) => void;
  onError: (chatId: number, text: string) => void;
}

export class Core {
  sessionChat = new Map<string, number>();
  private busyChats = new Set<number>();
  private queues = new Map<number, QueueEntry[]>(); // chatId -> queued prompts/attachments
  private pendingExecution = new Map<string, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();
  private validatedSessions = new Set<string>();
  private sessionInitializations = new Map<number, Map<string, Promise<string>>>();

  constructor(
    private client: Client,
    private events: EventBus,
    public getState: (chatId: number) => ChatState,
    public setState: (chatId: number, s: ChatState) => void,
    private handlersInit: CoreHandlers,
    private attachWrite?: AttachWrite,
    private modelSelector?: FreeModelSelector,
    private modelPolicy: ModelPolicy = "auto-free",
  ) {
    this.handlers = handlersInit;
    this.attachWriteFn = attachWrite ?? defaultAttachWrite;
  }

  private attachWriteFn: AttachWrite;

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
    const projectDir = this.getState(chatId).projectDir;
    let initializations = this.sessionInitializations.get(chatId);
    const pending = initializations?.get(projectDir);
    if (pending) return pending;
    const initialization = this.ensureSessionReady(chatId);
    if (!initializations) {
      initializations = new Map<string, Promise<string>>();
      this.sessionInitializations.set(chatId, initializations);
    }
    initializations.set(projectDir, initialization);
    try {
      return await initialization;
    } finally {
      if (initializations.get(projectDir) === initialization) initializations.delete(projectDir);
      if (initializations.size === 0) this.sessionInitializations.delete(chatId);
    }
  }

  private async ensureSessionReady(chatId: number): Promise<string> {
    const st = this.getState(chatId);
    if (st.sessionID) {
      if (this.validatedSessions.has(st.sessionID)) {
        this.sessionChat.set(st.sessionID, chatId);
        return st.sessionID;
      }
      const existing = await this.client.GET("/api/session/{sessionID}", {
        params: { path: { sessionID: st.sessionID } },
      });
      if (!existing.error && existing.data?.data) {
        this.validatedSessions.add(st.sessionID);
        this.sessionChat.set(st.sessionID, chatId);
        return st.sessionID;
      }
      if (existing.response.status !== 404) {
        throw new Error(`session lookup failed: ${JSON.stringify(existing.error)}`);
      }
      this.sessionChat.delete(st.sessionID);
      const recovered = { ...st, sessionID: undefined };
      const current = this.getState(chatId);
      if (current.projectDir === st.projectDir && current.sessionID === st.sessionID) {
        this.setState(chatId, recovered);
      }
      return this.createSession(chatId, recovered);
    }
    return this.createSession(chatId, st);
  }

  async newSession(chatId: number): Promise<string> {
    const st = this.getState(chatId);
    return this.createSession(chatId, st);
  }

  private async createSession(chatId: number, state: ChatState): Promise<string> {
    const model = await this.resolveModel(chatId, state);
    const created = await this.client.POST("/api/session", {
      body: {
        title: `tg-${chatId}`,
        location: { directory: state.projectDir },
        ...(state.agent ? { agent: state.agent } : {}),
        ...(model ? { model } : {}),
      },
    });
    if (created.error || !created.data?.data) {
      throw new Error(`session create failed: ${JSON.stringify(created.error)}`);
    }
    const sessionID = created.data.data.id;
    const current = this.getState(chatId);
    if (current.projectDir === state.projectDir && current.sessionID === state.sessionID) {
      // record the model actually used so /status and the menu can show it; `modelAuto` keeps
      // telling an automatic pick apart from a user choice (see ChatState)
      this.setState(chatId, {
        ...current,
        sessionID,
        model: current.model ?? model,
        modelAuto: current.model ? current.modelAuto : true,
      });
    }
    this.sessionChat.set(sessionID, chatId);
    this.validatedSessions.add(sessionID);
    return sessionID;
  }

  /**
   * Decide which model a new session should run on. An explicit choice from the menu wins, but
   * if it has disappeared upstream it is dropped (and reported) so the chat falls back to the
   * current free pick rather than failing every prompt. Falls back to the server default when
   * the model catalogue cannot be read.
   */
  private async resolveModel(chatId: number, state: ChatState): Promise<ModelRef | undefined> {
    if (this.modelPolicy === "server" || !this.modelSelector) return state.model;

    // An explicit user pick is sticky: only re-check that it still exists upstream.
    if (state.model && state.modelAuto !== true) {
      try {
        if (await this.modelSelector.stillAvailable(state.projectDir, state.model)) return state.model;
      } catch (error) {
        console.error("model availability check failed; leaving the session on the server default", error);
        return undefined;
      }
      const current = this.getState(chatId);
      if (current.model === state.model && current.projectDir === state.projectDir) {
        this.setState(chatId, { ...current, model: undefined, modelAuto: undefined });
      }
      this.handlers.onError(chatId, `Model ${state.model.providerID}/${state.model.id} is no longer available; switching to an automatic free model.`);
      return this.autoModel(chatId, state);
    }

    // Automatic pick (or none): re-evaluate so a newer free release takes over.
    return this.autoModel(chatId, state);
  }

  private async autoModel(chatId: number, state: ChatState): Promise<ModelRef | undefined> {
    let picked: ModelRef | undefined;
    try {
      picked = await this.modelSelector!.auto(state.projectDir);
    } catch (error) {
      console.error("free model selection failed; using server default", error);
      return undefined;
    }
    if (!picked) {
      // never fall through silently: a missing pick means the server default (a paid
      // model) would be used, which fails with "Insufficient account funds"
      this.handlers.onError(chatId, "No free text+image model is available right now; this session uses the server default model.");
      return undefined;
    }
    const current = this.getState(chatId);
    if (
      current.projectDir === state.projectDir &&
      current.sessionID === state.sessionID &&
      (current.model?.id !== picked.id || current.modelAuto !== true)
    ) {
      this.setState(chatId, { ...current, model: picked, modelAuto: true });
    }
    return picked;
  }

  async listAgents(chatId: number): Promise<AgentInfo[]> {
    const state = this.getState(chatId);
    const response = await this.client.GET("/api/agent", {
      params: { query: { location: { directory: state.projectDir } } },
    });
    if (response.error) throw new Error(`agent list failed: ${JSON.stringify(response.error)}`);
    return response.data?.data ?? [];
  }

  async listModels(chatId: number): Promise<ModelInfo[]> {
    const state = this.getState(chatId);
    const response = await this.client.GET("/api/model", {
      params: { query: { location: { directory: state.projectDir } } },
    });
    if (response.error) throw new Error(`model list failed: ${JSON.stringify(response.error)}`);
    return response.data?.data ?? [];
  }

  async listCommands(chatId: number): Promise<CommandInfo[]> {
    const state = this.getState(chatId);
    const response = await this.client.GET("/api/command", {
      params: { query: { location: { directory: state.projectDir } } },
    });
    if (response.error) throw new Error(`command list failed: ${JSON.stringify(response.error)}`);
    return response.data?.data ?? [];
  }

  async setAgent(chatId: number, agent: string): Promise<boolean> {
    let sessionID = await this.ensureSession(chatId);
    const projectDir = this.getState(chatId).projectDir;
    let response = await this.client.POST("/api/session/{sessionID}/agent", {
      params: { path: { sessionID } },
      body: { agent },
    });
    if (response.error && this.isSessionMissing(response.error, response.response)) {
      sessionID = await this.dropStaleSession(chatId, sessionID);
      response = await this.client.POST("/api/session/{sessionID}/agent", {
        params: { path: { sessionID } },
        body: { agent },
      });
    }
    if (response.error) return false;
    const current = this.getState(chatId);
    if (current.projectDir === projectDir) this.setState(chatId, { ...current, agent });
    return true;
  }

  async setModel(chatId: number, model: ModelRef): Promise<boolean> {
    let sessionID = await this.ensureSession(chatId);
    const projectDir = this.getState(chatId).projectDir;
    let response = await this.client.POST("/api/session/{sessionID}/model", {
      params: { path: { sessionID } },
      body: { model },
    });
    if (response.error && this.isSessionMissing(response.error, response.response)) {
      sessionID = await this.dropStaleSession(chatId, sessionID);
      response = await this.client.POST("/api/session/{sessionID}/model", {
        params: { path: { sessionID } },
        body: { model },
      });
    }
    if (response.error) return false;
    const current = this.getState(chatId);
    if (current.projectDir === projectDir) this.setState(chatId, { ...current, model, modelAuto: false });
    return true;
  }

  /** Put the chat back on automatic selection so newer free models can take over again. */
  setAutoModel(chatId: number) {
    const current = this.getState(chatId);
    this.setState(chatId, { ...current, model: undefined, modelAuto: true });
  }

  async openSession(chatId: number, sessionID: string, allowedDirectories: readonly string[]): Promise<boolean> {
    const response = await this.client.GET("/api/session/{sessionID}", {
      params: { path: { sessionID } },
    });
    const session = response.data?.data;
    const directory = session?.location?.directory ? resolvePath(session.location.directory) : undefined;
    if (response.error || !session || !directory || !allowedDirectories.includes(directory)) return false;
    this.setState(chatId, {
      ...this.getState(chatId),
      sessionID,
      projectDir: directory,
      agent: session.agent,
      model: session.model,
    });
    this.sessionChat.set(sessionID, chatId);
    this.validatedSessions.add(sessionID);
    return true;
  }

  async compact(chatId: number): Promise<boolean> {
    let sessionID = this.getState(chatId).sessionID;
    if (!sessionID) return false;
    let response = await this.client.POST("/api/session/{sessionID}/compact", {
      params: { path: { sessionID } },
      body: {},
    });
    if (response.error && this.isSessionMissing(response.error, response.response)) {
      sessionID = await this.dropStaleSession(chatId, sessionID);
      response = await this.client.POST("/api/session/{sessionID}/compact", {
        params: { path: { sessionID } },
        body: {},
      });
    }
    return !response.error;
  }

  async runCommand(chatId: number, name: string, text: string): Promise<"completed" | "busy" | "failed"> {
    let sessionID = await this.ensureSession(chatId);
    if (this.busyChats.has(chatId)) return "busy";
    this.busyChats.add(chatId);
    try {
      const done = this.waitForExecution(sessionID);
      this.lastText.delete(sessionID);
      try {
        let response = await this.client.POST("/api/session/{sessionID}/command", {
          params: { path: { sessionID } },
          body: { name, text },
        });
        if (response.error && this.isSessionMissing(response.error, response.response)) {
          this.cancelExecution(sessionID);
          sessionID = await this.dropStaleSession(chatId, sessionID);
          const retryDone = this.waitForExecution(sessionID);
          this.lastText.delete(sessionID);
          response = await this.client.POST("/api/session/{sessionID}/command", {
            params: { path: { sessionID } },
            body: { name, text },
          });
          if (response.error) {
            this.cancelExecution(sessionID);
            this.handlers.onError(chatId, `command failed: ${JSON.stringify(response.error).slice(0, 300)}`);
            return "failed";
          }
          const retrySucceeded = await retryDone;
          if (!retrySucceeded) {
            const reason = await this.lastAssistantError(sessionID);
            this.handlers.onError(chatId, reason ? `command failed: ${reason}` : "command execution timed out or failed");
            return "failed";
          }
          this.handlers.onDone(chatId, this.lastText.get(sessionID) ?? `/${name} completed.`);
          return "completed";
        }
        if (response.error) {
          this.cancelExecution(sessionID);
          this.handlers.onError(chatId, `command failed: ${JSON.stringify(response.error).slice(0, 300)}`);
          return "failed";
        }
        const succeeded = await done;
        if (!succeeded) {
          const reason = await this.lastAssistantError(sessionID);
          this.handlers.onError(chatId, reason ? `command failed: ${reason}` : "command execution timed out or failed");
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
      this.busyChats.delete(chatId);
      this.drainPromptQueue(chatId);
    }
  }

  private waitForExecution(sessionID: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingExecution.delete(sessionID);
        void this.interruptSession(sessionID);
        resolve(false);
      }, EXECUTION_TIMEOUT_MS);
      // never keep the process alive just to watch for a slow agent turn
      timer.unref?.();
      this.pendingExecution.set(sessionID, { resolve, timer });
    });
  }

  private async interruptSession(sessionID: string): Promise<void> {
    try {
      await this.client.POST("/api/session/{sessionID}/interrupt", {
        params: { path: { sessionID } },
      } as any);
    } catch (error) {
      console.error("interrupt on timeout failed", error);
    }
  }

  private isSessionMissing(error: unknown, response?: Response): boolean {
    if (response?.status === 404) return true;
    const text = typeof error === "object" && error !== null ? JSON.stringify(error) : String(error);
    return /not[ _-]?found|no such session|unknown session/i.test(text);
  }

  private async dropStaleSession(chatId: number, sessionID: string): Promise<string> {
    this.validatedSessions.delete(sessionID);
    this.sessionChat.delete(sessionID);
    const st = this.getState(chatId);
    if (st.sessionID === sessionID) this.setState(chatId, { ...st, sessionID: undefined });
    return this.ensureSession(chatId);
  }

  private cancelExecution(sessionID: string): void {
    const pending = this.pendingExecution.get(sessionID);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingExecution.delete(sessionID);
    pending.resolve(false);
  }

  private drainPromptQueue(chatId: number): void {
    const queue = this.queues.get(chatId);
    const next = queue?.shift();
    if (!next) {
      this.queues.delete(chatId);
      return;
    }
    if (!queue?.length) this.queues.delete(chatId);
    if (next.kind === "text") {
      void this.sendPrompt(chatId, next.text).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.handlers.onError(chatId, `queued prompt failed: ${message}`);
      });
      return;
    }
    void this.attachFile(chatId, next).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.handlers.onError(chatId, `queued attachment failed: ${message}`);
    });
  }

  async sendPrompt(chatId: number, text: string): Promise<string | null> {
    const sessionID = await this.ensureSession(chatId);
    this.sessionChat.set(sessionID, chatId);

    if (this.busyChats.has(chatId)) {
      const q = this.queues.get(chatId) ?? [];
      if (q.length >= MAX_QUEUED_ENTRIES) return "dropped";
      q.push({ kind: "text", text });
      this.queues.set(chatId, q);
      return "queued";
    }
    this.busyChats.add(chatId);
    try {
      await this.runPrompt(sessionID, chatId, text);
    } finally {
      this.busyChats.delete(chatId);
      this.drainPromptQueue(chatId);
    }
    return null;
  }

  private async runPrompt(sessionID: string, chatId: number, text: string) {
    const done = this.waitForExecution(sessionID);

    let sent = await this.client.POST("/api/session/{sessionID}/prompt", {
      params: { path: { sessionID } },
      body: { text } as any,
    });
    if (sent.error && this.isSessionMissing(sent.error, sent.response)) {
      this.cancelExecution(sessionID);
      sessionID = await this.dropStaleSession(chatId, sessionID);
      const retryDone = this.waitForExecution(sessionID);
      sent = await this.client.POST("/api/session/{sessionID}/prompt", {
        params: { path: { sessionID } },
        body: { text } as any,
      });
      if (sent.error) {
        this.cancelExecution(sessionID);
        this.handlers.onError(chatId, `prompt failed: ${JSON.stringify(sent.error).slice(0, 300)}`);
        return;
      }
      const retryOk = await retryDone;
      if (!retryOk) {
        await this.reportExecutionFailure(sessionID, chatId);
        return;
      }
      return this.finishWithMessages(sessionID, chatId);
    }
    if (sent.error) {
      this.cancelExecution(sessionID);
      this.handlers.onError(chatId, `prompt failed: ${JSON.stringify(sent.error).slice(0, 300)}`);
      return;
    }

    const ok = await done;
    if (!ok) {
      await this.reportExecutionFailure(sessionID, chatId);
      return;
    }
    return this.finishWithMessages(sessionID, chatId);
  }

  /**
   * A turn can end without succeeding for reasons other than our own timeout
   * (provider quota, auth, model errors). Prefer the assistant message's error
   * over a generic "failed", so the user sees the actual cause.
   */
  private async reportExecutionFailure(sessionID: string, chatId: number): Promise<void> {
    const reason = await this.lastAssistantError(sessionID);
    this.handlers.onError(chatId, reason ? `execution failed: ${reason}` : "execution timed out or failed");
  }

  private async lastAssistantError(sessionID: string): Promise<string | undefined> {
    try {
      const msgs = await this.client.GET("/api/session/{sessionID}/message", {
        params: { path: { sessionID }, query: { order: "desc" } },
      });
      const list = (msgs.data as any)?.data ?? msgs.data ?? [];
      const assistant = list.find((m: any) => m.type === "assistant");
      const error = assistant?.error;
      if (!error) return undefined;
      return typeof error === "string" ? error : String(error.message ?? JSON.stringify(error));
    } catch {
      return undefined;
    }
  }

  private async finishWithMessages(sessionID: string, chatId: number) {
    try {
      // order desc = newest first, so `.find` is the current turn and not an old one
      const msgs = await this.client.GET("/api/session/{sessionID}/message", {
        params: { path: { sessionID }, query: { order: "desc" } },
      });
      const list = (msgs.data as any)?.data ?? msgs.data ?? [];
      const assistant = list.find((m: any) => m.type === "assistant");
      const textOut = extractText(assistant) ?? this.lastText.get(sessionID) ?? "(no text)";
      this.handlers.onDone(chatId, textOut);
    } catch (err: any) {
      this.handlers.onError(chatId, `fetch messages failed: ${err?.message ?? err}`);
    }
  }

  async attachFile(chatId: number, entry: AttachmentInput): Promise<"queued" | "dropped" | null> {
    const sessionID = await this.ensureSession(chatId);
    this.sessionChat.set(sessionID, chatId);

    if (this.busyChats.has(chatId)) {
      const q = this.queues.get(chatId) ?? [];
      // queued attachments hold their bytes in memory (up to 20 MB each), so cap the queue
      if (q.length >= MAX_QUEUED_ENTRIES) return "dropped";
      q.push({ kind: "attachment", name: entry.name, mime: entry.mime, caption: entry.caption, bytes: entry.bytes });
      this.queues.set(chatId, q);
      return "queued";
    }
    this.busyChats.add(chatId);
    try {
      const st = this.getState(chatId);
      const name = await this.uniqueAttachmentName(st.projectDir, entry.name);
      await this.attachWriteFn(st.projectDir, name, entry.bytes);
      const prompt = `${entry.caption?.trim() || "Please review this file."}\n\n(File attached: ./${name})`;
      await this.runPrompt(sessionID, chatId, prompt);
    } finally {
      this.busyChats.delete(chatId);
      this.drainPromptQueue(chatId);
    }
    return null;
  }

  private async uniqueAttachmentName(directory: string, rawName: string): Promise<string> {
    // NOTE: collision detection assumes the bridge and the OpenCode server share a
    // filesystem (true with the default same-host wiring). If they are ever split,
    // this degrades to overwrite-on-collision rather than failing.
    let clean = basename(rawName).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80);
    // all-dots names ("..", ".") would escape or alias the target directory, and the
    // server write endpoint does not confine writes to the requested location
    if (!clean || /^\.+$/.test(clean)) clean = "attachment";
    if (!existsSync(join(directory, clean))) return clean;
    let candidate = `${Date.now()}-${clean}`;
    let i = 1;
    while (existsSync(join(directory, candidate))) candidate = `${Date.now()}-${i++}-${clean}`;
    return candidate;
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
    let sessionID = st.sessionID;
    let res = await this.client.POST("/api/session/{sessionID}/interrupt", {
      params: { path: { sessionID } },
    } as any);
    if (res.error && this.isSessionMissing(res.error, res.response)) {
      sessionID = await this.dropStaleSession(chatId, sessionID);
      res = await this.client.POST("/api/session/{sessionID}/interrupt", {
        params: { path: { sessionID } },
      } as any);
    }
    return !res.error;
  }

  setProject(chatId: number, projectDir: string) {
    const st = this.getState(chatId);
    if (st.projectDir === projectDir) return; // no-op: keep session/agent/model
    this.setState(chatId, { projectDir });
  }

  listProjects(allowlist: string[]) {
    return allowlist;
  }

  async listSessions(chatId: number) {
    const state = this.getState(chatId);
    const res = await this.client.GET("/api/session", {
      params: { query: { directory: state.projectDir, limit: "50", order: "desc" } },
    });
    if (res.error) throw new Error(`session list failed: ${JSON.stringify(res.error)}`);
    return res.data?.data ?? [];
  }

  async getPendingPermissions(chatId?: number): Promise<PermissionReq[]> {
    const res = await this.client.GET("/api/permission/request");
    if (res.error) throw new Error(`pending permission list failed: ${JSON.stringify(res.error)}`);
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
