import { homedir } from "node:os";
import { loadConfig } from "./config";
import { makeClient, writeProjectFile } from "./opencode";
import { EventBus } from "./events";
import { FreeModelSelector } from "./models";
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
    (directory, name, bytes) =>
      writeProjectFile(
        { url: config.opencodeUrl, user: config.opencodeUser, password: config.opencodePassword },
        directory,
        name,
        bytes,
      ),
    new FreeModelSelector(client, undefined, [config.defaultProject, homedir()]),
    config.modelPolicy,
  );
  core.restoreSessions(config.allowedIds);
  const bot = await makeBot(config, core);
  core.attach();
  events.start();

  // drop any updates queued while we were offline
  await bot.api.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
  bot.catch((error) => {
    const { ctx } = error;
    console.error("unhandled bot error:", error.error);
    const message = error.error instanceof Error ? error.error.message : String(error.error);
    void ctx
      .reply(`⚠️ ${message.slice(0, 500)}`)
      .catch((sendError: unknown) => console.error("error reply failed", sendError));
  });
  await bot.start({
    onStart: (info) => console.log(`bot started as @${info.username}`),
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
