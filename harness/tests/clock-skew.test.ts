// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  type ClockSample,
  coverage,
  coveredMs,
  crossRenditionSkews,
  errorOf,
  judgeCoverage,
  liveToVodSkews,
  nearest,
  protocolSkew,
  renditionOfUri,
  skewMetrics,
} from "../src/clock-skew.ts";
import { pickMediaContainer, recorderKillScript } from "../src/clock-skew-io.ts";

const T = 1_793_000_000_000;
/** A sample of `rendition` captured at T + `at` ms whose PDT is off by `e` ms. */
const s = (rendition: string, at: number, e: number): ClockSample => ({
  rendition,
  stripMs: T + at,
  pdtMs: T + at + e,
});

describe("pairing", () => {
  test("e is PDT minus the strip", () => {
    expect(errorOf(s("source", 0, 312))).toBe(312);
  });

  test("nearest capture time, only within the window", () => {
    const pool = [s("source", 0, 0), s("source", 2000, 0), s("source", 4000, 0)];
    expect(nearest(pool, T + 2600, 1000)?.stripMs).toBe(T + 2000);
    expect(nearest(pool, T + 3100, 1000)?.stripMs).toBe(T + 4000);
    expect(nearest(pool, T + 9000, 1000)).toBeNull();
    expect(nearest([], T, 1000)).toBeNull();
  });
});

describe("cross-rendition skew", () => {
  test("per source instant, max(e) − min(e) over the source and its paired rungs", () => {
    const samples = [
      s("source", 0, 300),
      s("720p", 0, 312),
      s("480p", 0, 290),
      s("source", 2000, 300),
      s("720p", 2010, 305), // nearest source sample within one segment
    ];
    expect(crossRenditionSkews(samples, 1000)).toEqual([22, 5]);
  });

  test("a rung sample with no source sample near it, and the VOD, are left out", () => {
    const samples = [s("source", 0, 300), s("720p", 5000, 900), s("vod", 0, 5000)];
    expect(crossRenditionSkews(samples, 1000)).toEqual([]);
  });

  test("two samples of one rung on one instant count their spread", () => {
    const samples = [s("source", 0, 300), s("720p", -100, 300), s("720p", 100, 340)];
    expect(crossRenditionSkews(samples, 1000)).toEqual([40]);
  });

  test("a constant offset between restarts shows up on every instant", () => {
    const samples = Array.from({ length: 10 }, (_, i) => [s("source", i * 2000, 250), s("480p", i * 2000, 270)]).flat();
    expect(crossRenditionSkews(samples, 1000)).toEqual(Array(10).fill(20));
  });
});

describe("live-to-VOD skew", () => {
  test("|e_vod − e_source| against the nearest source capture time", () => {
    const source = [s("source", 0, 300), s("source", 2000, 300), s("source", 4000, 300)];
    const vod = [s("vod", 100, 420), s("vod", 4000, 180), s("vod", 60_000, 0)];
    expect(liveToVodSkews(source, vod, 4000)).toEqual([120, 120]);
  });
});

describe("coverage", () => {
  test("samples merge into intervals across gaps up to the limit", () => {
    expect(coverage([0, 1000, 2000, 9000, 10000], 2000)).toEqual([
      { from: 0, to: 2000 },
      { from: 9000, to: 10000 },
    ]);
    expect(coverage([], 2000)).toEqual([]);
  });

  test("covered time overall and inside a window", () => {
    const iv = [
      { from: 0, to: 2000 },
      { from: 9000, to: 10000 },
    ];
    expect(coveredMs(iv)).toBe(3000);
    expect(coveredMs(iv, { from: 1500, to: 9500 })).toBe(1000);
    expect(coveredMs(iv, { from: 3000, to: 8000 })).toBe(0);
  });

  test("every rendition ≥ 2 min, rungs present in the minute after the restart", () => {
    const every = (rendition: string, from: number, to: number) =>
      Array.from({ length: Math.floor((to - from) / 2000) + 1 }, (_, i) => s(rendition, from + i * 2000, 0));
    const restartAt = T + 300_000;
    const samples = [
      ...every("source", 0, 400_000),
      ...every("720p", 0, 130_000),
      ...every("720p", 300_000, 400_000),
      // 480p came back but only 30 s after the restart: it misses most of the minute after.
      ...every("480p", 0, 130_000),
      ...every("480p", 330_000, 400_000),
      ...every("vod", 0, 400_000),
    ];
    const rule = { minTotalMs: 120_000, restartAt, afterRestartMs: 60_000, afterRestartFraction: 0.8, gapMs: 5_000 };
    const judged = judgeCoverage(samples, rule);
    expect(judged.map((r) => [r.rendition, r.ok])).toEqual([
      ["480p", false],
      ["720p", true],
      ["source", true],
    ]);
    expect(judged.find((r) => r.rendition === "720p")?.afterRestartMs).toBe(60_000);
    // Without a restart, only the total counts.
    expect(judgeCoverage(samples, { ...rule, restartAt: null }).every((r) => r.ok)).toBe(true);
    expect(judgeCoverage(every("720p", 0, 100_000), { ...rule, restartAt: null })[0]?.ok).toBe(false);
  });
});

describe("per-protocol summary", () => {
  test("p95 and max per protocol; overall metrics are the worst protocol", () => {
    const rtmp = protocolSkew(
      {
        protocol: "rtmp",
        live: [s("source", 0, 300), s("720p", 0, 310), s("source", 2000, 300), s("720p", 2000, 340)],
        vod: [s("vod", 0, 350)],
      },
      { liveGapMs: 1000, vodGapMs: 4000 },
    );
    const whip = protocolSkew(
      { protocol: "whip", live: [s("source", 0, 900), s("480p", 0, 905)], vod: [s("vod", 0, 1100)] },
      { liveGapMs: 1000, vodGapMs: 4000 },
    );
    expect(rtmp.crossRendition).toEqual({ samples: 2, p95: 40, max: 40 });
    expect(rtmp.liveToVod).toEqual({ samples: 1, p95: 50, max: 50 });
    expect(rtmp.renditions).toEqual(["720p", "source"]);
    const metrics = Object.fromEntries(skewMetrics([rtmp, whip]).map((m) => [m.name, m.value]));
    expect(metrics).toMatchObject({
      "crossRenditionSkewP95Ms.rtmp": 40,
      "crossRenditionSkewP95Ms.whip": 5,
      crossRenditionSkewP95Ms: 40,
      "liveToVodSkewP95Ms.whip": 200,
      liveToVodSkewP95Ms: 200,
      liveToVodSkewMaxMs: 200,
    });
  });

  test("a protocol without samples makes the overall metric unknown, not optimistic", () => {
    const empty = protocolSkew({ protocol: "whip", live: [], vod: [] }, { liveGapMs: 1000, vodGapMs: 4000 });
    const ok = protocolSkew(
      { protocol: "rtmp", live: [s("source", 0, 0), s("720p", 0, 10)], vod: [] },
      { liveGapMs: 1000, vodGapMs: 4000 },
    );
    const metrics = Object.fromEntries(skewMetrics([ok, empty]).map((m) => [m.name, m.value]));
    expect(metrics["crossRenditionSkewP95Ms.rtmp"]).toBe(10);
    expect(metrics["crossRenditionSkewP95Ms.whip"]).toBeNull();
    expect(metrics.crossRenditionSkewP95Ms).toBeNull();
  });
});

describe("origin variants and the media container", () => {
  test("rendition names from synthesized variant URIs", () => {
    expect(renditionOfUri("video1_stream.m3u8?t=x")).toBe("source");
    expect(renditionOfUri("720p/video1_stream.m3u8?t=x")).toBe("720p");
    expect(renditionOfUri("/hls/live/alice/480p/video1_stream.m3u8")).toBe("480p");
    expect(renditionOfUri("/hls/live/alice/video1_stream.m3u8")).toBe("source");
    expect(renditionOfUri("aac/video1_stream.m3u8")).toBe("aac");
  });

  test("the media container under compose or Quadlet, never another service", () => {
    expect(pickMediaContainer(["commonair_api_1", "commonair_media_1"])).toBe("commonair_media_1");
    expect(pickMediaContainer(["commonair-mediamtx-1", "commonair-media-1"])).toBe("commonair-media-1");
    expect(pickMediaContainer(["commonair-mediamtx", "commonair-media"])).toBe("commonair-media");
    expect(pickMediaContainer(["commonair-mediamtx", "commonair-web"])).toBeNull();
  });

  test("the recorder kill script targets one broadcast's recorder and refuses anything but a UUID", () => {
    const id = "0192f3a4-5b6c-7d8e-9f01-000000000001";
    const script = recorderKillScript(id);
    expect(script).toContain(`/broadcasts/${id}/r[0-9a-z]*\\.m3u8`);
    expect(script).toContain("kill -TERM");
    expect(() => recorderKillScript("x; rm -rf /")).toThrow(/UUID/);
  });
});
