// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The schedule's upcoming occurrences (`ChannelSchedule.upcoming`, `Channel.nextStreamAt`, the
 * calendar feed): weekly slots expanded in the channel's time zone (DST-correct, `zone.ts`),
 * skipped occurrences left out, one-offs merged, soonest first, from `now` to the horizon, capped.
 * An occurrence counts as upcoming until it starts. Pure, unit-tested.
 */
import { SCHEDULE_RULES } from "@commonair/contracts/enums";
import { addDays, isoWeekday, localDateOf, localToInstant, minutesOf, type LocalDate } from "./zone.ts";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export interface ScheduleCategoryRef {
  id: string;
  slug: string;
  name: string;
}

export interface SlotRule {
  id: string;
  /** ISO weekday, 1 = Monday. */
  weekday: number;
  /** "HH:MM" in the schedule's time zone. */
  startLocal: string;
  durationMinutes: number;
  title: string | null;
  category: ScheduleCategoryRef | null;
}

export interface OneOffRule {
  id: string;
  startsAt: Date;
  durationMinutes: number;
  title: string | null;
  category: ScheduleCategoryRef | null;
  /** Set: this entry skips the slot's occurrence at `startsAt` instead of adding a stream. */
  cancelsSlotId: string | null;
}

export interface Occurrence {
  startsAt: Date;
  endsAt: Date;
  title: string | null;
  category: ScheduleCategoryRef | null;
  slotId: string | null;
  oneOffId: string | null;
}

export interface ExpandOptions {
  now: Date;
  horizonDays?: number;
  max?: number;
}

/** The slot's occurrence on local `date` (whatever the date's weekday), as an instant in ms. */
export function slotStartOn(timeZone: string, slot: Pick<SlotRule, "startLocal">, date: LocalDate): number {
  return localToInstant(timeZone, date, minutesOf(slot.startLocal));
}

/**
 * Whether `startsAt` is exactly an occurrence of `slot`: its local date in the zone has the slot's
 * weekday and the slot's wall time resolves to that instant there. A slot at 23:30 whose occurrence
 * a DST gap pushed past midnight is looked up from the day before too.
 */
export function isSlotOccurrence(timeZone: string, slot: Pick<SlotRule, "weekday" | "startLocal">, startsAt: Date) {
  const ms = startsAt.getTime();
  const local = localDateOf(timeZone, ms);
  return [local, addDays(local, -1)].some(
    (date) => isoWeekday(date) === slot.weekday && slotStartOn(timeZone, slot, date) === ms,
  );
}

export function expandSchedule(
  timeZone: string,
  slots: readonly SlotRule[],
  oneOffs: readonly OneOffRule[],
  opts: ExpandOptions,
): Occurrence[] {
  const from = opts.now.getTime();
  const until = from + (opts.horizonDays ?? SCHEDULE_RULES.horizonDays) * DAY_MS;
  const max = opts.max ?? SCHEDULE_RULES.upcomingMax;
  const inWindow = (ms: number) => ms >= from && ms < until;

  const skipped = new Set(
    oneOffs.filter((o) => o.cancelsSlotId !== null).map((o) => `${o.cancelsSlotId}@${o.startsAt.getTime()}`),
  );
  const out: Occurrence[] = [];
  if (slots.length > 0) {
    // One local day either side covers every offset (−12 h to +14 h) and a start pushed by a gap.
    const first = addDays(localDateOf(timeZone, from), -1);
    const days = Math.ceil((until - from) / DAY_MS) + 2;
    for (let i = 0; i <= days; i++) {
      const date = addDays(first, i);
      const weekday = isoWeekday(date);
      for (const slot of slots) {
        if (slot.weekday !== weekday) continue;
        const start = slotStartOn(timeZone, slot, date);
        if (!inWindow(start) || skipped.has(`${slot.id}@${start}`)) continue;
        out.push({
          startsAt: new Date(start),
          endsAt: new Date(start + slot.durationMinutes * MINUTE_MS),
          title: slot.title,
          category: slot.category,
          slotId: slot.id,
          oneOffId: null,
        });
      }
    }
  }
  for (const o of oneOffs) {
    if (o.cancelsSlotId !== null || !inWindow(o.startsAt.getTime())) continue;
    out.push({
      startsAt: o.startsAt,
      endsAt: new Date(o.startsAt.getTime() + o.durationMinutes * MINUTE_MS),
      title: o.title,
      category: o.category,
      slotId: null,
      oneOffId: o.id,
    });
  }
  // Ties (two entries at one instant) sort by id, so the order never depends on input order.
  out.sort(
    (a, b) =>
      a.startsAt.getTime() - b.startsAt.getTime() ||
      (a.slotId ?? a.oneOffId ?? "").localeCompare(b.slotId ?? b.oneOffId ?? ""),
  );
  return out.slice(0, max);
}
