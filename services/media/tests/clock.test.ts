// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The media clock's pure parts (ADR 0012, variant A2): the fMP4 box parser, the W0 formula and
 * the PTS-wrap rebase, LL-HLS playlist picking, the bounded W0 fetch, run offsets and sidecars,
 * and the clock's drift and failure reporting.
 *
 * Fixtures (`fixtures/clock`, generated once with ffmpeg 9.0 on 32×32 test patterns):
 * - `nob_*`: H.264 without B-frames plus AAC, `-output_ts_offset 50000` and
 *   `movflags=+frag_discont`, so `tfdt` is 50000 s (as the recorder writes, non-zero);
 * - `bf_*`: H.264 with two B-frames (non-zero composition offsets), video only.
 * Expected values were read with ffprobe (`-show_entries packet=pts,dts`).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { parseFragment, parseInit } from "../src/clock/boxes.ts";
import { syncedFromState } from "../src/clock/host.ts";
import { createMediaClock } from "../src/clock/media-clock.ts";
import type { ClockMetrics } from "../src/clock/metrics.ts";
import { firstSampleSeconds, readSidecar, runOffsetMs, runSidecar, writeSidecar } from "../src/clock/run.ts";
import {
  computeW0,
  fetchW0,
  firstVariant,
  HLS_TFDT_OFFSET_SECONDS,
  newestSegment,
  pdtTrack,
  PTS_WRAP_SECONDS,
  rebasePts,
  W0Error,
  type W0Result,
} from "../src/clock/w0.ts";
import { captureLogger } from "./helpers/moderation.ts";

const FIXTURES = new URL("./fixtures/clock/", import.meta.url).pathname;
const fixture = (name: string) => Bun.file(join(FIXTURES, name)).bytes();

// --- tiny box builder for the cases ffmpeg does not produce --------------------------------

const u32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0);
  return b;
};
const u64 = (n: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n);
  return b;
};
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  return out;
};
const box = (type: string, ...body: Uint8Array[]) => {
  const payload = cat(...body);
  return cat(u32(8 + payload.byteLength), new TextEncoder().encode(type), payload);
};
const fullBox = (type: string, version: number, flags: number, ...body: Uint8Array[]) =>
  box(type, u32((version << 24) | flags), ...body);

function traf(trackId: number, tfdt: { version: 0 | 1; value: bigint }, trun?: { version: 0 | 1; cto: number }) {
  const parts = [
    fullBox("tfhd", 0, 0, u32(trackId)),
    fullBox("tfdt", tfdt.version, 0, tfdt.version === 1 ? u64(tfdt.value) : u32(Number(tfdt.value))),
  ];
  // flags: data offset (0x1) + sample duration (0x100) + composition offset (0x800); one sample.
  if (trun) parts.push(fullBox("trun", trun.version, 0x901, u32(1), u32(0), u32(3000), u32(trun.cto)));
  return box("traf", ...parts);
}

// -------------------------------------------------------------------------------------------

describe("fMP4 box parser", () => {
  test("init: track ids, timescales and handlers in moov order", async () => {
    expect(parseInit(await fixture("nob_init.mp4"))).toEqual([
      { trackId: 1, timescale: 15360, handler: "vide" },
      { trackId: 2, timescale: 48000, handler: "soun" },
    ]);
    expect(parseInit(await fixture("bf_init.mp4"))).toEqual([{ trackId: 1, timescale: 15360, handler: "vide" }]);
  });

  test("segment without B-frames: tfdt per track, no composition offset", async () => {
    // ffprobe: first video packet pts = dts = 768007680 (50000.5 s at 15360).
    expect(parseFragment(await fixture("nob_1.m4s"))).toEqual([
      { trackId: 1, baseDecodeTime: 768_007_680, firstCompositionOffset: 0 },
      { trackId: 2, baseDecodeTime: 2_400_024_576, firstCompositionOffset: 0 },
    ]);
  });

  test("B-frame segments: the first sample's composition offset gives its presentation time", async () => {
    const [s0] = parseFragment(await fixture("bf_0.m4s"));
    const [s1] = parseFragment(await fixture("bf_1.m4s"));
    expect(s0).toEqual({ trackId: 1, baseDecodeTime: 0, firstCompositionOffset: 1024 });
    expect(s1).toEqual({ trackId: 1, baseDecodeTime: 7680, firstCompositionOffset: 1024 });
    // ffprobe reports first pts 1014 and 8694: the same presentation times less the init's
    // 10-tick edit list, which W0 does not need (MediaMTX and the recorder are measured raw).
    expect((s0?.baseDecodeTime ?? 0) + (s0?.firstCompositionOffset ?? 0) - 1014).toBe(10);
    expect((s1?.baseDecodeTime ?? 0) + (s1?.firstCompositionOffset ?? 0) - 8694).toBe(10);
  });

  test("32-bit tfdt, signed (version 1) composition offsets, trun without offsets", () => {
    const seg = box(
      "moof",
      traf(1, { version: 0, value: 123_456n }, { version: 1, cto: -3000 }),
      traf(2, { version: 1, value: 2n ** 40n }),
    );
    expect(parseFragment(seg)).toEqual([
      { trackId: 1, baseDecodeTime: 123_456, firstCompositionOffset: -3000 },
      { trackId: 2, baseDecodeTime: 2 ** 40, firstCompositionOffset: 0 },
    ]);
  });

  test("only a track's first fragment counts when a segment has several (LL-HLS parts)", () => {
    const seg = cat(
      box("moof", traf(1, { version: 1, value: 900n }, { version: 0, cto: 30 })),
      box("mdat", new Uint8Array(4)),
      box("moof", traf(1, { version: 1, value: 990n }, { version: 0, cto: 60 })),
    );
    expect(parseFragment(seg)).toEqual([{ trackId: 1, baseDecodeTime: 900, firstCompositionOffset: 30 }]);
  });

  test("a segment head cut inside mdat parses when truncated, fails otherwise", async () => {
    const full = await fixture("nob_1.m4s");
    const head = full.subarray(0, full.byteLength - 100);
    expect(() => parseFragment(head)).toThrow(/overruns/);
    expect(parseFragment(head, { truncated: true })[0]?.baseDecodeTime).toBe(768_007_680);
  });

  test("malformed input throws instead of guessing", async () => {
    expect(() => parseFragment(new Uint8Array(0))).toThrow(/no moof/);
    expect(() => parseInit(box("ftyp", new Uint8Array(8)))).toThrow(/no moov/);
    const init = await fixture("nob_init.mp4");
    expect(() => parseInit(init.subarray(0, init.byteLength - 20))).toThrow(/overruns|truncated/);
    // A box claiming less than its own header.
    expect(() => parseFragment(cat(u32(4), new TextEncoder().encode("moof")))).toThrow(/impossible/);
    // A 64-bit size box (size field 1) is followed correctly.
    const large = cat(u32(1), new TextEncoder().encode("free"), u64(16n));
    expect(parseFragment(cat(large, box("moof", traf(1, { version: 0, value: 5n }))))[0]?.baseDecodeTime).toBe(5);
  });
});

describe("W0", () => {
  test("PDT minus the first sample's presentation time on the SRT timeline (tfdt − 10 s)", () => {
    expect(HLS_TFDT_OFFSET_SECONDS).toBe(10);
    // tfdt 12 s, one frame of composition offset: the SRT timeline has the frame at 2.0333 s.
    const w0 = computeW0({
      pdtMs: 1_000_000,
      baseDecodeTime: 12 * 90_000,
      compositionOffset: 3_000,
      timescale: 90_000,
    });
    expect(w0).toBeCloseTo(1_000_000 - 2_033.333, 3);
    // Same frame without B-frames is one frame earlier in decode order but the same instant.
    expect(
      computeW0({ pdtMs: 1_000_000 - 33.333, baseDecodeTime: 12 * 90_000, compositionOffset: 0, timescale: 90_000 }),
    ).toBeCloseTo(w0, 2);
  });

  test("rebase: plain times unchanged, MediaMTX's unwrapped tfdt folded into the TS period", () => {
    expect(PTS_WRAP_SECONDS).toBe(8_589_934_592 / 90_000);
    expect(rebasePts(5)).toBe(5);
    expect(rebasePts(PTS_WRAP_SECONDS - 100)).toBeCloseTo(PTS_WRAP_SECONDS - 100, 6);
    expect(rebasePts(PTS_WRAP_SECONDS + 5)).toBeCloseTo(5, 6);
    expect(rebasePts(3 * PTS_WRAP_SECONDS + 5)).toBeCloseTo(5, 6);
  });

  test("rebase: the last 60 s before the wrap are negative, as libavformat presents them", () => {
    expect(rebasePts(PTS_WRAP_SECONDS - 30)).toBeCloseTo(-30, 6);
    expect(rebasePts(2 * PTS_WRAP_SECONDS - 1)).toBeCloseTo(-1, 6);
  });

  test("rebase: refuses the few seconds where a new session could land on either side", () => {
    const errorOf = (t: number) => {
      try {
        rebasePts(t);
        return null;
      } catch (err) {
        return err;
      }
    };
    for (const t of [PTS_WRAP_SECONDS - 61, PTS_WRAP_SECONDS - 70]) {
      const err = errorOf(t);
      expect(err).toBeInstanceOf(W0Error);
      expect(err).toMatchObject({ reason: "wrap" });
    }
    expect(rebasePts(PTS_WRAP_SECONDS - 80)).toBeCloseTo(PTS_WRAP_SECONDS - 80, 6);
  });

  test("a tfdt MediaMTX wrapped itself and one it did not give the same W0 on both sides of the wrap", () => {
    const at = (tsSeconds: number, pdtMs: number) =>
      computeW0({
        pdtMs,
        baseDecodeTime: Math.round((tsSeconds + HLS_TFDT_OFFSET_SECONDS) * 90_000),
        compositionOffset: 0,
        timescale: 90_000,
      });
    const W = PTS_WRAP_SECONDS;
    const pdtAt = (s: number) => 2_000_000_000_000 + s * 1000;
    // After the wrap: an unwrapped tfdt (W + 5) and a wrapped one (5) both anchor PTS 5.
    const unwrapped = at(W + 5, pdtAt(W + 5));
    const wrapped = at(5, pdtAt(W + 5));
    expect(unwrapped).toBeCloseTo(wrapped, 3);
    // A session started now sees PTS ≈ 5 for that frame: W0 + 5 s is its PDT.
    expect(wrapped + 5_000).toBeCloseTo(pdtAt(W + 5), 3);
    // Just before the wrap the session sees negative times; after it, small ones: one W0.
    const before = at(W - 20, pdtAt(W - 20));
    expect(before + -20 * 1000).toBeCloseTo(pdtAt(W - 20), 3);
    expect(before).toBeCloseTo(wrapped, 3);
    // Far from the wrap the W0 is the session start (no fold).
    const plain = at(1_000, pdtAt(1_000));
    expect(plain).toBeCloseTo(pdtAt(0), 3);
  });

  test("the PDT track: video when present, else audio, else none", () => {
    const v = { trackId: 1, timescale: 90_000, handler: "vide" };
    const a = { trackId: 2, timescale: 48_000, handler: "soun" };
    expect(pdtTrack([a, v])).toBe(v);
    expect(pdtTrack([a])).toBe(a);
    expect(pdtTrack([{ trackId: 3, timescale: 1000, handler: "meta" }])).toBeNull();
  });
});

const MULTIVARIANT = `#EXTM3U
#EXT-X-VERSION:10
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio2",AUTOSELECT=YES,DEFAULT=YES,URI="audio2_stream.m3u8?session=s1"

#EXT-X-STREAM-INF:BANDWIDTH=1045444,CODECS="avc1.64001e,mp4a.40.2",RESOLUTION=640x360,AUDIO="audio"
video1_stream.m3u8?session=s1
`;

/** MediaMTX LL-HLS shape: PDT on some segments, parts before each EXTINF, trailing parts. */
const MEDIA = `#EXTM3U
#EXT-X-VERSION:10
#EXT-X-TARGETDURATION:2
#EXT-X-PART-INF:PART-TARGET=0.23400
#EXT-X-MEDIA-SEQUENCE:25
#EXT-X-MAP:URI="x_video1_init.mp4?session=s1"
#EXTINF:2.00000,
x_video1_seg25.mp4?session=s1
#EXT-X-PROGRAM-DATE-TIME:2026-10-28T00:53:47.377Z
#EXT-X-PART:DURATION=0.20050,URI="x_video1_part230.mp4?session=s1",INDEPENDENT=YES
#EXTINF:2.00000,
x_video1_seg26.mp4?session=s1
#EXT-X-PROGRAM-DATE-TIME:2026-10-28T00:53:49.377Z
#EXT-X-PART:DURATION=0.20000,URI="x_video1_part240.mp4?session=s1",INDEPENDENT=YES
#EXTINF:2.00000,
x_video1_seg27.mp4?session=s1
#EXT-X-PROGRAM-DATE-TIME:2026-10-28T00:53:51.377Z
#EXT-X-PART:DURATION=0.20000,URI="x_video1_part250.mp4?session=s1",INDEPENDENT=YES
#EXT-X-PRELOAD-HINT:TYPE=PART,URI="x_video1_part251.mp4?session=s1"
`;

describe("LL-HLS playlists", () => {
  test("the first variant of a multivariant playlist; null for a media playlist", () => {
    expect(firstVariant(MULTIVARIANT)).toBe("video1_stream.m3u8?session=s1");
    expect(firstVariant(MEDIA)).toBeNull();
  });

  test("the newest complete segment with a PDT; the segment still being written is ignored", () => {
    expect(newestSegment(MEDIA)).toEqual({
      uri: "x_video1_seg27.mp4?session=s1",
      map: "x_video1_init.mp4?session=s1",
      pdtMs: Date.parse("2026-10-28T00:53:49.377Z"),
    });
    expect(newestSegment('#EXTM3U\n#EXT-X-MAP:URI="i.mp4"\n#EXTINF:2,\ns.mp4\n')).toBeNull();
    expect(newestSegment("#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2026-10-28T00:00:00Z\n#EXTINF:2,\ns.mp4\n")).toBeNull();
  });
});

describe("fetchW0", () => {
  const BASE = "http://mediamtx:8888";
  const PASSWORD = "pass/with+chars=";
  let init: Uint8Array<ArrayBuffer>;
  let seg: Uint8Array<ArrayBuffer>;
  beforeEach(async () => {
    init = await fixture("nob_init.mp4");
    seg = await fixture("nob_1.m4s");
  });

  /** A fake MediaMTX: routes by pathname, records requests. */
  function fake(overrides: Record<string, () => Response | Promise<Response>> = {}) {
    const requests: { url: string; auth: string | null }[] = [];
    const routes: Record<string, () => Response | Promise<Response>> = {
      "/live/alice/index.m3u8": () => new Response(MULTIVARIANT),
      "/live/alice/video1_stream.m3u8": () => new Response(MEDIA),
      "/live/alice/x_video1_init.mp4": () => new Response(init),
      "/live/alice/x_video1_seg27.mp4": () => new Response(seg),
      ...overrides,
    };
    const doFetch = (async (input: string | URL | Request, initArg?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const headers = new Headers(initArg?.headers);
      requests.push({ url: url.toString(), auth: headers.get("authorization") });
      const route = routes[url.pathname];
      return route ? route() : new Response("not found", { status: 404 });
    }) as typeof fetch;
    return { requests, doFetch };
  }

  test("multivariant → media playlist → init + newest segment only, with basic auth", async () => {
    const { requests, doFetch } = fake();
    const r = await fetchW0({ hlsBase: BASE, path: "live/alice", password: PASSWORD, fetch: doFetch });
    expect(r.handler).toBe("vide");
    expect(r.sample).toEqual({
      pdtMs: Date.parse("2026-10-28T00:53:49.377Z"),
      baseDecodeTime: 768_007_680,
      compositionOffset: 0,
      timescale: 15_360,
    });
    expect(r.w0Ms).toBeCloseTo(Date.parse("2026-10-28T00:53:49.377Z") - (50_000.5 - 10) * 1000, 3);
    expect(requests.map((q) => new URL(q.url).pathname)).toEqual([
      "/live/alice/index.m3u8",
      "/live/alice/video1_stream.m3u8",
      "/live/alice/x_video1_init.mp4",
      "/live/alice/x_video1_seg27.mp4",
    ]);
    // The session query is kept, credentials never go in a URL.
    expect(requests[2]?.url).toContain("session=s1");
    const expected = `Basic ${Buffer.from(`internal:${PASSWORD}`).toString("base64")}`;
    for (const q of requests) {
      expect(q.auth).toBe(expected);
      expect(q.url).not.toContain(PASSWORD);
      expect(q.url).not.toContain(encodeURIComponent(PASSWORD));
    }
  });

  test("follows MediaMTX's same-origin cookie-check redirect once, refuses another origin", async () => {
    let hops = 0;
    const ok = fake({
      "/live/alice/index.m3u8": () =>
        hops++ === 0
          ? new Response(null, { status: 302, headers: { location: "/live/alice/index.m3u8?cookieCheck=1" } })
          : new Response(MULTIVARIANT),
    });
    await expect(
      fetchW0({ hlsBase: BASE, path: "live/alice", password: "p", fetch: ok.doFetch }),
    ).resolves.toBeTruthy();
    expect(ok.requests[1]?.url).toContain("cookieCheck=1");

    const evil = fake({
      "/live/alice/index.m3u8": () => new Response(null, { status: 302, headers: { location: "http://evil.test/x" } }),
    });
    await expect(fetchW0({ hlsBase: BASE, path: "live/alice", password: "p", fetch: evil.doFetch })).rejects.toThrow(
      /cross-origin/,
    );
    expect(evil.requests.some((q) => q.url.startsWith("http://evil.test"))).toBe(false);
  });

  test("bounded: an overall timeout, and a size cap on declared and streamed bodies", async () => {
    const hang = fake({
      "/live/alice/x_video1_seg27.mp4": () => new Promise<Response>(() => {}),
    });
    // The fake honours no signal, so wrap it: abort rejects like fetch does.
    const withAbort = (async (input: string | URL | Request, init?: RequestInit) =>
      Promise.race([
        hang.doFetch(input, init),
        new Promise<Response>((_, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason as Error)),
        ),
      ])) as typeof fetch;
    const err = await fetchW0({
      hlsBase: BASE,
      path: "live/alice",
      password: "p",
      fetch: withAbort,
      timeoutMs: 50,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(W0Error);
    expect((err as W0Error).reason).toBe("timeout");

    const declared = fake({
      "/live/alice/x_video1_seg27.mp4": () => new Response(seg, { headers: { "content-length": "999999999" } }),
    });
    await expect(
      fetchW0({ hlsBase: BASE, path: "live/alice", password: "p", fetch: declared.doFetch, maxBytes: 4096 }),
    ).rejects.toMatchObject({ reason: "too_large" });

    const streamed = fake({
      "/live/alice/x_video1_seg27.mp4": () =>
        new Response(
          new ReadableStream({
            pull(c) {
              c.enqueue(new Uint8Array(1024));
            },
          }),
        ),
    });
    await expect(
      fetchW0({ hlsBase: BASE, path: "live/alice", password: "p", fetch: streamed.doFetch, maxBytes: 4096 }),
    ).rejects.toMatchObject({ reason: "too_large" });
  });

  test("errors name the path, never credentials; no segment yet is a playlist error", async () => {
    const down = fake({ "/live/alice/index.m3u8": () => new Response("no", { status: 404 }) });
    const err = (await fetchW0({ hlsBase: BASE, path: "live/alice", password: "hunter2", fetch: down.doFetch }).catch(
      (e: unknown) => e,
    )) as W0Error;
    expect(err.reason).toBe("http");
    expect(err.message).toContain("live/alice");
    expect(err.message).not.toContain("hunter2");

    const empty = fake({ "/live/alice/video1_stream.m3u8": () => new Response("#EXTM3U\n") });
    await expect(
      fetchW0({ hlsBase: BASE, path: "live/alice", password: "p", fetch: empty.doFetch }),
    ).rejects.toMatchObject({ reason: "playlist" });

    const garbage = fake({ "/live/alice/x_video1_seg27.mp4": () => new Response("not mp4") });
    await expect(
      fetchW0({ hlsBase: BASE, path: "live/alice", password: "p", fetch: garbage.doFetch }),
    ).rejects.toMatchObject({ reason: "segment" });
  });

  test("an audio-only source anchors on its audio track", async () => {
    const audioInit = await fixture("nob_init.mp4");
    const { doFetch } = fake({
      // Media playlist straight away (no variants), init with video and audio: video wins;
      // here the init is replaced by one whose only track is audio (track 2 of the fixture).
      "/live/alice/index.m3u8": () => new Response(MEDIA),
      "/live/alice/x_video1_init.mp4": () => new Response(audioOnly(audioInit)),
    });
    const r = await fetchW0({ hlsBase: BASE, path: "live/alice", password: "p", fetch: doFetch });
    expect(r.handler).toBe("soun");
    expect(r.sample.timescale).toBe(48_000);
    expect(r.sample.baseDecodeTime).toBe(2_400_024_576);
  });
});

/** The fixture init with its video trak renamed (`skip`), leaving the audio track. */
function audioOnly(init: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const out = init.slice();
  const text = new TextDecoder("latin1").decode(out);
  const at = text.indexOf("trak");
  out.set(new TextEncoder().encode("skip"), at);
  return out;
}

describe("recorder runs (R4)", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "clock-run-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("offset = W0 + first sample − raw PDT", () => {
    expect(runOffsetMs(1_000_000, 2.5, 1_002_400)).toBeCloseTo(100, 6);
    expect(runOffsetMs(1_000_000, 2.5, 1_002_600)).toBeCloseTo(-100, 6);
  });

  test("a W0 read in the other wrap representation still gives the small true offset", () => {
    const wrapMs = PTS_WRAP_SECONDS * 1000;
    const t = 3; // the run started just after the wrap: small fMP4 times
    const raw = 5_000_000;
    const w0 = raw - t * 1000 + 120;
    expect(runOffsetMs(w0, t, raw)).toBeCloseTo(120, 3);
    expect(runOffsetMs(w0 - wrapMs, t, raw)).toBeCloseTo(120, 3);
    expect(runOffsetMs(w0 + wrapMs, t, raw)).toBeCloseTo(120, 3);
  });

  test("first sample time of a recorder segment, from the head of the file", async () => {
    await Bun.write(join(dir, "init.mp4"), await fixture("nob_init.mp4"));
    await Bun.write(join(dir, "s.m4s"), await fixture("nob_1.m4s"));
    expect(await firstSampleSeconds(join(dir, "init.mp4"), join(dir, "s.m4s"))).toBe(50_000.5);
    await Bun.write(join(dir, "b.mp4"), await fixture("bf_init.mp4"));
    await Bun.write(join(dir, "b.m4s"), await fixture("bf_1.m4s"));
    expect(await firstSampleSeconds(join(dir, "b.mp4"), join(dir, "b.m4s"))).toBeCloseTo((7680 + 1024) / 15360, 9);
  });

  test("sidecars round-trip atomically; a missing or broken one reads as null", async () => {
    expect(await readSidecar(dir, "r1")).toBeNull();
    await writeSidecar(dir, { runId: "r1", w0Ms: 123.5, offsetMs: null });
    expect(await readSidecar(dir, "r1")).toEqual({ runId: "r1", w0Ms: 123.5, offsetMs: null });
    await writeSidecar(dir, { runId: "r1", w0Ms: 123.5, offsetMs: -42 });
    expect(await readSidecar(dir, "r1")).toEqual({ runId: "r1", w0Ms: 123.5, offsetMs: -42 });
    await Bun.write(join(dir, runSidecar("r2")), "{not json");
    expect(await readSidecar(dir, "r2")).toBeNull();
    await Bun.write(join(dir, runSidecar("r3")), JSON.stringify({ w0Ms: "x", offsetMs: 5 }));
    expect(await readSidecar(dir, "r3")).toEqual({ runId: "r3", w0Ms: null, offsetMs: 5 });
  });
});

describe("media clock", () => {
  function metrics() {
    const seen = { offset: [] as number[], residual: [] as number[], failures: [] as string[], drift: [] as number[] };
    const m: ClockMetrics = {
      recorderOffset: (ms) => seen.offset.push(ms),
      recorderResidual: (ms) => seen.residual.push(ms),
      w0Failure: (c) => seen.failures.push(c),
      w0Drift: (ms) => seen.drift.push(ms),
    };
    return { m, seen };
  }
  const result = (w0Ms: number): W0Result => ({
    w0Ms,
    handler: "vide",
    sample: { pdtMs: 0, baseDecodeTime: 0, compositionOffset: 0, timescale: 90_000 },
  });

  test("W0 drift for the same broadcast is reported; another broadcast starts fresh", async () => {
    const { m, seen } = metrics();
    const values = [1000, 1000, 1012.5, 5000];
    const clock = createMediaClock({
      hlsBase: "http://m",
      password: "p",
      logger: captureLogger().logger,
      metrics: m,
      fetchW0: async () => result(values.shift() ?? 0),
    });
    expect(await clock.w0("b1", "live/a", "ladder")).toBe(1000);
    expect(seen.drift).toEqual([]);
    await clock.w0("b1", "live/a", "recorder");
    await clock.w0("b1", "live/a", "aac");
    expect(seen.drift).toEqual([0, 12.5]);
    await clock.w0("b2", "live/b", "ladder");
    expect(seen.drift).toEqual([0, 12.5]);
    clock.forget("b1");
  });

  test("a failed W0 is counted by consumer, logged without credentials, and rethrown", async () => {
    const { m, seen } = metrics();
    const cap = captureLogger();
    const clock = createMediaClock({
      hlsBase: "http://m",
      password: "hunter2",
      logger: cap.logger,
      metrics: m,
      fetchW0: async () => {
        throw new W0Error("multivariant playlist of live/a: HTTP 404", "http");
      },
    });
    await expect(clock.w0("b1", "live/a", "ladder")).rejects.toThrow(W0Error);
    await expect(clock.w0("b1", "live/a", "recorder")).rejects.toThrow(W0Error);
    expect(seen.failures).toEqual(["ladder", "recorder"]);
    expect(JSON.stringify(cap.lines)).not.toContain("hunter2");
  });

  test("run offsets: 0 until set, per broadcast and run, cleared and forgotten", () => {
    const clock = createMediaClock({ hlsBase: "http://m", password: "p", logger: captureLogger().logger });
    expect(clock.offsetMs("b1", "r1")).toBe(0);
    clock.setRunOffset("b1", "r1", 250);
    clock.setRunOffset("b2", "r1", -9);
    expect(clock.offsetMs("b1", "r1")).toBe(250);
    expect(clock.offsetMs("b1", "r2")).toBe(0);
    expect(clock.offsetMs("b2", "r1")).toBe(-9);
    clock.setRunOffset("b1", "r1", null);
    expect(clock.offsetMs("b1", "r1")).toBe(0);
    clock.forget("b2");
    expect(clock.offsetMs("b2", "r1")).toBe(0);
  });

  test("recovery reads a run's offset from its sidecar, null without one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clock-sidecar-"));
    try {
      const clock = createMediaClock({ hlsBase: "http://m", password: "p", logger: captureLogger().logger });
      await writeSidecar(dir, { runId: "r1", w0Ms: 1, offsetMs: 77 });
      await writeSidecar(dir, { runId: "r2", w0Ms: 1, offsetMs: null });
      expect(await clock.sidecarOffsetMs(dir, "r1")).toBe(77);
      expect(await clock.sidecarOffsetMs(dir, "r2")).toBeNull();
      expect(await clock.sidecarOffsetMs(dir, "r3")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("host clock", () => {
  test("adjtimex states: TIME_ERROR is unsynchronized, an error is unknown", () => {
    expect(syncedFromState(0)).toBe(true);
    expect(syncedFromState(1)).toBe(true);
    expect(syncedFromState(4)).toBe(true);
    expect(syncedFromState(5)).toBe(false);
    expect(syncedFromState(-1)).toBeNull();
  });
});
