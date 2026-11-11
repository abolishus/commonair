// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** seed-platform's growth plan: every metric every day, closed-list counters, floored cells on both pages. */
import {
  GROWTH_K_FLOOR,
  GROWTH_METRICS,
  UI_METRIC_ACTIONS,
  UI_METRIC_STEPS,
  UI_METRIC_SURFACES,
} from "@commonair/contracts/enums";
import { describe, expect, test } from "vite-plus/test";
import { createRng } from "../../src/seed/prng.ts";
import { GROWTH_DAYS, UI_DAYS, planGrowth } from "../../src/seed/platform/growth.ts";
import { NOT_SEEDED } from "../../src/seed/coverage.ts";
import { unit } from "../../src/seed/platform.ts";

const NOW = new Date("2026-11-10T15:00:00Z");

describe("planGrowth", () => {
  const plan = planGrowth(createRng(7), NOW, 1);

  test("writes every metric for each of the 400 days before the run, none of them today", () => {
    expect(plan.daily).toHaveLength(GROWTH_DAYS * GROWTH_METRICS.length);
    const days = [...new Set(plan.daily.map((r) => r.day))];
    expect(days).toHaveLength(GROWTH_DAYS);
    expect(days[0]).toBe("2025-10-06");
    expect(days.at(-1)).toBe("2026-11-09");
    for (const r of plan.daily) {
      expect(Number.isInteger(r.value)).toBe(true);
      expect(r.value).toBeGreaterThanOrEqual(0);
    }
    const keys = new Set(plan.daily.map((r) => `${r.day}|${r.metric}`));
    expect(keys.size).toBe(plan.daily.length);
  });

  test("keeps the funnel ordered and leaves floored and shown cells alike", () => {
    const byDay = new Map<string, Record<string, number>>();
    for (const r of plan.daily) byDay.set(r.day, { ...byDay.get(r.day), [r.metric]: r.value });
    for (const v of byDay.values()) {
      expect(v.accounts_verified).toBeLessThanOrEqual(v.accounts_created ?? 0);
      expect(v.first_follow_within_7d).toBeLessThanOrEqual(v.accounts_verified ?? 0);
    }
    const values = (metric: string) => plan.daily.filter((r) => r.metric === metric).map((r) => r.value);
    expect(values("accounts_created").some((v) => v >= GROWTH_K_FLOOR)).toBe(true);
    // A month of the creator steps stays under the floor at `small`.
    const nov = plan.daily.filter((r) => r.metric === "second_live_within_14d" && r.day.startsWith("2026-11"));
    expect(nov.reduce((a, r) => a + r.value, 0)).toBeLessThan(GROWTH_K_FLOOR);
  });

  test("counts the closed lists only, for the 30 days up to and including today", () => {
    const days = new Set(plan.ui.map((r) => r.day));
    expect(days.size).toBe(UI_DAYS);
    expect(days.has("2026-11-10")).toBe(true);
    for (const r of plan.ui) {
      expect(UI_METRIC_SURFACES).toContain(r.surface);
      expect(UI_METRIC_ACTIONS).toContain(r.action);
      expect(UI_METRIC_STEPS).toContain(r.step);
      expect(r.count).toBeGreaterThan(0);
    }
    expect(new Set(plan.ui.map((r) => `${r.day}|${r.surface}|${r.action}|${r.step}`)).size).toBe(plan.ui.length);
  });

  test("is the same for the same seed and scales with the factor", () => {
    expect(planGrowth(createRng(7), NOW, 1)).toEqual(plan);
    const big = planGrowth(createRng(7), NOW, 10);
    const sum = (p: typeof plan) => p.ui.reduce((a, r) => a + r.count, 0);
    expect(sum(big)).toBeGreaterThan(sum(plan));
  });
});

describe("registration", () => {
  test("seed-platform owns both tables and neither is NOT_SEEDED any more", () => {
    expect(unit.tables).toEqual(expect.arrayContaining(["ui_counters", "growth_daily"]));
    expect(Object.keys(NOT_SEEDED)).not.toContain("ui_counters");
    expect(Object.keys(NOT_SEEDED)).not.toContain("growth_daily");
  });
});
