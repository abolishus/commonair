// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** seed-schedule's plan: which channels, deterministic, within the schedule rules. */
import { describe, expect, test } from "vite-plus/test";
import { SCHEDULE_RULES } from "@commonair/contracts/enums";
import { createRng } from "../../src/seed/prng.ts";
import { SCHEDULED_BULK, planSchedules } from "../../src/seed/schedule/plan.ts";
import { unit } from "../../src/seed/schedule.ts";

const channels = ["streamer1", "streamer2", "streamer3", "s0001", "s0002", "s0003", "s0004"].map((h, i) => ({
  id: `00000000-0000-7000-8000-00000000000${i}`,
  ownerHandle: h,
}));
const categories = ["c1", "c2", "c3"];
const now = new Date("2026-11-11T15:20:00Z");

describe("planSchedules", () => {
  test("streamer1, streamer3 and two bulk channels; never streamer2", () => {
    const plans = planSchedules(createRng(1).fork("schedule"), channels, categories, now);
    const handles = plans.map((p) => p.ownerHandle);
    expect(handles.slice(0, 2)).toEqual(["streamer1", "streamer3"]);
    expect(handles).toHaveLength(2 + SCHEDULED_BULK);
    expect(handles).not.toContain("streamer2");
    expect(new Set(handles).size).toBe(handles.length);
  });

  test("the same seed gives the same plan, whatever order the channels came in", () => {
    const a = planSchedules(createRng(7).fork("schedule"), channels, categories, now);
    const b = planSchedules(createRng(7).fork("schedule"), [...channels].reverse(), [...categories].reverse(), now);
    expect(b).toEqual(a);
  });

  test("every schedule follows the rules; streamer1 is in Toronto and skips one week", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      for (const p of planSchedules(createRng(seed).fork("schedule"), channels, categories, now)) {
        expect(p.slots.length).toBeGreaterThanOrEqual(2);
        expect(p.slots.length).toBeLessThanOrEqual(Math.min(3, SCHEDULE_RULES.maxSlots));
        expect(new Set(p.slots.map((s) => s.weekday)).size).toBe(p.slots.length);
        for (const s of p.slots) {
          expect(s.weekday).toBeGreaterThanOrEqual(1);
          expect(s.weekday).toBeLessThanOrEqual(7);
          expect(s.startLocal).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
          expect(s.durationMinutes).toBeGreaterThanOrEqual(SCHEDULE_RULES.minDurationMinutes);
          expect(s.durationMinutes).toBeLessThanOrEqual(SCHEDULE_RULES.maxDurationMinutes);
          expect([null, ...categories]).toContain(s.categoryId);
        }
        const ahead = p.oneOff.startsAt.getTime() - now.getTime();
        expect(ahead).toBeGreaterThan(2 * 86_400_000 - 3_600_000);
        expect(ahead).toBeLessThan(SCHEDULE_RULES.horizonDays * 86_400_000);
        expect(p.oneOff.startsAt.getUTCMinutes()).toBe(0);
        expect(p.skip).toEqual(p.ownerHandle === "streamer1" ? { slot: 0, weeksOut: 1 } : null);
        expect(p.ownerHandle !== "streamer1" || p.timezone === "America/Toronto").toBe(true);
      }
    }
  });

  test("no categories: every category is null", () => {
    for (const p of planSchedules(createRng(3).fork("schedule"), channels, [], now)) {
      expect(p.oneOff.categoryId).toBeNull();
      for (const s of p.slots) expect(s.categoryId).toBeNull();
    }
  });

  test("the unit owns the three schedule tables and runs last", () => {
    expect(unit.tables).toEqual(["channel_schedules", "channel_schedule_slots", "channel_schedule_one_offs"]);
    expect(unit.pending).toEqual([]);
    expect(unit.after).toContain("platform");
  });
});
