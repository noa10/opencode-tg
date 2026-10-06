import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Core, type CoreHandlers } from "../src/core";
import type { Client } from "../src/opencode";
import type { EventBus, OcEvent } from "../src/events";
import { createCore, createHarness, updateDocumentMessage, USER_ID } from "./harness";

function coreWithEvents(client: Partial<Client>, state: Parameters<typeof createCore>[1], handlers?: CoreHandlers, attachWrite?: Parameters<typeof createCore>[2]) {
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

test("an uploaded document is written to the project dir and referenced in the prompt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-tg-attach-"));
  const prompts: string[] = [];
  let onComplete: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => { onComplete = resolve; });
  const outputs: string[] = [];
  const handlers: CoreHandlers = {
    onPermission: () => {},
    onProgress: () => {},
    onDone: (_c, text) => { outputs.push(text); onComplete?.(); },
    onError: (_c, text) => { outputs.push(text); onComplete?.(); },
  };
  const client = {
    GET: async (path: string) => {
      if (path === "/api/session/{sessionID}/message") {
        return { data: { data: [{ type: "assistant", content: [{ type: "text", text: "done" }] }] }, error: undefined };
      }
      return { data: { data: { id: "session-1", location: { directory } } }, error: undefined };
    },
    POST: async (path: string, options?: { body?: unknown }) => {
      if (path === "/api/session/{sessionID}/prompt") {
        prompts.push(String((options?.body as { text: string }).text));
      }
      return { data: { data: true }, error: undefined, response: new Response(null, { status: 200 }) };
    },
  } as unknown as Partial<Client>;

  try {
    const { core, emit } = coreWithEvents(client, { sessionID: "session-1", projectDir: directory }, handlers);
    const result = core.attachFile(USER_ID, { name: "notes.txt", caption: "Summarize this.", bytes: new Uint8Array([104, 105]) });
    // wait for the prompt POST to have been issued
    await new Promise((resolve) => setTimeout(resolve, 20));
    emit({ type: "session.execution.succeeded", data: { sessionID: "session-1" } } as OcEvent);
    assert.equal(await result, null);
    await completed;
    const written = readFileSync(join(directory, "notes.txt"));
    assert.deepEqual([...written], [104, 105]);
    assert.match(prompts.join("\n"), /Summarize this\./);
    assert.match(prompts.join("\n"), /\(File attached: \.\/notes\.txt\)/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an empty caption falls back to a review prompt", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-tg-attach-"));
  const prompts: string[] = [];
  let onComplete: (() => void) | undefined;
  const completed = new Promise<void>((resolve) => { onComplete = resolve; });
  const handlers: CoreHandlers = {
    onPermission: () => {}, onProgress: () => {},
    onDone: () => onComplete?.(), onError: (_c, t) => { console.error(t); onComplete?.(); },
  };
  const client = {
    GET: async () => ({ data: { data: [{ type: "assistant", content: [{ type: "text", text: "done" }] }] }, error: undefined }),
    POST: async (path: string, options?: { body?: unknown }) => {
      if (path.includes("/prompt")) prompts.push(String((options?.body as { text: string }).text));
      return { data: { data: true }, error: undefined, response: new Response(null, { status: 200 }) };
    },
  } as unknown as Partial<Client>;
  try {
    const { core, emit } = coreWithEvents(client, { sessionID: "session-1", projectDir: directory }, handlers);
    const result = core.attachFile(USER_ID, { name: "a.bin", caption: "   ", bytes: new Uint8Array([1]) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    emit({ type: "session.execution.succeeded", data: { sessionID: "session-1" } } as OcEvent);
    assert.equal(await result, null);
    await completed;
    assert.match(prompts.join("\n"), /Please review this file\./);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an attachment while busy is queued instead of writing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "opencode-tg-attach-"));
  const writes: Array<[string, string]> = [];
  const handlers: CoreHandlers = { onPermission: () => {}, onProgress: () => {}, onDone: () => {}, onError: () => {} };
  let releasePost: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { releasePost = resolve; });
  const client = {
    GET: async () => ({ data: { data: { id: "s1", location: { directory } } }, error: undefined }),
    POST: async (path: string) => {
      if (path.includes("/prompt")) await gate;
      return { data: { data: true }, error: undefined };
    },
  } as unknown as Partial<Client>;
  const { core, emit } = coreWithEvents(client, { sessionID: "s1", projectDir: tmpdir() }, handlers, async (dir, name) => { writes.push([dir, name]); });
  try {
    const first = core.sendPrompt(USER_ID, "first");
    await new Promise((r) => setTimeout(r, 20));
    const queued = await core.attachFile(USER_ID, { name: "late.txt", caption: "later", bytes: new Uint8Array([9]) });
    assert.equal(queued, "queued");
    assert.equal(writes.length, 0, "attachment must not be written while busy");
    releasePost?.();
    await new Promise((r) => setTimeout(r, 20));
    emit?.({ type: "session.execution.succeeded", data: { sessionID: "s1" } } as never);
    await first;
  } finally {
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