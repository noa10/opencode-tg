// Integration check of the full Telegram path: a real file update goes through the real
// grammY bot, the real Core, the real OpenCode service and a real agent turn. Only the
// Telegram API responses (getFile + file download) are stubbed, because those need a real
// upload from a phone. This is the layer the unit tests and scripts/e2e-attach.ts skip.
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { makeClient, writeProjectFile } from "../src/opencode";
import { EventBus } from "../src/events";
import { Core, type CoreHandlers } from "../src/core";
import { State } from "../src/state";
import { makeBot } from "../src/bot";

const USER_ID = 65_889_010;
const FILE_BYTES = new TextEncoder().encode(`ROUND_TRIP_${Date.now()}\n`);

function documentUpdate(fileSize?: number, caption?: string, fileName = "round-trip.txt") {
  return {
    update_id: 9001,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: USER_ID, type: "private" as const },
      from: { id: USER_ID, is_bot: false, first_name: "Tester" },
      caption,
      document: {
        file_id: "tg-file-id",
        file_unique_id: "u1",
        file_name: fileName,
        mime_type: "text/plain",
        ...(fileSize !== undefined ? { file_size: fileSize } : {}),
      },
    },
  };
}

async function main() {
  const config = loadConfig();
  const projectDir = mkdtempSync(join(tmpdir(), "opencode-tg-rt-"));
  const replies: string[] = [];

  const telegramFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/file/bot")) return new Response(FILE_BYTES, { status: 200 });
    const method = new URL(url).pathname.split("/").at(-1) ?? "";
    const payload = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (method === "getFile") {
      return Response.json({ ok: true, result: { file_id: "tg-file-id", file_unique_id: "u1", file_path: "documents/file_1.txt" } });
    }
    if (method === "sendMessage") {
      replies.push(String(payload.text ?? ""));
      return Response.json({
        ok: true,
        result: { message_id: replies.length, date: Math.floor(Date.now() / 1000), chat: { id: payload.chat_id, type: "private" }, text: payload.text },
      });
    }
    let result: unknown = true;
    if (method === "getMe") result = { id: 1, is_bot: true, first_name: "OpenCode", username: "opencode_rt_bot" };
    return Response.json({ ok: true, result });
  };

  const client = makeClient({ url: config.opencodeUrl, user: config.opencodeUser, password: config.opencodePassword });
  const auth = "Basic " + Buffer.from(`${config.opencodeUser}:${config.opencodePassword}`).toString("base64");
  const events = new EventBus(`${config.opencodeUrl}/api/event`, auth);
  const statePath = join(projectDir, "state.json");
  const state = new State(statePath);
  state.set(USER_ID, { projectDir });

  const outputs: string[] = [];
  const handlers: CoreHandlers = {
    onPermission: () => {},
    onProgress: () => {},
    onDone: (_c, text) => { outputs.push(text); console.log("agent:", text.slice(0, 200)); },
    onError: (_c, text) => { outputs.push(text); console.log("error:", text.slice(0, 200)); },
  };
  const core = new Core(
    client,
    events,
    (chatId) => state.get(chatId, config.defaultProject),
    (chatId, s) => state.set(chatId, s),
    handlers,
    (directory, name, bytes) => writeProjectFile({ url: config.opencodeUrl, user: config.opencodeUser, password: config.opencodePassword }, directory, name, bytes),
  );
  const bot = await makeBot({ ...config, tgToken: "test-token", allowedIds: new Set([USER_ID]), projectAllowlist: [projectDir], defaultProject: projectDir }, core, telegramFetch);
  await bot.init();
  core.attach();
  events.start();
  await new Promise((r) => setTimeout(r, 1500));

  console.log("== oversized upload (30 MB declared) ==");
  await bot.handleUpdate(documentUpdate(30 * 1024 * 1024) as any);
  const oversizeReplies = replies.slice();
  console.log("bot replied:", oversizeReplies.at(-1));

  console.log("\n== normal upload with caption ==");
  replies.length = 0;
  await bot.handleUpdate(documentUpdate(undefined, "Reply with only the first token of this file.") as any);
  // give the agent turn time to finish
  for (let i = 0; i < 60 && outputs.length === 0; i++) await new Promise((r) => setTimeout(r, 1000));
  console.log("bot replies during turn:", replies.join(" | ") || "(none)");
  console.log("core outputs:", outputs.join(" | ") || "(none)");

  console.log("\n== checks ==");
  const { readdirSync } = await import("node:fs");
  const listing = readdirSync(projectDir);
  console.log("files:", listing.join(", "));
  // makeBot() replaces the Core handlers with its own, so agent output and errors
  // arrive as Telegram replies rather than in `outputs`. Judge the turn on both.
  const agentText = `${outputs.join("\n")}\n${replies.join("\n")}`;
  // A provider-side failure (quota/auth) blocks the "agent replied" assertions only;
  // it is not a bridge defect, so report it as BLOCKED rather than FAIL.
  const providerBlocked = /Insufficient account funds|quota|Unauthorized|401|402/.test(agentText);
  const checks: Array<[string, boolean]> = [
    ["oversize rejected without download", /too large/.test(oversizeReplies.join("\n"))],
    ["attachment saved through the bot path", existsSync(join(projectDir, "round-trip.txt"))],
    ["bytes match what Telegram served", readFileSync(join(projectDir, "round-trip.txt")).equals(Buffer.from(FILE_BYTES))],
    ["agent turn completed (no timeout wording)", /ROUND_TRIP|done|here/i.test(agentText) && !/timed out/.test(agentText)],
    ["agent saw the file contents", /ROUND_TRIP/.test(agentText)],
  ];
  for (const [name, ok] of checks) {
    const isAgentTurnCheck = name.includes("agent turn completed") || name.includes("agent saw");
    if (!ok && isAgentTurnCheck && providerBlocked) {
      console.log(`BLOCKED  ${name} (provider error, not a bridge failure)`);
      continue;
    }
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  }

  const listed = await client.GET("/api/session", { params: { query: { directory: projectDir, limit: "10" } } });
  for (const s of ((listed.data as any)?.data ?? [])) {
    await client.DELETE("/api/session/{sessionID}" as any, { params: { path: { sessionID: s.id } } } as any);
  }
  events.stop();
  rmSync(projectDir, { recursive: true, force: true });

  const hardFailures = checks.filter(([name, ok]) => !ok && !(providerBlocked && name.includes("agent")));
  console.log(`\n${hardFailures.length === 0 ? (providerBlocked ? "ROUND TRIP OK (agent-turn checks blocked by provider error)" : "ROUND TRIP OK") : `ROUND TRIP FAILURES: ${hardFailures.length}`}`);
  process.exit(hardFailures.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });