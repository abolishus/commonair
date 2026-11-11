// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-schedule (overhaul wave 5): weekly slots, a one-off and a skipped week for streamer1,
 * streamer3 and two bulk channels, so the offline channel page shows its next stream, About lists
 * the week, the calendar feed has events and `/schedule` opens on a real schedule. It runs last:
 * it needs only seed-social's channels, and running after every other unit keeps the existing
 * checkpoints and side-by-side steps as they were.
 */
import { planSchedules } from "./schedule/plan.ts";
import { writeSchedules } from "./schedule/write.ts";
import type { SeedUnit } from "./types.ts";

const TABLES = ["channel_schedules", "channel_schedule_slots", "channel_schedule_one_offs"] as const;

export const unit: SeedUnit = {
  name: "schedule",
  after: ["social", "platform"],
  tables: TABLES,
  pending: [],
  async run(ctx) {
    const categories = await ctx.db.sql<{ id: string }[]>`select id from categories order by slug`;
    const plans = planSchedules(
      ctx.rng,
      ctx.store.channels.map((c) => ({ id: c.id, ownerHandle: c.ownerHandle })),
      categories.map((c) => c.id),
      ctx.now,
    );
    await writeSchedules(ctx.db, plans, ctx.now);
    const rows: Record<string, number> = {};
    for (const table of TABLES) {
      const [r] = await ctx.db.sql.unsafe<{ n: number }[]>(`select count(*)::int as n from ${table}`);
      rows[table] = Number(r?.n ?? 0);
    }
    return {
      rows,
      notes: [
        `seed-schedule: ${plans.map((p) => `${p.ownerHandle} (${p.timezone})`).join(", ")} have a schedule; streamer1 skips one week`,
      ],
    };
  },
};
