import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** Expand a leading ~, absolutize, and resolve symlinks when the path exists. */
export function normalizePath(value: string): string {
  const expanded = value.startsWith("~/") || value === "~" ? resolve(homedir(), value.slice(2)) : value;
  const absolute = resolve(expanded);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export interface Config {
  tgToken: string;
  allowedIds: Set<number>;
  opencodeUrl: string;
  opencodeUser: string;
  opencodePassword: string;
  projectAllowlist: string[];
  defaultProject: string;
  statePath: string;
  modelPolicy: "auto-free" | "server";
}

export function readEnvFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (match?.[1] && match[2] !== undefined) env[match[1]] = match[2];
  }
  return env;
}

export function readServicePassword(path: string): string {
  const serviceConfig: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof serviceConfig !== "object" || serviceConfig === null || !("password" in serviceConfig) || typeof serviceConfig.password !== "string") {
    throw new Error(`OpenCode service config at ${path} must contain a string password`);
  }
  return serviceConfig.password;
}

export function loadConfig(): Config {
  const envPath = process.env.TG_ENV ?? resolve(homedir(), ".config/opencode-tg/env");
  const env = readEnvFile(envPath);
  const servicePath = normalizePath(env.OPENCODE_SERVICE_FILE ?? resolve(homedir(), ".config/opencode/service.json"));
  const projectDirs = env.PROJECT_ALLOWLIST;
  if (!projectDirs) throw new Error("PROJECT_ALLOWLIST is required and must contain at least one directory");
  const allowlist = projectDirs.split(",").map((s) => s.trim()).filter(Boolean).map(normalizePath);
  if (allowlist.length === 0) throw new Error("PROJECT_ALLOWLIST must contain at least one directory");
  const tgToken = env.TG_BOT_TOKEN;
  if (!tgToken) throw new Error("TG_BOT_TOKEN is required");
  const allowedRaw = (env.TG_ALLOWED_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (allowedRaw.length === 0) throw new Error("TG_ALLOWED_IDS is required and must list at least one numeric Telegram user ID");
  const allowedIds = new Set(allowedRaw.map((s) => Number(s)).filter(Number.isFinite));
  if (allowedIds.size === 0) throw new Error("TG_ALLOWED_IDS must contain at least one numeric Telegram user ID");
  return {
    tgToken,
    allowedIds,
    opencodeUrl: env.OPENCODE_URL ?? "http://127.0.0.1:49374",
    opencodeUser: env.OPENCODE_USER ?? "opencode",
    opencodePassword: readServicePassword(servicePath),
    projectAllowlist: allowlist,
    defaultProject: allowlist[0],
    statePath: normalizePath(env.TG_STATE ?? resolve(homedir(), ".config/opencode-tg/state.json")),
    modelPolicy: env.MODEL_POLICY === "server" ? "server" : "auto-free",
  };
}
