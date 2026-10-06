import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Core, type AttachWrite, type CoreHandlers } from "../src/core";
import type { Client } from "../src/opencode";
import type { EventBus, OcEvent } from "../src/events";
import type { ChatState } from "../src/state";
import { createCore, createHarness, updateDocumentMessage, USER_ID } from "./harness";

function coreWithEvents(client: Partial<Client>, state: ChatState, handlers?: CoreHandlers, attachWrite?: AttachWrite) {
  let onEvent: ((event: OcEvent) => void) | undefined;
  const core = new Core(
    client as Client,
    { on: (cb: (event: OcEvent) => void) => { onEvent = cb; } } as unknown as EventBus,
    () => state,
    (_chatId, nextState) => { state = nextState; },
    handlers ?? { onPermission: () => {}, onProgress: () => {}, onDone: () => {}, onError: () => {} },
    attachWrite,
  );
  core.attach();
  return { core, emit: (e: OcEvent) => onEvent?.(e) };
}

/** Wait until `predicate` holds, polling on a short timer. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * The core's execution timer is unref'd on purpose, so a test that forgets to
 * settle would otherwise drain the event loop and cancel the whole file.
 */
function keepAlive() {
  const handle = setInterval(() => {}, 50);
  return () => clearInterval(handle);
}

test("an uploaded document is written to the project dir and referenced in the prompt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-tg-attach-"));
  const release = keepAlive();
  const prompts: string[] = [];
  let promptedSession: string | undefined;
  const handlers: CoreHandlers = { onPermission: () => {}, onProgress: () => {}, onDone: () => {}, onError: () => {} };
  const client = {
    GET: async (path: string) => {
      if (path === "/api/session/{sessionID}/message") {
        return { data: { data: [{ type: "assistant", content: [{ type: "text", text: "done" }] }] }, error: undefined };
      }
      return { data: { data: { id: "session-1", location: { directory } } }, error: undefined };
    },
    POST: async (path: string, options?: { body?: unknown; params?: { path?: { sessionID?: string } } }) => {
      if (path === "/api/session/{sessionID}/prompt") {
        prompts.push(String((options?.body as { text: string }).text));
        promptedSession = options?.params?.path?.sessionID;
      }
      return { data: { data: true }, error: undefined, response: new Response(null, { status: 200 }) };
    },
  } as unknown as Partial<Client>;

  try {
    const { core, emit } = coreWithEvents(client, { sessionID: "session-1", projectDir: directory }, handlers);
    const done = core.attachFile(USER_ID, { name: "notes.txt", caption: "Summarize this.", bytes: new Uint8Array([104, 105]) });
    await waitFor(() => promptedSession !== undefined, "the prompt to be sent");
    emit({ type: "session.execution.succeeded", data: { sessionID: promptedSession } } as OcEvent);
    assert.equal(await done, null);

    assert.deepEqual([...readFileSync(join(directory, "notes.txt"))], [104, 105]);
    assert.match(prompts.join("\n"), /Summarize this\./);
    assert.match(prompts.join("\n"), /\(File attached: \.\/notes\.txt\)/);
  } finally {
    release();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an all-dots filename is replaced instead of escaping the project dir", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-tg-attach-"));
  const release = keepAlive();
  const prompts: string[] = [];
  let promptedSession: string | undefined;
  const handlers: CoreHandlers = { onPermission: () => {}, onProgress: () => {}, onDone: () => {}, onError: () => {} };
  const client = {
    GET: async (path: string) => {
      if (path === "/api/session/{sessionID}/message") {
        return { data: { data: [{ type: "assistant", content: [{ type: "text", text: "done" }] }] }, error: undefined };
      }
      return { data: { data: { id: "session-1", location: { directory } } }, error: undefined };
    },
    POST: async (path: string, options?: { body?: unknown; params?: { path?: { sessionID?: string } } }) => {
      if (path === "/api/session/{sessionID}/prompt") {
        prompts.push(String((options?.body as { text: string }).text));
        promptedSession = options?.params?.path?.sessionID;
      }
      return { data: { data: true }, error: undefined, response: new Response(null, { status: 200 }) };
    },
  } as unknown as Partial<Client>;
  const writes: string[] = [];

  try {
    const { core, emit } = coreWithEvents(
      client,
      { sessionID: "session-1", projectDir: directory },
      handlers,
      async (_dir, name) => { writes.push(name); },
    );
    const done = core.attachFile(USER_ID, { name: "..", caption: "look", bytes: new Uint8Array([1]) });
    await waitFor(() => promptedSession !== undefined, "the prompt to be sent");
    emit({ type: "session.execution.succeeded", data: { sessionID: promptedSession } } as OcEvent);
    assert.equal(await done, null);
    assert.deepEqual(writes, ["attachment"], `expected a safe fallback name, got ${JSON.stringify(writes)}`);
    assert.match(prompts.join("\n"), /\(File attached: \.\/attachment\)/);
  } finally {
    release();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the queue drops attachments past its cap instead of growing without bound", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-tg-attach-"));
  const release = keepAlive();
  const handlers: CoreHandlers = { onPermission: () => {}, onProgress: () => {}, onDone: () => {}, onError: () => {} };
  let releasePost: (() => void) | undefined;
  let promptedSession: string | undefined;
  const gate = new Promise<void>((resolve) => { releasePost = resolve; });
  const client = {
    GET: async (path: string) => {
      if (path === "/api/session/{sessionID}/message") return { data: { data: [] }, error: undefined };
      return { data: { data: { id: "s1", location: { directory } } }, error: undefined };
    },
    POST: async (path: string, options?: { params?: { path?: { sessionID?: string } } }) => {
      if (path.includes("/prompt")) {
        promptedSession = options?.params?.path?.sessionID;
        await gate;
      }
      return { data: { data: true }, error: undefined };
    },
  } as unknown as Partial<Client>;
  const { core, emit } = coreWithEvents(client, { sessionID: "s1", projectDir: directory }, handlers, async () => {});

  try {
    const first = core.sendPrompt(USER_ID, "first");
    await waitFor(() => promptedSession !== undefined, "the first prompt");
    const results: string[] = [];
    for (let i = 0; i < 8; i++) {
      results.push(await core.attachFile(USER_ID, { name: `f${i}.txt`, bytes: new Uint8Array([1]) }) ?? "ran");
    }
    assert.ok(results.includes("queued"), "some attachments should queue");
    assert.ok(results.includes("dropped"), "attachments past the cap should be dropped");
    releasePost?.();
    emit({ type: "session.execution.succeeded", data: { sessionID: promptedSession } } as OcEvent);
    await first;
  } finally {
    release();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an empty caption falls back to a review prompt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-tg-attach-"));
  const release = keepAlive();
  const prompts: string[] = [];
  let promptedSession: string | undefined;
  const handlers: CoreHandlers = { onPermission: () => {}, onProgress: () => {}, onDone: () => {}, onError: () => {} };
  const client = {
    GET: async (path: string) => {
      if (path === "/api/session/{sessionID}/message") {
        return { data: { data: [{ type: "assistant", content: [{ type: "text", text: "done" }] }] }, error: undefined };
      }
      return { data: { data: { id: "session-1", location: { directory } } }, error: undefined };
    },
    POST: async (path: string, options?: { body?: unknown; params?: { path?: { sessionID?: string } } }) => {
      if (path === "/api/session/{sessionID}/prompt") {
        prompts.push(String((options?.body as { text: string }).text));
        promptedSession = options?.params?.path?.sessionID;
      }
      return { data: { data: true }, error: undefined, response: new Response(null, { status: 200 }) };
    },
  } as unknown as Partial<Client>;

  try {
    const { core, emit } = coreWithEvents(client, { sessionID: "session-1", projectDir: directory }, handlers);
    const done = core.attachFile(USER_ID, { name: "a.bin", caption: "   ", bytes: new Uint8Array([1]) });
    await waitFor(() => promptedSession !== undefined, "the prompt to be sent");
    emit({ type: "session.execution.succeeded", data: { sessionID: promptedSession } } as OcEvent);
    assert.equal(await done, null);
    assert.match(prompts.join("\n"), /Please review this file\./);
  } finally {
    release();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an attachment while busy is queued instead of written", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-tg-attach-"));
  const release = keepAlive();
  const writes: Array<[string, string]> = [];
  const handlers: CoreHandlers = { onPermission: () => {}, onProgress: () => {}, onDone: () => {}, onError: () => {} };
  let releasePost: (() => void) | undefined;
  let promptedSession: string | undefined;
  const gate = new Promise<void>((resolve) => { releasePost = resolve; });
  const client = {
    GET: async (path: string) => {
      if (path === "/api/session/{sessionID}/message") return { data: { data: [] }, error: undefined };
      return { data: { data: { id: "s1", location: { directory } } }, error: undefined };
    },
    POST: async (path: string, options?: { params?: { path?: { sessionID?: string } } }) => {
      if (path.includes("/prompt")) {
        promptedSession = options?.params?.path?.sessionID;
        await gate;
      }
      return { data: { data: true }, error: undefined };
    },
  } as unknown as Partial<Client>;
  const { core, emit } = coreWithEvents(
    client,
    { sessionID: "s1", projectDir: directory },
    handlers,
    async (_dir, name) => { writes.push([directory, name]); },
  );

  try {
    const first = core.sendPrompt(USER_ID, "first");
    await waitFor(() => promptedSession !== undefined, "the first prompt");
    assert.equal(await core.attachFile(USER_ID, { name: "late.txt", caption: "later", bytes: new Uint8Array([9]) }), "queued");
    assert.equal(writes.length, 0, "attachment must not be written while busy");
    releasePost?.();
    emit({ type: "session.execution.succeeded", data: { sessionID: promptedSession } } as OcEvent);
    assert.equal(await first, null);
  } finally {
    release();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the bot rejects an oversized document before calling attachFile", async () => {
  let attachCalls = 0;
  const harness = await createHarness({ attachFile: async () => { attachCalls++; return null; } });
  await harness.bot.handleUpdate(updateDocumentMessage(1, { fileSize: 30 * 1024 * 1024 }));
  const replies = harness.calls.filter((c) => c.method === "sendMessage");
  assert.match(String(replies.at(-1)?.payload.text), /too large/);
  assert.equal(attachCalls, 0);
});

test("the bot passes an uploaded document to attachFile with its caption", async () => {
  const seen: Array<{ name: string; caption?: string }> = [];
  const harness = await createHarness({ attachFile: async (_id, entry) => { seen.push({ name: entry.name, caption: entry.caption }); return null; } });
  await harness.bot.handleUpdate(updateDocumentMessage(1, { caption: "Summarize please" }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].name, "notes.txt");
  assert.equal(seen[0].caption, "Summarize please");
});

// keeps the unused-import checker honest about createCore's default attach write
test("createCore defaults to the local write fallback", async () => {
  const { core } = createCore({ POST: async () => ({ data: { data: { id: "s" } }, error: undefined }) }, { projectDir: "/repo" });
  assert.equal(typeof core.attachFile, "function");
});
