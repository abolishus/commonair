// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A server-sent-events client for the overlay alert stream (`OVERLAY_EVENTS_PATH?token=`): what
 * an OBS browser source's `EventSource` sees, without a browser. The URL carries the overlay
 * token, so it is never logged; errors name the stream, not the URL.
 */
import { waitFor } from "../wait.ts";

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** Incremental SSE parser (WHATWG "event stream interpretation"), fed arbitrary chunks. */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private id: string | undefined;

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const out: SseEvent[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buffer);
      if (!m) break;
      // A lone trailing "\r" may be the first half of "\r\n": wait for the next chunk.
      if (m[0] === "\r" && m.index === this.buffer.length - 1) break;
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  private line(line: string): SseEvent | null {
    if (line === "") {
      if (this.data.length === 0) {
        this.event = "";
        return null;
      }
      const ev: SseEvent = { event: this.event || "message", data: this.data.join("\n") };
      if (this.id !== undefined) ev.id = this.id;
      this.event = "";
      this.data = [];
      return ev;
    }
    if (line.startsWith(":")) return null;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    else if (field === "id" && !value.includes("\0")) this.id = value;
    return null;
  }
}

/** One open SSE connection, recording every event with the time it arrived. */
export class SseStream {
  readonly events: (SseEvent & { at: number })[] = [];
  status: number | null = null;
  closedAt: number | null = null;
  private readonly controller = new AbortController();
  private readonly done: Promise<void>;

  private constructor(
    readonly label: string,
    response: Response | null,
  ) {
    this.status = response?.status ?? null;
    if (response?.ok && response.body) this.done = this.read(response.body);
    else {
      void response?.body?.cancel().catch(() => undefined);
      this.markClosed();
      this.done = Promise.resolve();
    }
  }

  /** Open the stream; resolves once the response headers arrived (any status). */
  static async open(label: string, url: string, timeoutMs = 15_000): Promise<SseStream> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response | null = null;
    try {
      res = await fetch(url, { headers: { accept: "text/event-stream" }, signal: controller.signal });
    } catch {
      res = null;
    } finally {
      clearTimeout(timer);
    }
    // The connect timer is cleared, so it never cuts the body; `close()` cancels the reader.
    return new SseStream(label, res);
  }

  private markClosed(): void {
    this.closedAt ??= Date.now();
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = body.getReader();
    const onAbort = () => void reader.cancel().catch(() => undefined);
    this.controller.signal.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const now = Date.now();
        for (const ev of parser.push(decoder.decode(value, { stream: true }))) this.events.push({ ...ev, at: now });
      }
    } catch {
      // A reset connection is a close, like EventSource sees it.
    } finally {
      this.markClosed();
    }
  }

  get open(): boolean {
    return this.status === 200 && this.closedAt === null;
  }

  /** Events of one type, parsed as JSON where they are JSON. */
  ofType<T = unknown>(event: string): { data: T; at: number }[] {
    return this.events
      .filter((e) => e.event === event)
      .map((e) => {
        let data: unknown = e.data;
        try {
          data = JSON.parse(e.data);
        } catch {
          // not JSON: keep the text
        }
        return { data: data as T, at: e.at };
      });
  }

  async waitEvent<T = unknown>(
    event: string,
    match: (data: T) => boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ data: T; at: number }> {
    return waitFor(`${this.label}: "${event}" event`, () => this.ofType<T>(event).find((e) => match(e.data)) ?? null, {
      timeoutMs,
      intervalMs: 100,
      signal,
    });
  }

  /** Resolve with the close time once the server ended the stream. */
  async waitClosed(timeoutMs: number, signal?: AbortSignal): Promise<number> {
    return waitFor(`${this.label}: stream closed by the server`, () => this.closedAt, {
      timeoutMs,
      intervalMs: 100,
      signal,
    });
  }

  async close(): Promise<void> {
    this.controller.abort();
    await this.done.catch(() => undefined);
  }
}
