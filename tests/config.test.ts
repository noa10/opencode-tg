import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config";

function withEnv(envText: string, run: () => void) {
  const directory = mkdtempSync(join(tmpdir(), "opencode-tg-config-"));
  const envPath = join(directory, "env");
  const serviceFile = join(directory, "service.json");
  const previousEnvPath = process.env.TG_ENV;
  try {
    writeFileSync(envPath, envText);
    writeFileSync(serviceFile, JSON.stringify({ password: "secret" }));
    process.env.TG_ENV = envPath;
    run();
  } finally {
    if (previousEnvPath === undefined) delete process.env.TG_ENV;
    else process.env.TG_ENV = previousEnvPath;
    rmSync(directory, { recursive: true, force: true });
  }
}

test("configuration requires an explicit project allowlist", () => {
  withEnv("TG_BOT_TOKEN=test-token\n", () => {
    assert.throws(loadConfig, /PROJECT_ALLOWLIST is required/);
  });
});

test("configuration requires TG_BOT_TOKEN", () => {
  withEnv("PROJECT_ALLOWLIST=/repo\n", () => {
    assert.throws(loadConfig, /TG_BOT_TOKEN is required/);
  });
});

test("configuration rejects an empty TG_ALLOWED_IDS", () => {
  withEnv("TG_BOT_TOKEN=token\nPROJECT_ALLOWLIST=/repo\nTG_ALLOWED_IDS=\n", () => {
    assert.throws(loadConfig, /TG_ALLOWED_IDS/);
  });
});

test("configuration normalizes allowlist paths", () => {
  withEnv("TG_BOT_TOKEN=token\nTG_ALLOWED_IDS=1\nPROJECT_ALLOWLIST=/repo/, /repo//sub\n", () => {
    const config = loadConfig();
    assert.deepEqual(config.projectAllowlist, ["/repo", "/repo/sub"]);
  });
});
