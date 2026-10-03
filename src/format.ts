const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{10,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /[A-Za-z0-9+/]{40,}={0,2}/g, // generic long base64-ish blobs, last-resort, noisy — used sparingly below
];

export function redact(text: string): string {
  let out = text;
  for (let i = 0; i < SECRET_PATTERNS.length - 1; i++) {
    out = out.replace(SECRET_PATTERNS[i], "[redacted]");
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
