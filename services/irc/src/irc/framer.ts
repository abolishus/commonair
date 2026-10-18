// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Line framing for byte streams (TCP/TLS) and message frames (WebSocket).
 * Lines end in LF, optionally preceded by CR. A line longer than `maxBytes` is
 * discarded whole (we never buffer more than `maxBytes` per connection) and
 * reported once via `onOverflow`.
 */

export const LF = 0x0a;
const CR = 0x0d;
const decoder = new TextDecoder("utf-8", { fatal: false });

export interface FramerSink {
  line(text: string): void;
  overflow(): void;
}

export class LineFramer {
  private buf: Uint8Array;
  private len = 0;
  private discarding = false;

  constructor(
    private readonly maxBytes: number,
    private readonly sink: FramerSink,
  ) {
    this.buf = new Uint8Array(Math.min(maxBytes, 4096));
  }

  push(chunk: Uint8Array): void {
    let start = 0;
    while (start < chunk.length) {
      const nl = chunk.indexOf(LF, start);
      const end = nl === -1 ? chunk.length : nl;
      if (this.discarding) {
        if (nl !== -1) this.discarding = false;
      } else if (this.len + (end - start) > this.maxBytes) {
        this.len = 0;
        this.sink.overflow();
        // The rest of an overlong line (if it is not complete yet) is dropped too.
        this.discarding = nl === -1;
      } else {
        this.append(chunk.subarray(start, end));
        if (nl !== -1) this.emit();
      }
      if (nl === -1) break;
      start = nl + 1;
    }
  }

  private append(part: Uint8Array): void {
    const need = this.len + part.length;
    if (need > this.buf.length) {
      const grown = new Uint8Array(Math.min(this.maxBytes, Math.max(need, this.buf.length * 2)));
      grown.set(this.buf.subarray(0, this.len));
      this.buf = grown;
    }
    this.buf.set(part, this.len);
    this.len = need;
  }

  private emit(): void {
    let end = this.len;
    if (end > 0 && this.buf[end - 1] === CR) end--;
    const text = decoder.decode(this.buf.subarray(0, end));
    this.len = 0;
    if (text.length > 0) this.sink.line(text);
  }
}

/** Split one WebSocket text frame into lines (clients may batch several, with or without a final CRLF). */
export function splitFrame(text: string, maxBytes: number, sink: FramerSink): void {
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.length === 0) continue;
    if (Buffer.byteLength(line, "utf8") > maxBytes) sink.overflow();
    else sink.line(line);
  }
}
