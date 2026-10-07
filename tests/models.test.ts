import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FreeModelSelector,
  isFreeModel,
  isModelAvailable,
  isUsable,
  pickFreeVisionModel,
  supportsTextAndImage,
} from "../src/models";
import { Core, type CoreHandlers } from "../src/core";
import type { Client } from "../src/opencode";
import { createCore, USER_ID } from "./harness";

function model(overrides: Record<string, unknown> = {}) {
  return {
    id: "m",
    modelID: "m",
    providerID: "opencode",
    name: "M",
    capabilities: { input: ["text", "image"], output: ["text"] },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    status: "active",
    enabled: true,
    time: { released: 1_000_000 },
    ...overrides,
  } as any;
}

test("a paid model is not free even when its name says otherwise", () => {
  assert.equal(isFreeModel(model({ id: "x-free", cost: [{ input: 1.5, output: 2, cache: { read: 0, write: 0 } }] })), false);
  assert.equal(isFreeModel(model()), true);
  assert.equal(isFreeModel(model({ cost: [] })), false, "no price information is not free");
});

test("text-only and image-only models do not qualify", () => {
  assert.equal(supportsTextAndImage(model()), true);
  assert.equal(supportsTextAndImage(model({ capabilities: { input: ["text"], output: ["text"] } })), false);
  assert.equal(supportsTextAndImage(model({ capabilities: { input: ["image"], output: ["text"] } })), false);
});

test("disabled and deprecated models are not usable", () => {
  assert.equal(isUsable(model()), true);
  assert.equal(isUsable(model({ enabled: false })), false);
  assert.equal(isUsable(model({ status: "deprecated" })), false);
});

test("the newest free vision model wins", () => {
  const models = [
    model({ id: "older", time: { released: 1000 } }),
    model({ id: "newest", time: { released: 9000 } }),
    model({ id: "paid-newest", time: { released: 9999 }, cost: [{ input: 3, output: 3, cache: { read: 0, write: 0 } }] }),
    model({ id: "text-only-newest", time: { released: 9500 }, capabilities: { input: ["text"], output: ["text"] } }),
  ];
  assert.deepEqual(pickFreeVisionModel(models), { id: "newest", providerID: "opencode" });
});

test("a newly released free model takes over and a removed one is dropped", () => {
  const before = [model({ id: "old", time: { released: 1000 } })];
  assert.deepEqual(pickFreeVisionModel(before), { id: "old", providerID: "opencode" });

  const after = [model({ id: "new", time: { released: 2000 } })];
  assert.deepEqual(pickFreeVisionModel(after), { id: "new", providerID: "opencode" }, "rotates to the newer release");
  assert.equal(isModelAvailable(after, { id: "old", providerID: "opencode" }), false, "the removed model is gone");
  assert.equal(isModelAvailable(after, { id: "new", providerID: "opencode" }), true);
});

test("no free vision model yields no automatic choice", () => {
  assert.equal(pickFreeVisionModel([model({ cost: [{ input: 1, output: 1, cache: { read: 0, write: 0 } }] })]), undefined);
  assert.equal(pickFreeVisionModel([]), undefined);
});

test("the selector reports availability and caches the catalogue", async () => {
  let calls = 0;
  const client = {
    GET: async () => {
      calls++;
      return { data: { data: [model({ id: "alpha", time: { released: 10 } })] }, error: undefined };
    },
  } as unknown as Client;
  const selector = new FreeModelSelector(client, 60_000);
  assert.deepEqual(await selector.auto("/repo"), { id: "alpha", providerID: "opencode" });
  assert.equal(await selector.stillAvailable("/repo", { id: "alpha", providerID: "opencode" }), true);
  assert.equal(await selector.stillAvailable("/repo", { id: "gone", providerID: "opencode" }), false);
  assert.equal(calls, 1, "one catalogue fetch serves both calls");
});

test("an automatic pick rotates to a newer free release on the next session", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  let pick: { id: string; providerID: string } = { id: "free-v1", providerID: "opencode" };
  const selector = { auto: async () => pick, stillAvailable: async () => true };
  const { core, getState } = createCore(
    {
      POST: async (path: string, options?: { body?: unknown }) => {
        if (path === "/api/session") {
          bodies.push(options?.body as Record<string, unknown>);
          return { data: { data: { id: `s-${bodies.length}` } }, error: undefined };
        }
        return { data: { data: true }, error: undefined };
      },
    },
    { projectDir: "/repo" },
  );
  (core as unknown as { modelSelector: unknown }).modelSelector = selector;

  await core.newSession(USER_ID);
  assert.deepEqual(bodies[0]?.model, { id: "free-v1", providerID: "opencode" });
  assert.equal(getState().modelAuto, true, "the pick is marked automatic");

  // a newer free model is published upstream
  pick = { id: "free-v2", providerID: "opencode" };
  await core.newSession(USER_ID);
  assert.deepEqual(bodies[1]?.model, { id: "free-v2", providerID: "opencode" }, "a newer release takes over");
  assert.deepEqual(getState().model, { id: "free-v2", providerID: "opencode" });
});

test("an explicit user pick is never overridden by rotation", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  let pick: { id: string; providerID: string } = { id: "free-v2", providerID: "opencode" };
  const selector = { auto: async () => pick, stillAvailable: async () => true };
  const { core, getState } = createCore(
    {
      GET: async () => ({ data: { data: { id: "s-0", location: { directory: "/repo" } } }, error: undefined }),
      POST: async (path: string, options?: { body?: unknown }) => {
        if (path === "/api/session") {
          bodies.push(options?.body as Record<string, unknown>);
          return { data: { data: { id: `s-${bodies.length}` } }, error: undefined };
        }
        if (path === "/api/session/{sessionID}/model") return { data: { data: true }, error: undefined };
        return { data: { data: true }, error: undefined };
      },
    },
    { projectDir: "/repo", sessionID: "s-0" },
  );
  (core as unknown as { modelSelector: unknown }).modelSelector = selector;

  assert.equal(await core.setModel(USER_ID, { id: "chosen", providerID: "opencode" }), true);
  assert.equal(getState().modelAuto, false, "a menu pick is not automatic");

  pick = { id: "free-v3", providerID: "opencode" };
  await core.newSession(USER_ID);
  assert.deepEqual(bodies.at(-1)?.model, { id: "chosen", providerID: "opencode" }, "rotation must not override a user pick");
});

test("setAutoModel puts the chat back on rotation", async () => {
  const bodies: Array<Record<string, unknown>> = [];
  let pick: { id: string; providerID: string } = { id: "free-v9", providerID: "opencode" };
  const selector = { auto: async () => pick, stillAvailable: async () => true };
  const { core, getState } = createCore(
    {
      POST: async (path: string, options?: { body?: unknown }) => {
        if (path === "/api/session") {
          bodies.push(options?.body as Record<string, unknown>);
          return { data: { data: { id: `s-${bodies.length}` } }, error: undefined };
        }
        return { data: { data: true }, error: undefined };
      },
    },
    { projectDir: "/repo", sessionID: "s-0", model: { id: "chosen", providerID: "opencode" }, modelAuto: false },
  );
  (core as unknown as { modelSelector: unknown }).modelSelector = selector;
  core.setAutoModel(USER_ID);
  assert.equal(getState().model, undefined);
  assert.equal(getState().modelAuto, true);
  await core.newSession(USER_ID);
  assert.deepEqual(bodies.at(-1)?.model, { id: "free-v9", providerID: "opencode" });
});

test("the newest assistant message is read with an explicit order", async () => {
  const queries: Array<unknown> = [];
  let promptedSession: string | undefined;
  const handlers: CoreHandlers = { onPermission: () => {}, onProgress: () => {}, onDone: () => {}, onError: () => {} };
  const client = {
    GET: async (path: string, options?: { params?: { query?: unknown } }) => {
      if (path === "/api/session/{sessionID}/message") {
        queries.push(options?.params?.query);
        return { data: { data: [{ type: "assistant", content: [{ type: "text", text: "newest" }] }] }, error: undefined };
      }
      return { data: { data: { id: "s1", location: { directory: "/repo" } } }, error: undefined };
    },
    POST: async (path: string, options?: { params?: { path?: { sessionID?: string } } }) => {
      if (path === "/api/session/{sessionID}/prompt") promptedSession = options?.params?.path?.sessionID;
      return { data: { data: true }, error: undefined };
    },
  } as unknown as Partial<Client>;
  const { core, emit } = coreWithEventsForModel(client, { sessionID: "s1", projectDir: "/repo" }, handlers);
  const done = core.sendPrompt(USER_ID, "hi");
  while (promptedSession === undefined) await new Promise((r) => setTimeout(r, 5));
  emit({ type: "session.execution.succeeded", data: { sessionID: promptedSession } });
  await done;
  assert.deepEqual(queries, [{ order: "desc" }], "newest-first must be requested explicitly");
});

function coreWithEventsForModel(client: Partial<Client>, state: { sessionID?: string; projectDir: string }, handlers: CoreHandlers) {
  let onEvent: ((event: { type: string; data?: unknown }) => void) | undefined;
  const core = new Core(
    client as Client,
    { on: (cb: (event: { type: string; data?: unknown }) => void) => { onEvent = cb; } } as never,
    () => state,
    (_c, s) => { state = s; },
    handlers,
  );
  core.attach();
  return { core, emit: (e: { type: string; data?: unknown }) => onEvent?.(e) };
}

test("a new session gets the auto-selected free model when none is pinned", async () => {
  let body: Record<string, unknown> | undefined;
  const selector = { auto: async () => ({ id: "auto-free", providerID: "opencode" }), stillAvailable: async () => false };
  const { core, getState } = createCore(
    {
      POST: async (path: string, options?: { body?: unknown }) => {
        if (path === "/api/session") {
          body = options?.body as Record<string, unknown>;
          return { data: { data: { id: "s-new" } }, error: undefined };
        }
        return { data: { data: true }, error: undefined };
      },
    },
    { projectDir: "/repo" },
  );
  (core as unknown as { modelSelector: unknown }).modelSelector = selector;
  assert.equal(await core.newSession(USER_ID), "s-new");
  assert.deepEqual(body?.model, { id: "auto-free", providerID: "opencode" });
  assert.deepEqual(getState().model, { id: "auto-free", providerID: "opencode" }, "the choice is recorded so it can be validated later");
});

test("a pinned model that vanished upstream is dropped and re-selected", async () => {
  const notices: string[] = [];
  const selector = { auto: async () => ({ id: "auto-free", providerID: "opencode" }), stillAvailable: async () => false };
  const { core, getState } = createCore(
    {
      POST: async (path: string) => {
        if (path === "/api/session") return { data: { data: { id: "s-fresh" } }, error: undefined };
        return { data: { data: true }, error: undefined };
      },
    },
    { projectDir: "/repo", model: { id: "retired-model", providerID: "opencode" } },
  );
  (core as unknown as { modelSelector: unknown }).modelSelector = selector;
  (core as unknown as Core).setHandlers({
    onPermission: () => {},
    onProgress: () => {},
    onDone: () => {},
    onError: (_chatId: number, text: string) => { notices.push(text); },
  });
  await core.newSession(USER_ID);
  assert.match(notices.join("\n"), /retired-model is no longer available/);
  assert.deepEqual(getState().model, { id: "auto-free", providerID: "opencode" });
});

test("a still-available pinned model is kept", async () => {
  let body: Record<string, unknown> | undefined;
  const selector = { auto: async () => ({ id: "auto-free", providerID: "opencode" }), stillAvailable: async () => true };
  const { core } = createCore(
    {
      POST: async (path: string, options?: { body?: unknown }) => {
        if (path === "/api/session") {
          body = options?.body as Record<string, unknown>;
          return { data: { data: { id: "s-keep" } }, error: undefined };
        }
        return { data: { data: true }, error: undefined };
      },
    },
    { projectDir: "/repo", model: { id: "pinned", providerID: "opencode" } },
  );
  (core as unknown as { modelSelector: unknown }).modelSelector = selector;
  await core.newSession(USER_ID);
  assert.deepEqual(body?.model, { id: "pinned", providerID: "opencode" });
});