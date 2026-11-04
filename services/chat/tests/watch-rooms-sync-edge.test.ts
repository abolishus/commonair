// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 8 (B8-player, W3-watch-rooms review MEDIUM 1): the room sync edge is `max(edgeWallclock)`
 * of the live members reporting one, with the remembered estimate as the fallback for older
 * clients, and reports ahead of chat's clock dropped.
 */
import { describe, expect, test } from "vite-plus/test";
import type { RoomSyncReport } from "@commonair/contracts/internal";
import { EDGE_SKEW_MS, SYNC_STALE_MS, syncState, syncTarget } from "../src/watch-rooms/sync.ts";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");

/** A live report made `ago` ms before NOW: playhead and edge at `NOW - ago + offset`. */
const live = (headOffset: number, edgeOffset: number | null | undefined, ago = 0): RoomSyncReport => ({
  playheadWallclock: new Date(NOW - ago + headOffset).toISOString(),
  mode: "live",
  at: NOW - ago,
  ...(edgeOffset === undefined
    ? {}
    : { edgeWallclock: edgeOffset === null ? null : new Date(NOW - ago + edgeOffset).toISOString() }),
});
/** A report at `t`, playhead and edge relative to `t`. */
const liveAt = (t: number, headOffset: number, edgeOffset?: number): RoomSyncReport => ({
  playheadWallclock: new Date(t + headOffset).toISOString(),
  mode: "live",
  at: t,
  ...(edgeOffset === undefined ? {} : { edgeWallclock: new Date(t + edgeOffset).toISOString() }),
});
const dvrAt = (t: number): RoomSyncReport => ({
  playheadWallclock: new Date(t - 600_000).toISOString(),
  mode: "dvr",
  at: t,
  edgeWallclock: null,
});

describe("the edge from reports", () => {
  test("the edge is max(edgeWallclock); the target is the slowest within the cap of it", () => {
    // Edges 3 s and 1 s behind now: the edge is NOW - 1000, so the cap point is NOW - 6000.
    const s = syncState({ reports: [live(-4000, -3000), live(-9000, -1000)], now: NOW });
    expect(s).toEqual({ target: NOW - 6000, edge: { edge: NOW - 1000, at: NOW } });
    // Within the cap: the slowest member.
    expect(syncTarget({ reports: [live(-4000, -3000), live(-5000, -1000)], now: NOW })).toBe(NOW - 5000);
  });

  test("members on different sources: wall-clock edges, not offsets", () => {
    // A relay member 2 s behind its edge (6 s behind now), an origin member 3 s behind its edge (4 s).
    const s = syncState({ reports: [live(-6000, -4000), live(-4000, -1000)], now: NOW });
    expect(s?.edge.edge).toBe(NOW - 1000);
    expect(s?.target).toBe(NOW - 6000);
  });

  test("a reported edge replaces the remembered one, ahead or behind", () => {
    const ahead = { edge: NOW + 500, at: NOW };
    expect(syncState({ reports: [live(-9000, -2000)], now: NOW, prevEdge: ahead })?.edge.edge).toBe(NOW - 2000);
    const behind = { edge: NOW - 20_000, at: NOW };
    expect(syncState({ reports: [live(-9000, -2000)], now: NOW, prevEdge: behind })?.edge.edge).toBe(NOW - 2000);
  });

  test("the leader steering back does not drag the room: the reported edge holds", () => {
    for (let i = 0; i < 10; i++) {
      const t = NOW + i * 2000;
      expect(syncTarget({ reports: [liveAt(t, -7000, -2000), liveAt(t, -10_000, -2000)], now: t })).toBe(t - 7000);
    }
  });

  test("edges are extrapolated with the report's age", () => {
    // Reported 1.5 s ago at 2 s behind: still 2 s behind now.
    const s = syncState({ reports: [live(-8000, -2000, 1500)], now: NOW });
    expect(s?.edge.edge).toBe(NOW - 2000);
    expect(s?.target).toBe(NOW - 7000);
  });

  test("a stale or DVR report's edge is left out", () => {
    const stale = live(-3000, 0, SYNC_STALE_MS + 1);
    expect(syncState({ reports: [live(-9000, -4000), stale], now: NOW })?.edge.edge).toBe(NOW - 4000);
    const dvrWithEdge = { ...dvrAt(NOW), edgeWallclock: new Date(NOW).toISOString() };
    expect(syncState({ reports: [live(-9000, -4000), dvrWithEdge], now: NOW })?.edge.edge).toBe(NOW - 4000);
    expect(syncState({ reports: [dvrWithEdge], now: NOW })).toBeNull();
  });

  test("an unparseable edge is ignored; the playhead still counts", () => {
    const r = { ...live(-6000, undefined), edgeWallclock: "nope" };
    expect(syncState({ reports: [r], now: NOW })?.edge.edge).toBe(NOW - 6000);
  });
});

describe("the fallback and mixed rooms", () => {
  test("no member reports an edge: the remembered estimate decides, as before batch 8", () => {
    const prev = { edge: NOW - 2000, at: NOW - 2000 };
    for (const e of [undefined, null] as const) {
      const s = syncState({ reports: [live(-7000, e), live(-10_000, e)], now: NOW, prevEdge: prev });
      expect(s).toEqual({ target: NOW - 5000, edge: { edge: NOW, at: NOW } });
    }
    // Without memory: the leader.
    expect(syncState({ reports: [live(-7000, null)], now: NOW })?.edge.edge).toBe(NOW - 7000);
  });

  test("the fallback carries on from the last reported edge when its reporter goes to DVR", () => {
    const first = syncState({ reports: [live(-3000, -1000), live(-7500, undefined)], now: NOW });
    expect(first?.edge.edge).toBe(NOW - 1000);
    const t = NOW + 2000;
    const next = syncState({ reports: [dvrAt(t), liveAt(t, -7500)], now: t, prevEdge: first?.edge ?? null });
    expect(next).toEqual({ target: t - 6000, edge: { edge: t - 1000, at: t } });
  });

  test("an old client on a faster source still floors the edge", () => {
    // The new client's edge is 4 s back (a slow source); an old client plays 2 s back.
    const s = syncState({ reports: [live(-6000, -4000), live(-2000, undefined)], now: NOW });
    expect(s?.edge.edge).toBe(NOW - 2000);
    expect(s?.target).toBe(NOW - 6000);
    // An old client far behind a new client's edge is capped from that edge.
    expect(syncTarget({ reports: [live(-3000, -1000), live(-12_000, undefined)], now: NOW })).toBe(NOW - 6000);
  });
});

describe("a lying client cannot drag the room forward", () => {
  test("an edge in the future is dropped", () => {
    const s = syncState({ reports: [live(-9000, -4000), live(-3000, 60_000)], now: NOW });
    expect(s?.edge.edge).toBe(NOW - 3000);
    expect(s?.target).toBe(NOW - 8000);
  });

  test("the skew allowance is exact at its boundary, and the room never passes now + EDGE_SKEW_MS", () => {
    const edgy = syncState({ reports: [live(-9000, EDGE_SKEW_MS)], now: NOW });
    expect(edgy).toEqual({ target: NOW + EDGE_SKEW_MS - 5000, edge: { edge: NOW + EDGE_SKEW_MS, at: NOW } });
    expect(syncState({ reports: [live(-9000, EDGE_SKEW_MS + 1)], now: NOW })?.edge.edge).toBe(NOW - 9000);
  });

  test("a playhead in the future is dropped too; alone, there is no target", () => {
    expect(syncTarget({ reports: [live(30_000, 30_000)], now: NOW })).toBeNull();
    expect(syncTarget({ reports: [live(-6000, -2000), live(30_000, undefined)], now: NOW })).toBe(NOW - 6000);
  });

  test("a remembered edge never carries past now + EDGE_SKEW_MS", () => {
    const s = syncState({ reports: [live(-1000, null)], now: NOW, prevEdge: { edge: NOW + 30_000, at: NOW } });
    expect(s?.edge.edge).toBe(NOW + EDGE_SKEW_MS);
  });
});

describe("one member, and the cap", () => {
  test("a single member is its own edge-capped playhead, steady from tick to tick", () => {
    expect(syncTarget({ reports: [live(-4000, -2000)], now: NOW })).toBe(NOW - 4000);
    // 9 s behind its 2 s edge: capped at 7 s, the same on every tick (no oscillation).
    for (let i = 0; i < 5; i++) {
      const t = NOW + i * 2000;
      expect(syncTarget({ reports: [liveAt(t, -9000, -2000)], now: t })).toBe(t - 7000);
    }
  });

  test("the cap is exact at the boundary and configurable", () => {
    expect(syncTarget({ reports: [live(-6000, -1000)], now: NOW })).toBe(NOW - 6000);
    expect(syncTarget({ reports: [live(-6001, -1000)], now: NOW })).toBe(NOW - 6000);
    expect(syncTarget({ reports: [live(-6000, -1000)], now: NOW, edgeCapMs: 2000 })).toBe(NOW - 3000);
  });
});
