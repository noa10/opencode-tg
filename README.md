# opencode-tg

Telegram bridge for [OpenCode](https://opencode.ai) v2 — drive the agent from your phone.

- Long-polling only; no public ports (OpenCode stays on `127.0.0.1:49374`)
- HTTP Basic auth to the local OpenCode service (password read from `~/.config/opencode/service.json`)
- Chat → session continuity, per-chat project allowlist
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
PROJECT_ALLOWLIST=/home/ubuntu,/home/ubuntu/repos
```

State: `~/.config/opencode-tg/state.json`.

## Run

```
npm install
npm run start          # dev
systemctl --user start opencode-tg   # production
```

Requires the OpenCode background service (`opencode service status`).
