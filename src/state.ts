import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface ChatState {
  sessionID?: string;
  projectDir: string;
}

export class State {
  private path: string;
  private data: Record<string, ChatState> = {};

  constructor(path = "/home/ubuntu/.config/opencode-tg/state.json") {
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
