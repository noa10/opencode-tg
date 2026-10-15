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

test("redact masks credentials in connection URLs, basic auth, suffixed flags and Slack webhooks", () => {
  for (const secret of [
    "psql --db-password hunter2 -h localhost", // suffixed flag name
    "DATABASE_URL=postgres://appuser:s3cr3t@db.internal:5432/prod", // URL userinfo
    "curl -u admin:hunter2 http://internal", // basic auth flag
    // assembled at runtime so the fixture itself never looks like a live webhook token
    ["https://hooks.slack.com/services", "T00000000", "B00000000", "XXXXXXXXXXXXXXXXXXXXXXXX"].join("/"),
  ]) {
    assert.match(redact(secret), /\[redacted\]/, `should mask ${secret}`);
  }
});

test("redact masks Basic auth headers and does not double-mask Bearer/Basic values", () => {
  const bearer = "Authorization: Bearer supersecrettoken123";
  assert.equal(redact(bearer), "Authorization: Bearer [redacted]");
  assert.equal(redact(redact(bearer)), redact(bearer), "a second redact pass must not change the output");
  const basic = 'curl -H "Authorization: Basic YWRtaW46aHVudGVyMg==" https://api.example.com';
  assert.doesNotMatch(redact(basic), /YWRtaW46aHVudGVyMg/);
  assert.equal(redact("Authorization: Basic YWRtaW46aHVudGVyMg=="), "Authorization: Basic [redacted]");
});

test("redact leaves flags that merely contain a keyword untouched", () => {
  for (const command of ["run --tokenizer fast", "pass --secret-scanner", "check --token-limit 10"]) {
    assert.equal(redact(command), command, `${command} should not be masked`);
  }
});

test("redact leaves benign text untouched", () => {
  assert.equal(redact("no secrets here, just a normal command"), "no secrets here, just a normal command");
});
