import { Bot, InlineKeyboard } from "grammy";
import { Core, PermissionReq } from "./core";
import { Config } from "./config";
import { chunk, escapeHtml, redact, toTelegramHtml } from "./format";

const PERMISSION_TTL_MS = 5 * 60 * 1000;

export function makeBot(config: Config, core: Core) {
  const bot = new Bot(config.tgToken);

  const allowed = (id: number | undefined) => id != null && config.allowedIds.has(id);

  // whitelist + private chats only, for messages and callbacks
  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (!allowed(fromId)) {
      console.log(`blocked update from user ${fromId} (${ctx.from?.username ?? "?"})`);
      return;
    }
    const chatType = ctx.chat?.type;
    if (chatType && chatType !== "private") return;
    await next();
  });

  const permissionMap = new Map<string, PermissionReq>();
  let permCounter = 0;

  core.setHandlers({
    onPermission: (chatId, req) => {
      const key = `p${++permCounter}`;
      permissionMap.set(key, req);
      const kb = new InlineKeyboard()
        .text("Allow once", `${key}:once`)
        .text("Reject", `${key}:reject`)
        .row()
        .text("Always (session)", `${key}:always`);
      const lines = [
        `<b>Permission request</b>`,
        `action: <code>${escapeHtml(req.action)}</code>`,
        ...(req.resources.length ? [`resources: <code>${escapeHtml(req.resources.join(", "))}</code>`] : []),
        ...(req.message ? [escapeHtml(req.message)] : []),
      ];
      void bot.api.sendMessage(chatId, lines.join("\n"), {
        parse_mode: "HTML",
        reply_markup: kb,
      });
      const timer = setTimeout(async () => {
        if (permissionMap.delete(key)) {
          await core.permissionReply(req.sessionID, req.id, "reject").catch(() => {});
          try {
            await bot.api.sendMessage(chatId, "⏰ Permission request timed out and was rejected.");
          } catch {}
        }
      }, PERMISSION_TTL_MS);
      (permissionMap.get(key) as any)._timer = timer;
    },
    onProgress: throttleProgress,
    onDone: async (chatId, text) => {
      const clean = redact(text);
      const html = toTelegramHtml(clean);
      const parts = chunk(html);
      for (const part of parts) {
        try {
          await bot.api.sendMessage(chatId, part, { parse_mode: "HTML" });
        } catch {
          await bot.api.sendMessage(chatId, part.replace(/<[^>]+>/g, "")).catch(() => {});
        }
      }
      progressMsg.delete(chatId);
    },
    onError: async (chatId, text) => {
      await bot.api.sendMessage(chatId, `⚠️ ${escapeHtml(redact(text))}`, { parse_mode: "HTML" }).catch(() => {});
      progressMsg.delete(chatId);
    },
  });

  const progressMsg = new Map<number, { messageId: number; lastEdit: number }>();
  function throttleProgress(chatId: number, text: string) {
    const now = Date.now();
    const prev = progressMsg.get(chatId);
    if (prev && now - prev.lastEdit < 1200) return;
    const content = `🔄 ${escapeHtml(text)}`;
    if (prev) {
      bot.api
        .editMessageText(chatId, prev.messageId, content, { parse_mode: "HTML" })
        .then(() => progressMsg.set(chatId, { messageId: prev.messageId, lastEdit: now }))
        .catch(() => {});
    } else {
      bot.api
        .sendMessage(chatId, content, { parse_mode: "HTML" })
        .then((m) => progressMsg.set(chatId, { messageId: m.message_id, lastEdit: now }))
        .catch(() => {});
    }
  }

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const m = data.match(/^(p\d+):(once|always|reject)$/);
    if (!m) {
      await ctx.answerCallbackQuery();
      return;
    }
    const [, key, decision] = m;
    const req = permissionMap.get(key);
    if (!req) {
      await ctx.answerCallbackQuery({ text: "Already handled or expired" });
      return;
    }
    permissionMap.delete(key);
    clearTimeout((req as any)._timer);
    const ok = await core.permissionReply(req.sessionID, req.id, decision as any);
    await ctx.answerCallbackQuery({ text: ok ? `sent: ${decision}` : "failed" });
    try {
      await ctx.editMessageText(`✅ decision: <b>${decision}</b> for <code>${escapeHtml(req.action)}</code>`, {
        parse_mode: "HTML",
      });
    } catch {}
  });

  // stale message guard
  const FRESH_MS = 120_000;
  bot.on("message:text", async (ctx, next) => {
    if (Date.now() / 1000 - (ctx.message.date ?? 0) > 120) return;
    await next();
  });

  bot.command("start", (ctx) =>
    ctx.reply("OpenCode Telegram bridge. Commands: /new /sessions /project /models /model /interrupt /status /pending"),
  );

  bot.command("new", async (ctx) => {
    const id = await core.newSession(ctx.chat!.id);
    await ctx.reply(`New session: <code>${id}</code>`, { parse_mode: "HTML" });
  });

  bot.command("sessions", async (ctx) => {
    const sessions = await core.listSessions(ctx.chat!.id);
    const lines = sessions.slice(0, 10).map((s: any) => `• <code>${s.id}</code> ${escapeHtml(s.title ?? "")}`);
    await ctx.reply(lines.join("\n") || "none", { parse_mode: "HTML" });
  });

  bot.command("project", async (ctx) => {
    const arg = ctx.match?.trim();
    if (!arg) {
      await ctx.reply(`Current project allowlist:\n${config.projectAllowlist.map((p) => `<code>${p}</code>`).join("\n")}\n\nUsage: /project <dir>`, {
        parse_mode: "HTML",
      });
      return;
    }
    const match = config.projectAllowlist.find((p) => p === arg || p.endsWith(arg));
    if (!match) {
      await ctx.reply("Not in allowlist.");
      return;
    }
    core.setProject(ctx.chat!.id, match);
    await ctx.reply(`Project set to <code>${match}</code>. Next message starts a new session there.`, { parse_mode: "HTML" });
  });

  bot.command("models", async (ctx) => {
    const models = await core.listModels();
    const lines = (Array.isArray(models) ? models : [])
      .slice(0, 20)
      .map((m: any) => `• <code>${m.id ?? m.modelID ?? JSON.stringify(m).slice(0, 60)}</code>`);
    await ctx.reply(lines.join("\n") || "none", { parse_mode: "HTML" });
  });

  bot.command("interrupt", async (ctx) => {
    const ok = await core.interrupt(ctx.chat!.id);
    await ctx.reply(ok ? "interrupted" : "no active session");
  });

  bot.command("status", async (ctx) => {
    const st = core.getState(ctx.chat!.id);
    await ctx.reply(`session: <code>${st.sessionID ?? "none"}</code>\nproject: <code>${st.projectDir}</code>`, {
      parse_mode: "HTML",
    });
  });

  bot.command("pending", async (ctx) => {
    const pending = await core.getPendingPermissions();
    if (!pending.length) {
      await ctx.reply("no pending permission requests");
      return;
    }
    await ctx.reply(pending.map((p) => `<code>${p.id}</code> ${escapeHtml(p.action)} ${p.resources.join(",")}`).join("\n"), {
      parse_mode: "HTML",
    });
  });

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat!.id;
    void bot.api.sendChatAction(chatId, "typing").catch(() => {});
    const result = await core.sendPrompt(chatId, ctx.message.text);
    if (result === "queued") {
      await ctx.reply("⏳ still working on the previous prompt; yours is queued.");
    }
  });

  return bot;
}
