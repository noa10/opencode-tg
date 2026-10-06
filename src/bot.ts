import { randomBytes } from "node:crypto";
import { Bot, GrammyError, InlineKeyboard, type Context } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import type { components } from "./api";
import type { Config } from "./config";
import { Core, type PermissionReq } from "./core";
import { chunk, escapeHtml, redact, toTelegramHtml } from "./format";

type ModelRef = components["schemas"]["Model.Ref"];
type PermissionDecision = "once" | "always" | "reject";

type MenuAction =
  | { readonly kind: "home" }
  | { readonly kind: "agents" }
  | { readonly kind: "select-agent"; readonly agent: string }
  | { readonly kind: "models"; readonly page: number }
  | { readonly kind: "model-variants"; readonly id: string; readonly providerID: string; readonly page: number }
  | { readonly kind: "select-model"; readonly model: ModelRef }
  | { readonly kind: "projects" }
  | { readonly kind: "select-project"; readonly directory: string }
  | { readonly kind: "sessions"; readonly page: number }
  | { readonly kind: "open-session"; readonly sessionID: string }
  | { readonly kind: "new-session" }
  | { readonly kind: "commands" }
  | { readonly kind: "run-command"; readonly name: string }
  | { readonly kind: "command-args"; readonly name: string }
  | { readonly kind: "compact" }
  | { readonly kind: "interrupt" };

type MenuScreen = {
  readonly text: string;
  readonly keyboard: InlineKeyboard;
};

type PendingPermission = {
  readonly chatId: number;
  readonly request: PermissionReq;
  readonly timer: NodeJS.Timeout;
};

type PendingCommand = {
  readonly name: string;
  readonly timer: NodeJS.Timeout;
};

const PERMISSION_TTL_MS = 5 * 60 * 1000;
const MENU_ACTION_TTL_MS = 5 * 60 * 1000;
const PENDING_COMMAND_TTL_MS = 5 * 60 * 1000;
const FRESH_MS = 120_000;
const PAGE_SIZE = 8;

function assertNever(value: never): never {
  throw new Error(`Unhandled menu action: ${JSON.stringify(value)}`);
}

function isPermissionDecision(value: string): value is PermissionDecision {
  return value === "once" || value === "always" || value === "reject";
}

function buttonLabel(value: string, max = 48): string {
  const characters = Array.from(value);
  return characters.length > max ? `${characters.slice(0, max - 1).join("")}…` : value;
}

export interface BotOptions {
  readonly pendingCommandTtlMs?: number;
  readonly permissionTtlMs?: number;
}

export async function makeBot(config: Config, core: Core, telegramApiFetch?: typeof fetch, options: BotOptions = {}) {
  const bot = new Bot(config.tgToken, {
    client: telegramApiFetch ? { fetch: telegramApiFetch } : {},
  });
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, rethrowInternalServerErrors: true, rethrowHttpErrors: true, maxDelaySeconds: 10 }));
  const allowed = (id: number | undefined) => id != null && config.allowedIds.has(id);

  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (!allowed(fromId)) {
      console.log(`blocked update from user ${fromId} (${ctx.from?.username ?? "?"})`);
      return;
    }
    if (ctx.chat && ctx.chat.type !== "private") return;
    await next();
  });

  const permissionMap = new Map<string, PendingPermission>();
  const menuActions = new Map<string, { readonly chatId: number; readonly action: MenuAction; readonly timer: NodeJS.Timeout }>();
  const inFlightMenuActions = new Set<string>();
  const pendingCommands = new Map<number, PendingCommand>();

  function actionData(chatId: number, action: MenuAction): string {
    let key: string;
    do {
      key = `m${randomBytes(6).toString("base64url")}`;
    } while (menuActions.has(key));
    const timer = setTimeout(() => menuActions.delete(key), MENU_ACTION_TTL_MS);
    timer.unref();
    menuActions.set(key, { chatId, action, timer });
    return key;
  }

  const PERMISSION_TTL_EFFECTIVE = options.permissionTtlMs ?? PERMISSION_TTL_MS;
  const PENDING_COMMAND_TTL_EFFECTIVE = options.pendingCommandTtlMs ?? PENDING_COMMAND_TTL_MS;

  function setPendingCommand(chatId: number, name: string): void {
    const previous = pendingCommands.get(chatId);
    if (previous) clearTimeout(previous.timer);
    const pending: PendingCommand = {
      name,
      timer: setTimeout(() => {
        if (pendingCommands.get(chatId) !== pending) return;
        pendingCommands.delete(chatId);
        void bot.api.sendMessage(chatId, `The argument prompt for /${name} expired. Open /commands to try again.`)
          .catch((error: unknown) => console.error("argument timeout notice failed", error));
      }, PENDING_COMMAND_TTL_EFFECTIVE),
    };
    pending.timer.unref();
    pendingCommands.set(chatId, pending);
  }

  function clearPendingCommand(chatId: number): string | undefined {
    const pending = pendingCommands.get(chatId);
    if (!pending) return undefined;
    clearTimeout(pending.timer);
    pendingCommands.delete(chatId);
    return pending.name;
  }

  function startCommand(chatId: number, name: string, text: string): void {
    void core.runCommand(chatId, name, text).then((result) => {
      if (result === "busy") {
        return bot.api.sendMessage(chatId, "The session is busy. Try the command again when it finishes.");
      }
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return bot.api.sendMessage(chatId, `⚠️ ${escapeHtml(redact(message))}`, { parse_mode: "HTML" })
        .catch((sendError: unknown) => console.error("command failure notice failed", sendError));
    });
  }

  function startPrompt(chatId: number, text: string): void {
    void core.sendPrompt(chatId, text).then((result) => {
      if (result === "queued") {
        return bot.api.sendMessage(chatId, "⏳ Still working on the previous prompt; yours is queued.");
      }
      if (result === "dropped") {
        return bot.api.sendMessage(chatId, "⚠️ Queue is full — drop the pending work or wait for the current turn to finish.");
      }
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      return bot.api.sendMessage(chatId, `⚠️ ${escapeHtml(redact(message))}`, { parse_mode: "HTML" })
        .catch((sendError: unknown) => console.error("prompt failure notice failed", sendError));
    });
  }

  const progressMsg = new Map<number, { messageId: number; lastEdit: number }>();
  function throttleProgress(chatId: number, text: string) {
    const now = Date.now();
    const prev = progressMsg.get(chatId);
    if (prev && now - prev.lastEdit < 1200) return;
    const content = `🔄 ${escapeHtml(text)}`;
    if (prev) {
      void bot.api
        .editMessageText(chatId, prev.messageId, content, { parse_mode: "HTML" })
        .then(() => progressMsg.set(chatId, { messageId: prev.messageId, lastEdit: now }))
        .catch((error: unknown) => {
          // editing to identical text is not an error for our throttle
          if (error instanceof GrammyError && error.error_code === 400 && error.description.includes("message is not modified")) {
            progressMsg.set(chatId, { messageId: prev.messageId, lastEdit: now });
            return;
          }
          console.error("progress edit failed", error);
        });
    } else {
      void bot.api
        .sendMessage(chatId, content, { parse_mode: "HTML" })
        .then((message) => progressMsg.set(chatId, { messageId: message.message_id, lastEdit: now }))
        .catch((error: unknown) => console.error("progress message failed", error));
    }
  }

  core.setHandlers({
    onPermission: (chatId, request) => {
      let key: string;
      do {
        key = `p${randomBytes(6).toString("base64url")}`;
      } while (permissionMap.has(key));
      const keyboard = new InlineKeyboard()
        .text("Allow once", `${key}:once`)
        .text("Reject", `${key}:reject`)
        .row()
        .text("Always (session)", `${key}:always`);
      const lines = [
        "<b>Permission request</b>",
        `action: <code>${escapeHtml(request.action)}</code>`,
        ...(request.resources.length ? [`resources: <code>${escapeHtml(request.resources.join(", "))}</code>`] : []),
        ...(request.message ? [escapeHtml(request.message)] : []),
      ];
      void bot.api.sendMessage(chatId, lines.join("\n"), {
        parse_mode: "HTML",
        reply_markup: keyboard,
      }).catch((error: unknown) => console.error("permission message failed", error));

      const timer = setTimeout(async () => {
        const pending = permissionMap.get(key);
        if (!pending) return;
        permissionMap.delete(key);
        const accepted = await core.permissionReply(request.sessionID, request.id, "reject").catch((error: unknown) => {
          console.error("permission timeout rejection failed", error);
          return false;
        });
        const notice = accepted ? "Permission timed out and was rejected." : "Permission timed out; rejection could not be sent.";
        await bot.api.sendMessage(chatId, `⏰ ${notice}`).catch((error: unknown) => console.error("permission timeout notice failed", error));
      }, PERMISSION_TTL_EFFECTIVE);
      timer.unref();
      permissionMap.set(key, { chatId, request, timer });
    },
    onProgress: throttleProgress,
    onDone: async (chatId, text) => {
      const html = toTelegramHtml(redact(text));
      for (const part of chunk(html)) {
        try {
          await bot.api.sendMessage(chatId, part, { parse_mode: "HTML" });
        } catch (error) {
          console.error("formatted answer failed; retrying as plain text", error);
          await bot.api.sendMessage(chatId, part.replace(/<[^>]+>/g, "")).catch((fallbackError: unknown) => {
            console.error("plain text answer failed", fallbackError);
          });
        }
      }
      progressMsg.delete(chatId);
    },
    onError: async (chatId, text) => {
      await bot.api.sendMessage(chatId, `⚠️ ${escapeHtml(redact(text))}`, { parse_mode: "HTML" }).catch((error: unknown) => {
        console.error("error notice failed", error);
      });
      progressMsg.delete(chatId);
    },
  });

  async function homeScreen(chatId: number, notice?: string): Promise<MenuScreen> {
    const state = core.getState(chatId);
    const agent = state.agent ?? "OpenCode default";
    const model = state.model
      ? `${state.model.providerID}/${state.model.id}${state.model.variant ? `#${state.model.variant}` : ""}`
      : "OpenCode default";
    const keyboard = new InlineKeyboard()
      .text("Agent / plan or build", actionData(chatId, { kind: "agents" }))
      .text("Model", actionData(chatId, { kind: "models", page: 0 }))
      .row()
      .text("Project", actionData(chatId, { kind: "projects" }))
      .text("Sessions", actionData(chatId, { kind: "sessions", page: 0 }))
      .row()
      .text("OpenCode commands", actionData(chatId, { kind: "commands" }))
      .text("New session", actionData(chatId, { kind: "new-session" }))
      .row()
      .text("Compact context", actionData(chatId, { kind: "compact" }))
      .text("Interrupt", actionData(chatId, { kind: "interrupt" }));
    const lines = [
      "<b>OpenCode controls</b>",
      `Project: <code>${escapeHtml(state.projectDir)}</code>`,
      `Session: <code>${escapeHtml(state.sessionID ?? "not started")}</code>`,
      `Agent: <code>${escapeHtml(agent)}</code>`,
      `Model: <code>${escapeHtml(model)}</code>`,
      ...(notice ? ["", escapeHtml(notice)] : []),
    ];
    return { text: lines.join("\n"), keyboard };
  }

  async function agentScreen(chatId: number): Promise<MenuScreen> {
    const agents = (await core.listAgents(chatId)).filter((agent) => !agent.hidden && (agent.mode === "primary" || agent.mode === "all"));
    const selected = core.getState(chatId).agent;
    const keyboard = new InlineKeyboard();
    for (const agent of agents) {
      const marker = selected === agent.id ? "✓ " : "";
      keyboard.text(buttonLabel(`${marker}${agent.name} (${agent.id})`), actionData(chatId, { kind: "select-agent", agent: agent.id })).row();
    }
    keyboard.text("Back", actionData(chatId, { kind: "home" }));
    const text = agents.length
      ? "<b>Choose an agent</b>\nPlan is usually analysis-focused; Build is generally for coding. Tool permissions follow your OpenCode configuration. Custom primary agents also appear here."
      : "No visible primary agents are available for this project. Check the OpenCode agent configuration.";
    return { text, keyboard };
  }

  async function modelScreen(chatId: number, page: number): Promise<MenuScreen> {
    const models = (await core.listModels(chatId)).filter((model) => model.enabled);
    const selected = core.getState(chatId).model;
    const pageCount = Math.max(1, Math.ceil(models.length / PAGE_SIZE));
    const currentPage = Math.min(Math.max(page, 0), pageCount - 1);
    const keyboard = new InlineKeyboard();
    for (const model of models.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)) {
      const marker = selected?.id === model.id && selected.providerID === model.providerID ? "✓ " : "";
      keyboard.text(buttonLabel(`${marker}${model.name} · ${model.providerID}`), actionData(chatId, {
        kind: "model-variants",
        id: model.id,
        providerID: model.providerID,
        page: currentPage,
      })).row();
    }
    if (pageCount > 1) {
      if (currentPage > 0) keyboard.text("‹ Previous", actionData(chatId, { kind: "models", page: currentPage - 1 }));
      if (currentPage < pageCount - 1) keyboard.text("Next ›", actionData(chatId, { kind: "models", page: currentPage + 1 }));
      keyboard.row();
    }
    keyboard.text("Back", actionData(chatId, { kind: "home" }));
    const text = models.length
      ? `<b>Choose a model</b> (page ${currentPage + 1}/${pageCount})\nChoose a model to see its available variants.`
      : "No enabled models are available for this project. OpenCode model availability depends on its provider setup.";
    return { text, keyboard };
  }

  async function modelVariantScreen(chatId: number, id: string, providerID: string, page: number): Promise<MenuScreen> {
    const model = (await core.listModels(chatId)).find((item) => item.id === id && item.providerID === providerID);
    if (!model) return modelScreen(chatId, page);
    const keyboard = new InlineKeyboard().text("Default variant", actionData(chatId, {
      kind: "select-model",
      model: { id: model.id, providerID: model.providerID },
    })).row();
    for (const variant of model.variants) {
      keyboard.text(buttonLabel(variant.id), actionData(chatId, {
        kind: "select-model",
        model: { id: model.id, providerID: model.providerID, variant: variant.id },
      })).row();
    }
    keyboard.text("Back to models", actionData(chatId, { kind: "models", page }));
    return { text: `<b>${escapeHtml(model.name)}</b>\nChoose the default settings or a model variant.`, keyboard };
  }

  async function projectScreen(chatId: number): Promise<MenuScreen> {
    const current = core.getState(chatId).projectDir;
    const keyboard = new InlineKeyboard();
    for (const directory of config.projectAllowlist) {
      const marker = current === directory ? "✓ " : "";
      keyboard.text(buttonLabel(`${marker}${directory}`), actionData(chatId, { kind: "select-project", directory })).row();
    }
    keyboard.text("Back", actionData(chatId, { kind: "home" }));
    return { text: "<b>Choose an allowed project</b>\nChanging projects clears the active agent and model selections. The next message starts a new session.", keyboard };
  }

  async function sessionScreen(chatId: number, page: number): Promise<MenuScreen> {
    const sessions = await core.listSessions(chatId);
    const pageCount = Math.max(1, Math.ceil(sessions.length / PAGE_SIZE));
    const currentPage = Math.min(Math.max(page, 0), pageCount - 1);
    const currentSession = core.getState(chatId).sessionID;
    const keyboard = new InlineKeyboard();
    for (const session of sessions.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)) {
      const title = session.title ?? session.id;
      const marker = currentSession === session.id ? "✓ " : "";
      keyboard.text(buttonLabel(`${marker}${title}`), actionData(chatId, { kind: "open-session", sessionID: session.id })).row();
    }
    keyboard.text("New session", actionData(chatId, { kind: "new-session" }));
    keyboard.row();
    if (pageCount > 1) {
      if (currentPage > 0) keyboard.text("‹ Previous", actionData(chatId, { kind: "sessions", page: currentPage - 1 }));
      if (currentPage < pageCount - 1) keyboard.text("Next ›", actionData(chatId, { kind: "sessions", page: currentPage + 1 }));
      keyboard.row();
    } else {
      keyboard.row();
    }
    keyboard.text("Back", actionData(chatId, { kind: "home" }));
    return {
      text: sessions.length
        ? `<b>Sessions for this project</b> (page ${currentPage + 1}/${pageCount})`
        : "No sessions exist for this project yet.",
      keyboard,
    };
  }

  async function commandScreen(chatId: number): Promise<MenuScreen> {
    const registered = await core.listCommands(chatId);
    const commands = registered.slice(0, 40);
    const keyboard = new InlineKeyboard();
    for (const command of commands) {
      keyboard
        .text(buttonLabel(`/${command.name}`), actionData(chatId, { kind: "run-command", name: command.name }))
        .text("Args", actionData(chatId, { kind: "command-args", name: command.name }))
        .row();
    }
    keyboard.text("Back", actionData(chatId, { kind: "home" }));
    const note = registered.length > commands.length ? "\nShowing the first 40 commands." : "";
    return {
      text: commands.length
        ? `<b>OpenCode commands</b>\nTap a command to run it, or Args to provide command text.${note}`
        : "No OpenCode commands are registered for this project.",
      keyboard,
    };
  }

  async function editScreen(ctx: Context, screen: MenuScreen): Promise<void> {
    try {
      await ctx.editMessageText(screen.text, { parse_mode: "HTML", reply_markup: screen.keyboard });
    } catch (error) {
      if (
        error instanceof GrammyError &&
        error.error_code === 400 &&
        error.description.includes("message is not modified")
      ) {
        return;
      }
      throw error;
    }
  }

  async function showHome(ctx: Context, chatId: number, notice?: string): Promise<void> {
    await editScreen(ctx, await homeScreen(chatId, notice));
  }

  async function handleMenuAction(ctx: Context, chatId: number, action: MenuAction): Promise<void> {
    switch (action.kind) {
      case "home":
        await showHome(ctx, chatId);
        return;
      case "agents":
        await editScreen(ctx, await agentScreen(chatId));
        return;
      case "select-agent": {
        const selected = await core.setAgent(chatId, action.agent);
        await showHome(ctx, chatId, selected ? `Agent set to ${action.agent}.` : `OpenCode could not switch to ${action.agent}.`);
        return;
      }
      case "models":
        await editScreen(ctx, await modelScreen(chatId, action.page));
        return;
      case "model-variants":
        await editScreen(ctx, await modelVariantScreen(chatId, action.id, action.providerID, action.page));
        return;
      case "select-model": {
        const selected = await core.setModel(chatId, action.model);
        const label = `${action.model.providerID}/${action.model.id}${action.model.variant ? `#${action.model.variant}` : ""}`;
        await showHome(ctx, chatId, selected ? `Model set to ${label}.` : `OpenCode could not switch to ${label}.`);
        return;
      }
      case "projects":
        await editScreen(ctx, await projectScreen(chatId));
        return;
      case "select-project":
        core.setProject(chatId, action.directory);
        await showHome(ctx, chatId, `Project changed to ${action.directory}. Your next message starts a new session there.`);
        return;
      case "sessions":
        await editScreen(ctx, await sessionScreen(chatId, action.page));
        return;
      case "open-session": {
        const opened = await core.openSession(chatId, action.sessionID, config.projectAllowlist);
        await showHome(ctx, chatId, opened ? `Switched to session ${action.sessionID}.` : "OpenCode could not open that session.");
        return;
      }
      case "new-session": {
        const sessionID = await core.newSession(chatId);
        await showHome(ctx, chatId, `Started session ${sessionID}.`);
        return;
      }
      case "commands":
        await editScreen(ctx, await commandScreen(chatId));
        return;
      case "run-command": {
        startCommand(chatId, action.name, "");
        await showHome(ctx, chatId, `/${action.name} started.`);
        return;
      }
      case "command-args":
        setPendingCommand(chatId, action.name);
        await ctx.reply(`Send arguments for /${action.name}. Use /cancel to stop.`, {
          reply_markup: { force_reply: true, selective: true },
        });
        return;
      case "compact": {
        const accepted = await core.compact(chatId);
        await showHome(ctx, chatId, accepted ? "Compaction queued for this session." : "OpenCode could not compact this session.");
        return;
      }
      case "interrupt": {
        const interrupted = await core.interrupt(chatId);
        await showHome(ctx, chatId, interrupted ? "Interrupt requested." : "There is no active session to interrupt.");
        return;
      }
      default:
        return assertNever(action);
    }
  }

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const menuAction = menuActions.get(data);
    if (menuAction) {
      const chatId = ctx.chat?.id;
      if (chatId == null || chatId !== menuAction.chatId) {
        await ctx.answerCallbackQuery({ text: "This menu belongs to another chat." });
        return;
      }
      if (inFlightMenuActions.has(data)) {
        await ctx.answerCallbackQuery({ text: "This action is still running." });
        return;
      }
      inFlightMenuActions.add(data);
      try {
        await ctx.answerCallbackQuery();
        await handleMenuAction(ctx, chatId, menuAction.action);
        menuActions.delete(data);
        clearTimeout(menuAction.timer);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        console.error("menu action failed", error);
        await ctx.reply(`⚠️ ${escapeHtml(redact(error.message))}`, { parse_mode: "HTML" });
      } finally {
        inFlightMenuActions.delete(data);
      }
      return;
    }
    if (data.startsWith("m")) {
      await ctx.answerCallbackQuery({ text: "This menu expired. Send /menu to reopen it." });
      return;
    }

    const match = data.match(/^(p[A-Za-z0-9_-]+):(once|always|reject)$/);
    if (!match) {
      await ctx.answerCallbackQuery();
      return;
    }
    const [, key, value] = match;
    if (!key || !value || !isPermissionDecision(value)) {
      await ctx.answerCallbackQuery();
      return;
    }
    const pending = permissionMap.get(key);
    if (!pending) {
      await ctx.answerCallbackQuery({ text: "Already handled or expired" });
      return;
    }
    if (pending.chatId !== ctx.chat?.id) {
      await ctx.answerCallbackQuery({ text: "This permission belongs to another chat." });
      return;
    }
    permissionMap.delete(key);
    clearTimeout(pending.timer);
    const { request } = pending;
    const ok = await core.permissionReply(request.sessionID, request.id, value);
    await ctx.answerCallbackQuery({ text: ok ? `sent: ${value}` : "failed" });
    try {
      await ctx.editMessageText(`✅ decision: <b>${value}</b> for <code>${escapeHtml(request.action)}</code>`, {
        parse_mode: "HTML",
      });
    } catch (error) {
      console.error("permission result edit failed", error);
    }
  });

  bot.on(["message:text", "message:document", "message:photo", "message:video", "message:audio", "message:voice"], async (ctx, next) => {
    if (Date.now() / 1000 - (ctx.message.date ?? 0) > FRESH_MS / 1000) return;
    await next();
  });

  bot.on("message:text", async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const commandEntity = ctx.message.entities?.find((entity) => entity.type === "bot_command" && entity.offset === 0);
    if (commandEntity) {
      const command = ctx.message.text.slice(0, commandEntity.length).split("@", 1)[0]?.toLowerCase();
      if (command !== "/cancel") clearPendingCommand(chatId);
      await next();
      return;
    }
    const commandName = clearPendingCommand(chatId);
    if (!commandName) {
      await next();
      return;
    }
    const text = ctx.message.text.trim();
    startCommand(chatId, commandName, text);
    await ctx.reply(`Running /${commandName}…`);
  });

  // Wrap slash-command handlers: a failure (e.g. OpenCode 401/500 or a restart)
  // must reply with a redacted error instead of propagating out of bot.start().
  const guard = (fn: (ctx: any) => Promise<void>) => async (ctx: any) => {
    try {
      await fn(ctx);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error("command failed", error);
      await ctx
        .reply(`⚠️ ${escapeHtml(redact(error.message))}`, { parse_mode: "HTML" })
        .catch((sendError: unknown) => console.error("error reply failed", sendError));
    }
  };

  bot.command("start", guard(async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const screen = await homeScreen(chatId);
    await ctx.reply(screen.text, { parse_mode: "HTML", reply_markup: screen.keyboard });
  }));

  bot.command("menu", guard(async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const screen = await homeScreen(chatId);
    await ctx.reply(screen.text, { parse_mode: "HTML", reply_markup: screen.keyboard });
  }));

  bot.command("new", guard(async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const id = await core.newSession(chatId);
    await ctx.reply(`New session: <code>${escapeHtml(id)}</code>`, { parse_mode: "HTML" });
  }));

  bot.command("sessions", guard(async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const screen = await sessionScreen(chatId, 0);
    await ctx.reply(screen.text, { parse_mode: "HTML", reply_markup: screen.keyboard });
  }));

  bot.command("project", guard(async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const arg = ctx.match?.trim();
    if (!arg) {
      const screen = await projectScreen(chatId);
      await ctx.reply(screen.text, { parse_mode: "HTML", reply_markup: screen.keyboard });
      return;
    }
    const matches = config.projectAllowlist.filter((project) => project === arg || project.endsWith(`/${arg}`));
    if (matches.length === 0) {
      await ctx.reply("Not in the project allowlist.");
      return;
    }
    if (matches.length > 1) {
      await ctx.reply(`Ambiguous: ${matches.length} projects match "${arg}". Give more of the path.`);
      return;
    }
    core.setProject(chatId, matches[0]);
    await ctx.reply(`Project set to <code>${escapeHtml(matches[0])}</code>. Your next message starts a new session there.`, { parse_mode: "HTML" });
  }));

  bot.command("agent", guard(async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const screen = await agentScreen(chatId);
    await ctx.reply(screen.text, { parse_mode: "HTML", reply_markup: screen.keyboard });
  }));

  for (const command of ["model", "models"] as const) {
    bot.command(command, guard(async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId == null) return;
      const screen = await modelScreen(chatId, 0);
      await ctx.reply(screen.text, { parse_mode: "HTML", reply_markup: screen.keyboard });
    }));
  }

  bot.command("commands", guard(async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const screen = await commandScreen(chatId);
    await ctx.reply(screen.text, { parse_mode: "HTML", reply_markup: screen.keyboard });
  }));

  bot.command("cancel", guard(async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    await ctx.reply(clearPendingCommand(chatId) ? "Command cancelled." : "There is no command waiting for arguments.");
  }));

  bot.command("compact", guard(async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const accepted = await core.compact(chatId);
    await ctx.reply(accepted ? "Compaction queued for this session." : "OpenCode could not compact this session.");
  }));

  bot.command("interrupt", guard(async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const ok = await core.interrupt(chatId);
    await ctx.reply(ok ? "Interrupt requested." : "No active session.");
  }));

  bot.command("status", guard(async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const state = core.getState(chatId);
    const model = state.model
      ? `${state.model.providerID}/${state.model.id}${state.model.variant ? `#${state.model.variant}` : ""}`
      : "OpenCode default";
    await ctx.reply(
      `session: <code>${escapeHtml(state.sessionID ?? "none")}</code>\nproject: <code>${escapeHtml(state.projectDir)}</code>\nagent: <code>${escapeHtml(state.agent ?? "OpenCode default")}</code>\nmodel: <code>${escapeHtml(model)}</code>`,
      { parse_mode: "HTML" },
    );
  }));

  bot.command("pending", guard(async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const pending = await core.getPendingPermissions(chatId);
    if (!pending.length) {
      await ctx.reply("No pending permission requests.");
      return;
    }
    const lines = pending.map((request) =>
      `<code>${escapeHtml(request.id)}</code> ${escapeHtml(request.action)} ${escapeHtml(request.resources.join(", "))}`,
    );
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  }));

  const KNOWN_COMMANDS = new Set([
    "start", "menu", "new", "sessions", "project", "agent", "model", "models",
    "commands", "cancel", "compact", "interrupt", "status", "pending",
  ]);

  bot.on("message:text", guard(async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const text = ctx.message.text;
    if (text.startsWith("/")) {
      const name = text.slice(1).split(/[\s@]/, 1)[0]?.toLowerCase();
      if (name && !KNOWN_COMMANDS.has(name)) {
        await ctx.reply(`Unknown command: /${name}. Use /menu to browse what is available.`);
        return;
      }
    }
    void bot.api.sendChatAction(chatId, "typing").catch((error: unknown) => console.error("typing indicator failed", error));
    startPrompt(chatId, text);
  }));

  const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

  type AttachmentMeta = { fileId: string; name: string; mime?: string; size?: number; caption?: string; chatAction: "upload_document" | "upload_photo" };

  // Only the five message types registered below reach here, so this always resolves.
  function attachmentMeta(message: any): AttachmentMeta {
    if (message.document) {
      return { fileId: message.document.file_id, name: message.document.file_name ?? "document", mime: message.document.mime_type, size: message.document.file_size, caption: message.caption, chatAction: "upload_document" };
    }
    if (Array.isArray(message.photo) && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1];
      return { fileId: largest.file_id, name: "photo.jpg", mime: "image/jpeg", size: largest.file_size, caption: message.caption, chatAction: "upload_photo" };
    }
    if (message.video) {
      return { fileId: message.video.file_id, name: message.video.file_name ?? "video.mp4", mime: message.video.mime_type, size: message.video.file_size, caption: message.caption, chatAction: "upload_document" };
    }
    if (message.audio) {
      return { fileId: message.audio.file_id, name: message.audio.file_name ?? "audio.mp3", mime: message.audio.mime_type, size: message.audio.file_size, caption: message.caption, chatAction: "upload_document" };
    }
    return { fileId: message.voice.file_id, name: `voice-${message.date ?? Date.now()}.oga`, mime: message.voice.mime_type ?? "audio/ogg", size: message.voice.file_size, caption: message.caption, chatAction: "upload_document" };
  }

  async function handleAttachment(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    try {
      const meta = attachmentMeta(ctx.message);
      if (typeof meta.size === "number" && meta.size > MAX_ATTACHMENT_BYTES) {
        await ctx.reply("File is too large — maximum is 20 MB.");
        return;
      }
      void bot.api.sendChatAction(chatId, meta.chatAction).catch(() => {});
      const file = await ctx.getFile();
      if (!file.file_path) throw new Error("Telegram returned no file path");
      const fromTelegram = typeof telegramApiFetch === "function" ? telegramApiFetch : fetch;
      const url = `https://api.telegram.org/file/bot${config.tgToken}/${file.file_path}`;
      const res = await fromTelegram(url);
      if (!res.ok) throw new Error(`Telegram download failed: ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        await ctx.reply("File is too large — maximum is 20 MB.");
        return;
      }
      const result = await core.attachFile(chatId, { name: meta.name, mime: meta.mime, caption: meta.caption, bytes });
      if (result === "queued") {
        await ctx.reply("⏳ Still working on the previous prompt; the attachment is queued.");
      } else if (result === "dropped") {
        await ctx.reply("⚠️ Queue is full — drop the pending work or wait for the current turn to finish.");
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      console.error("attachment handling failed", error);
      await ctx.reply(`⚠️ ${escapeHtml(redact(error.message))}`, { parse_mode: "HTML" }).catch(() => {});
    }
  }

  for (const type of ["message:document", "message:photo", "message:video", "message:audio", "message:voice"] as const) {
    bot.on(type, guard(async (ctx) => handleAttachment(ctx)));
  }

  void bot.api.setMyCommands([
    { command: "menu", description: "Open controls for agent, model, and sessions" },
    { command: "new", description: "Start a new OpenCode session" },
    { command: "sessions", description: "Choose a session in this project" },
    { command: "project", description: "Choose an allowed project" },
    { command: "agent", description: "Choose Plan, Build, or another agent" },
    { command: "model", description: "Choose a model and variant" },
    { command: "commands", description: "Run a registered OpenCode command" },
    { command: "compact", description: "Compact the current session" },
    { command: "interrupt", description: "Interrupt the active session" },
    { command: "status", description: "Show current session settings" },
    { command: "pending", description: "List pending permission requests" },
    { command: "cancel", description: "Cancel a command argument prompt" },
  ]).catch((error: unknown) => console.error("Telegram command-menu registration failed", error));

  return bot;
}
