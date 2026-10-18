// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import type { SegmentFetch } from "@commonair/contracts/internal";
import { SegmentLog } from "../src/accounting.ts";
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

