import assert from "node:assert/strict";
import { test } from "node:test";
import type { Core } from "../src/core";
import { callbackDataFor, captureConsoleErrors, createHarness, updateCallback, updateMessage } from "./harness";

test("an OpenCode command argument prompt does not consume /interrupt", async () => {
  let interrupts = 0;
  const harness = await createHarness();
  const core = harness.core as unknown as { interrupt(chatId: number): Promise<boolean> };
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
  harness.handlers()?.onPermission(71, { id: "request-1", sessionID: "session-1", action: "write", resources: ["/repo/file"] });
  const key = callbackDataFor(harness.calls, "Allow once");
  await harness.bot.handleUpdate(updateCallback(key, 1, 72));
  assert.equal(decisions, 0, "the forwarded callback must not approve the original chat's request");
});

test("Telegram command-menu registration failure does not prevent bot startup", async () => {
  const captured = await captureConsoleErrors(async () => {
    const harness = await createHarness({ failSetMyCommands: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    return harness;
  });
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
  first.handlers()?.onPermission(71, { id: "request-1", sessionID: "session-1", action: "write", resources: [] });
  second.handlers()?.onPermission(71, { id: "request-2", sessionID: "session-2", action: "write", resources: [] });
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

test("an ambiguous /project argument is rejected instead of picking the first match", async () => {
  const harness = await createHarness();
  await harness.bot.handleUpdate(updateMessage("/project repo", 1));
  const replies = harness.calls.filter((call) => call.method === "sendMessage");
  assert.match(String(replies.at(-1)?.payload.text), /Ambiguous/);
});

test("an unknown slash command is not forwarded to the agent", async () => {
  const prompted: string[] = [];
  const harness = await createHarness({ sendPrompt: async (_chatId, text) => { prompted.push(text); return null; } });
  await harness.bot.handleUpdate(updateMessage("/modle gpt", 1));
  const replies = harness.calls.filter((call) => call.method === "sendMessage");
  assert.match(String(replies.at(-1)?.payload.text), /Unknown command/);
  assert.deepEqual(prompted, [], "the misspelled command must not become a prompt");
});
