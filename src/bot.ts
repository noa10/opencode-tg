import { Bot, InlineKeyboard, type Context } from "grammy";
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
  | { readonly kind: "model-variants"; readonly id: string; readonly providerID: string }
  | { readonly kind: "select-model"; readonly model: ModelRef }
  | { readonly kind: "projects" }
  | { readonly kind: "select-project"; readonly directory: string }
  | { readonly kind: "sessions"; readonly page: number }
  | { readonly kind: "open-session"; readonly sessionID: string }
  | { readonly kind: "new-session" }
  | { readonly kind: "commands" }
  | { readonly kind: "run-command"; readonly name: string; readonly text: string }
  | { readonly kind: "command-args"; readonly name: string }
  | { readonly kind: "compact" }
  | { readonly kind: "interrupt" };

type MenuScreen = {
  readonly text: string;
  readonly keyboard: InlineKeyboard;
};

type PendingPermission = {
  readonly request: PermissionReq;
  readonly timer: NodeJS.Timeout;
};

const PERMISSION_TTL_MS = 5 * 60 * 1000;
const MENU_ACTION_TTL_MS = 5 * 60 * 1000;
const FRESH_MS = 120_000;
const PAGE_SIZE = 8;

function assertNever(value: never): never {
  throw new Error(`Unhandled menu action: ${JSON.stringify(value)}`);
}

function isPermissionDecision(value: string): value is PermissionDecision {
  return value === "once" || value === "always" || value === "reject";
}

function buttonLabel(value: string, max = 48): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export async function makeBot(config: Config, core: Core, telegramApiFetch?: typeof fetch) {
  const bot = new Bot(config.tgToken, {
    client: telegramApiFetch ? { fetch: telegramApiFetch } : {},
  });
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
  const pendingCommands = new Map<number, string>();
  let permissionCounter = 0;
  let menuActionCounter = 0;

  function actionData(chatId: number, action: MenuAction): string {
    const key = `m${++menuActionCounter}`;
    const timer = setTimeout(() => menuActions.delete(key), MENU_ACTION_TTL_MS);
    timer.unref();
    menuActions.set(key, { chatId, action, timer });
    return key;
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
        .catch((error: unknown) => console.error("progress edit failed", error));
    } else {
      void bot.api
        .sendMessage(chatId, content, { parse_mode: "HTML" })
        .then((message) => progressMsg.set(chatId, { messageId: message.message_id, lastEdit: now }))
        .catch((error: unknown) => console.error("progress message failed", error));
    }
  }

  core.setHandlers({
    onPermission: (chatId, request) => {
      const key = `p${++permissionCounter}`;
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
      }, PERMISSION_TTL_MS);
      permissionMap.set(key, { request, timer });
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

  async function modelVariantScreen(chatId: number, id: string, providerID: string): Promise<MenuScreen> {
    const model = (await core.listModels(chatId)).find((item) => item.id === id && item.providerID === providerID);
    if (!model) return modelScreen(chatId, 0);
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
    keyboard.text("Back to models", actionData(chatId, { kind: "models", page: 0 }));
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
    return { text: "<b>Choose an allowed project</b>\nChanging project starts a new session and clears project-specific agent and model selections.", keyboard };
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
        .text(buttonLabel(`/${command.name}`), actionData(chatId, { kind: "run-command", name: command.name, text: "" }))
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
    await ctx.editMessageText(screen.text, { parse_mode: "HTML", reply_markup: screen.keyboard });
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
        await editScreen(ctx, await modelVariantScreen(chatId, action.id, action.providerID));
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
        await showHome(ctx, chatId, `Project changed to ${action.directory}. Start a new session to continue.`);
        return;
      case "sessions":
        await editScreen(ctx, await sessionScreen(chatId, action.page));
        return;
      case "open-session": {
        const opened = await core.openSession(chatId, action.sessionID);
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
        const result = await core.runCommand(chatId, action.name, action.text);
        const notice = result === "completed"
          ? `/${action.name} completed.`
          : result === "busy"
            ? "The session is busy. Try the command again when it finishes."
            : `/${action.name} did not complete.`;
        await showHome(ctx, chatId, notice);
        return;
      }
      case "command-args":
        pendingCommands.set(chatId, action.name);
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
      menuActions.delete(data);
      clearTimeout(menuAction.timer);
      await ctx.answerCallbackQuery();
      try {
        await handleMenuAction(ctx, chatId, menuAction.action);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        console.error("menu action failed", error);
        await ctx.reply(`⚠️ ${escapeHtml(redact(error.message))}`, { parse_mode: "HTML" });
      }
      return;
    }
    if (data.startsWith("m")) {
      await ctx.answerCallbackQuery({ text: "This menu expired. Send /menu to reopen it." });
      return;
    }

    const match = data.match(/^(p\d+):(once|always|reject)$/);
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
    if (pending.request.chatId !== undefined && pending.request.chatId !== ctx.chat?.id) {
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

  bot.on("message:text", async (ctx, next) => {
    if (Date.now() / 1000 - (ctx.message.date ?? 0) > FRESH_MS / 1000) return;
    await next();
  });

  bot.on("message:text", async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const commandName = pendingCommands.get(chatId);
    if (!commandName) {
      await next();
      return;
    }
    pendingCommands.delete(chatId);
    const text = ctx.message.text.trim();
    if (text === "/cancel") {
      await ctx.reply("Command cancelled.");
      return;
    }
    const result = await core.runCommand(chatId, commandName, text);
    if (result === "busy") await ctx.reply("The session is busy. Try the command again when it finishes.");
  });

  bot.command("start", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const screen = await homeScreen(chatId);
    await ctx.reply(screen.text, { parse_mode: "HTML", reply_markup: screen.keyboard });
  });

  bot.command("menu", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const screen = await homeScreen(chatId);
    await ctx.reply(screen.text, { parse_mode: "HTML", reply_markup: screen.keyboard });
  });

  bot.command("new", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const id = await core.newSession(chatId);
    await ctx.reply(`New session: <code>${escapeHtml(id)}</code>`, { parse_mode: "HTML" });
  });

  bot.command("sessions", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const screen = await sessionScreen(chatId, 0);
    await ctx.reply(screen.text, { parse_mode: "HTML", reply_markup: screen.keyboard });
  });

  bot.command("project", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const arg = ctx.match?.trim();
    if (!arg) {
      const screen = await projectScreen(chatId);
      await ctx.reply(screen.text, { parse_mode: "HTML", reply_markup: screen.keyboard });
      return;
    }
    const match = config.projectAllowlist.find((project) => project === arg || project.endsWith(arg));
    if (!match) {
      await ctx.reply("Not in the project allowlist.");
      return;
    }
    core.setProject(chatId, match);
    await ctx.reply(`Project set to <code>${escapeHtml(match)}</code>. Start a new session there.`, { parse_mode: "HTML" });
  });

  bot.command("agent", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const screen = await agentScreen(chatId);
    await ctx.reply(screen.text, { parse_mode: "HTML", reply_markup: screen.keyboard });
  });

  for (const command of ["model", "models"] as const) {
    bot.command(command, async (ctx) => {
      const chatId = ctx.chat?.id;
      if (chatId == null) return;
      const screen = await modelScreen(chatId, 0);
      await ctx.reply(screen.text, { parse_mode: "HTML", reply_markup: screen.keyboard });
    });
  }

  bot.command("commands", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const screen = await commandScreen(chatId);
    await ctx.reply(screen.text, { parse_mode: "HTML", reply_markup: screen.keyboard });
  });

  bot.command("cancel", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    await ctx.reply(pendingCommands.delete(chatId) ? "Command cancelled." : "There is no command waiting for arguments.");
  });

  bot.command("compact", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const accepted = await core.compact(chatId);
    await ctx.reply(accepted ? "Compaction queued for this session." : "OpenCode could not compact this session.");
  });

  bot.command("interrupt", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    const ok = await core.interrupt(chatId);
    await ctx.reply(ok ? "Interrupt requested." : "No active session.");
  });

  bot.command("status", async (ctx) => {
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
  });

  bot.command("pending", async (ctx) => {
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
  });

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    void bot.api.sendChatAction(chatId, "typing").catch((error: unknown) => console.error("typing indicator failed", error));
    const result = await core.sendPrompt(chatId, ctx.message.text);
    if (result === "queued") await ctx.reply("⏳ Still working on the previous prompt; yours is queued.");
  });

  await bot.api.setMyCommands([
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
  ]);

  return bot;
}
