// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SegmentFetch } from "@commonair/contracts/internal";
import { describe, expect, test } from "vite-plus/test";
import { aggregate, minuteBucket, parseEntry } from "../src/segments/aggregate.ts";
import { BroadcastCache } from "../src/segments/consumer.ts";

const S1 = "0193e6a0-0000-7000-8000-000000000001";
const S2 = "0193e6a0-0000-7000-8000-000000000002";
const S3 = "0193e6a0-0000-7000-8000-000000000003";
const C = "0193e6a0-0000-7000-8000-0000000000cc";
const B1 = "0193e6a0-0000-7000-8000-0000000000b1";
const B2 = "0193e6a0-0000-7000-8000-0000000000b2";
const T0 = Date.parse("2026-05-01T12:00:00Z");

const f = (
  sid: string,
  src: SegmentFetch["src"],
  kind: SegmentFetch["kind"],
  bytes: number,
  at: number,
): SegmentFetch => ({
  sid,
  cid: C,
  src,
  kind,
  bytes,
  at,
});
const broadcasts: Record<string, string | null> = { [S1]: B1, [S2]: B2, [S3]: null };

describe("minuteBucket", () => {
  test("floors to the minute", () => {
    expect(minuteBucket(T0).toISOString()).toBe("2026-05-01T12:00:00.000Z");
    expect(minuteBucket(T0 + 59_999).toISOString()).toBe("2026-05-01T12:00:00.000Z");
    expect(minuteBucket(T0 + 60_000).toISOString()).toBe("2026-05-01T12:01:00.000Z");
    expect(minuteBucket(T0 - 1).toISOString()).toBe("2026-05-01T11:59:00.000Z");
  });
});

describe("aggregate", () => {
  test("sums bytes and requests per broadcast, minute and source", () => {
    const agg = aggregate(
      [
        f(S1, "origin", "segment", 1000, T0 + 1),
        f(S1, "origin", "playlist", 200, T0 + 2),
        f(S1, "origin", "segment", 1000, T0 + 61_000),
        f(S1, "relay", "segment", 500, T0 + 3),
        f(S2, "origin", "segment", 700, T0 + 4),
      ],
      (sid) => broadcasts[sid],
    );
    const rows = agg.egress
      .map(
        (r) =>
          `${r.broadcastId === B1 ? "b1" : "b2"} ${r.bucketStart.toISOString().slice(11, 16)} ${r.source} ${r.bytes}/${r.requests}`,
      )
      .sort();
    expect(rows).toEqual([
      "b1 12:00 origin 1200/2",
      "b1 12:00 relay 500/1",
      "b1 12:01 origin 1000/1",
      "b2 12:00 origin 700/1",
    ]);
  });

  test("session counters count media segments only and HTTP bytes only", () => {
    const agg = aggregate(
      [
        f(S1, "origin", "segment", 1000, T0),
        f(S1, "origin", "part", 300, T0),
        f(S1, "origin", "playlist", 200, T0),
        f(S1, "p2p", "segment", 900, T0),
        f(S1, "cdn", "segment", 100, T0),
        f(S1, "relay", "segment", 50, T0),
      ],
      (sid) => broadcasts[sid],
    );
    expect(agg.sessions).toEqual([{ sessionId: S1, segments: 4, bytesHttp: 1650 }]);
  });

  test("sessions without a broadcast update counters but produce no egress", () => {
    const agg = aggregate([f(S3, "origin", "segment", 10, T0)], (sid) => broadcasts[sid]);
    expect(agg.egress).toEqual([]);
    expect(agg.sessions).toEqual([{ sessionId: S3, segments: 1, bytesHttp: 10 }]);
  });

  test("empty input and zero-only sessions produce nothing", () => {
    expect(aggregate([], () => B1)).toEqual({ egress: [], sessions: [] });
    const agg = aggregate([f(S1, "p2p", "playlist", 0, T0)], () => B1);
    expect(agg.sessions).toEqual([]);
    expect(agg.egress).toHaveLength(1);
  });

  test("totals are conserved for a 200-viewer minute", () => {
    const fetches: SegmentFetch[] = [];
    for (let v = 0; v < 200; v++)
      for (let s = 0; s < 60; s++) fetches.push(f(v % 2 ? S1 : S2, "origin", "segment", 1234, T0 + s * 1000));
    const agg = aggregate(fetches, (sid) => broadcasts[sid]);
    expect(agg.egress.reduce((n, r) => n + r.bytes, 0)).toBe(200 * 60 * 1234);
    expect(agg.egress.reduce((n, r) => n + r.requests, 0)).toBe(12_000);
    expect(agg.sessions.reduce((n, s) => n + s.segments, 0)).toBe(12_000);
  });
});

describe("parseEntry", () => {
  test("decodes stream field pairs and coerces numbers", () => {
    expect(
      parseEntry(["sid", S1, "cid", C, "src", "origin", "kind", "segment", "bytes", "42", "at", String(T0)]),
    ).toEqual({ sid: S1, cid: C, src: "origin", kind: "segment", bytes: 42, at: T0 });
  });
  test("rejects malformed entries", () => {
    expect(parseEntry(["sid", "nope"])).toBeNull();
    expect(
      parseEntry(["sid", S1, "cid", C, "src", "satellite", "kind", "segment", "bytes", "1", "at", "1"]),
    ).toBeNull();
    expect(parseEntry(["sid", S1, "cid", C, "src", "origin", "kind", "segment", "bytes", "-1", "at", "1"])).toBeNull();
    expect(parseEntry([])).toBeNull();
  });
});

describe("BroadcastCache", () => {
  test("evicts the oldest entry at capacity and remembers nulls", () => {
    const c = new BroadcastCache(2);
    c.set("a", "1");
    c.set("b", null);
    expect(c.has("b")).toBe(true);
    expect(c.get("b")).toBeNull();
    c.set("c", "3");
    expect(c.has("a")).toBe(false);
    expect(c.get("c")).toBe("3");
  });
});
