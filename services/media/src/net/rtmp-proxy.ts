// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Keeps simulcast stream keys out of ffmpeg's argv (readable by every local user via `ps` or
 * /proc/<pid>/cmdline). ffmpeg has no way to read an output URL or an RTMP protocol option
 * from a file (`-/opt` only covers ffmpeg's own options, `-fpre` values never reach the
 * protocol), so ffmpeg publishes to a loopback listener with a random placeholder of the same
 * length as the key, and this proxy:
 *
 * - resolves and vets the real target on every connection (SSRF check on the address actually
 *   dialled, so DNS rebinding cannot redirect it), and connects to it, with TLS for `rtmps:`;
 * - replaces the placeholder with the key in the client→server bytes of the RTMP command phase
 *   (`releaseStream`, `FCPublish`, `publish`). Equal lengths mean no RTMP length field changes.
 *   Only the window after the fixed-size handshake and before media starts is rewritten.
 */
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { Transform } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import type { Logger } from "@commonair/observability";
import { resolveTarget, TargetNotAllowedError, type ParsedTarget, type ResolveOptions } from "./ssrf.ts";

/** C0 + C1 + C2 of the RTMP handshake: random bytes, never rewritten. */
export const HANDSHAKE_BYTES = 1 + 1536 + 1536;
/** The command phase fits easily; media follows only after `NetStream.Publish.Start`. */
export const REWRITE_WINDOW_END = 64 * 1024;
/** How long a possible partial placeholder is held back waiting for its remainder. */
const HOLD_FLUSH_MS = 25;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A random alphanumeric string with the same byte length as `secret`. */
export function placeholderFor(secret: string): string {
  const len = Buffer.byteLength(secret, "utf8");
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/**
 * Streaming replace of `from` with `to` (same length) for bytes whose absolute offset lies in
 * [windowStart, windowEnd). Holds back at most `from.length - 1` bytes so a match split across
 * chunks is still found.
 */
export class KeyRewriter {
  private held: Buffer = Buffer.alloc(0);
  /** Absolute stream offset of `held[0]`. */
  private base = 0;
  private passthrough = false;

  constructor(
    private readonly from: Buffer,
    private readonly to: Buffer,
    private readonly windowStart = HANDSHAKE_BYTES,
    private readonly windowEnd = REWRITE_WINDOW_END,
  ) {
    if (from.length !== to.length || from.length === 0) throw new Error("placeholder and key must have equal length");
  }

  push(chunk: Buffer): Buffer {
    if (this.passthrough) return chunk;
    const buf = this.held.length > 0 ? Buffer.concat([this.held, chunk]) : chunk;
    let i = buf.indexOf(this.from, Math.max(0, this.windowStart - this.base));
    while (i >= 0 && this.base + i < this.windowEnd) {
      this.to.copy(buf, i);
      i = buf.indexOf(this.from, i + this.from.length);
    }
    if (this.base + buf.length >= this.windowEnd) {
      this.passthrough = true;
      this.held = Buffer.alloc(0);
      return buf;
    }
    // Hold back only a tail that could be the start of a split placeholder (usually nothing):
    // the peer answers each command before ffmpeg sends more, so held bytes could stall it.
    const keep = this.partialMatchLength(buf);
    const out = buf.subarray(0, buf.length - keep);
    this.held = Buffer.from(buf.subarray(buf.length - keep));
    this.base += out.length;
    return out;
  }

  /** Bytes currently held back. */
  get pending(): number {
    return this.held.length;
  }

  private partialMatchLength(buf: Buffer): number {
    for (let k = Math.min(buf.length, this.from.length - 1); k > 0; k--) {
      if (this.base + buf.length - k < this.windowStart) return 0;
      if (buf.subarray(buf.length - k).equals(this.from.subarray(0, k))) return k;
    }
    return 0;
  }

  /** Emit held bytes (end of stream, or no more data arrived soon enough to complete a match). */
  flush(): Buffer {
    const out = this.held;
    this.held = Buffer.alloc(0);
    this.base += out.length;
    return out;
  }
}

export type ProxyFailure = "target_not_allowed" | "connection_failed";

export interface RtmpKeyProxyOptions {
  target: ParsedTarget;
  placeholder: string;
  secret: string;
  logger: Logger;
  resolve?: ResolveOptions;
  connectTimeoutMs?: number;
}

export class RtmpKeyProxy {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  /** Why the most recent upstream connection failed; cleared when one succeeds. */
  lastFailure: ProxyFailure | null = null;

  constructor(private readonly opts: RtmpKeyProxyOptions) {}

  /** Listen on an ephemeral loopback port and return it. */
  async listen(): Promise<number> {
    const server = createServer((client) => void this.handle(client));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("proxy has no port");
    return addr.port;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
  }

  private track(s: Socket): void {
    this.sockets.add(s);
    s.once("close", () => this.sockets.delete(s));
  }

  private async handle(client: Socket): Promise<void> {
    const { target, logger } = this.opts;
    this.track(client);
    client.pause();
    client.on("error", () => client.destroy());
    let upstream: Socket;
    try {
      const addr = await resolveTarget(target, this.opts.resolve);
      upstream = await this.dial(addr.address);
    } catch (err) {
      this.lastFailure = err instanceof TargetNotAllowedError ? "target_not_allowed" : "connection_failed";
      // Host names are not secret, but keep the log to the reason and the error class.
      logger.warn("simulcast upstream connection failed", {
        reason: err instanceof TargetNotAllowedError ? err.reason : "connect",
        err: err instanceof Error ? err.message : String(err),
      });
      client.destroy();
      return;
    }
    this.lastFailure = null;
    this.track(upstream);
    const rewriter = new KeyRewriter(Buffer.from(this.opts.placeholder), Buffer.from(this.opts.secret));
    let idle: ReturnType<typeof setTimeout> | null = null;
    const rewrite = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        if (idle) clearTimeout(idle);
        idle = null;
        const out = rewriter.push(chunk);
        // ffmpeg writes each RTMP message in one go; a tail still held shortly after is not
        // the start of a placeholder, and the server may be waiting for it.
        if (rewriter.pending > 0) idle = setTimeout(() => this.push(rewriter.flush()), HOLD_FLUSH_MS);
        cb(null, out);
      },
      flush(cb) {
        if (idle) clearTimeout(idle);
        cb(null, rewriter.flush());
      },
    });
    const closeBoth = () => {
      client.destroy();
      upstream.destroy();
    };
    upstream.on("error", (err) => {
      logger.warn("simulcast upstream error", { err: err.message });
      closeBoth();
    });
    upstream.on("close", closeBoth);
    client.on("close", closeBoth);
    client.pipe(rewrite).pipe(upstream);
    upstream.pipe(client);
    client.resume();
  }

  private dial(address: string): Promise<Socket> {
    const { target } = this.opts;
    const timeout = this.opts.connectTimeoutMs ?? 10_000;
    return new Promise<Socket>((resolve, reject) => {
      const s: Socket =
        target.protocol === "rtmps:"
          ? tlsConnect({ host: address, port: target.port, servername: target.host, timeout })
          : netConnect({ host: address, port: target.port, timeout });
      const ready = target.protocol === "rtmps:" ? "secureConnect" : "connect";
      const fail = (err: Error) => {
        s.destroy();
        reject(err);
      };
      s.once("error", fail);
      s.once("timeout", () => fail(new Error("connect timeout")));
      s.once(ready, () => {
        s.off("error", fail);
        s.setTimeout(0);
        resolve(s);
      });
    });
  }
}
