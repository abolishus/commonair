// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Channel points accrual math (ADR 0026 decision 1): blocks, carry, the daily cap, UTC days. */
import { describe, expect, test, vi } from "vite-plus/test";
import { PointsAccrualSetting } from "@commonair/contracts/shapes";
import { DEFAULT_POINTS_ACCRUAL, accrue, creditableSeconds, parsePointsAccrual, utcDay } from "../src/accrual.ts";

const S = DEFAULT_POINTS_ACCRUAL; // 10 per 5 min, 1,000 a day
const NOW = new Date("2026-10-29T12:00:00Z");
const day = (carrySeconds: number, dayPoints: number, d = "2026-10-29") => ({ carrySeconds, day: d, dayPoints });

describe("accrue", () => {
  test("the default matches the seeded setting's shape", () => {
    expect(PointsAccrualSetting.parse(S)).toEqual({ pointsPerBlock: 10, blockMinutes: 5, dailyCapPerChannel: 1000 });
  });

  test("first time: nothing below one block, the seconds carried", () => {
    expect(accrue(S, null, 299, NOW)).toEqual({ points: 0, state: day(299, 0) });
  });

  test("block boundary: exactly one block credits it with no carry", () => {
    expect(accrue(S, null, 300, NOW)).toEqual({ points: 10, state: day(0, 10) });
    expect(accrue(S, null, 301, NOW)).toEqual({ points: 10, state: day(1, 10) });
  });

  test("the carry completes a block", () => {
    expect(accrue(S, day(250, 40), 50, NOW)).toEqual({ points: 10, state: day(0, 50) });
    expect(accrue(S, day(250, 40), 49, NOW)).toEqual({ points: 0, state: day(299, 40) });
  });

  test("several blocks at once, remainder carried", () => {
    expect(accrue(S, day(100, 0), 3 * 300 + 50, NOW)).toEqual({ points: 30, state: day(150, 30) });
  });

  test("exactly at the cap: credited, then nothing more that day, carry still kept", () => {
    const at = accrue(S, day(0, 990), 300, NOW);
    expect(at).toEqual({ points: 10, state: day(0, 1000) });
    expect(accrue(S, at.state, 420, NOW)).toEqual({ points: 0, state: day(120, 1000) });
  });

  test("over the cap: blocks past it dropped, a crossing block credited only up to it", () => {
    expect(accrue(S, day(0, 980), 5 * 300 + 7, NOW)).toEqual({ points: 20, state: day(7, 1000) });
    const odd = { pointsPerBlock: 10, blockMinutes: 5, dailyCapPerChannel: 25 };
    expect(accrue(odd, day(0, 20), 600, NOW)).toEqual({ points: 5, state: day(0, 25) });
  });

  test("day rollover resets the day's points and keeps the carry", () => {
    const yesterday = day(200, 1000, "2026-10-28");
    expect(accrue(S, yesterday, 100, NOW)).toEqual({ points: 10, state: day(0, 10) });
    expect(accrue(S, yesterday, 0, NOW)).toEqual({ points: 0, state: day(200, 0) });
  });

  test("the day is the UTC day", () => {
    const lateUtc = new Date("2026-10-29T23:59:59.999Z");
    const nextUtc = new Date("2026-10-30T00:00:00.000Z");
    expect(utcDay(lateUtc)).toBe("2026-10-29");
    expect(utcDay(nextUtc)).toBe("2026-10-30");
    expect(accrue(S, day(0, 1000), 300, nextUtc)).toEqual({ points: 10, state: day(0, 10, "2026-10-30") });
  });

  test("cap 0 credits nothing but keeps counting the carry", () => {
    const off = { ...S, dailyCapPerChannel: 0 };
    expect(accrue(off, null, 650, NOW)).toEqual({ points: 0, state: day(50, 0) });
  });

  test("one-minute blocks (the harness stack)", () => {
    const fast = { pointsPerBlock: 10, blockMinutes: 1, dailyCapPerChannel: 1000 };
    expect(accrue(fast, null, 180, NOW)).toEqual({ points: 30, state: day(0, 30) });
    expect(accrue(fast, day(30, 30), 45, NOW)).toEqual({ points: 10, state: day(15, 40) });
  });

  test("negative, fractional and non-finite inputs count as whole non-negative seconds", () => {
    expect(accrue(S, null, -50, NOW)).toEqual({ points: 0, state: day(0, 0) });
    expect(accrue(S, null, 300.9, NOW)).toEqual({ points: 10, state: day(0, 10) });
    expect(accrue(S, null, Number.NaN, NOW)).toEqual({ points: 0, state: day(0, 0) });
    expect(accrue(S, day(-5, -10), 300, NOW)).toEqual({ points: 10, state: day(0, 10) });
  });
});

describe("creditableSeconds (concurrent sessions count once)", () => {
  test("first run: the largest single session's growth", () => {
    expect(creditableSeconds([60, 50], null)).toBe(60);
    expect(creditableSeconds([], null)).toBe(0);
  });

  test("two concurrent sessions over a minute credit a minute", () => {
    expect(creditableSeconds([60, 60], 60)).toBe(60);
  });

  test("sequential sessions inside the window both count, up to the window", () => {
    expect(creditableSeconds([20, 30], 60)).toBe(50);
    expect(creditableSeconds([40, 40], 60)).toBe(60);
  });

  test("one session reporting a little past the window keeps its own growth", () => {
    expect(creditableSeconds([65], 60)).toBe(65);
    expect(creditableSeconds([65, 65], 60)).toBe(65);
  });

  test("a long gap since the last run bounds nothing beyond the sum", () => {
    expect(creditableSeconds([100, 200], 86_400)).toBe(300);
  });

  test("negative growth and a negative window are ignored", () => {
    expect(creditableSeconds([-10, 30], -5)).toBe(30);
  });
});

describe("parsePointsAccrual", () => {
  test("a valid value as stored, nothing logged", () => {
    const log = { error: vi.fn<(msg: string, fields?: Record<string, unknown>) => void>() };
    const v = { pointsPerBlock: 5, blockMinutes: 2, dailyCapPerChannel: 0 };
    expect(parsePointsAccrual(v, log)).toEqual(v);
    expect(log.error).not.toHaveBeenCalled();
  });

  test("missing: the defaults, logged as missing", () => {
    const log = { error: vi.fn<(msg: string, fields?: Record<string, unknown>) => void>() };
    expect(parsePointsAccrual(undefined, log)).toEqual(DEFAULT_POINTS_ACCRUAL);
    expect(log.error.mock.calls[0]?.[1]).toMatchObject({ missing: true });
  });

  test("invalid: the defaults, logged with the failing paths", () => {
    const log = { error: vi.fn<(msg: string, fields?: Record<string, unknown>) => void>() };
    expect(parsePointsAccrual({ pointsPerBlock: 10, blockMinutes: 0, dailyCapPerChannel: 1.5 }, log)).toEqual(
      DEFAULT_POINTS_ACCRUAL,
    );
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]?.[1]).toMatchObject({
      missing: false,
      issues: ["blockMinutes", "dailyCapPerChannel"],
    });
  });

  test("the defaults are a fresh copy each time", () => {
    const a = parsePointsAccrual(null);
    a.pointsPerBlock = 999;
    expect(parsePointsAccrual(null).pointsPerBlock).toBe(10);
  });
});
