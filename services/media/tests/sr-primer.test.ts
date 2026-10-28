// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { connect, createServer, type Socket } from "node:net";
import { describe, expect, test } from "vite-plus/test";
import { startRtspPublishProxy } from "../src/ffmpeg/rtsp-publish-proxy.ts";
import { SrPrimer } from "../src/ffmpeg/sr-primer.ts";

const text = (s: string) => new TextEncoder().encode(s);

function frame(channel: number, payload: Uint8Array): Uint8Array {
  const f = new Uint8Array(4 + payload.length);
  f.set([0x24, channel, payload.length >> 8, payload.length & 0xff]);
  f.set(payload, 4);
  return f;
}

function rtp(channel: number, ssrc: number, seq: number, ts = 1000, body = [1, 2, 3]): Uint8Array {
  const p = new Uint8Array(12 + body.length);
  const v = new DataView(p.buffer);
  p[0] = 0x80;
  p[1] = 96;
  v.setUint16(2, seq);
  v.setUint32(4, ts);
  v.setUint32(8, ssrc);
  p.set(body, 12);
  return frame(channel, p);
}

/** SR (28 bytes) followed by an SDES chunk, as ffmpeg's `rtcp_send_sr` writes it. */
function sr(channel: number, ssrc: number, rtpTs = 5000): Uint8Array {
  const p = new Uint8Array(28 + 12);
  const v = new DataView(p.buffer);
  p[0] = 0x80;
  p[1] = 200;
  v.setUint16(2, 6);
  v.setUint32(4, ssrc);
  v.setUint32(8, 0xe0000000);
  v.setUint32(12, 0x80000000);
  v.setUint32(16, rtpTs);
  p[28] = 0x81;
  p[29] = 202;
  v.setUint16(30, 2);
  v.setUint32(32, ssrc);
  return frame(channel, p);
}

const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const seqOf = (f: Uint8Array) => (f[6]! << 8) | f[7]!;

const RECORD = text("RECORD rtsp://h/live/a/aac RTSP/1.0\r\nCSeq: 5\r\nSession: 1\r\n\r\n");
const ANNOUNCE_BODY = "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n";
const ANNOUNCE = text(
  `ANNOUNCE rtsp://h/live/a/aac RTSP/1.0\r\nCSeq: 2\r\nContent-Type: application/sdp\r\nContent-length: ${ANNOUNCE_BODY.length}\r\n\r\n${ANNOUNCE_BODY}`,
);

describe("SrPrimer", () => {
  test("RTSP text messages, bodies included, pass through unchanged", () => {
    const p = new SrPrimer();
    expect(join(p.push(join([ANNOUNCE, RECORD])))).toEqual(join([ANNOUNCE, RECORD]));
    expect(p.stats).toEqual({ primed: 0, passthrough: false });
  });

  test("the first RTP packet of an SSRC is preceded by a copy one sequence earlier and the cached SR", () => {
    const p = new SrPrimer();
    const report = sr(1, 7);
    const first = rtp(0, 7, 100);
    const out = p.push(join([RECORD, report, first]));
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual(RECORD);
    expect(out[1]).toEqual(report);
    expect(seqOf(out[2]!)).toBe(99);
    expect(out[2]!.subarray(8)).toEqual(first.subarray(8));
    expect(out[3]).toEqual(report);
    expect(out[4]).toEqual(first);
    expect(p.stats.primed).toBe(1);
  });

  test("later packets and reports of a primed SSRC are forwarded once, unchanged", () => {
    const p = new SrPrimer();
    p.push(join([sr(1, 7), rtp(0, 7, 100)]));
    const rest = [rtp(0, 7, 101), sr(1, 7, 9000), rtp(0, 7, 102)];
    expect(join(p.push(join(rest)))).toEqual(join(rest));
    expect(p.stats.primed).toBe(1);
  });

  test("the sequence number wraps below 0", () => {
    const p = new SrPrimer();
    const out = p.push(join([sr(1, 7), rtp(0, 7, 0)]));
    expect(seqOf(out[1]!)).toBe(0xffff);
    expect(seqOf(out[3]!)).toBe(0);
  });

  test("the latest SR before the first packet is the one resent", () => {
    const p = new SrPrimer();
    const newer = sr(1, 7, 6000);
    const out = p.push(join([sr(1, 7, 5000), newer, rtp(0, 7, 1)]));
    expect(out[3]).toEqual(newer);
  });

  test("an SSRC without a prior SR is forwarded unchanged and never primed later", () => {
    const p = new SrPrimer();
    const input = [rtp(0, 7, 1), sr(1, 7), rtp(0, 7, 2)];
    expect(join(p.push(join(input)))).toEqual(join(input));
    expect(p.stats.primed).toBe(0);
  });

  test("each SSRC (video and audio of one session) is primed on its own channel", () => {
    const p = new SrPrimer();
    const out = p.push(join([sr(3, 9), sr(1, 7), rtp(0, 7, 10), rtp(0, 7, 11), rtp(2, 9, 50)]));
    const summary = out.map((f) => [f[1], f[5] === 200 ? "sr" : seqOf(f)]);
    expect(summary).toEqual([
      [3, "sr"],
      [1, "sr"],
      [0, 9],
      [1, "sr"],
      [0, 10],
      [0, 11],
      [2, 49],
      [3, "sr"],
      [2, 50],
    ]);
    expect(p.stats.primed).toBe(2);
  });

  test("any chunking gives the same bytes, and the caller's buffers are not modified", () => {
    const input = join([ANNOUNCE, RECORD, sr(3, 9), sr(1, 7), rtp(0, 7, 10), rtp(2, 9, 50), rtp(0, 7, 11)]);
    const whole = join(new SrPrimer().push(input));
    for (const size of [1, 2, 3, 5, 17, 64]) {
      const p = new SrPrimer();
      const parts: Uint8Array[] = [];
      for (let o = 0; o < input.length; o += size) {
        const chunk = Buffer.from(input.subarray(o, o + size));
        const before = Buffer.from(chunk);
        parts.push(...p.push(chunk));
        expect(chunk).toEqual(before);
      }
      expect(join(parts)).toEqual(whole);
    }
    // Two primed SSRCs add a copy and an SR each.
    expect(whole.length).toBe(
      input.length + rtp(0, 7, 10).length + sr(1, 7).length + rtp(2, 9, 50).length + sr(3, 9).length,
    );
  });

  test("an RTSP head without an end gives up and passes everything through", () => {
    const p = new SrPrimer();
    const junk = new Uint8Array(70 * 1024).fill(0x41);
    const later = rtp(0, 7, 1);
    expect(join([...p.push(sr(1, 7)), ...p.push(junk), ...p.push(later)])).toEqual(join([sr(1, 7), junk, later]));
    expect(p.stats).toEqual({ primed: 0, passthrough: true });
  });

  test("an unparseable Content-Length gives up and passes everything through", () => {
    const p = new SrPrimer();
    const bad = text(`SET_PARAMETER rtsp://h RTSP/1.0\r\nContent-Length: ${"9".repeat(30)}\r\n\r\nxyz`);
    const later = join([sr(1, 7), rtp(0, 7, 1)]);
    expect(join([...p.push(bad), ...p.push(later)])).toEqual(join([bad, later]));
    expect(p.stats.passthrough).toBe(true);
  });

  test("an incomplete frame waits for the rest", () => {
    const p = new SrPrimer();
    const f = rtp(0, 7, 1);
    expect(p.push(f.subarray(0, 3))).toEqual([]);
    expect(p.push(f.subarray(3, 10))).toEqual([]);
    expect(join(p.push(f.subarray(10)))).toEqual(f);
  });
});

describe("startRtspPublishProxy", () => {
  test("relays both directions, primes the publisher's first packet and flushes on close", async () => {
    const received: Buffer[] = [];
    const upstream = createServer((s: Socket) => {
      s.on("data", (d: Buffer) => {
        received.push(d);
        if (received.length === 1) s.write("RTSP/1.0 200 OK\r\nCSeq: 5\r\n\r\n");
      });
      s.on("end", () => s.end());
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const addr = upstream.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const relay = await startRtspPublishProxy(`rtsp://127.0.0.1:${addr.port}`);
    expect(relay.base).toMatch(/^rtsp:\/\/127\.0\.0\.1:\d+$/);
    const port = Number(new URL(relay.base).port);

    const client = connect({ host: "127.0.0.1", port });
    const reply = new Promise<string>((r) => client.once("data", (d: Buffer) => r(d.toString())));
    client.write(RECORD);
    expect(await reply).toContain("200 OK");
    const report = sr(1, 7);
    const first = rtp(0, 7, 100);
    const closed = new Promise<void>((r) => client.on("close", () => r()));
    client.end(join([report, first]));
    await closed;

    const expected = join([RECORD, report, rtp(0, 7, 99), report, first]);
    expect(join(received)).toEqual(expected);
    await relay.close();
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  test("refuses a non-RTSP upstream", async () => {
    await expect(startRtspPublishProxy("srt://127.0.0.1:8890")).rejects.toThrow(/rtsp:\/\//);
  });
});
