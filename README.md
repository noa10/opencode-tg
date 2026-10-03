# opencode-tg

Telegram bridge for [OpenCode](https://opencode.ai) v2 — drive the agent from your phone.

- Long-polling only; no public ports (OpenCode stays on `127.0.0.1:49374`)
- HTTP Basic auth to the local OpenCode service (password read from `~/.config/opencode/service.json`)
- Chat → session continuity, per-chat project allowlist
- Telegram `/menu` with Plan/Build and custom primary agent selection, model variants, project/session switching
- Registered OpenCode commands, session compaction, and interrupt controls
- Permission prompts as inline buttons (`permission.asked` → session-scoped reply route)
- Busy-session queue, `/interrupt`, SSE-driven progress updates
- Whitelist of Telegram user IDs, private chats only, stale-update drop
- Outgoing-secret redaction, audited slash commands

## Layout

- `src/index.ts` — entry, wires Config/Client/EventBus/Core/Bot
- `src/core.ts` — session manager, permission routing, execution wait
- `src/bot.ts` — grammY adapter (commands, inline keyboards, throttled progress)
- `src/events.ts` — SSE subscriber with reconnect
- `src/format.ts` — HTML escaping, chunking, redaction
- `scripts/smoke.ts` — REST smoke test (create session → prompt → messages)

## Config

`~/.config/opencode-tg/env` (chmod 600):

```
TG_BOT_TOKEN=...
TG_ALLOWED_IDS=<your numeric telegram id>
OPENCODE_URL=http://127.0.0.1:49374
OPENCODE_USER=opencode
PROJECT_ALLOWLIST=/Users/you/dev,/Users/you/work
# Optional overrides:
OPENCODE_SERVICE_FILE=/Users/you/.config/opencode/service.json
TG_STATE=/Users/you/.config/opencode-tg/state.json
```

The default environment, service, and state files live under `~/.config`. Set `TG_ENV` to use a different environment file. `PROJECT_ALLOWLIST` must contain directories OpenCode is allowed to open.

Open the Telegram bot's command menu or send `/menu` to switch the active agent, model and variant, project, or session. The menu also lists project-registered OpenCode commands and offers compact and interrupt actions. Agent and model choices are applied to the current session and reused for new sessions in that project.

## Run

```
npm install
npm run start          # dev
systemctl --user start opencode-tg   # production
```

Requires the OpenCode background service (`opencode service status`).
