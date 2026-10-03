import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Core, type CoreHandlers } from "../src/core";
import { makeBot } from "../src/bot";
import { loadConfig, type Config } from "../src/config";
import type { Client } from "../src/opencode";
import type { EventBus, OcEvent } from "../src/events";
import type { ChatState } from "../src/state";

type TelegramCall = { readonly method: string; readonly payload: Record<string, unknown> };
type HarnessOptions = {
  readonly editNotModified?: boolean;
  readonly failSetMyCommands?: boolean;
  readonly listAgents?: () => Promise<unknown[]>;
  readonly runCommand?: (...args: [number, string, string]) => Promise<"completed" | "busy" | "failed">;
  readonly sendPrompt?: (chatId: number, text: string) => Promise<string | null>;
};

const USER_ID = 71;
const OTHER_USER_ID = 72;
const config: Config = {
  tgToken: "test-token",
  allowedIds: new Set([USER_ID, OTHER_USER_ID]),
  opencodeUrl: "http://127.0.0.1:49374",
  opencodeUser: "opencode",
  opencodePassword: "test-password",
  projectAllowlist: ["/repo"],
  defaultProject: "/repo",
  statePath: "/tmp/opencode-tg-test-state.json",
};

function updateMessage(text: string, updateID: number, userID = USER_ID) {
  const command = text.split(/\s/, 1)[0] ?? "";
  return {
    update_id: updateID,
    message: {
      message_id: updateID,
      date: Math.floor(Date.now() / 1000),
      chat: { id: userID, type: "private" as const },
      from: { id: userID, is_bot: false, first_name: "Tester" },
      text,
      ...(text.startsWith("/") ? { entities: [{ type: "bot_command" as const, offset: 0, length: command.length }] } : {}),
    },
  };
}

function updateCallback(data: string, updateID: number, chatID = USER_ID, userID = chatID) {
  return {
    update_id: updateID,
    callback_query: {
      id: `callback-${updateID}`,
      from: { id: userID, is_bot: false, first_name: "Tester" },
      chat_instance: `instance-${chatID}`,
      message: {
        message_id: 900,
        date: Math.floor(Date.now() / 1000),
        chat: { id: chatID, type: "private" as const },
        text: "OpenCode controls",
      },
      data,
    },
  };
}

async function createHarness(options: HarnessOptions = {}) {
  const calls: TelegramCall[] = [];
  let handlers: CoreHandlers | undefined;
  const telegramFetch: typeof fetch = async (input, init) => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    const method = new URL(requestUrl).pathname.split("/").at(-1) ?? "";
    const payload = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ method, payload });
    if (method === "setMyCommands" && options.failSetMyCommands) {
      return Response.json({ ok: false, error_code: 500, description: "Telegram unavailable" });
    }
    if (method === "editMessageText" && options.editNotModified) {
      return Response.json({ ok: false, error_code: 400, description: "Bad Request: message is not modified" });
    }
    let result: unknown = true;
    if (method === "getMe") result = { id: 9000, is_bot: true, first_name: "OpenCode", username: "opencode_test_bot" };
    if (method === "sendMessage") {
      result = {
        message_id: calls.length + 100,
        date: Math.floor(Date.now() / 1000),
        chat: { id: payload.chat_id, type: "private" },
        text: payload.text,
      };
    }
    return Response.json({ ok: true, result });
  };
  const core = {
    setHandlers(value: CoreHandlers) { handlers = value; },
    getState() { return { projectDir: "/repo" }; },
    listAgents: options.listAgents ?? (async () => [{ id: "build", name: "Build", mode: "primary", hidden: false }]),
    listModels: async () => [],
    listCommands: async () => [{ name: "review" }],
    listSessions: async () => [],
    getPendingPermissions: async () => [],
    setAgent: async () => true,
    setModel: async () => true,
    setProject() {},
    openSession: async () => true,
    newSession: async () => "session-1",
    compact: async () => true,
    interrupt: async () => true,
    runCommand: options.runCommand ?? (async () => "completed"),
    sendPrompt: options.sendPrompt ?? (async () => null),
    permissionReply: async () => true,
  } as unknown as Core;
  const bot = await makeBot(config, core, telegramFetch);
  await bot.init();
  return { bot, calls, core, handlers: () => handlers };
}

function callbackDataFor(calls: TelegramCall[], buttonText: string): string {
  const sent = calls.filter((call) => call.method === "sendMessage").at(-1);
  assert.ok(sent, "menu message should be sent");
  const markup = sent.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  const button = markup.inline_keyboard.flat().find((item) => item.text === buttonText);
  assert.ok(button, `button ${buttonText} should exist`);
  return button.callback_data;
}

async function captureConsoleErrors<T>(run: () => Promise<T>): Promise<{ readonly result: T; readonly messages: readonly string[] }> {
  const messages: string[] = [];
  const original = console.error;
  console.error = (...values: Parameters<typeof console.error>) => messages.push(values.map(String).join(" "));
  try {
    return { result: await run(), messages };
  } finally {
    console.error = original;
  }
}

test("an OpenCode command argument prompt does not consume /interrupt", async () => {
  let interrupts = 0;
  const harness = await createHarness();
  const core = harness.core as unknown as { interrupt(chatId: number): Promise<boolean>; runCommand: Core["runCommand"] };
  core.interrupt = async () => { interrupts++; return true; };
  await harness.bot.handleUpdate(updateMessage("/commands", 1));
  const argsKey = callbackDataFor(harness.calls, "Args");
  await harness.bot.handleUpdate(updateCallback(argsKey, 2));
  await harness.bot.handleUpdate(updateMessage("/interrupt", 3));
  assert.equal(interrupts, 1, "/interrupt should reach its handler while command arguments are pending");
});

test("a long-running prompt does not hold grammY's sequential update loop", async () => {
  const harness = await createHarness({ sendPrompt: async () => new Promise<string | null>(() => {}) });
  const outcome = await Promise.race([
    harness.bot.handleUpdate(updateMessage("please work", 1)).then(() => "settled"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 30)),
  ]);
  assert.equal(outcome, "settled", "Telegram update handling should return while OpenCode is still running");
});

test("a permission button from another private chat cannot answer the request", async () => {
  const harness = await createHarness();
  let decisions = 0;
  const core = harness.core as unknown as { permissionReply(): Promise<boolean> };
  core.permissionReply = async () => { decisions++; return true; };
  harness.handlers()?.onPermission(USER_ID, { id: "request-1", sessionID: "session-1", action: "write", resources: ["/repo/file"] });
  const key = callbackDataFor(harness.calls, "Allow once");
  await harness.bot.handleUpdate(updateCallback(key, 1, OTHER_USER_ID));
  assert.equal(decisions, 0, "the forwarded callback must not approve the original chat's request");
});

test("Telegram command-menu registration failure does not prevent bot startup", async () => {
  const captured = await captureConsoleErrors(() => createHarness({ failSetMyCommands: true }));
  assert.ok(captured.result.bot);
  assert.match(captured.messages.join("\n"), /command-menu registration failed/);
});

test("message-not-modified from Telegram does not produce an error reply", async () => {
  const harness = await createHarness({ editNotModified: true });
  await harness.bot.handleUpdate(updateMessage("/menu", 1));
  const key = callbackDataFor(harness.calls, "Agent / plan or build");
  const previousMessages = harness.calls.filter((call) => call.method === "sendMessage").length;
  await harness.bot.handleUpdate(updateCallback(key, 2));
  const newMessages = harness.calls.filter((call) => call.method === "sendMessage").slice(previousMessages);
  assert.equal(newMessages.some((call) => String(call.payload.text).includes("message is not modified")), false);
});

test("a failed menu lookup leaves the button available for retry", async () => {
  let fail = true;
  const harness = await createHarness({ listAgents: async () => {
    if (fail) throw new Error("agent service unavailable");
    return [{ id: "build", name: "Build", mode: "primary", hidden: false }];
  } });
  await harness.bot.handleUpdate(updateMessage("/menu", 1));
  const key = callbackDataFor(harness.calls, "Agent / plan or build");
  await captureConsoleErrors(() => harness.bot.handleUpdate(updateCallback(key, 2)));
  fail = false;
  await captureConsoleErrors(() => harness.bot.handleUpdate(updateCallback(key, 3)));
  assert.equal(harness.calls.some((call) => call.method === "editMessageText"), true);
});

test("callback action identifiers do not repeat when the bot restarts", async () => {
  const first = await createHarness();
  const second = await createHarness();
  first.handlers()?.onPermission(USER_ID, { id: "request-1", sessionID: "session-1", action: "write", resources: [] });
  second.handlers()?.onPermission(USER_ID, { id: "request-2", sessionID: "session-2", action: "write", resources: [] });
  const firstKey = callbackDataFor(first.calls, "Allow once");
  const secondKey = callbackDataFor(second.calls, "Allow once");
  assert.match(firstKey, /^p[A-Za-z0-9_-]+:once$/);
  assert.notEqual(firstKey, secondKey);
});

test("pending argument state expires and the next message is handled as a prompt", async (context) => {
  const prompted: string[] = [];
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = await createHarness({ sendPrompt: async (_chatId, text) => { prompted.push(text); return null; } });
  await harness.bot.handleUpdate(updateMessage("/commands", 1));
  const argsKey = callbackDataFor(harness.calls, "Args");
  await harness.bot.handleUpdate(updateCallback(argsKey, 2));
  context.mock.timers.tick(5 * 60 * 1000);
  await harness.bot.handleUpdate(updateMessage("continue normally", 3));
  assert.deepEqual(prompted, ["continue normally"]);
});

test("a slash command runs asynchronously from the command menu", async () => {
  const harness = await createHarness({ runCommand: async () => new Promise<"completed" | "busy" | "failed">(() => {}) });
  await harness.bot.handleUpdate(updateMessage("/commands", 1));
  const key = callbackDataFor(harness.calls, "/review");
  const outcome = await Promise.race([
    harness.bot.handleUpdate(updateCallback(key, 2)).then(() => "settled"),
    new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 30)),
  ]);
  assert.equal(outcome, "settled", "the callback must be acknowledged without waiting for the agent turn");
});

test("menu action callback keys are unique across bot instances", async () => {
  const first = await createHarness();
  const second = await createHarness();
  await first.bot.handleUpdate(updateMessage("/menu", 1));
  await second.bot.handleUpdate(updateMessage("/menu", 1));
  assert.notEqual(callbackDataFor(first.calls, "Agent / plan or build"), callbackDataFor(second.calls, "Agent / plan or build"));
});

function createCore(client: Partial<Client>, initialState: ChatState) {
  let state = initialState;
  const handlers: CoreHandlers = {
    onPermission: () => {},
    onProgress: () => {},
    onDone: () => {},
    onError: () => {},
  };
  const core = new Core(
    client as Client,
    {} as EventBus,
    () => state,
    (_chatId, nextState) => { state = nextState; },
    handlers,
  );
  return { core, getState: () => state };
}

test("project agent lookup reports API failure instead of an empty agent list", async () => {
  const { core } = createCore({
    GET: async () => ({ data: undefined, error: { message: "Unauthorized" } }),
  }, { projectDir: "/repo" });
  await assert.rejects(core.listAgents(USER_ID), /agent list failed/);
});

test("opening a session outside the project allowlist is rejected", async () => {
  const { core, getState } = createCore({
    GET: async () => ({
      data: { data: { id: "other-session", location: { directory: "/outside" }, agent: "build", model: { id: "model", providerID: "provider" } } },
      error: undefined,
    }),
  }, { projectDir: "/repo" });
  assert.equal(await core.openSession(USER_ID, "other-session", ["/repo"]), false);
  assert.equal(getState().projectDir, "/repo");
  assert.equal(getState().sessionID, undefined);
});

test("a persisted session removed from OpenCode is replaced with a fresh session", async () => {
  let createdBody: Record<string, unknown> | undefined;
  const { core, getState } = createCore({
    GET: async () => ({ data: undefined, error: { message: "Session not found" }, response: { status: 404 } }),
    POST: async (_path, options) => {
      createdBody = options?.body as Record<string, unknown>;
      return { data: { data: { id: "replacement-session" } }, error: undefined };
    },
  }, { sessionID: "deleted-session", projectDir: "/repo", agent: "plan", model: { id: "model", providerID: "provider" } });
  assert.equal(await core.ensureSession(USER_ID), "replacement-session");
  assert.equal(getState().sessionID, "replacement-session");
  assert.equal(createdBody?.agent, "plan");
  assert.deepEqual(createdBody?.model, { id: "model", providerID: "provider" });
});

test("concurrent first prompts share a single newly created session", async () => {
  let postCount = 0;
  let releaseCreation: (() => void) | undefined;
  const creationGate = new Promise<void>((resolve) => { releaseCreation = resolve; });
  const { core } = createCore({
    POST: async () => {
      postCount++;
      await creationGate;
      return { data: { data: { id: "shared-session" } }, error: undefined };
    },
  }, { projectDir: "/repo" });
  const first = core.ensureSession(USER_ID);
  const second = core.ensureSession(USER_ID);
  assert.equal(postCount, 1, "parallel updates should start only one session creation request");
  releaseCreation?.();
  assert.deepEqual(await Promise.all([first, second]), ["shared-session", "shared-session"]);
});

test("changing projects during session creation does not restore the previous project", async () => {
  let state: ChatState = { projectDir: "/repo" };
  let releaseOldProject: (() => void) | undefined;
  const oldProjectGate = new Promise<void>((resolve) => { releaseOldProject = resolve; });
  const { core, getState } = createCore({
    POST: async (_path, options) => {
      const body = options?.body as { location?: { directory?: string } };
      if (body.location?.directory === "/repo") {
        await oldProjectGate;
        return { data: { data: { id: "old-project-session" } }, error: undefined };
      }
      return { data: { data: { id: "new-project-session" } }, error: undefined };
    },
  }, state);
  const originalSetState = core.setState.bind(core);
  core.setState = (chatId, nextState) => {
    state = nextState;
    originalSetState(chatId, nextState);
  };
  const oldSession = core.ensureSession(USER_ID);
  core.setProject(USER_ID, "/other");
  const newSession = core.ensureSession(USER_ID);
  assert.equal(await newSession, "new-project-session");
  releaseOldProject?.();
  assert.equal(await oldSession, "old-project-session");
  assert.equal(getState().projectDir, "/other");
  assert.equal(getState().sessionID, "new-project-session");
});

test("OpenCode endpoint query serialization preserves nested project location", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = async (input) => {
    requestedUrls.push(input instanceof Request ? input.url : String(input));
    return Response.json({ location: { directory: "/repo" }, data: [] });
  };
  try {
    const { makeClient } = await import("../src/opencode");
    const client = makeClient({ url: "http://opencode.test", user: "opencode", password: "secret" });
    const { core } = createCore(client, { projectDir: "/repo" });
    await Promise.all([core.listAgents(USER_ID), core.listModels(USER_ID), core.listCommands(USER_ID)]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requestedUrls.length, 3);
  for (const requestedUrl of requestedUrls) {
    const query = new URL(requestedUrl).searchParams;
    assert.equal(query.get("location[directory]"), "/repo");
  }
});

test("agent and model changes reach OpenCode and are reused for a new session", async () => {
  const calls: Array<{ path: string; body: unknown }> = [];
  const { core, getState } = createCore({
    GET: async () => ({ data: { data: { id: "current-session", location: { directory: "/repo" } } }, error: undefined }),
    POST: async (path, options) => {
      calls.push({ path: String(path), body: options?.body });
      if (path === "/api/session") return { data: { data: { id: "new-session" } }, error: undefined };
      return { data: { data: true }, error: undefined };
    },
  }, { sessionID: "current-session", projectDir: "/repo" });
  assert.equal(await core.setAgent(USER_ID, "plan"), true);
  assert.equal(await core.setModel(USER_ID, { id: "model", providerID: "provider", variant: "high" }), true);
  assert.equal(getState().agent, "plan");
  assert.deepEqual(getState().model, { id: "model", providerID: "provider", variant: "high" });
  assert.equal(await core.newSession(USER_ID), "new-session");
  assert.ok(calls.some((call) => call.path === "/api/session/{sessionID}/agent" && JSON.stringify(call.body) === JSON.stringify({ agent: "plan" })));
  assert.ok(calls.some((call) => call.path === "/api/session/{sessionID}/model" && JSON.stringify(call.body) === JSON.stringify({ model: { id: "model", providerID: "provider", variant: "high" } })));
  const creation = calls.find((call) => call.path === "/api/session");
  assert.ok(creation);
  const body = creation.body as { agent?: string; location?: { directory?: string }; model?: unknown };
  assert.equal(body.agent, "plan");
  assert.equal(body.location?.directory, "/repo");
  assert.deepEqual(body.model, { id: "model", providerID: "provider", variant: "high" });
});

test("a registered command completes when the session execution event arrives", async () => {
  let onEvent: ((event: OcEvent) => void) | undefined;
  let commandStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { commandStarted = resolve; });
  const outputs: string[] = [];
  const handlers: CoreHandlers = {
    onPermission: () => {},
    onProgress: () => {},
    onDone: (_chatId, text) => outputs.push(text),
    onError: (_chatId, text) => outputs.push(text),
  };
  const core = new Core(
    {
      GET: async () => ({ data: { data: { id: "session-1", location: { directory: "/repo" } } }, error: undefined }),
      POST: async () => {
        commandStarted?.();
        return { data: { data: true }, error: undefined };
      },
    } as unknown as Client,
    { on: (callback: (event: OcEvent) => void) => { onEvent = callback; } } as unknown as EventBus,
    () => ({ sessionID: "session-1", projectDir: "/repo" }),
    () => {},
    handlers,
  );
  core.attach();
  const command = core.runCommand(USER_ID, "review", "");
  await started;
  onEvent?.({ type: "session.text.ended", data: { sessionID: "session-1", text: "Review complete" } } as OcEvent);
  onEvent?.({ type: "session.execution.succeeded", data: { sessionID: "session-1" } } as OcEvent);
  assert.equal(await command, "completed");
  assert.deepEqual(outputs, ["Review complete"]);
});

test("configuration requires an explicit project allowlist", () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-tg-config-"));
  const envPath = join(directory, "env");
  const previousEnvPath = process.env.TG_ENV;
  try {
    writeFileSync(envPath, "TG_BOT_TOKEN=test-token\n");
    process.env.TG_ENV = envPath;
    assert.throws(loadConfig, /PROJECT_ALLOWLIST is required/);
  } finally {
    if (previousEnvPath === undefined) delete process.env.TG_ENV;
    else process.env.TG_ENV = previousEnvPath;
    rmSync(directory, { recursive: true, force: true });
  }
});
