import createClient from "openapi-fetch";
import type { paths } from "./api";

export interface OpenCodeConfig {
  url: string;
  user: string;
  password: string;
}

export async function writeProjectFile(
  cfg: { url: string; user: string; password: string },
  directory: string,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const url = `${cfg.url}/api/experimental/fs/write?location[directory]=${encodeURIComponent(directory)}&path=${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${cfg.user}:${cfg.password}`).toString("base64"),
      "Content-Type": "application/octet-stream",
    },
    body: Buffer.from(bytes),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`fs write failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

export function makeClient(cfg: OpenCodeConfig) {
  const client = createClient<paths>({
    baseUrl: cfg.url,
    headers: {
      Authorization: "Basic " + Buffer.from(`${cfg.user}:${cfg.password}`).toString("base64"),
    },
  });
  return client;
}

export type Client = ReturnType<typeof makeClient>;
