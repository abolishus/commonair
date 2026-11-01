// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Decision (r): the room sync target is the slowest live member, capped 5 s behind the edge. */
import { describe, expect, test } from "vite-plus/test";
import type { RoomSyncReport } from "@commonair/contracts/internal";
import { parseSyncHash, SYNC_STALE_MS, syncTarget } from "../src/watch-rooms/sync.ts";

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

describe("parseSyncHash", () => {
  test("keeps valid reports and drops malformed ones", () => {
    const good = at(-5000);
    const parsed = parseSyncHash({ a: JSON.stringify(good), b: "{", c: JSON.stringify({ x: 1 }) }, (raw) =>
      typeof raw === "object" && raw !== null && "mode" in raw ? (raw as RoomSyncReport) : null,
    );
    expect(parsed).toEqual([good]);
  });
});
