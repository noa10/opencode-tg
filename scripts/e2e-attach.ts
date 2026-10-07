// Live end-to-end check of the attachment path against the running OpenCode service.
// Exercises the real client, the real SSE event stream, the server-side file write and a
// real agent turn. Only the Telegram download is stubbed (it is a fixed HTTPS GET).
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { makeClient } from "../src/opencode";
import { EventBus } from "../src/events";
import { Core, type CoreHandlers } from "../src/core";
import type { ChatState } from "../src/state";

const CHAT_ID = 999_000_1;

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

  const projectDir = mkdtempSync(join(tmpdir(), "opencode-tg-e2e-"));
  console.log("project dir:", projectDir);

  let state: ChatState = { projectDir };
  const seen: string[] = [];
  const handlers: CoreHandlers = {
    onPermission: (_c, req) => console.log("permission requested:", req.action),
    onProgress: (_c, text) => console.log("progress:", text),
    onDone: (_c, text) => { seen.push(text); console.log("agent replied:", text.slice(0, 400)); },
    onError: (_c, text) => { seen.push(text); console.log("ERROR:", text); },
  };
  const core = new Core(
    client,
    events,
    () => state,
    (_chatId, next) => { state = next; },
    handlers,
    (directory, name, bytes) => {
      // exactly what index.ts wires in production
      return import("../src/opencode").then(({ writeProjectFile }) =>
        writeProjectFile(
          { url: config.opencodeUrl, user: config.opencodeUser, password: config.opencodePassword },
          directory,
          name,
          bytes,
        ),
      );
    },
  );
  core.attach();
  events.start();
  await new Promise((r) => setTimeout(r, 1500)); // let the SSE stream connect

  // --- 1. attachment with a caption -------------------------------------------
  const body = `MAGIC_TOKEN_${Date.now()}\nThe capital of France is Lyon.\n`;
  const bytes = new Uint8Array(Buffer.from(body, "utf8"));
  console.log("\n== case 1: document with caption ==");
  const done = core.attachFile(CHAT_ID, { name: "e2e-notes.txt", mime: "text/plain", caption: "Read e2e-notes.txt and reply with only the value of MAGIC_TOKEN and the stated capital, separated by a comma.", bytes });
  console.log("attachFile returned:", await done);

  // --- 2. same file again -> collision-safe name ------------------------------
  console.log("\n== case 2: colliding filename ==");
  const second = core.attachFile(CHAT_ID, { name: "e2e-notes.txt", mime: "text/plain", caption: "Reply with only: second", bytes });
  console.log("attachFile returned:", await second);

  // --- 3. empty caption fallback ----------------------------------------------
  console.log("\n== case 3: empty caption ==");
  const third = core.attachFile(CHAT_ID, { name: "e2e-empty.txt", bytes: new Uint8Array(Buffer.from("hello", "utf8")) });
  console.log("attachFile returned:", await third);

  // --- 4. all-dots filename ---------------------------------------------------
  console.log("\n== case 4: all-dots filename ==");
  const fourth = core.attachFile(CHAT_ID, { name: "..", bytes: new Uint8Array(Buffer.from("nope", "utf8")), caption: "Reply with only: dots" });
  console.log("attachFile returned:", await fourth);

  await new Promise((r) => setTimeout(r, 2000));

  console.log("\n== files on disk ==");
  const { readdirSync } = await import("node:fs");
  const listing = readdirSync(projectDir);
  console.log(listing.join("\n"));

  const checks: Array<[string, boolean]> = [
    ["e2e-notes.txt written", existsSync(join(projectDir, "e2e-notes.txt"))],
    ["file content matches", readFileSync(join(projectDir, "e2e-notes.txt"), "utf8") === body],
    ["collision produced a second distinct name", listing.filter((n) => n.includes("e2e-notes.txt")).length === 2],
    ["empty-caption file written", existsSync(join(projectDir, "e2e-empty.txt"))],
    ["all-dots became attachment", existsSync(join(projectDir, "attachment"))],
    ["agent turns completed", seen.length >= 4],
  ];
  console.log("\n== checks ==");
  for (const [name, ok] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);

  // clean up the throwaway session and directory
  const sessionID = core.sessionChat.size ? undefined : undefined;
  const listed = await client.GET("/api/session", { params: { query: { directory: projectDir, limit: "10" } } });
  const sessions = (listed.data as any)?.data ?? [];
  for (const s of sessions) {
    await client.DELETE("/api/session/{sessionID}" as any, { params: { path: { sessionID: s.id } } } as any);
  }
  events.stop();
  rmSync(projectDir, { recursive: true, force: true });
  const failed = checks.filter(([, ok]) => !ok);
  console.log(`\n${failed.length === 0 ? "E2E OK" : `E2E FAILURES: ${failed.length}`}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });