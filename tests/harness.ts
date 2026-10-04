import assert from "node:assert/strict";
import { Core, type CoreHandlers } from "../src/core";
import { makeBot } from "../src/bot";
import type { Config } from "../src/config";
import type { Client } from "../src/opencode";
import type { EventBus } from "../src/events";
import type { ChatState } from "../src/state";

export type TelegramCall = { readonly method: string; readonly payload: Record<string, unknown> };
export type HarnessOptions = {
  readonly editNotModified?: boolean;
  readonly failSetMyCommands?: boolean;
  readonly listAgents?: () => Promise<unknown[]>;
  readonly runCommand?: (...args: [number, string, string]) => Promise<"completed" | "busy" | "failed">;
  readonly sendPrompt?: (chatId: number, text: string) => Promise<string | null>;
};

export const USER_ID = 71;
export const OTHER_USER_ID = 72;
export const config: Config = {
  tgToken: "test-token",
  allowedIds: new Set([USER_ID, OTHER_USER_ID]),
  opencodeUrl: "http://127.0.0.1:49374",
  opencodeUser: "opencode",
  opencodePassword: "test-password",
  projectAllowlist: ["/repo", "/other/repo"],
  defaultProject: "/repo",
  statePath: "/tmp/opencode-tg-test-state.json",
};

export function updateMessage(text: string, updateID: number, userID = USER_ID) {
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

export function updateCallback(data: string, updateID: number, chatID = USER_ID, userID = chatID) {
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

export async function createHarness(options: HarnessOptions = {}) {
  const calls: TelegramCall[] = [];
  let handlers: CoreHandlers | undefined;
  const telegramFetch: typeof fetch = async (input, init) => {
    const requestUrl = input instanceof Request ? input.url : String(input);
    const method = new URL(requestUrl).pathname.split("/").at(-1) ?? "";
    const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ method, payload });
    if (method === "setMyCommands" && options.failSetMyCommands) {
      return Response.json({ ok: false, error_code: 500, description: "Telegram unavailable" });
    }
    if (method === "editMessageText" && options.editNotModified) {
      return Response.json({
        ok: false,
        error_code: 400,
        description:
          "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      });
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

export function callbackDataFor(calls: TelegramCall[], buttonText: string): string {
  const sent = calls.filter((call) => call.method === "sendMessage").at(-1);
  assert.ok(sent, "menu message should be sent");
  const markup = sent.payload.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  const button = markup.inline_keyboard.flat().find((item) => item.text === buttonText);
  assert.ok(button, `button ${buttonText} should exist`);
  return button.callback_data;
}

export async function captureConsoleErrors<T>(run: () => Promise<T>): Promise<{ readonly result: T; readonly messages: readonly string[] }> {
  const messages: string[] = [];
  const original = console.error;
  console.error = (...values: Parameters<typeof console.error>) => messages.push(values.map(String).join(" "));
  try {
    return { result: await run(), messages };
  } finally {
    console.error = original;
  }
}

export function createCore(client: Partial<Client>, initialState: ChatState) {
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
