// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** d2-metrics pure helpers: the k floor, windows and months in UTC, stock and flow totals, the daily bucket key. */
import { GROWTH_K_FLOOR } from "@commonair/contracts/enums";
import { describe, expect, test } from "vite-plus/test";
import { bucketKey, utcDay } from "../src/growth/ingest.ts";
import { daysBetween, floorK, growthWindow, lastMonths, periodValue, STOCK_METRICS } from "../src/growth/report.ts";

describe("floorK", () => {
  test("hides every count below the floor, zero included, and keeps the floor itself", () => {
    expect(GROWTH_K_FLOOR).toBe(5);
    expect(floorK(0)).toBeNull();
    expect(floorK(4)).toBeNull();
    expect(floorK(5)).toBe(5);
    expect(floorK(1234)).toBe(1234);
  });
});

describe("UTC days and windows", () => {
  test("a day is the UTC calendar day, whatever the hour", () => {
    expect(utcDay(new Date("2026-03-01T00:00:00Z"))).toBe("2026-03-01");
    expect(utcDay(new Date("2026-02-28T23:59:59.999Z"))).toBe("2026-02-28");
  });
  test("lists days inclusive, across a month end and a leap day", () => {
    expect(daysBetween("2028-02-27", "2028-03-01")).toEqual(["2028-02-27", "2028-02-28", "2028-02-29", "2028-03-01"]);
    expect(daysBetween("2026-01-01", "2026-01-01")).toEqual(["2026-01-01"]);
    expect(daysBetween("2026-01-02", "2026-01-01")).toEqual([]);
  });
  test("a window of n days ends yesterday", () => {
    const w = growthWindow(new Date("2026-11-10T00:30:00Z"), 7);
    expect(w).toEqual({ from: "2026-11-03", to: "2026-11-09" });
    expect(daysBetween(w.from, w.to)).toHaveLength(7);
    expect(growthWindow(new Date("2026-03-01T23:59:00Z"), 30)).toEqual({ from: "2026-01-30", to: "2026-02-28" });
  });
  test("the last 12 months end with the current one, across a year end", () => {
    const months = lastMonths(new Date("2026-02-15T12:00:00Z"), 12);
    expect(months).toHaveLength(12);
    expect(months[0]).toBe("2025-03");
    expect(months.at(-1)).toBe("2026-02");
    expect(lastMonths(new Date("2026-12-31T23:59:59Z"), 1)).toEqual(["2026-12"]);
  });
});

describe("periodValue", () => {
  const points = [
    { day: "2026-01-03", value: 7 },
    { day: "2026-01-01", value: 2 },
    { day: "2026-01-02", value: 4 },
  ];
  test("sums a flow", () => {
    expect(periodValue("accounts_created", points)).toBe(13);
    expect(periodValue("accounts_created", [])).toBe(0);
  });
  test("takes a stock's last day, whatever the order", () => {
    expect([...STOCK_METRICS].sort()).toEqual(["active_streamers", "members_total"]);
    expect(periodValue("members_total", points)).toBe(7);
    expect(periodValue("active_streamers", [])).toBe(0);
  });
});

describe("bucketKey", () => {
  test("never holds the address, is stable within a day and changes the next", async () => {
    const a = await bucketKey("secret", "203.0.113.7", "2026-11-10");
    expect(a).not.toContain("203.0.113.7");
    expect(a).toMatch(/^ui-metrics:tb:[0-9a-f]{64}$/);
    expect(await bucketKey("secret", "203.0.113.7", "2026-11-10")).toBe(a);
    expect(await bucketKey("secret", "203.0.113.7", "2026-11-11")).not.toBe(a);
    expect(await bucketKey("other", "203.0.113.7", "2026-11-10")).not.toBe(a);
  });
  test("one IPv6 /64 shares a bucket", async () => {
    expect(await bucketKey("s", "2001:db8:1:2::1", "2026-11-10")).toBe(
      await bucketKey("s", "2001:db8:1:2::ff", "2026-11-10"),
    );
    expect(await bucketKey("s", "2001:db8:1:3::1", "2026-11-10")).not.toBe(
      await bucketKey("s", "2001:db8:1:2::1", "2026-11-10"),
    );
  });
});
