// Step 0 smoke test: create a session, send a prompt, list messages.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { makeClient } from "../src/opencode";

function loadOpenCodeConfig(): { readonly url: string; readonly user: string; readonly password: string } {
  const envPath = process.env.TG_ENV ?? resolve(homedir(), ".config/opencode-tg/env");
  const env: Record<string, string> = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match?.[1] && match[2] !== undefined) env[match[1]] = match[2];
  }
  const servicePath = env.OPENCODE_SERVICE_FILE ?? resolve(homedir(), ".config/opencode/service.json");
  const serviceConfig: unknown = JSON.parse(readFileSync(servicePath, "utf8"));
  if (typeof serviceConfig !== "object" || serviceConfig === null || !("password" in serviceConfig) || typeof serviceConfig.password !== "string") {
    throw new Error(`OpenCode service config at ${servicePath} must contain a string password`);
  }
  return {
    url: env.OPENCODE_URL ?? "http://127.0.0.1:49374",
    user: env.OPENCODE_USER ?? "opencode",
    password: serviceConfig.password,
  };
}

async function main() {
  const config = loadOpenCodeConfig();
  const client = makeClient({
    url: config.url,
    user: config.user,
    password: config.password,
  });

  const info = await client.GET("/api/info");
  console.log("info:", JSON.stringify(info.data));
  if (info.error) {
    console.error("info error:", info.error);
    process.exit(1);
  }

  const created = await client.POST("/api/session", {
    body: { title: "smoke-test", location: { directory: process.cwd() } },
  });
  console.log("create:", JSON.stringify(created.data)?.slice(0, 200), created.error ?? "");
  if (!created.data) process.exit(1);
  const createdData = (created.data as any)?.data ?? created.data;
  const sessionID = createdData.id as string;

  const prompt = await client.POST("/api/session/{sessionID}/prompt", {
    params: { path: { sessionID } },
    body: { text: "Reply with exactly: ok" } as any,
  });
  console.log("prompt status:", prompt.response.status, prompt.error ?? "");

  // poll messages until idle-ish
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const msgs = await client.GET("/api/session/{sessionID}/message", {
      params: { path: { sessionID } },
    });
    const list = (msgs.data as any)?.data ?? msgs.data ?? [];
    const last = list[list.length - 1];
    if (last && (last.type === "assistant" || last.type === "message")) {
      console.log("last msg type:", last.type, "finish:", last.metadata?.finish ?? last.finish ?? "?");
      if (last.metadata?.finish || last.finish) {
        console.log("SMOKE OK, session", sessionID);
        return;
      }
    } else if (last) {
      console.log("waiting... last:", JSON.stringify(last).slice(0, 120));
    }
  }
  console.log("SMOKE DONE (no finish flag seen)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
