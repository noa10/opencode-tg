import { loadConfig } from "./config";
import { makeClient } from "./opencode";
import { EventBus } from "./events";
import { Core } from "./core";
import { State } from "./state";
import { makeBot } from "./bot";

async function main() {
  const config = loadConfig();
  const client = makeClient({
    url: config.opencodeUrl,
    user: config.opencodeUser,
    password: config.opencodePassword,
  });
  const events = new EventBus(
    `${config.opencodeUrl}/api/event`,
    "Basic " + Buffer.from(`${config.opencodeUser}:${config.opencodePassword}`).toString("base64"),
  );
  const state = new State(config.statePath);
  const core = new Core(
    client,
    events,
    (chatId) => state.get(chatId, config.defaultProject),
    (chatId, s) => state.set(chatId, s),
    {
      onPermission: () => {},
      onProgress: () => {},
      onDone: () => {},
      onError: () => {},
    },
  );
  core.restoreSessions(config.allowedIds);
  const bot = await makeBot(config, core);
  core.attach();
  events.start();

  // drop any updates queued while we were offline
  await bot.api.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
  await bot.start({
    onStart: (info) => console.log(`bot started as @${info.username}`),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
