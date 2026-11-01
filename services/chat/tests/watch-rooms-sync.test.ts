// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Decision (r): the room sync target is the slowest live member, capped 5 s behind the edge. */
import { describe, expect, test } from "vite-plus/test";
import type { RoomSyncReport } from "@commonair/contracts/internal";
import {
  EDGE_FIELD,
  EDGE_MEMORY_MS,
  EDGE_SLACK_MS,
  parseEdge,
  parseSyncHash,
  SYNC_STALE_MS,
  syncState,
  syncTarget,
} from "../src/watch-rooms/sync.ts";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const at = (headOffsetMs: number, reportedAgoMs = 0, mode: "live" | "dvr" = "live"): RoomSyncReport => ({
  playheadWallclock: new Date(NOW - reportedAgoMs + headOffsetMs).toISOString(),
  mode,
  at: NOW - reportedAgoMs,
});

describe("syncTarget", () => {
  test("no reports, no target", () => {
    expect(syncTarget({ reports: [], now: NOW })).toBeNull();
  });

  test("one member is its own target", () => {
    expect(syncTarget({ reports: [at(-8000)], now: NOW })).toBe(NOW - 8000);
  });

  test("the slowest live member wins within the cap", () => {
    expect(syncTarget({ reports: [at(-6000), at(-8000), at(-7000)], now: NOW })).toBe(NOW - 8000);
  });

  test("a member more than 5 s behind the most advanced one is capped", () => {
    expect(syncTarget({ reports: [at(-6000), at(-30_000)], now: NOW })).toBe(NOW - 11_000);
  });

  test("the cap is configurable and exact at the boundary", () => {
    expect(syncTarget({ reports: [at(-6000), at(-11_000)], now: NOW })).toBe(NOW - 11_000);
    expect(syncTarget({ reports: [at(-6000), at(-11_000)], now: NOW, edgeCapMs: 2000 })).toBe(NOW - 8000);
  });

  test("reports are extrapolated to now", () => {
    // Reported 1.5 s ago at 8 s behind: still 8 s behind now.
    expect(syncTarget({ reports: [at(-8000, 1500), at(-7000)], now: NOW })).toBe(NOW - 8000);
  });

  test("DVR members are left out", () => {
    expect(syncTarget({ reports: [at(-6000), at(-600_000, 0, "dvr")], now: NOW })).toBe(NOW - 6000);
    expect(syncTarget({ reports: [at(-600_000, 0, "dvr")], now: NOW })).toBeNull();
  });

  test("stale and future reports are left out", () => {
    expect(syncTarget({ reports: [at(-6000), at(-9000, SYNC_STALE_MS + 1)], now: NOW })).toBe(NOW - 6000);
    expect(syncTarget({ reports: [at(-6000), at(-9000, -100)], now: NOW })).toBe(NOW - 6000);
  });

  test("a member joining slower lowers the target; leaving raises it", () => {
    const base = [at(-6000), at(-7000)];
    expect(syncTarget({ reports: base, now: NOW })).toBe(NOW - 7000);
    expect(syncTarget({ reports: [...base, at(-9000)], now: NOW })).toBe(NOW - 9000);
    expect(syncTarget({ reports: [base[0]!], now: NOW })).toBe(NOW - 6000);
  });

  test("an unparseable playhead is ignored", () => {
    expect(syncTarget({ reports: [{ playheadWallclock: "nope", mode: "live", at: NOW }, at(-6000)], now: NOW })).toBe(
      NOW - 6000,
    );
  });
});

describe("syncState: the remembered edge", () => {
  // A report `offset` ms from `t` (a playhead at t + offset), reported at t.
  const rep = (t: number, offset: number): RoomSyncReport => ({
    playheadWallclock: new Date(t + offset).toISOString(),
    mode: "live",
    at: t,
  });

  test("the leader stepping back to the target does not drag the room behind live", () => {
    // Live is at t; A sits 2 s behind, S 10 s behind.
    const first = syncState({ reports: [rep(NOW, -2000), rep(NOW, -10_000)], now: NOW })!;
    expect(first.target).toBe(NOW - 7000);
    // A steps back to the target; S stays 10 s behind. Ten ticks later the target has not moved.
    let prev = first.edge;
    for (let i = 1; i <= 10; i++) {
      const t = NOW + i * 2000;
      const s = syncState({ reports: [rep(t, -7000), rep(t, -10_000)], now: t, prevEdge: prev })!;
      expect(s.target).toBe(t - 7000);
      prev = s.edge;
    }
  });

  test("without memory the leader proxy alone drifts (the case the memory fixes)", () => {
    const t = NOW + 2000;
    expect(syncTarget({ reports: [rep(t, -7000), rep(t, -10_000)], now: t })).toBe(t - 10_000);
  });

  test("a member ahead of the remembered edge moves the edge up", () => {
    const s = syncState({ reports: [rep(NOW, -1000)], now: NOW, prevEdge: { edge: NOW - 4000, at: NOW } })!;
    expect(s.edge.edge).toBe(NOW - 1000);
  });

  test("the remembered edge is bounded ahead of the leader (a stalled stream)", () => {
    const s = syncState({ reports: [rep(NOW, -20_000)], now: NOW, prevEdge: { edge: NOW, at: NOW } })!;
    expect(s.edge.edge).toBe(NOW - 20_000 + 5000 + EDGE_SLACK_MS);
    expect(s.target).toBe(NOW - 20_000 + EDGE_SLACK_MS);
  });

  test("an old or future memory is dropped", () => {
    const old = { edge: NOW - EDGE_MEMORY_MS - 1, at: NOW - EDGE_MEMORY_MS - 1 };
    expect(syncState({ reports: [rep(NOW, -8000)], now: NOW, prevEdge: old })!.edge.edge).toBe(NOW - 8000);
    const future = { edge: NOW + 1000, at: NOW + 1000 };
    expect(syncState({ reports: [rep(NOW, -8000)], now: NOW, prevEdge: future })!.edge.edge).toBe(NOW - 8000);
  });

  test("no live reports, no state", () => {
    expect(syncState({ reports: [], now: NOW, prevEdge: { edge: NOW, at: NOW } })).toBeNull();
  });
});

describe("parseEdge", () => {
  test("round-trips and rejects malformed values", () => {
    expect(parseEdge(JSON.stringify({ edge: 5, at: 6 }))).toEqual({ edge: 5, at: 6 });
    expect(parseEdge(undefined)).toBeNull();
    expect(parseEdge("{")).toBeNull();
    expect(parseEdge("null")).toBeNull();
    expect(parseEdge(JSON.stringify({ edge: "5", at: 6 }))).toBeNull();
  });
});

describe("parseSyncHash", () => {
  test("skips the edge field", () => {
    const good = at(-5000);
    const parsed = parseSyncHash(
      { u: JSON.stringify(good), [EDGE_FIELD]: JSON.stringify({ edge: 1, at: 1 }) },
      (raw) => raw as RoomSyncReport,
    );
    expect(parsed).toEqual([good]);
  });

  test("keeps valid reports and drops malformed ones", () => {
    const good = at(-5000);
    const parsed = parseSyncHash({ a: JSON.stringify(good), b: "{", c: JSON.stringify({ x: 1 }) }, (raw) =>
      typeof raw === "object" && raw !== null && "mode" in raw ? (raw as RoomSyncReport) : null,
    );
    expect(parsed).toEqual([good]);
  });
});
