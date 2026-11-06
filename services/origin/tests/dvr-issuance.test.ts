// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  decodeDvrObject,
  DVR_ISSUANCE_SPAN_SECONDS,
  DVR_PULLS_GRACE_MS,
  DVR_PULLS_SLACK_MS,
  dvrAllowance,
  DvrPullStore,
  dvrPullsKey,
  encodeDvrObject,
  type DvrObject,
} from "../src/dvr-issuance.ts";
import { noopMetrics, type OriginMetrics } from "../src/metrics.ts";

const VOD = "0190a0a0-0000-7000-8000-0000000000d1";
const seg = (i: number, bytes: number, durationMs = 4000): DvrObject => ({
  file: `r1_${String(i).padStart(6, "0")}.m4s`,
  bytes,
  durationMs,
});
const init = (bytes: number, file = "r1_init.mp4"): DvrObject => ({ file, bytes, durationMs: 0 });

describe("member encoding", () => {
  test("round-trips, and anything malformed is dropped", () => {
    const o = seg(7, 123_456);
    expect(encodeDvrObject(o)).toBe("123456:4000:r1_000007.m4s");
    expect(decodeDvrObject(encodeDvrObject(o))).toEqual(o);
    expect(decodeDvrObject(encodeDvrObject(init(9)))).toEqual(init(9));
    for (const bad of ["", "x:1:f", "1:x:f", "1:1:", "-1:1:f", "1:-1:f", "1:1", "1234567890123456:1:f"])
      expect(decodeDvrObject(bad)).toBeNull();
  });
});

describe("dvrAllowance", () => {
  test("the heaviest segments until they cover the span plus one segment, plus the largest init", () => {
    // 40 uniform 4 s segments of rising size: 120 s + 4 s needs the 31 heaviest.
    const objects = [...Array.from({ length: 40 }, (_, i) => seg(i, 1000 + i)), init(50), init(70, "r2_init.mp4")];
    const heaviest = Array.from({ length: 31 }, (_, i) => 1000 + 39 - i).reduce((a, b) => a + b, 0);
    expect(dvrAllowance(objects)).toEqual({ segments: 32, bytes: heaviest + 70 });
  });

  test("covers any contiguous 120 s of uniform segments", () => {
    const sizes = Array.from({ length: 60 }, (_, i) => ((i * 7919) % 97) * 1000 + 500);
    const objects = sizes.map((b, i) => seg(i, b));
    const allow = dvrAllowance(objects);
    // A run of playback of 120 s starting inside a segment touches 31 segments.
    for (let start = 0; start + 31 <= sizes.length; start++) {
      const run = sizes.slice(start, start + 31).reduce((a, b) => a + b, 0);
      expect(allow.bytes).toBeGreaterThanOrEqual(run);
    }
  });

  test("short segments (a stream restart) cannot outweigh or outnumber the allowance", () => {
    // 60 long 8 s segments of 1000 bytes, and 40 short 1 s segments of 900 bytes after a restart.
    const long = Array.from({ length: 60 }, (_, i) => seg(i, 1000, 8000));
    const short = Array.from({ length: 40 }, (_, i) => seg(100 + i, 900, 1000));
    const allow = dvrAllowance([...long, ...short]);
    // 120 s + 8 s: the densest are the short ones (900 B/s), then 11 long ones to reach 128 s.
    expect(allow).toEqual({ segments: 40 + 11, bytes: 40 * 900 + 11 * 1000 });
    // Any contiguous run lasting 128 s or less: the 40 short ones plus 11 long, at most.
    const ordered = [...long, ...short];
    for (let start = 0; start < ordered.length; start++) {
      let ms = 0;
      let bytes = 0;
      let n = 0;
      for (let i = start; i < ordered.length && ms + (ordered[i]?.durationMs ?? 0) <= 128_000; i++) {
        ms += ordered[i]?.durationMs ?? 0;
        bytes += ordered[i]?.bytes ?? 0;
        n++;
      }
      expect(allow.bytes).toBeGreaterThanOrEqual(bytes);
      expect(allow.segments).toBeGreaterThanOrEqual(n);
    }
  });

  test("fewer pulls than the span: all of them", () => {
    expect(dvrAllowance([seg(0, 10), seg(1, 20), init(5)])).toEqual({ segments: 3, bytes: 35 });
  });

  test("nothing pulled, or only an init: nothing issued", () => {
    expect(dvrAllowance([])).toEqual({ segments: 0, bytes: 0 });
    expect(dvrAllowance([init(500)])).toEqual({ segments: 0, bytes: 0 });
  });

  test("a file listed twice counts once, at its larger size", () => {
    expect(dvrAllowance([seg(0, 10), seg(0, 30), seg(1, 20)])).toEqual({ segments: 2, bytes: 50 });
  });

  test("the span is a parameter; zero still covers the one segment a seek lands in", () => {
    const objects = [seg(0, 10), seg(1, 30), seg(2, 20)];
    expect(dvrAllowance(objects, 0)).toEqual({ segments: 1, bytes: 30 });
    expect(dvrAllowance(objects, 4)).toEqual({ segments: 2, bytes: 50 });
  });

  test("the default span is two minutes of media", () => {
    expect(DVR_ISSUANCE_SPAN_SECONDS).toBe(120);
  });
});

describe("DvrPullStore", () => {
  test("records through one atomic script: add, trim past window + grace, expire", async () => {
    const calls: unknown[][] = [];
    const store = new DvrPullStore({
      valkey: {
        eval: (async (...args: unknown[]) => (calls.push(args), 1)) as never,
        zrangebyscore: (async () => []) as never,
      },
      windowSeconds: 60,
    });
    store.record(VOD, seg(3, 999), 10_000_000);
    await store.flush();
    const keep = 60_000 + DVR_PULLS_SLACK_MS + DVR_PULLS_GRACE_MS;
    expect(calls[0]?.slice(1)).toEqual([
      1,
      dvrPullsKey(VOD),
      10_000_000,
      "999:4000:r1_000003.m4s",
      10_000_000 - keep,
      keep,
    ]);
  });

  test("servable reads pulls in [start − window − slack, end) and drops malformed members", async () => {
    const reads: unknown[][] = [];
    const store = new DvrPullStore({
      valkey: {
        eval: (async () => 1) as never,
        zrangebyscore: (async (...args: unknown[]) => (
          reads.push(args),
          ["10:4000:a.m4s", "junk", "0:0:r1_init.mp4"]
        )) as never,
      },
      windowSeconds: 30,
    });
    expect(await store.servable(VOD, 120_000, 180_000)).toEqual([
      { file: "a.m4s", bytes: 10, durationMs: 4000 },
      { file: "r1_init.mp4", bytes: 0, durationMs: 0 },
    ]);
    expect(reads).toEqual([[dvrPullsKey(VOD), 120_000 - 30_000 - DVR_PULLS_SLACK_MS, "(180000"]]);
  });

  test("Valkey failures and a full write queue are counted, never thrown at callers", async () => {
    let dropped = 0;
    const metrics: OriginMetrics = {
      ...noopMetrics,
      accountingDropped: (what, n) => void (what === "dvr_pulls" && (dropped += n)),
    };
    const failing = new DvrPullStore({
      valkey: { eval: (() => Promise.reject(new Error("down"))) as never, zrangebyscore: (async () => []) as never },
      windowSeconds: 60,
      metrics,
    });
    failing.record(VOD, seg(0, 1), 0);
    await failing.flush();
    expect(dropped).toBe(1);
    const stuck = new DvrPullStore({
      valkey: { eval: (() => new Promise(() => {})) as never, zrangebyscore: (async () => []) as never },
      windowSeconds: 60,
      metrics,
      maxPending: 2,
    });
    for (let i = 0; i < 5; i++) stuck.record(VOD, seg(i, 1), 0);
    expect(dropped).toBe(4);
  });
});
