type SecretPattern = { re: RegExp; replacement?: string };

/**
 * Ordered specific-first; the generic base64 catch-all stays last because
 * `redact()` deliberately skips it. Patterns that should keep their surroundings
 * (key names, URL shape) capture them and use `$1[redacted]`.
 */
const SECRET_PATTERNS: SecretPattern[] = [
  { re: /sk-[A-Za-z0-9_-]{10,}/g },
  { re: /ghp_[A-Za-z0-9]{20,}/g },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { re: /AIza[0-9A-Za-z_-]{20,}/g },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // Telegram bot tokens ("<bot id>:<url-safe secret>") — this bridge holds one
  { re: /\b[0-9]{6,12}:[A-Za-z0-9_-]{30,}\b/g },
  // Bearer/Authorization header values and JWTs
  { re: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, replacement: "$1[redacted]" },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g },
  // AWS access keys
  { re: /\bA[SK]IA[0-9A-Z]{16}\b/g },
  // credentials in a connection URL's userinfo ("postgres://user:pass@host")
  { re: /(\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:)[^@\s/]+@/g, replacement: "$1[redacted]@" },
  // Slack incoming webhooks
  { re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]+/g, replacement: "https://hooks.slack.com/services/[redacted]" },
  // secrets in URL query strings — keep the parameter name and the rest of the URL
  { re: /([?&](?:token|api[_-]?key|apikey|access[_-]?(?:key|token)|sig(?:nature)?|secret|password|credential|client[_-]?secret)=)[^&\s'"]+/gi, replacement: "$1[redacted]" },
  // KEY=value-style assignments in tool commands — keep the key, mask the value.
  // The lookahead avoids a second pass over already-redacted values and leaves
  // "Authorization: Bearer …" to the bearer pattern above (which masks the token).
  { re: /(["']?\b[A-Za-z0-9_]*(?:api[_-]?key|apikey|token|secret|password|passwd|pwd|credential|authorization)[A-Za-z0-9_]*["']?\s*[=:]\s*["']?)(?!\[redacted\]|(?:Bearer|Basic)\b)[^\s"',;&}]{4,}/gi, replacement: "$1[redacted]" },
  // --password-style flags, including suffixed names like --db-password
  { re: /(--[A-Za-z0-9-]*(?:password|passwd|token|secret|api[-_]?key|apikey|credential)[A-Za-z0-9-]*\s+)(\S+)/gi, replacement: "$1[redacted]" },
  // HTTP basic-auth flags: curl -u user:pass / --user user:pass
  { re: /((?:-u|--user)\s+[^\s:@]+:)(\S{4,})/gi, replacement: "$1[redacted]" },
  { re: /[A-Za-z0-9+/]{40,}={0,2}/g }, // generic long base64-ish blobs, last-resort, noisy — used sparingly below
];

export function redact(text: string): string {
  let out = text;
  for (let i = 0; i < SECRET_PATTERNS.length - 1; i++) {
    const pattern = SECRET_PATTERNS[i];
    out = out.replace(pattern.re, pattern.replacement ?? "[redacted]");
  }
  return out;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Very small markdown-ish subset -> HTML: fenced code blocks and inline code.
export function toTelegramHtml(md: string): string {
  const parts: string[] = [];
  const fence = /```(?:[a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(md))) {
    parts.push(renderInline(md.slice(last, m.index)));
    parts.push(`<pre><code>${escapeHtml(m[1])}</code></pre>`);
    last = m.index + m[0].length;
  }
  parts.push(renderInline(md.slice(last)));
  return parts.join("");
}

function renderInline(s: string): string {
  return escapeHtml(s).replace(/`([^`]+)`/g, "<code>$1</code>");
}

export function chunk(text: string, max = 3900): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let idx = rest.lastIndexOf("\n\n", max);
    if (idx < max / 2) idx = rest.lastIndexOf("\n", max);
    if (idx < max / 2) idx = max;
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx).replace(/^\n+/, "");
  }
  if (rest) out.push(rest);
  return out;
}
