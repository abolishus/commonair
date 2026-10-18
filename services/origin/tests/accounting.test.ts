// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import type { SegmentFetch } from "@commonair/contracts/internal";
import type { Executor } from "@commonair/db";
import { EgressAccumulator, ProductionTracker, SegmentLog, minuteOf } from "../src/accounting.ts";
import type { OriginMetrics } from "../src/metrics.ts";
import { noopMetrics } from "../src/metrics.ts";

const SID = "0190a0a0-0000-7000-8000-000000000001";
const CID = "0190a0a0-0000-7000-8000-000000000002";
const RID = "0190a0a0-0000-7000-8000-000000000003";
const entry = (i: number, rid?: string): SegmentFetch => ({
  sid: SID,
  cid: CID,
  src: rid ? "relay" : "origin",
  ...(rid ? { rid } : {}),
  kind: "segment",
  bytes: i,
  at: 1000 + i,
});

function fakeValkey(fail = { value: false }) {
  const calls: unknown[][] = [];
  let execs = 0;
  return {
    calls,
    get execs() {
      return execs;
    },
    pipeline() {
      const queued: unknown[][] = [];
      const p = {
        xadd: (...args: unknown[]) => (queued.push(args), p),
        exec: async () => {
          execs++;
          if (fail.value) throw new Error("ECONNREFUSED");
          calls.push(...queued);
          return queued.map(() => [null, "1-0"]);
        },
      };
      return p;
    },
  };
}

function countingMetrics() {
  const dropped: Record<string, number> = {};
  const m: OriginMetrics = {
    ...noopMetrics,
    accountingDropped: (what, n) => void (dropped[what] = (dropped[what] ?? 0) + n),
  };
  return { m, dropped };
}

describe("SegmentLog", () => {
  test("pipelines XADDs with MAXLEN and the SegmentFetch fields", async () => {
    const v = fakeValkey();
    const log = new SegmentLog({ valkey: v as never, stream: "test:segments", maxLen: 50 });
    log.record(entry(1));
    log.record(entry(2, RID));
    await log.flush();
    expect(v.execs).toBe(1);
    expect(v.calls[0]).toEqual([
      "test:segments",
      "MAXLEN",
      "~",
      50,
      "*",
      "sid",
      SID,
      "cid",
      CID,
      "src",
      "origin",
      "kind",
      "segment",
      "bytes",
      "1",
      "at",
      "1001",
    ]);
    expect(v.calls[1]).toContain("rid");
    expect(log.written).toBe(2);
    expect(log.buffered).toBe(0);
  });

  test("a full batch triggers a flush without waiting for the timer", async () => {
    const v = fakeValkey();
    const log = new SegmentLog({ valkey: v as never, stream: "s", batchSize: 3 });
    for (let i = 0; i < 3; i++) log.record(entry(i));
    await Bun.sleep(1);
    expect(v.calls).toHaveLength(3);
  });

  test("keeps entries while Valkey is down, bounded, and delivers them later", async () => {
    const fail = { value: true };
    const v = fakeValkey(fail);
    const { m, dropped } = countingMetrics();
    const log = new SegmentLog({ valkey: v as never, stream: "s", maxBuffer: 5, batchSize: 100, metrics: m });
    for (let i = 0; i < 7; i++) log.record(entry(i));
    expect(dropped.segment_fetch).toBe(2);
    await log.flush();
    expect(log.buffered).toBe(5);
    fail.value = false;
    await log.flush();
    expect(v.calls).toHaveLength(5);
    expect(log.buffered).toBe(0);
  });

  test("stop() flushes what is left", async () => {
    const v = fakeValkey();
    const log = new SegmentLog({ valkey: v as never, stream: "s", flushMs: 60_000 });
    log.start();
    log.record(entry(1));
    await log.stop();
    expect(v.calls).toHaveLength(1);
  });
});

function fakeDb(fail = { value: false }) {
  const inserted: Record<string, unknown>[][] = [];
  const db = {
    insert: () => ({
      values: (rows: Record<string, unknown>[]) => ({
        onConflictDoUpdate: async () => {
          if (fail.value) throw new Error("db down");
          inserted.push(rows);
        },
      }),
    }),
  };
  return { db: db as unknown as Executor, inserted };
}

describe("EgressAccumulator", () => {
  const B = "0190a0a0-0000-7000-8000-0000000000bb";
  test("aggregates by broadcast × minute × source", async () => {
    const { db, inserted } = fakeDb();
    const e = new EgressAccumulator({ db });
    e.add(B, "origin", 100, 60_000);
    e.add(B, "origin", 50, 119_999);
    e.add(B, "origin", 7, 120_000);
    e.add(B, "relay", 1, 60_001);
    await e.flush();
    expect(inserted).toHaveLength(1);
    const rows = (inserted[0] ?? []).map((r) => ({ ...r, bucketStart: (r.bucketStart as Date).getTime() }));
    expect(rows).toEqual([
      { broadcastId: B, bucketStart: 60_000, source: "origin", bytes: 150, requests: 2 },
      { broadcastId: B, bucketStart: 120_000, source: "origin", bytes: 7, requests: 1 },
      { broadcastId: B, bucketStart: 60_000, source: "relay", bytes: 1, requests: 1 },
    ]);
    expect(e.pending()).toEqual([]);
  });

  test("a failed flush keeps the totals for the next attempt (no loss, no double count)", async () => {
    const fail = { value: true };
    const { db, inserted } = fakeDb(fail);
    const e = new EgressAccumulator({ db });
    e.add(B, "cdn", 10, 0);
    await e.flush();
    e.add(B, "cdn", 5, 0);
    expect(e.pending()).toMatchObject([{ bytes: 15, requests: 2 }]);
    fail.value = false;
    await e.flush();
    expect(inserted[0]).toMatchObject([{ bytes: 15, requests: 2 }]);
  });

  test("bounded number of cells", () => {
    const { db } = fakeDb();
    const { m, dropped } = countingMetrics();
    const e = new EgressAccumulator({ db, maxCells: 2, metrics: m });
    for (let i = 0; i < 4; i++) e.add(B, "origin", 1, i * 60_000);
    expect(e.pending()).toHaveLength(2);
    expect(dropped.egress).toBe(2);
  });
});

describe("ProductionTracker", () => {
  test("counts each segment once, in the minute it first appears", () => {
    const p = new ProductionTracker();
    p.notePlaylist("live/a", "live/a", ["s1", "s2"], 10_000);
    p.notePlaylist("live/a", "live/a", ["s1", "s2", "s3"], 20_000);
    p.notePlaylist("live/a", "live/a", ["s2", "s3", "s4"], 61_000);
    expect(p.get("live/a", 0)?.get("live/a")?.segments).toBe(3);
    expect(p.get("live/a", 60_000)?.get("live/a")?.segments).toBe(1);
  });

  test("tracks segment and part bytes per directory", () => {
    const p = new ProductionTracker();
    p.noteObject("live/a", "live/a", "segment", 1000, 5);
    p.noteObject("live/a", "live/a", "part", 300, 6);
    p.noteObject("live/a", "live/a/720p", "segment", 400, 7);
    expect(p.get("live/a", 0)?.get("live/a")).toEqual({ segments: 0, segmentBytes: 1000, partBytes: 300 });
    expect(p.get("live/a", 0)?.get("live/a/720p")?.segmentBytes).toBe(400);
  });

  test("prunes old minutes and seen names", () => {
    const p = new ProductionTracker(60_000);
    p.notePlaylist("live/a", "live/a", ["s1"], 0);
    p.prune(200_000);
    expect(p.get("live/a", 0)).toBeUndefined();
    // After pruning, the name may be counted again (it has long left the live window anyway).
    p.notePlaylist("live/a", "live/a", ["s1"], 200_000);
    expect(p.get("live/a", minuteOf(200_000))?.get("live/a")?.segments).toBe(1);
  });
});
