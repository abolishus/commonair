// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel schedule (overhaul wave 5): one query loads the time zone, the slots and the one-offs
 * that have not ended (`loadSchedule`), shared by `channels.schedule.get`, `Channel.nextStreamAt`
 * and the calendar feed; `replaceSchedule` is `channels.schedule.set` (delete and insert in one
 * transaction; the 0060 triggers enforce the time zone and the counts as well).
 */
import { inArray, sql } from "drizzle-orm";
import type { z } from "zod";
import type { dto } from "@commonair/contracts";
import { SCHEDULE_FEED_PATH } from "@commonair/contracts/enums";
import { schema, uuidv7, type Executor } from "@commonair/db";
import { badRequest, pgCode } from "../lib/errors.ts";
import { expandSchedule, isSlotOccurrence, type OneOffRule, type Occurrence, type SlotRule } from "./expand.ts";
import { isKnownTimeZone } from "./zone.ts";

const { channelSchedules, channelScheduleSlots, channelScheduleOneOffs, categories } = schema;

export type ChannelScheduleDto = z.infer<typeof dto.ChannelSchedule>;
export type ChannelScheduleInput = z.infer<typeof dto.ChannelScheduleInput>;

/** The subscribable feed (`raw-routes.ts` matches it); `?next=1` is the next stream alone. */
export const scheduleFeedPath = SCHEDULE_FEED_PATH;

export interface LoadedSchedule {
  timezone: string;
  /** When the schedule last changed; null without a schedule row. */
  updatedAt: Date | null;
  slots: SlotRule[];
  /** One-offs (and skips) that have not ended at `now`. */
  oneOffs: OneOffRule[];
}

interface JsonCategory {
  id: string;
  slug: string;
  name: string;
}
interface Row extends Record<string, unknown> {
  timezone: string | null;
  updated_at: string | Date | null;
  slots: {
    id: string;
    weekday: number;
    startLocal: string;
    durationMinutes: number;
    title: string | null;
    category: JsonCategory | null;
  }[];
  one_offs: {
    id: string;
    startsAt: string;
    durationMinutes: number;
    title: string | null;
    category: JsonCategory | null;
    cancelsSlotId: string | null;
  }[];
}

/** One round trip: the schedule row, every slot and the one-offs not yet ended, with categories. */
export async function loadSchedule(db: Executor, channelId: string, now: Date): Promise<LoadedSchedule> {
  const category = (alias: string) =>
    sql.raw(
      `case when ${alias}.id is null then null else json_build_object('id', ${alias}.id, 'slug', ${alias}.slug, 'name', ${alias}.name) end`,
    );
  const rows = await db.execute<Row>(sql`
    select s.timezone, s.updated_at,
      coalesce((
        select json_agg(json_build_object(
                 'id', sl.id, 'weekday', sl.weekday, 'startLocal', to_char(sl.start_local, 'HH24:MI'),
                 'durationMinutes', sl.duration_minutes, 'title', sl.title, 'category', ${category("sc")})
               order by sl.weekday, sl.start_local, sl.id)
          from channel_schedule_slots sl left join categories sc on sc.id = sl.category_id
         where sl.channel_id = ${channelId}::uuid), '[]'::json) as slots,
      coalesce((
        select json_agg(json_build_object(
                 'id', o.id, 'startsAt', o.starts_at, 'durationMinutes', o.duration_minutes, 'title', o.title,
                 'category', ${category("oc")}, 'cancelsSlotId', o.cancels_slot_id)
               order by o.starts_at, o.id)
          from channel_schedule_one_offs o left join categories oc on oc.id = o.category_id
         where o.channel_id = ${channelId}::uuid
           and o.starts_at + make_interval(mins => o.duration_minutes) > ${now.toISOString()}::timestamptz), '[]'::json)
        as one_offs
      from (select ${channelId}::uuid as channel_id) c
      left join channel_schedules s on s.channel_id = c.channel_id`);
  const row = rows[0];
  return {
    timezone: row?.timezone ?? "UTC",
    updatedAt: row?.updated_at ? new Date(row.updated_at) : null,
    slots: (row?.slots ?? []).map((s) => ({ ...s, weekday: Number(s.weekday) })),
    oneOffs: (row?.one_offs ?? []).map((o) => ({ ...o, startsAt: new Date(o.startsAt) })),
  };
}

/** The upcoming occurrences; none for a suspended channel (it cannot go live). */
export function upcomingOf(loaded: LoadedSchedule, now: Date, suspended: boolean, max?: number): Occurrence[] {
  if (suspended) return [];
  return expandSchedule(loaded.timezone, loaded.slots, loaded.oneOffs, max === undefined ? { now } : { now, max });
}

export function toScheduleDto(
  slug: string,
  loaded: LoadedSchedule,
  upcoming: readonly Occurrence[],
): ChannelScheduleDto {
  return {
    timezone: loaded.timezone,
    slots: loaded.slots.map((s) => ({
      id: s.id,
      weekday: s.weekday,
      startLocal: s.startLocal,
      durationMinutes: s.durationMinutes,
      title: s.title,
      category: s.category,
    })),
    oneOffs: loaded.oneOffs.map((o) => ({
      id: o.id,
      startsAt: o.startsAt.toISOString(),
      durationMinutes: o.durationMinutes,
      title: o.title,
      category: o.category,
      cancelsSlotId: o.cancelsSlotId,
    })),
    upcoming: upcoming.map((o) => ({
      startsAt: o.startsAt.toISOString(),
      endsAt: o.endsAt.toISOString(),
      title: o.title,
      category: o.category,
      slotId: o.slotId,
      oneOffId: o.oneOffId,
    })),
    feedPath: scheduleFeedPath(slug),
  };
}

/** `Channel.nextStreamAt`: the first upcoming occurrence's start, or null. */
export async function nextStreamAt(
  db: Executor,
  channel: { id: string; suspendedAt: Date | null },
  now: Date,
): Promise<string | null> {
  const loaded = await loadSchedule(db, channel.id, now);
  if (loaded.slots.length === 0 && loaded.oneOffs.length === 0) return null;
  const [next] = upcomingOf(loaded, now, channel.suspendedAt !== null, 1);
  return next ? next.startsAt.toISOString() : null;
}

/**
 * Checks what the contract cannot: a known time zone, categories that exist, and each skip on an
 * actual occurrence of the slot it names. Throws a 400 naming the first problem.
 */
export async function validateScheduleInput(db: Executor, input: ChannelScheduleInput): Promise<void> {
  if (!isKnownTimeZone(input.timezone)) throw badRequest("Unknown time zone");
  const ids = [
    ...new Set([...input.slots, ...input.oneOffs].map((x) => x.categoryId).filter((id): id is string => id !== null)),
  ];
  if (ids.length > 0) {
    const found = await db.select({ id: categories.id }).from(categories).where(inArray(categories.id, ids));
    if (found.length !== ids.length) throw badRequest("Unknown category");
  }
  for (const o of input.oneOffs) {
    if (o.cancelsSlot === null) continue;
    const slot = input.slots[o.cancelsSlot];
    if (!slot) throw badRequest("A skipped stream names a slot that does not exist");
    if (!isSlotOccurrence(input.timezone, slot, new Date(o.startsAt)))
      throw badRequest("A skipped stream must fall exactly on one of its slot's streams");
  }
}

/**
 * Ids for `wanted`, reusing an `existing` id whose key matches (each id once), else a new
 * UUIDv7. The feed's UIDs are built from these ids, so a save that keeps a slot (or one-off) where
 * it was keeps its calendar events: subscribed calendars update them instead of dropping and
 * re-creating every event with the viewer's alarms and notes. Pure, unit-tested.
 */
export function keepIds<T>(
  existing: readonly { id: string; key: string }[],
  wanted: readonly T[],
  keyOf: (item: T) => string,
): string[] {
  const free = new Map<string, string[]>();
  for (const e of existing) free.set(e.key, [...(free.get(e.key) ?? []), e.id]);
  return wanted.map((item) => free.get(keyOf(item))?.shift() ?? uuidv7());
}

const slotKey = (s: { weekday: number; startLocal: string }) => `${s.weekday}-${s.startLocal}`;
const oneOffKey = (startsAt: Date) => startsAt.toISOString();

/** Replace the whole schedule in one transaction; the caller validated `input`. */
export async function replaceSchedule(
  db: Executor,
  channelId: string,
  input: ChannelScheduleInput,
  now: Date,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const oldSlots = await tx
        .select({
          id: channelScheduleSlots.id,
          weekday: channelScheduleSlots.weekday,
          startLocal: channelScheduleSlots.startLocal,
        })
        .from(channelScheduleSlots)
        .where(sql`${channelScheduleSlots.channelId} = ${channelId}`);
      const oldOneOffs = await tx
        .select({ id: channelScheduleOneOffs.id, startsAt: channelScheduleOneOffs.startsAt })
        .from(channelScheduleOneOffs)
        .where(
          sql`${channelScheduleOneOffs.channelId} = ${channelId} and ${channelScheduleOneOffs.cancelsSlotId} is null`,
        );
      const slotIds = keepIds(
        // Postgres `time` reads back as "HH:MM:SS"; the input is "HH:MM".
        oldSlots.map((s) => ({ id: s.id, key: slotKey({ weekday: s.weekday, startLocal: s.startLocal.slice(0, 5) }) })),
        input.slots,
        slotKey,
      );
      // Skips add no feed event, so only one-offs that add a stream keep their ids.
      const oneOffIds = keepIds(
        oldOneOffs.map((o) => ({ id: o.id, key: oneOffKey(o.startsAt) })),
        input.oneOffs,
        (o) => (o.cancelsSlot === null ? oneOffKey(new Date(o.startsAt)) : "skip"),
      );
      await tx
        .insert(channelSchedules)
        .values({ channelId, timezone: input.timezone, updatedAt: now })
        .onConflictDoUpdate({ target: channelSchedules.channelId, set: { timezone: input.timezone, updatedAt: now } });
      // Slots first would cascade the skips anyway; one-offs first keeps the delete explicit.
      await tx.delete(channelScheduleOneOffs).where(sql`${channelScheduleOneOffs.channelId} = ${channelId}`);
      await tx.delete(channelScheduleSlots).where(sql`${channelScheduleSlots.channelId} = ${channelId}`);
      if (input.slots.length > 0)
        await tx.insert(channelScheduleSlots).values(
          input.slots.map((s, i) => ({
            id: slotIds[i],
            channelId,
            weekday: s.weekday,
            startLocal: s.startLocal,
            durationMinutes: s.durationMinutes,
            title: s.title,
            categoryId: s.categoryId,
          })),
        );
      if (input.oneOffs.length > 0)
        await tx.insert(channelScheduleOneOffs).values(
          input.oneOffs.map((o, i) => ({
            id: oneOffIds[i],
            channelId,
            startsAt: new Date(o.startsAt),
            durationMinutes: o.durationMinutes,
            title: o.title,
            categoryId: o.categoryId,
            cancelsSlotId: o.cancelsSlot === null ? null : (slotIds[o.cancelsSlot] ?? null),
          })),
        );
    });
  } catch (err) {
    // The 0060 triggers (time zone unknown to Postgres, counts) and the 0059 checks.
    if (pgCode(err) === "23514") throw badRequest("The schedule breaks a rule: check the time zone and the limits");
    throw err;
  }
}
