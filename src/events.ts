// Minimal SSE subscriber for the OpenCode event stream with reconnect.
import { EventSource } from "eventsource";

export interface OcEvent {
  id?: string;
  type: string;
  data?: any;
  location?: { directory?: string };
}

export type Handler = (e: OcEvent) => void;

export class EventBus {
  private handlers: Handler[] = [];
  private es?: EventSource;
  private stopped = false;
  private backoff = 1000;
  on: (h: Handler) => void;
  emit: (e: OcEvent) => void;

  constructor(private url: string, private authHeader: string) {
    this.on = (h) => this.handlers.push(h);
    this.emit = (e) => {
      for (const h of this.handlers) {
        try {
          h(e);
        } catch (err) {
          console.error("event handler error", err);
        }
      }
    };
  }

  start() {
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.es?.close();
  }

  private connect() {
    if (this.stopped) return;
    this.es = new EventSource(this.url, {
      fetch: (input, init) =>
        fetch(input, { ...init, headers: { ...init?.headers, Authorization: this.authHeader } }),
    } as any);
    this.es.onmessage = (msg) => {
      this.backoff = 1000;
      try {
        const parsed = JSON.parse(msg.data);
        this.emit(parsed);
      } catch {
        // heartbeat / non-json
      }
    };
    this.es.onerror = () => {
      console.error(`event stream error, reconnecting in ${this.backoff}ms`);
      this.es?.close();
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 30000);
    };
  }
}
