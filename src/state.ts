import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import type { components } from "./api";

type ModelRef = components["schemas"]["Model.Ref"];

export interface ChatState {
  sessionID?: string;
  projectDir: string;
  agent?: string;
  model?: ModelRef;
}

export class State {
  private path: string;
  private data: Record<string, ChatState> = {};

  constructor(path = `${homedir()}/.config/opencode-tg/state.json`) {
    this.path = path;
    if (existsSync(path)) {
      try {
        this.data = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        this.data = {};
      }
    }
  }

  get(chatId: number, fallbackProject: string): ChatState {
    return this.data[String(chatId)] ?? { projectDir: fallbackProject };
  }

  set(chatId: number, s: ChatState) {
    this.data[String(chatId)] = s;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }
}
