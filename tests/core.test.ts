import assert from "node:assert/strict";
import { test } from "node:test";
import { Core, type CoreHandlers } from "../src/core";
import type { Client } from "../src/opencode";
import type { EventBus, OcEvent } from "../src/events";
import type { ChatState } from "../src/state";
import { createCore, USER_ID } from "./harness";

/**
 * Progress is emitted only while the bridge is waiting on a turn. Tests that drive
 * tool events directly must mark the session watched the same way `sendPrompt` does.
 */
function watchSession(core: Core, sessionID: string): void {
  const internals = core as unknown as { waitForExecution(sessionID: string): Promise<unknown> };
  void internals.waitForExecution(sessionID);
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
  await new Promise((resolve) => setTimeout(resolve, 0)); // let the shared creation reach the client
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
    await Promise.all([
      core.listAgents(USER_ID),
      core.listModels(USER_ID),
      core.listCommands(USER_ID),
      core.listSessions(USER_ID),
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requestedUrls.length, 4);
  const nested = requestedUrls.slice(0, 3);
  for (const requestedUrl of nested) {
    const query = new URL(requestedUrl).searchParams;
    assert.equal(query.get("location[directory]"), "/repo");
  }
  const sessionsQuery = new URL(requestedUrls[3]).searchParams;
  assert.equal(sessionsQuery.get("directory"), "/repo");
  assert.equal(sessionsQuery.get("limit"), "50");
  assert.equal(sessionsQuery.get("order"), "desc");
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

test("setProject to the current directory is a no-op", () => {
  const { core, getState } = createCore({}, {
    sessionID: "current-session",
    projectDir: "/repo",
    agent: "plan",
    model: { id: "model", providerID: "provider" },
  });
  core.setProject(USER_ID, "/repo");
  assert.equal(getState().sessionID, "current-session");
  assert.equal(getState().agent, "plan");
  assert.deepEqual(getState().model, { id: "model", providerID: "provider" });
});

test("getPendingPermissions reports API failure instead of hiding it", async () => {
  const { core } = createCore({
    GET: async () => ({ data: undefined, error: { message: "Unauthorized" } }),
  }, { projectDir: "/repo" });
  await assert.rejects(core.getPendingPermissions(), /pending permission list failed/);
});

test("a question tool's progress line shows the prompt and options, not raw JSON", () => {
  let onEvent: ((event: OcEvent) => void) | undefined;
  const progress: string[] = [];
  const handlers: CoreHandlers = {
    onPermission: () => {},
    onProgress: (_chatId, text) => progress.push(text),
    onDone: () => {},
    onError: () => {},
  };
  const core = new Core(
    {} as unknown as Client,
    { on: (callback: (event: OcEvent) => void) => { onEvent = callback; } } as unknown as EventBus,
    () => ({ sessionID: "session-1", projectDir: "/repo" }),
    () => {},
    handlers,
  );
  core.attach();
  core.sessionChat.set("session-1", USER_ID);
  watchSession(core, "session-1");
  const args = JSON.stringify({
    questions: [{
      question: "I can't find the opencode-tg repo locally. How would you like to proceed?",
      header: "Repo location",
      options: [{ label: "Clone it", description: "clone from GitHub" }, { label: "Skip it" }],
    }],
  });
  onEvent?.({ type: "session.tool.input.started", data: { sessionID: "session-1", id: "call_1", name: "question" } } as OcEvent);
  onEvent?.({ type: "session.tool.input.ended", data: { sessionID: "session-1", id: "call_1", text: args } } as OcEvent);
  onEvent?.({ type: "session.tool.called", data: { sessionID: "session-1", id: "call_1", input: JSON.parse(args) } } as OcEvent);
  const line = progress.at(-1) ?? "";
  assert.match(line, /Repo location:/);
  assert.match(line, /How would you like to proceed\?/);
  assert.match(line, /Clone it/);
  assert.doesNotMatch(line, /\{"questions"/);
});

test("truncated arguments fall back to the tool name instead of dumping raw JSON", () => {
  let onEvent: ((event: OcEvent) => void) | undefined;
  const progress: string[] = [];
  const core = new Core(
    {} as unknown as Client,
    { on: (callback: (event: OcEvent) => void) => { onEvent = callback; } } as unknown as EventBus,
    () => ({ sessionID: "session-1", projectDir: "/repo" }),
    () => {},
    { onPermission: () => {}, onProgress: (_c, text) => progress.push(text), onDone: () => {}, onError: () => {} },
  );
  core.attach();
  core.sessionChat.set("session-1", USER_ID);
  watchSession(core, "session-1");
  onEvent?.({ type: "session.tool.input.started", data: { sessionID: "session-1", id: "call_1", name: "question" } } as OcEvent);
  onEvent?.({ type: "session.tool.input.ended", data: { sessionID: "session-1", id: "call_1", text: "{\"questions\":[{\"question\":\"trunca" } } as OcEvent);
  assert.equal(progress.at(-1), "tool: question");
  assert.doesNotMatch(progress.at(-1) ?? "", /questions/);
});

test("a tool failure with an unmapped call id still names the last known tool", () => {
  let onEvent: ((event: OcEvent) => void) | undefined;
  const progress: string[] = [];
  const core = new Core(
    {} as unknown as Client,
    { on: (callback: (event: OcEvent) => void) => { onEvent = callback; } } as unknown as EventBus,
    () => ({ sessionID: "session-1", projectDir: "/repo" }),
    () => {},
    { onPermission: () => {}, onProgress: (_c, text) => progress.push(text), onDone: () => {}, onError: () => {} },
  );
  core.attach();
  core.sessionChat.set("session-1", USER_ID);
  watchSession(core, "session-1");
  onEvent?.({ type: "session.tool.input.started", data: { sessionID: "session-1", id: "call_9", name: "question" } } as OcEvent);
  // the failure arrives with an id the bridge never mapped (e.g. events buffered out of
  // order), so the per-call lookup misses and the last reliably-named tool is used
  onEvent?.({ type: "session.tool.failed", data: { sessionID: "session-1", error: { message: "Tool execution interrupted" } } } as OcEvent);
  assert.equal(progress.at(-1), "tool failed: question — Tool execution interrupted");
});

test("a guess from the last-seen fallback is never persisted as a tool name", () => {
  let onEvent: ((event: OcEvent) => void) | undefined;
  const progress: string[] = [];
  const core = new Core(
    {} as unknown as Client,
    { on: (callback: (event: OcEvent) => void) => { onEvent = callback; } } as unknown as EventBus,
    () => ({ sessionID: "session-1", projectDir: "/repo" }),
    () => {},
    { onPermission: () => {}, onProgress: (_c, text) => progress.push(text), onDone: () => {}, onError: () => {} },
  );
  core.attach();
  core.sessionChat.set("session-1", USER_ID);
  watchSession(core, "session-1");
  onEvent?.({ type: "session.tool.input.started", data: { sessionID: "session-1", id: "call_1", name: "shell" } } as OcEvent);
  // an unmapped call id resolves via the last-seen name but must NOT be stored under it —
  // otherwise a real name arriving later for that id could not take over cleanly
  onEvent?.({ type: "session.tool.called", data: { sessionID: "session-1", id: "call_2", input: { command: "ls" } } } as OcEvent);
  onEvent?.({ type: "session.tool.input.started", data: { sessionID: "session-1", id: "call_2", name: "edit" } } as OcEvent);
  onEvent?.({ type: "session.tool.failed", data: { sessionID: "session-1", id: "call_2", error: { message: "aborted" } } } as OcEvent);
  assert.equal(progress.at(-1), "tool failed: edit — aborted");
});

test("progress lines redact secrets in tool arguments", () => {
  let onEvent: ((event: OcEvent) => void) | undefined;
  const progress: string[] = [];
  const core = new Core(
    {} as unknown as Client,
    { on: (callback: (event: OcEvent) => void) => { onEvent = callback; } } as unknown as EventBus,
    () => ({ sessionID: "session-1", projectDir: "/repo" }),
    () => {},
    { onPermission: () => {}, onProgress: (_c, text) => progress.push(text), onDone: () => {}, onError: () => {} },
  );
  core.attach();
  core.sessionChat.set("session-1", USER_ID);
  watchSession(core, "session-1");
  const command = 'curl -H "Authorization: Bearer supersecrettoken123" https://example.com/upload';
  onEvent?.({ type: "session.tool.input.started", data: { sessionID: "session-1", id: "call_1", name: "shell" } } as OcEvent);
  onEvent?.({ type: "session.tool.input.ended", data: { sessionID: "session-1", id: "call_1", text: JSON.stringify({ command }) } } as OcEvent);
  onEvent?.({ type: "session.tool.called", data: { sessionID: "session-1", id: "call_1", input: { command } } } as OcEvent);
  const line = progress.at(-1) ?? "";
  assert.match(line, /\[redacted\]/);
  assert.doesNotMatch(line, /supersecrettoken123/);
});

test("tool failure reasons are collapsed, truncated and fall back to JSON", () => {
  let onEvent: ((event: OcEvent) => void) | undefined;
  const progress: string[] = [];
  const core = new Core(
    {} as unknown as Client,
    { on: (callback: (event: OcEvent) => void) => { onEvent = callback; } } as unknown as EventBus,
    () => ({ sessionID: "session-1", projectDir: "/repo" }),
    () => {},
    { onPermission: () => {}, onProgress: (_c, text) => progress.push(text), onDone: () => {}, onError: () => {} },
  );
  core.attach();
  core.sessionChat.set("session-1", USER_ID);
  watchSession(core, "session-1");
  onEvent?.({ type: "session.tool.input.started", data: { sessionID: "session-1", id: "call_1", name: "shell" } } as OcEvent);
  onEvent?.({ type: "session.tool.failed", data: { sessionID: "session-1", id: "call_1", error: { message: "line one\nline two\n\tindented" } } } as OcEvent);
  assert.equal(progress.at(-1), "tool failed: shell — line one line two indented");
  // an error object without a message still gets reported (JSON fallback), not dropped
  onEvent?.({ type: "session.tool.failed", data: { sessionID: "session-1", id: "call_1", error: { code: 500 } } } as OcEvent);
  assert.equal(progress.at(-1), 'tool failed: shell — {"code":500}');
});

test("an unnamed tool event warns once about schema drift", () => {
  let onEvent: ((event: OcEvent) => void) | undefined;
  const progress: string[] = [];
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...values: Parameters<typeof console.warn>) => warnings.push(values.map(String).join(" "));
  try {
    const core = new Core(
      {} as unknown as Client,
      { on: (callback: (event: OcEvent) => void) => { onEvent = callback; } } as unknown as EventBus,
      () => ({ sessionID: "session-1", projectDir: "/repo" }),
      () => {},
      { onPermission: () => {}, onProgress: (_c, text) => progress.push(text), onDone: () => {}, onError: () => {} },
    );
    core.attach();
    core.sessionChat.set("session-1", USER_ID);
    watchSession(core, "session-1");
    // input.started is the event whose missing name field is the likeliest drift
    onEvent?.({ type: "session.tool.input.started", data: { sessionID: "session-1", id: "call_1" } } as OcEvent);
    onEvent?.({ type: "session.tool.input.started", data: { sessionID: "session-1", id: "call_2" } } as OcEvent);
    assert.deepEqual(progress, ["preparing tool: tool", "preparing tool: tool"]);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.filter((warning) => warning.includes("no tool name")).length, 1, "the drift warning must not repeat");
});

test("an unnamed input.started does not poison the last-seen tool fallback", () => {
  let onEvent: ((event: OcEvent) => void) | undefined;
  const progress: string[] = [];
  const core = new Core(
    {} as unknown as Client,
    { on: (callback: (event: OcEvent) => void) => { onEvent = callback; } } as unknown as EventBus,
    () => ({ sessionID: "session-1", projectDir: "/repo" }),
    () => {},
    { onPermission: () => {}, onProgress: (_c, text) => progress.push(text), onDone: () => {}, onError: () => {} },
  );
  core.attach();
  core.sessionChat.set("session-1", USER_ID);
  watchSession(core, "session-1");
  onEvent?.({ type: "session.tool.input.started", data: { sessionID: "session-1", id: "call_1", name: "shell" } } as OcEvent);
  // a name-less input.started must fall back for display but never store "tool"
  onEvent?.({ type: "session.tool.input.started", data: { sessionID: "session-1", id: "call_2" } } as OcEvent);
  assert.equal(progress.at(-1), "preparing tool: shell");
  onEvent?.({ type: "session.tool.failed", data: { sessionID: "session-1", error: { message: "boom" } } } as OcEvent);
  assert.equal(progress.at(-1), "tool failed: shell — boom");
});

test("progress is not emitted for an execution the bridge is not watching", () => {
  let onEvent: ((event: OcEvent) => void) | undefined;
  const progress: string[] = [];
  const core = new Core(
    {} as unknown as Client,
    { on: (callback: (event: OcEvent) => void) => { onEvent = callback; } } as unknown as EventBus,
    () => ({ sessionID: "session-1", projectDir: "/repo" }),
    () => {},
    { onPermission: () => {}, onProgress: (_c, text) => progress.push(text), onDone: () => {}, onError: () => {} },
  );
  core.attach();
  core.sessionChat.set("session-1", USER_ID);
  // a turn started from the OpenCode web UI/TUI: mapped session, but no pendingExecution,
  // so a progress bubble would never get its terminal cleanup
  onEvent?.({ type: "session.execution.started", data: { sessionID: "session-1" } } as OcEvent);
  onEvent?.({ type: "session.step.started", data: { sessionID: "session-1", agent: "build" } } as OcEvent);
  onEvent?.({ type: "session.text.started", data: { sessionID: "session-1" } } as OcEvent);
  onEvent?.({ type: "session.tool.input.started", data: { sessionID: "session-1", id: "call_1", name: "shell" } } as OcEvent);
  onEvent?.({ type: "session.tool.called", data: { sessionID: "session-1", id: "call_1", input: { command: "ls" } } } as OcEvent);
  assert.deepEqual(progress, []);
});

test("an interrupted turn ends with a plain interruption notice instead of an error", async () => {
  let onEvent: ((event: OcEvent) => void) | undefined;
  const notices: string[] = [];
  const errors: string[] = [];
  let prompted = false;
  const client = {
    GET: async () => ({ data: { data: [] }, error: undefined }),
    POST: async () => {
      prompted = true;
      return { data: { data: true }, error: undefined, response: new Response(null, { status: 200 }) };
    },
  } as unknown as Client;
  const core = new Core(
    client,
    { on: (callback: (event: OcEvent) => void) => { onEvent = callback; } } as unknown as EventBus,
    () => ({ sessionID: "session-1", projectDir: "/repo" }),
    () => {},
    {
      onPermission: () => {},
      onProgress: () => {},
      onDone: () => {},
      onError: (_chatId, text) => errors.push(text),
      onInterrupted: (chatId) => notices.push(String(chatId)),
    },
  );
  core.attach();
  core.sessionChat.set("session-1", USER_ID);
  const done = core.sendPrompt(USER_ID, "work");
  const deadline = Date.now() + 2000;
  while (!prompted && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  onEvent?.({ type: "session.execution.interrupted", data: { sessionID: "session-1" } } as OcEvent);
  await done;
  assert.deepEqual(notices, [String(USER_ID)], "an interrupt must reach the interruption notice");
  assert.deepEqual(errors, [], "an interrupt must not be reported as an error");
});
