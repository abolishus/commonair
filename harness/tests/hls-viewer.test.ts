// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test } from "vite-plus/test";
import type { ApiClient } from "../src/api/client.ts";
import { BOT_TIMING } from "../src/fingerprint.ts";
import { BufferModel, HttpViewer } from "../src/http-viewer.ts";
import { lowestVariant, parseAttributes, parsePlaylist, resolveUri, withToken } from "../src/hls.ts";
import { aggregateReports, emptyReport } from "../src/viewer.ts";

const MULTIVARIANT = `#EXTM3U
#EXT-X-VERSION:10
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio2",AUTOSELECT=YES,DEFAULT=YES,URI="audio2_stream.m3u8?session=abc"
#EXT-X-STREAM-INF:BANDWIDTH=2469744,AVERAGE-BANDWIDTH=2469744,CODECS="avc1.64001e,mp4a.40.2",RESOLUTION=640x360,FRAME-RATE=30.000,AUDIO="audio"
video1_stream.m3u8?session=abc
#EXT-X-STREAM-INF:BANDWIDTH=900000,CODECS="avc1.42c01e,mp4a.40.2",RESOLUTION=426x240,AUDIO="audio"
low/index.m3u8
`;

const MEDIA = `#EXTM3U
#EXT-X-VERSION:9
#EXT-X-TARGETDURATION:1
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=0.6
#EXT-X-PART-INF:PART-TARGET=0.2
#EXT-X-MEDIA-SEQUENCE:40
#EXT-X-MAP:URI="init.mp4"
#EXT-X-PROGRAM-DATE-TIME:2026-10-18T12:00:00.000Z
#EXTINF:1.00000,
seg40.mp4
#EXTINF:1.00000,
seg41.mp4
#EXT-X-PROGRAM-DATE-TIME:2026-10-18T12:00:05.000Z
#EXTINF:0.50000,
seg42.mp4
#EXT-X-PART:DURATION=0.2,URI="part43.0.mp4",INDEPENDENT=YES
#EXT-X-PRELOAD-HINT:TYPE=PART,URI="part43.1.mp4"
`;

describe("playlist parsing", () => {
  test("attributes with quoted commas", () => {
    expect(parseAttributes('A=1,B="x,y",C=0x1F')).toEqual({ A: "1", B: "x,y", C: "0x1F" });
  });

  test("multivariant", () => {
    const p = parsePlaylist(MULTIVARIANT);
    if (p.kind !== "multivariant") throw new Error("expected multivariant");
    expect(p.variants).toHaveLength(2);
    expect(p.variants[0]).toMatchObject({
      bandwidth: 2469744,
      resolution: { width: 640, height: 360 },
      audioGroup: "audio",
    });
    expect(p.renditions[0]).toMatchObject({
      type: "AUDIO",
      groupId: "audio",
      uri: "audio2_stream.m3u8?session=abc",
      isDefault: true,
    });
    expect(lowestVariant(p)?.uri).toBe("low/index.m3u8");
  });

  test("LL-HLS media playlist with PDT carried forward", () => {
    const p = parsePlaylist(MEDIA);
    if (p.kind !== "media") throw new Error("expected media");
    expect(p).toMatchObject({ targetDuration: 1, mediaSequence: 40, partTarget: 0.2, ended: false });
    expect(p.segments.map((s) => s.sequence)).toEqual([40, 41, 42]);
    expect(p.segments.map((s) => s.map)).toEqual(["init.mp4", "init.mp4", "init.mp4"]);
    const t0 = Date.parse("2026-10-18T12:00:00.000Z");
    expect(p.segments[0]?.programDateTime).toBe(t0);
    expect(p.segments[1]?.programDateTime).toBe(t0 + 1000);
    expect(p.segments[2]?.programDateTime).toBe(t0 + 5000);
  });

  test("delta playlists account for skipped segments; ENDLIST", () => {
    const p = parsePlaylist(
      "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:10\n#EXT-X-SKIP:SKIPPED-SEGMENTS=5\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST\n",
    );
    if (p.kind !== "media") throw new Error("expected media");
    expect(p.segments[0]?.sequence).toBe(15);
    expect(p.ended).toBe(true);
    expect(p.segments[0]?.programDateTime).toBeNull();
  });

  test("not a playlist", () => {
    expect(() => parsePlaylist("<html>")).toThrow(/EXTM3U/);
  });

  test("token handling on URIs", () => {
    const base = "http://o/hls/live/c/index.m3u8?t=TOKEN1";
    expect(resolveUri("seg1.mp4", base)).toBe("http://o/hls/live/c/seg1.mp4?t=TOKEN1");
    expect(resolveUri("seg1.mp4?t=OTHER", base)).toBe("http://o/hls/live/c/seg1.mp4?t=OTHER");
    expect(resolveUri("http://relay/x.mp4", "http://o/a.m3u8")).toBe("http://relay/x.mp4");
    expect(withToken("http://o/a.mp4?t=OLD&x=1", "NEW")).toBe("http://o/a.mp4?t=NEW&x=1");
    expect(withToken("http://o/a.mp4", "NEW")).toBe("http://o/a.mp4");
  });
});

describe("buffer model", () => {
  test("TTFF on the first full segment, stall on underrun, resume on refill", () => {
    const b = new BufferModel(1, 0);
    expect(b.append(0.5, 100)).toBe(false);
    expect(b.playing).toBe(false);
    expect(b.append(0.5, 200)).toBe(true);
    expect(b.playing).toBe(true);
    b.tick(1_200);
    expect(b.playedSeconds).toBeCloseTo(1);
    expect(b.stalls).toBe(0);
    b.tick(1_700);
    expect(b.stalls).toBe(1);
    expect(b.playing).toBe(false);
    expect(b.totalStallMs(2_200)).toBe(1_000);
    expect(b.append(1, 2_200)).toBe(false);
    expect(b.stallMs).toBe(1_000);
    expect(b.playing).toBe(true);
  });

  test("steady supply never stalls", () => {
    const b = new BufferModel(1, 0);
    for (let t = 0; t <= 20_000; t += 1_000) b.append(1, t);
    b.tick(20_500);
    expect(b.stalls).toBe(0);
    expect(b.playedSeconds).toBeCloseTo(20.5, 1);
  });
});

describe("HTTP viewer against a fake origin", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  afterEach(async () => {
    await server?.stop(true);
    server = null;
  });

  function startOrigin(opts: { missing?: Set<number> } = {}) {
    let seq = 0;
    const startedAt = Date.now();
    const requests: string[] = [];
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url);
        requests.push(url.pathname + url.search);
        if (url.pathname === "/index.m3u8") {
          // One new 0.5 s segment every 500 ms.
          seq = Math.floor((Date.now() - startedAt) / 500) + 3;
          const lines = [
            "#EXTM3U",
            "#EXT-X-TARGETDURATION:1",
            `#EXT-X-MEDIA-SEQUENCE:${seq - 3}`,
            '#EXT-X-MAP:URI="init.mp4"',
          ];
          for (let s = seq - 3; s < seq; s++) lines.push("#EXTINF:0.5,", `s${s}.mp4`);
          return new Response(lines.join("\n"));
        }
        if (url.pathname === "/init.mp4") return new Response(new Uint8Array(100));
        const m = /^\/s(\d+)\.mp4$/.exec(url.pathname);
        if (m) {
          if (opts.missing?.has(Number(m[1]))) return new Response("gone", { status: 404 });
          return new Response(new Uint8Array(5_000));
        }
        return new Response("nope", { status: 404 });
      },
    });
    return { base: `http://127.0.0.1:${server.port}`, requests };
  }

  test("plays, counts bytes and carries the token", async () => {
    const { base, requests } = startOrigin();
    const v = new HttpViewer({ target: { playlistUrl: `${base}/index.m3u8?t=tok` } });
    await v.start();
    expect(await v.waitForFirstFrame(5_000)).toBeLessThan(5_000);
    await Bun.sleep(1_500);
    const r = await v.stop();
    expect(r.bytesHttp).toBeGreaterThan(5_000 * 3);
    expect(r.playedSeconds).toBeGreaterThan(0.5);
    expect(r.errors).toEqual([]);
    expect(requests.filter((p) => p.startsWith("/init.mp4"))).toHaveLength(1);
    expect(requests.every((p) => p.includes("t=tok"))).toBe(true);
    // Stopping is idempotent.
    expect((await v.stop()).bytesHttp).toBe(r.bytesHttp);
  });

  test("skips a missing segment instead of failing", async () => {
    const { base } = startOrigin({ missing: new Set([1, 2, 5]) });
    const v = new HttpViewer({ target: { playlistUrl: `${base}/index.m3u8` } });
    await v.start();
    await v.waitForFirstFrame(5_000);
    await Bun.sleep(1_500);
    const r = await v.stop();
    expect(r.skippedSegments).toBeGreaterThan(0);
    expect(r.errors).toEqual([]);
  });

  test("playlist-only mode downloads no media", async () => {
    const { base, requests } = startOrigin();
    const v = new HttpViewer({ target: { playlistUrl: `${base}/index.m3u8` }, fetchSegments: false });
    await v.start();
    await Bun.sleep(1_200);
    const r = await v.stop();
    expect(r.ttffMs).toBeNull();
    expect(requests.every((p) => p.startsWith("/index.m3u8"))).toBe(true);
  });

  test("follows switchTo from a relay playlist to the origin, with the new token", async () => {
    const { base, requests } = startOrigin();
    const tok = (claims: object) => `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
    const relayTok = tok({ v: 1, src: "relay", rid: "relay-1" });
    const originTok = tok({ v: 1, src: "origin" });
    let beats = 0;
    // A fake playback API: the second heartbeat moves the session off the relay.
    const api = {
      playback: {
        start: async () => ({
          sessionId: "s1",
          token: relayTok,
          playlistUrl: `${base}/index.m3u8?t=${relayTok}`,
          source: "relay",
          heartbeatIntervalMs: 300,
        }),
        heartbeat: async () =>
          ++beats === 2 ? { ok: true, token: originTok, switchTo: `${base}/index.m3u8?t=${originTok}` } : { ok: true },
        end: async () => ({ ok: true }),
      },
    } as unknown as ApiClient;
    const v = new HttpViewer({ target: { channel: "al" }, api, timing: BOT_TIMING });
    await v.start();
    expect(v.assignment).toEqual({ source: "relay", relayId: "relay-1" });
    await v.waitForFirstFrame(5_000);
    const switchedAt = Date.now();
    for (let i = 0; i < 40 && v.switchHistory.length === 0; i++) await Bun.sleep(100);
    expect(v.switchHistory).toHaveLength(1);
    expect(v.switchHistory[0]?.from).toEqual({ source: "relay", relayId: "relay-1" });
    expect(v.assignment).toEqual({ source: "origin", relayId: null });
    const after = requests.length;
    for (let i = 0; i < 30 && (v.lastSegmentAt ?? 0) <= (v.switchHistory[0]?.at ?? Infinity); i++) await Bun.sleep(100);
    expect(v.lastSegmentAt).toBeGreaterThan(v.switchHistory[0]?.at ?? Infinity);
    const r = await v.stop();
    expect(r.source).toBe("origin");
    expect(r.errors).toEqual([]);
    // Every request after the switch carries the origin token.
    expect(requests.slice(after).every((q) => q.includes(`t=${originTok}`))).toBe(true);
    expect(Date.now() - switchedAt).toBeLessThan(10_000);
  });

  test("a heartbeat in flight when stop() begins is counted", async () => {
    const { base } = startOrigin();
    let received = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const api = {
      playback: {
        start: async () => ({
          sessionId: "s1",
          token: "t",
          playlistUrl: `${base}/index.m3u8?t=t`,
          source: "origin",
          heartbeatIntervalMs: 200,
        }),
        heartbeat: async () => {
          received++;
          await held;
          return { ok: true };
        },
        end: async () => ({ ok: true }),
      },
    } as unknown as ApiClient;
    const v = new HttpViewer({ target: { channel: "al" }, api, timing: BOT_TIMING });
    await v.start();
    await v.waitForFirstFrame(5_000);
    for (let i = 0; i < 50 && received === 0; i++) await Bun.sleep(50);
    expect(received).toBe(1);
    const stopping = v.stop();
    release();
    const r = await stopping;
    expect(r.heartbeats).toBe(1);
    expect(r.heartbeatErrors).toBe(0);
  });

  test("channel targets need an API client", async () => {
    await expect(new HttpViewer({ target: { channel: "x" } }).start()).rejects.toThrow(/API client/);
  });
});

describe("aggregation", () => {
  test("rates and summaries", () => {
    const a = {
      ...emptyReport("a", "http", "http"),
      ttffMs: 1000,
      playedSeconds: 60,
      stalls: 2,
      stallMs: 3000,
      latencyMs: [2000, 3000],
    };
    const b = {
      ...emptyReport("b", "browser", "chromium"),
      ttffMs: 3000,
      playedSeconds: 60,
      latencyMs: [4000],
      bytesHttp: 10,
    };
    const c = emptyReport("c", "browser", "webkit");
    const agg = aggregateReports([a, b, c]);
    expect(agg.viewers).toBe(3);
    expect(agg.started).toBe(2);
    expect(agg.ttff.p95).toBe(3000);
    expect(agg.latency.p50).toBe(3000);
    expect(agg.stallsPerMinute).toBeCloseTo(1);
    expect(agg.stallRatio).toBeCloseTo(3 / 123);
    expect(agg.bytesHttp).toBe(10);
    expect(aggregateReports([]).stallRatio).toBe(0);
  });
});
