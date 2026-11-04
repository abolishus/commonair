// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** B8-player's harness checks: the edge reports in `room.sync` frames, and the DVR fetch summary. */
import { describe, expect, it } from "vite-plus/test";
import { ROOM_LIMITS } from "@commonair/contracts/enums";
import { dvrFetchSummary, EDGE_CAP_SLACK_MS, edgeReportsOk, targetLeadOk, withinEdgeCap } from "../../src/b8/player.ts";
import {
  behindRoomEdgeAt,
  edgeSummary,
  syncFrameOf,
  targetFrameOf,
  targetLeadSummary,
  type PlayheadSample,
} from "../../src/w3/watch-rooms/sync.ts";

const ROOM = "01890000-0000-7000-8000-00000000a001";
const T0 = 1_800_000_000_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe("syncFrameOf: edgeWallclock", () => {
  const frame = (extra: Record<string, unknown>) =>
    JSON.stringify({ op: "room.sync", roomId: ROOM, playheadWallclock: iso(T0), mode: "live", ...extra });

  it("reads the edge, null, or nothing for an older client", () => {
    expect(syncFrameOf(frame({ edgeWallclock: iso(T0 + 3000) }), ROOM)).toEqual({
      pdt: T0,
      mode: "live",
      edge: T0 + 3000,
    });
    expect(syncFrameOf(frame({ edgeWallclock: null }), ROOM)).toEqual({ pdt: T0, mode: "live", edge: null });
    expect(syncFrameOf(frame({ edgeWallclock: "nope" }), ROOM)).toEqual({ pdt: T0, mode: "live", edge: null });
    expect(syncFrameOf(frame({}), ROOM)).toEqual({ pdt: T0, mode: "live" });
  });
});

const s = (sentAt: number, pdt: number, edge?: number | null, mode: "live" | "dvr" = "live"): PlayheadSample => ({
  sentAt,
  pdt,
  mode,
  ...(edge === undefined ? {} : { edge }),
});

describe("edgeSummary", () => {
  it("counts live frames with edges, edges behind the playhead and DVR frames with edges", () => {
    const sum = edgeSummary([
      s(T0, T0 - 8000, T0 - 3000),
      s(T0 + 2000, T0 - 6000, T0 - 1000),
      s(T0 + 4000, T0 - 4000, null),
      s(T0 + 6000, T0 - 2000, T0 - 3000),
      s(T0 + 8000, T0 - 60_000, T0, "dvr"),
      s(T0 + 10_000, T0 - 60_000, null, "dvr"),
    ]);
    expect(sum).toEqual({ live: 4, withEdge: 3, behindPlayhead: 1, dvrWithEdge: 1, medianLatencyMs: 5000 });
    expect(edgeSummary([])).toEqual({ live: 0, withEdge: 0, behindPlayhead: 0, dvrWithEdge: 0, medianLatencyMs: null });
  });

  it("edgeReportsOk wants edges on 80 % of live frames, none behind the playhead, none in DVR", () => {
    const ok = edgeSummary([1, 2, 3, 4, 5].map((i) => s(T0 + i, T0 - 5000, i === 5 ? null : T0 - 1000)));
    expect(edgeReportsOk(ok)).toBe(true);
    const sparse = edgeSummary([1, 2, 3, 4, 5].map((i) => s(T0 + i, T0 - 5000, i > 3 ? null : T0 - 1000)));
    expect(edgeReportsOk(sparse)).toBe(false);
    expect(edgeReportsOk({ ...ok, behindPlayhead: 1 })).toBe(false);
    expect(edgeReportsOk({ ...ok, dvrWithEdge: 1 })).toBe(false);
    expect(edgeReportsOk(edgeSummary([]))).toBe(false);
  });
});

describe("behindRoomEdgeAt", () => {
  it("measures every live member from max of the reported edges, extrapolated", () => {
    const samples = {
      near: [s(T0, T0 - 3000, T0 - 1000)],
      far: [s(T0 - 1000, T0 - 7000, T0 - 2500)],
      dvr: [s(T0, T0 - 60_000, null, "dvr")],
    };
    // far's edge at T0 is T0 - 1500; near's T0 - 1000 is the max.
    expect(behindRoomEdgeAt(samples, T0)).toEqual({ near: 2000, far: 5000 });
  });

  it("null without any edge; stale members are left out", () => {
    expect(behindRoomEdgeAt({ a: [s(T0, T0 - 3000)] }, T0)).toBeNull();
    expect(behindRoomEdgeAt({ a: [s(T0, T0 - 3000, T0)], b: [s(T0 - 10_000, T0 - 20_000, T0 - 10_000)] }, T0)).toEqual({
      a: 3000,
    });
  });

  it("withinEdgeCap allows the cap plus slack, for every member", () => {
    const cap = 5000 + EDGE_CAP_SLACK_MS;
    expect(withinEdgeCap({ a: cap, b: 1000 }, ["a", "b"])).toBe(true);
    expect(withinEdgeCap({ a: cap + 1, b: 1000 }, ["a", "b"])).toBe(false);
    expect(withinEdgeCap({ a: 1000 }, ["a", "b"])).toBe(false);
    expect(withinEdgeCap(null, ["a"])).toBe(false);
  });
});

describe("dvrFetchSummary", () => {
  const hosts = { relay: "http://192.168.1.5:7443", origin: "http://localhost:3003" };
  it("splits by source, counts 403s and finds the first origin success after `since`", () => {
    const sum = dvrFetchSummary(
      [
        { origin: "http://192.168.1.5:7443", status: 200, at: T0 - 1000 },
        { origin: "http://192.168.1.5:7443", status: 200, at: T0 + 1000 },
        { origin: "http://192.168.1.5:7443", status: 403, at: T0 + 2000 },
        { origin: "http://localhost:3003", status: 200, at: T0 + 5000 },
        { origin: "http://localhost:3003", status: 200, at: T0 + 3000 },
        { origin: "https://cdn.example.invalid", status: 200, at: T0 + 6000 },
      ],
      hosts,
      T0,
    );
    expect(sum).toEqual({
      relay: 2,
      origin: 2,
      other: 1,
      forbidden: 1,
      lastRelayAt: T0 + 2000,
      firstOriginOkAt: T0 + 3000,
    });
  });

  it("a failed origin fetch is not a success", () => {
    const sum = dvrFetchSummary([{ origin: "http://localhost:3003", status: 404, at: T0 }], hosts, T0);
    expect(sum.firstOriginOkAt).toBeNull();
    expect(sum.origin).toBe(1);
  });
});

describe("targetFrameOf", () => {
  it("reads the server's target for this room only", () => {
    expect(targetFrameOf(JSON.stringify({ op: "room.sync", roomId: ROOM, target: iso(T0) }), ROOM)).toBe(T0);
    expect(targetFrameOf(JSON.stringify({ op: "room.sync", roomId: "other", target: iso(T0) }), ROOM)).toBeNull();
    // A client frame (playheadWallclock, no target), junk, a bad date.
    expect(
      targetFrameOf(JSON.stringify({ op: "room.sync", roomId: ROOM, playheadWallclock: iso(T0) }), ROOM),
    ).toBeNull();
    expect(targetFrameOf("not json", ROOM)).toBeNull();
    expect(targetFrameOf(JSON.stringify({ op: "room.sync", roomId: ROOM, target: "nope" }), ROOM)).toBeNull();
  });
});

describe("targetLeadSummary and targetLeadOk", () => {
  const CAP = ROOM_LIMITS.edgeCapSeconds * 1000;
  // Both members synced near the target; the edges they report sit ahead of it.
  const samples = {
    near: [s(T0, T0 - 5000, T0), s(T0 + 2000, T0 - 3000, T0 + 2000)],
    far: [s(T0 + 500, T0 - 4500, T0 - 3500), s(T0 + 2500, T0 - 2500, T0 - 1500)],
  };

  it("batch 8: the target sits the cap behind max(edgeWallclock)", () => {
    const targets = [1000, 2000, 3000].map((d) => ({ receivedAt: T0 + d, target: T0 + d - CAP }));
    const lead = targetLeadSummary(samples, targets, T0, T0 + 3000);
    expect(lead).toEqual({ measured: 3, medianMs: CAP, minMs: CAP, maxMs: CAP });
    expect(targetLeadOk(lead)).toBe(true);
  });

  it("the batch 7 estimate (a target set from the playheads, 3 s nearer the edge) fails", () => {
    const targets = [1000, 2000, 3000].map((d) => ({ receivedAt: T0 + d, target: T0 + d - CAP + 3000 }));
    const lead = targetLeadSummary(samples, targets, T0, T0 + 3000);
    expect(lead.medianMs).toBe(CAP - 3000);
    expect(targetLeadOk(lead)).toBe(false);
  });

  it("frames outside the window, or without an edge, are not measured; too few fail", () => {
    const targets = [
      { receivedAt: T0 + 1000, target: T0 - 4000 },
      { receivedAt: T0 + 60_000, target: T0 },
    ];
    expect(targetLeadSummary(samples, targets, T0, T0 + 3000).measured).toBe(1);
    expect(targetLeadOk(targetLeadSummary(samples, targets, T0, T0 + 3000))).toBe(false);
    const noEdges = { near: [s(T0, T0 - 5000)] };
    expect(targetLeadSummary(noEdges, targets, T0, T0 + 3000)).toEqual({
      measured: 0,
      medianMs: null,
      minMs: null,
      maxMs: null,
    });
  });
});
