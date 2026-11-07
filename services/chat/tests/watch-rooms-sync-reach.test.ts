// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The room sync target is never later than what a live member has buffered, less
 * `ROOM_LIMITS.syncSpareMs`: a member behind the target with too little buffered to play faster
 * never reaches it (watch-room CI run 42333642371, WebKit held 1.63 s behind for 30 s).
 */
import { describe, expect, test } from "vite-plus/test";
import { ROOM_LIMITS } from "@commonair/contracts/enums";
import type { RoomSyncReport } from "@commonair/contracts/internal";
import { EDGE_SKEW_MS, REACH_SLACK_MS, syncState, syncTarget } from "../src/watch-rooms/sync.ts";

const NOW = Date.parse("2026-11-01T12:00:00.000Z");
const SPARE = ROOM_LIMITS.syncSpareMs;
const CAP = ROOM_LIMITS.edgeCapSeconds * 1000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A live report made `ago` ms before NOW, offsets relative to that moment. */
const live = (o: { head: number; edge?: number; buffered?: number | null; ago?: number }): RoomSyncReport => {
  const t = NOW - (o.ago ?? 0);
  return {
    playheadWallclock: iso(t + o.head),
    mode: "live",
    at: t,
    ...(o.edge === undefined ? {} : { edgeWallclock: iso(t + o.edge) }),
    ...(o.buffered === undefined ? {} : { bufferedWallclock: o.buffered === null ? null : iso(t + o.buffered) }),
  };
};

describe("the target stays where every live member can play to", () => {
  test("the CI run's room: the WebKit member, 6.66 s behind with 1.2 s buffered, sets the target", () => {
    const reports = [
      // Two Chromium members on the cap point with their buffers near the edge.
      live({ head: -5000, edge: -50, buffered: -400 }),
      live({ head: -5100, edge: -60, buffered: -500 }),
      // WebKit: 1.2 s buffered ahead of its playhead.
      live({ head: -6660, edge: -60, buffered: -5460 }),
    ];
    // Without buffers reported, the capped target: 5 s behind the edge.
    const capped = syncTarget({ reports: reports.map((r) => ({ ...r, bufferedWallclock: undefined })), now: NOW });
    expect(capped).toBe(NOW - 50 - CAP);
    // With them: the WebKit buffer's end less the spare, which puts WebKit ahead of the target
    // (it slows down, which needs no buffer) and the others come back to it.
    const target = syncTarget({ reports, now: NOW });
    expect(target).toBe(NOW - 5460 - SPARE);
    expect(target).toBeLessThan(NOW - 6660);
  });

  test("buffers ahead of the capped target change nothing", () => {
    const reports = [
      live({ head: -5000, edge: -50, buffered: -100 }),
      live({ head: -9000, edge: -50, buffered: -2000 }),
    ];
    expect(syncTarget({ reports, now: NOW })).toBe(NOW - 50 - CAP);
  });

  test("a member with a dry buffer pulls the target no further than the slack past the cap point", () => {
    const reports = [
      live({ head: -5000, edge: 0, buffered: -1000 }),
      live({ head: -20_000, edge: 0, buffered: -20_000 }),
    ];
    expect(syncTarget({ reports, now: NOW })).toBe(NOW - CAP - REACH_SLACK_MS);
  });

  test("a reported buffer is extrapolated with its report's age, like the playhead", () => {
    const fresh = syncTarget({ reports: [live({ head: -6660, edge: -60, buffered: -5460 })], now: NOW });
    const older = syncTarget({ reports: [live({ head: -6660, edge: -60, buffered: -5460, ago: 2000 })], now: NOW });
    expect(older).toBe(fresh);
  });

  test("a buffer end behind its playhead counts as the playhead; one in the future as chat's ceiling", () => {
    expect(syncTarget({ reports: [live({ head: -7000, edge: -2000, buffered: -9000 })], now: NOW })).toBe(
      NOW - 7000 - SPARE,
    );
    const ahead = syncTarget({ reports: [live({ head: -1000, edge: 0, buffered: 60_000 })], now: NOW });
    expect(ahead).toBe(Math.min(NOW - 1000, NOW + EDGE_SKEW_MS - SPARE));
  });

  test("null and absent buffers (DVR, older clients) and stale or DVR reports are left out", () => {
    const base = live({ head: -5000, edge: 0 });
    const capped = syncTarget({ reports: [base, live({ head: -9000, edge: 0 })], now: NOW });
    expect(syncTarget({ reports: [base, live({ head: -9000, edge: 0, buffered: null })], now: NOW })).toBe(capped);
    const stale = live({ head: -6000, edge: 0, buffered: -6000, ago: 60_000 });
    expect(syncTarget({ reports: [base, live({ head: -9000, edge: 0 }), stale], now: NOW })).toBe(capped);
    const dvr: RoomSyncReport = { ...live({ head: -60_000, buffered: -59_000 }), mode: "dvr" };
    expect(syncTarget({ reports: [base, live({ head: -9000, edge: 0 }), dvr], now: NOW })).toBe(capped);
  });

  test("the edge estimate is unchanged by the buffers", () => {
    const reports = [live({ head: -6660, edge: -60, buffered: -5460 })];
    expect(syncState({ reports, now: NOW })?.edge).toEqual({ edge: NOW - 60, at: NOW });
  });
});
