// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Rewrites the publisher → MediaMTX half of an RTSP-over-TCP session so the sender report
 * ffmpeg sends with each stream's first packet is used.
 *
 * Why: ffmpeg's RTP muxer (`libavformat/rtpenc.c`) sends a sender report right before a stream's
 * first RTP packet and the next one no sooner than 5 s later. gortsplib (MediaMTX 1.21.2,
 * gortsplib v5.6.7 `serverSessionMedia.readPacketRTCP`) routes a sender report to a format by the
 * remote SSRC, which it learns only from the first RTP packet, so it drops that first report.
 * A `useAbsoluteTimestamp` path then has no absolute time and skips every packet for ~5 s.
 *
 * The fix, per SSRC: before the first RTP packet goes out, send a copy of it one sequence number
 * earlier (MediaMTX learns the SSRC from it and then skips it, as it has no absolute time), then
 * the cached sender report again (now routed), then the original packet, which is the first one
 * MediaMTX keeps. The report's NTP↔RTP mapping holds for every packet, so resending it later is
 * exact. Nothing is lost: the copy carries no sequence gap, and the original is delivered.
 *
 * Interleaved frames are `$`, channel, 16-bit length, payload (RFC 2326 §10.12). Anything the
 * parser does not understand switches it to plain pass-through for the rest of the connection.
 */

const DOLLAR = 0x24;
/** RTCP packet types 200–204 (SR, RR, SDES, BYE, APP), as ffmpeg tells RTCP from RTP. */
const RTCP_SR = 200;
const isRtcp = (pt: number) => pt >= 200 && pt <= 204;
/** Cap for an RTSP text message (request line + headers) before giving up on parsing. */
const MAX_TEXT_HEADER = 64 * 1024;
const HEADER_END = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);

export interface SrPrimerStats {
  /** SSRCs whose first RTP packet was primed with a copy and the cached sender report. */
  primed: number;
  /** True once the parser gave up and forwards bytes unchanged. */
  passthrough: boolean;
}

function indexOf(buf: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i + needle.length <= buf.length; i++) {
    for (let j = 0; j < needle.length; j++) if (buf[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** A copy that owns its bytes (`Buffer#slice` would return a view). */
const copyOf = (b: Uint8Array) => new Uint8Array(b);

const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;

/** `Content-Length` of an RTSP message head (ASCII), 0 when absent. */
function contentLength(head: Uint8Array): number | null {
  const text = new TextDecoder("latin1").decode(head);
  const m = /\r\ncontent-length:[ \t]*(\d+)/i.exec(text);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}

export class SrPrimer {
  private pending: Uint8Array = new Uint8Array(0);
  private passthrough = false;
  /** Latest sender report frame (whole interleaved frame) per SSRC not primed yet. */
  private readonly reports = new Map<number, Uint8Array>();
  private readonly seen = new Set<number>();
  private primedCount = 0;

  get stats(): SrPrimerStats {
    return { primed: this.primedCount, passthrough: this.passthrough };
  }

  /** Feed bytes from the publisher; returns the bytes to forward now, in order. */
  push(chunk: Uint8Array): Uint8Array[] {
    if (this.passthrough) return chunk.length ? [chunk] : [];
    this.pending = concat(this.pending, chunk);
    const out: Uint8Array[] = [];
    let off = 0;
    const buf = this.pending;
    while (off < buf.length) {
      if (buf[off] === DOLLAR) {
        if (buf.length - off < 4) break;
        const len = (buf[off + 2]! << 8) | buf[off + 3]!;
        if (buf.length - off < 4 + len) break;
        this.frame(buf.subarray(off, off + 4 + len), out);
        off += 4 + len;
        continue;
      }
      const end = indexOf(buf, HEADER_END, off);
      if (end < 0) {
        if (buf.length - off > MAX_TEXT_HEADER) return this.giveUp(out, buf.subarray(off));
        break;
      }
      const body = contentLength(buf.subarray(off, end + 4));
      if (body === null) return this.giveUp(out, buf.subarray(off));
      const total = end + 4 - off + body;
      if (buf.length - off < total) break;
      out.push(buf.subarray(off, off + total));
      off += total;
    }
    // Copy the remainder: `out` holds views into `buf`, which the next push must not reuse.
    this.pending = copyOf(buf.subarray(off));
    return out;
  }

  private giveUp(out: Uint8Array[], rest: Uint8Array): Uint8Array[] {
    this.passthrough = true;
    this.pending = new Uint8Array(0);
    this.reports.clear();
    if (rest.length) out.push(rest);
    return out;
  }

  private frame(frame: Uint8Array, out: Uint8Array[]): void {
    const payload = frame.subarray(4);
    if (payload.length >= 8 && isRtcp(payload[1]!)) {
      // A compound RTCP packet starts with the SR (RFC 3550 §6.1); ffmpeg sends SR + SDES.
      if (payload[1] === RTCP_SR) {
        const ssrc = u32(payload, 4);
        if (!this.seen.has(ssrc)) this.reports.set(ssrc, copyOf(frame));
      }
      out.push(frame);
      return;
    }
    if (payload.length >= 12 && payload[0]! >> 6 === 2) {
      const ssrc = u32(payload, 8);
      if (!this.seen.has(ssrc)) {
        this.seen.add(ssrc);
        const report = this.reports.get(ssrc);
        this.reports.delete(ssrc);
        if (report) {
          const copy = copyOf(frame);
          const seq = ((payload[2]! << 8) | payload[3]!) - 1;
          copy[4 + 2] = (seq >> 8) & 0xff;
          copy[4 + 3] = seq & 0xff;
          out.push(copy, report);
          this.primedCount++;
        }
      }
    }
    out.push(frame);
  }
}
