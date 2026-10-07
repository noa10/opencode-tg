// Live check that a real image attachment reaches the model as an image: builds a solid-colour
// PNG, sends it through the attachment path and asks the agent which colour it sees. This is the
// only verification of the vision path -- text attachments prove nothing about image input.
import { deflateSync } from "node:zlib";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { makeClient, writeProjectFile } from "../src/opencode";
import { EventBus } from "../src/events";
import { FreeModelSelector } from "../src/models";
import { Core, type CoreHandlers } from "../src/core";
import type { ChatState } from "../src/state";

const CHAT_ID = 999_000_2;

function crc32(buf: Buffer): number {
  let c: number;
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

/** Solid-colour 8-bit RGB PNG. */
function solidPng(width: number, height: number, rgb: [number, number, number]): Uint8Array {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = rowStart + 1 + x * 3;
      raw[p] = rgb[0];
      raw[p + 1] = rgb[1];
      raw[p + 2] = rgb[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function main() {
  const config = loadConfig();
  const projectDir = mkdtempSync(join(tmpdir(), "opencode-tg-vision-"));
  const client = makeClient({ url: config.opencodeUrl, user: config.opencodeUser, password: config.opencodePassword });
  const events = new EventBus(
    `${config.opencodeUrl}/api/event`,
    "Basic " + Buffer.from(`${config.opencodeUser}:${config.opencodePassword}`).toString("base64"),
  );
  let state: ChatState = { projectDir };
  const outputs: string[] = [];
  const handlers: CoreHandlers = {
    onPermission: () => {},
    onProgress: () => {},
    onDone: (_c, text) => { outputs.push(text); console.log("agent:", text.slice(0, 300)); },
    onError: (_c, text) => { outputs.push(text); console.log("error:", text.slice(0, 300)); },
  };
  const core = new Core(
    client,
    events,
    () => state,
    (_c, s) => { state = s; },
    handlers,
    (directory, name, bytes) => writeProjectFile({ url: config.opencodeUrl, user: config.opencodeUser, password: config.opencodePassword }, directory, name, bytes),
    new FreeModelSelector(client, undefined, [config.defaultProject]),
    config.modelPolicy,
  );
  core.attach();
  events.start();
  await new Promise((r) => setTimeout(r, 1500));

  const png = solidPng(64, 64, [255, 0, 0]);
  console.log(`sending a ${png.length} byte solid-red PNG as red-block.png`);
  const done = core.attachFile(CHAT_ID, {
    name: "red-block.png",
    mime: "image/png",
    caption: "Look at red-block.png. What is the dominant colour of that image? Reply with one word only.",
    bytes: png,
  });
  await done;
  for (let i = 0; i < 90 && outputs.length === 0; i++) await new Promise((r) => setTimeout(r, 1000));

  const reply = outputs.join("\n");
  console.log("\nmodel used:", JSON.stringify(state.model));
  const providerBlocked = /Insufficient account funds|quota|Unauthorized/.test(reply);
  const checks: Array<[string, boolean | undefined]> = [
    ["image saved to the project", existsSync(join(projectDir, "red-block.png"))],
    ["agent answered about the image", /red/i.test(reply)],
    ["agent did not guess from the filename", !/cannot|can't (read|view|open)/i.test(reply)],
    ["no provider error", !providerBlocked],
  ];
  console.log("\n== checks ==");
  for (const [name, ok] of checks) {
    if (ok === undefined) continue;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  }

  const listed = await client.GET("/api/session", { params: { query: { directory: projectDir, limit: "10" } } });
  for (const s of ((listed.data as any)?.data ?? [])) {
    await client.DELETE("/api/session/{sessionID}" as any, { params: { path: { sessionID: s.id } } } as any);
  }
  events.stop();
  rmSync(projectDir, { recursive: true, force: true });
  const hard = checks.filter(([, ok]) => ok === false && !providerBlocked);
  console.log(`\n${hard.length === 0 ? (providerBlocked ? "VISION CHECKS BLOCKED (provider error)" : "VISION OK") : `VISION FAILURES: ${hard.length}`}`);
  process.exit(hard.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });