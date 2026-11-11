// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-schedule's writes, straight to the database as the app role (the 0060 triggers apply).
 * Each channel's schedule is replaced in one transaction, as `channels.schedule.set` does. The
 * skipped occurrence's instant comes from Postgres (`(date + time) at time zone`), so it falls on
 * the slot's real occurrence in the channel's zone, DST included.
 */
import { type DbHandle, uuidv7 } from "@commonair/db";
import type { PlannedSchedule } from "./plan.ts";

export async function writeSchedules(h: Pick<DbHandle, "sql">, plans: readonly PlannedSchedule[], now: Date) {
  for (const plan of plans) {
    const slotIds = plan.slots.map(() => uuidv7());
    await h.sql.begin(async (q) => {
      await q`
        insert into channel_schedules (channel_id, timezone, updated_at)
        values (${plan.channelId}, ${plan.timezone}, ${now.toISOString()}::timestamptz)
        on conflict (channel_id) do update set timezone = excluded.timezone, updated_at = excluded.updated_at`;
      await q`delete from channel_schedule_one_offs where channel_id = ${plan.channelId}`;
      await q`delete from channel_schedule_slots where channel_id = ${plan.channelId}`;
      for (const [i, s] of plan.slots.entries())
        await q`
          insert into channel_schedule_slots (id, channel_id, weekday, start_local, duration_minutes, title, category_id)
          values (${slotIds[i] ?? uuidv7()}, ${plan.channelId}, ${s.weekday}, ${s.startLocal}, ${s.durationMinutes},
                  ${s.title}, ${s.categoryId})`;
      const o = plan.oneOff;
      await q`
        insert into channel_schedule_one_offs (id, channel_id, starts_at, duration_minutes, title, category_id)
        values (${uuidv7()}, ${plan.channelId}, ${o.startsAt.toISOString()}::timestamptz, ${o.durationMinutes}, ${o.title}, ${o.categoryId})`;
      const skipped = plan.skip ? plan.slots[plan.skip.slot] : undefined;
      const skippedId = plan.skip ? slotIds[plan.skip.slot] : undefined;
      if (plan.skip && skipped && skippedId)
        await q`
          with d as (select (${now.toISOString()}::timestamptz at time zone ${plan.timezone})::date as today)
          insert into channel_schedule_one_offs (id, channel_id, starts_at, duration_minutes, cancels_slot_id)
          select ${uuidv7()}, ${plan.channelId},
                 ((d.today + ((${skipped.weekday}::int - extract(isodow from d.today)::int + 7) % 7)
                   + 7 * ${plan.skip.weeksOut}::int) + ${skipped.startLocal}::time) at time zone ${plan.timezone},
                 ${skipped.durationMinutes}, ${skippedId}
            from d`;
    });
  }
}
