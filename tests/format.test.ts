import assert from "node:assert/strict";
import { test } from "node:test";
import { redact } from "../src/format";

test("redact masks token formats the progress path can plausibly see", () => {
  for (const secret of [
    "sk-abcdefghij1234567890", // OpenAI-style
    "1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw", // Telegram bot token
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c", // JWT
    "AKIAIOSFODNN7EXAMPLE", // AWS access key
    "FOO_API_KEY=abcd1234", // env-style assignment
    "--password hunter2", // flag-style secret
    "DB_PASSWORD='s3cr3t-value'", // quoted env-style assignment
  ]) {
    assert.match(redact(secret), /\[redacted\]/, `should mask ${secret}`);
  }
});

test("redact masks secret values in URL query strings while keeping the URL shape", () => {
  const out = redact("curl https://api.example.com/data?token=supersecret123&limit=10");
  assert.match(out, /\[redacted\]/);
  assert.doesNotMatch(out, /supersecret123/);
  assert.match(out, /token=/);
  assert.match(out, /&limit=10/);
});

test("redact leaves benign text untouched", () => {
  assert.equal(redact("no secrets here, just a normal command"), "no secrets here, just a normal command");
});
