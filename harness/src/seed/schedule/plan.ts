// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-schedule's plan (overhaul wave 5): a few channels get a weekly schedule in their own time
 * zone, one one-off each, and streamer1 one skipped week, all from the unit's own random stream
 * so the same `--seed` gives the same schedules. Pure, unit-tested.
 */
import { SCHEDULE_RULES } from "@commonair/contracts/enums";
import { FIXED_ACCOUNTS } from "../accounts.ts";
import type { Rng } from "../prng.ts";

/** The fixed streamers that always get a schedule (streamer3 is usually offline in walkthroughs). */
export const SCHEDULED_FIXED = ["streamer1", "streamer3"] as const;
/** How many bulk channels (not a fixed account's) get one besides. */
export const SCHEDULED_BULK = 2;

const ZONES = ["America/Toronto", "Europe/Paris", "America/Los_Angeles", "UTC", "Asia/Tokyo"] as const;
const STARTS = ["18:00", "19:30", "20:00", "21:00", "23:30"] as const;
const DURATIONS = [90, 120, 180] as const;
const TITLES = ["Community campaign night", "Viewer games", "Chill and chat", "Speedrun practice", null] as const;
const ONE_OFF_TITLES = ["Charity marathon", "Q&A with chat", "Season premiere"] as const;

export interface PlannedSlot {
  weekday: number;
  startLocal: string;
  durationMinutes: number;
  title: string | null;
  categoryId: string | null;
}

export interface PlannedSchedule {
  channelId: string;
  ownerHandle: string;
  timezone: string;
  slots: PlannedSlot[];
  oneOff: { startsAt: Date; durationMinutes: number; title: string; categoryId: string | null };
  /** Skip slot `slot`'s occurrence `weeksOut` weeks after its next one this week (from today, local). */
  skip: { slot: number; weeksOut: number } | null;
}

export interface ScheduleChannel {
  id: string;
  ownerHandle: string;
}

/**
 * Which channels, and each one's schedule. `channels` and `categoryIds` are sorted first so the
 * plan never depends on the order the database listed them in.
 */
export function planSchedules(
  rng: Rng,
  channels: readonly ScheduleChannel[],
  categoryIds: readonly string[],
  now: Date,
): PlannedSchedule[] {
  const sorted = [...channels].sort((a, b) => a.ownerHandle.localeCompare(b.ownerHandle));
  const fixed = sorted.filter((c) => (SCHEDULED_FIXED as readonly string[]).includes(c.ownerHandle));
  const fixedHandles = new Set(FIXED_ACCOUNTS.map((a) => a.handle));
  const bulk = rng.sample(
    sorted.filter((c) => !fixedHandles.has(c.ownerHandle)),
    SCHEDULED_BULK,
  );
  const categories = [...categoryIds].sort();
  const category = () => (categories.length > 0 && rng.chance(0.8) ? rng.pick(categories) : null);
  return [...fixed, ...bulk].map((c) => {
    const timezone = c.ownerHandle === "streamer1" ? "America/Toronto" : rng.pick(ZONES);
    const weekdays = rng.sample([1, 2, 3, 4, 5, 6, 7], rng.int(2, 3)).sort((a, b) => a - b);
    const slots = weekdays.map((weekday) => ({
      weekday,
      startLocal: rng.pick(STARTS),
      durationMinutes: rng.pick(DURATIONS),
      title: rng.pick(TITLES),
      categoryId: category(),
    }));
    // On the hour, two to ten days out, inside the horizon the channel page shows.
    const startsAt = new Date(Math.ceil(now.getTime() / 3_600_000) * 3_600_000 + rng.int(2, 10) * 86_400_000);
    return {
      channelId: c.id,
      ownerHandle: c.ownerHandle,
      timezone,
      slots: slots.slice(0, SCHEDULE_RULES.maxSlots),
      oneOff: { startsAt, durationMinutes: 120, title: rng.pick(ONE_OFF_TITLES), categoryId: category() },
      skip: c.ownerHandle === "streamer1" ? { slot: 0, weeksOut: 1 } : null,
    };
  });
}
