import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface Config {
  tgToken: string;
  allowedIds: Set<number>;
  opencodeUrl: string;
  opencodeUser: string;
  opencodePassword: string;
  projectAllowlist: string[];
  defaultProject: string;
  statePath: string;
}

export function loadConfig(): Config {
  const envPath = process.env.TG_ENV ?? resolve(homedir(), ".config/opencode-tg/env");
  const raw = readFileSync(envPath, "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  const servicePath = env.OPENCODE_SERVICE_FILE ?? resolve(homedir(), ".config/opencode/service.json");
  const serviceConfig: unknown = JSON.parse(readFileSync(servicePath, "utf8"));
  if (typeof serviceConfig !== "object" || serviceConfig === null || !("password" in serviceConfig) || typeof serviceConfig.password !== "string") {
    throw new Error(`OpenCode service config at ${servicePath} must contain a string password`);
  }
  const allowlist = (env.PROJECT_ALLOWLIST ?? homedir()).split(",").map((s) => s.trim()).filter(Boolean);
  if (allowlist.length === 0) throw new Error("PROJECT_ALLOWLIST must contain at least one directory");
  const tgToken = env.TG_BOT_TOKEN;
  if (!tgToken) throw new Error("TG_BOT_TOKEN is required");
  return {
    tgToken,
    allowedIds: new Set((env.TG_ALLOWED_IDS ?? "").split(",").map((s) => Number(s.trim())).filter(Number.isFinite)),
    opencodeUrl: env.OPENCODE_URL ?? "http://127.0.0.1:49374",
    opencodeUser: env.OPENCODE_USER ?? "opencode",
    opencodePassword: serviceConfig.password,
    projectAllowlist: allowlist,
    defaultProject: allowlist[0],
    statePath: env.TG_STATE ?? resolve(homedir(), ".config/opencode-tg/state.json"),
  };
}
