import { readFileSync } from "node:fs";

export interface Config {
  tgToken: string;
  allowedIds: Set<number>;
  opencodeUrl: string;
  opencodeUser: string;
  opencodePassword: string;
  projectAllowlist: string[];
  defaultProject: string;
}

export function loadConfig(): Config {
  const envPath = process.env.TG_ENV ?? "/home/ubuntu/.config/opencode-tg/env";
  const raw = readFileSync(envPath, "utf8");
  const env: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2];
  }
  const sw = JSON.parse(readFileSync("/home/ubuntu/.config/opencode/service.json", "utf8"));
  const allowlist = (env.PROJECT_ALLOWLIST ?? "/home/ubuntu").split(",").map((s) => s.trim());
  return {
    tgToken: env.TG_BOT_TOKEN,
    allowedIds: new Set((env.TG_ALLOWED_IDS ?? "").split(",").map((s) => Number(s.trim())).filter(Number.isFinite)),
    opencodeUrl: env.OPENCODE_URL ?? "http://127.0.0.1:49374",
    opencodeUser: env.OPENCODE_USER ?? "opencode",
    opencodePassword: sw.password,
    projectAllowlist: allowlist,
    defaultProject: allowlist[0],
  };
}
