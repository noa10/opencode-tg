import createClient from "openapi-fetch";
import type { paths } from "./api";

export interface OpenCodeConfig {
  url: string;
  user: string;
  password: string;
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
