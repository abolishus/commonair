// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { LiveTimeAccumulator, splitByHour } from "../src/health/hours.ts";

const t = (iso: string) => new Date(iso).getTime();

describe("splitByHour", () => {
  test("within one hour", () => {
    expect(splitByHour(t("2026-10-18T20:10:00Z"), t("2026-10-18T20:10:05Z"))).toEqual([
      { hourStart: new Date("2026-10-18T20:00:00Z"), ms: 5000 },
    ]);
  });

  test("across an hour boundary", () => {
    expect(splitByHour(t("2026-10-18T20:59:58Z"), t("2026-10-18T21:00:03Z"))).toEqual([
      { hourStart: new Date("2026-10-18T20:00:00Z"), ms: 2000 },
      { hourStart: new Date("2026-10-18T21:00:00Z"), ms: 3000 },
    ]);
  });

  test("across several hours and empty ranges", () => {
    const parts = splitByHour(t("2026-10-18T20:30:00Z"), t("2026-10-18T23:15:00Z"));
    expect(parts.map((p) => p.ms / 60_000)).toEqual([30, 60, 60, 15]);
    expect(splitByHour(5, 5)).toEqual([]);
    expect(splitByHour(10, 5)).toEqual([]);
  });
});

describe("LiveTimeAccumulator", () => {
  test("carries sub-second remainders instead of losing them", () => {
    const acc = new LiveTimeAccumulator();
    const base = t("2026-10-18T20:00:00Z");
    for (let i = 0; i < 10; i++) acc.add(base + i * 1500, base + (i + 1) * 1500);
    expect(acc.take()).toEqual([{ hourStart: new Date(base), seconds: 15 }]);
    acc.add(base + 15_000, base + 15_400);
    expect(acc.take()).toEqual([]);
    acc.add(base + 15_400, base + 16_000);
    expect(acc.take()).toEqual([{ hourStart: new Date(base), seconds: 1 }]);
  });

  test("restore puts seconds back after a failed write", () => {
    const acc = new LiveTimeAccumulator();
    const base = t("2026-10-18T20:00:00Z");
    acc.add(base, base + 5000);
    const rows = acc.take();
    acc.restore(rows);
    expect(acc.take()).toEqual(rows);
  });
});
