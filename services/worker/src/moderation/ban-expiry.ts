// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Timed account suspensions that ran out (decision (z)). A ban with `ban_expires` stops counting
 * by time alone, so no write ever said so: this sweep clears each lapsed ban and writes
 * `channel.suspension {suspended: false}` for the owner's channels it leaves unsuspended, so
 * federation and relays hear about it. A channel suspended in its own right stays suspended (no
 * event). One transaction per account.
 *
 * Better Auth's admin plugin also clears a lapsed ban when the member next signs in, without an
 * event; whichever runs first wins (see the batch 7 contract-step notes).
 */
import { QUEUES } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { and, asc, eq, isNotNull, lte } from "drizzle-orm";
import { z } from "zod";
import type { WorkerContext } from "../context.ts";
import { suspensionScope, withSuspensionState } from "../media-state.ts";
import { defineJob } from "../runtime/registry.ts";

const { users } = schema;

export async function clearLapsedBans(ctx: WorkerContext, batch = 200): Promise<{ cleared: number }> {
  const now = ctx.now();
  const lapsed = and(eq(users.banned, true), isNotNull(users.banExpires), lte(users.banExpires, now));
  const due = await ctx.db
    .select({ id: users.id, banExpires: users.banExpires })
    .from(users)
    .where(lapsed)
    .orderBy(asc(users.banExpires))
    .limit(batch);
  let cleared = 0;
  for (const u of due) {
    if (!u.banExpires) continue;
    // "Before" is the last instant the ban was in force.
    const beforeAsOf = new Date(u.banExpires.getTime() - 1);
    cleared += await ctx.db.transaction((tx) =>
      withSuspensionState(
        tx,
        suspensionScope({ userId: u.id }),
        now,
        async () =>
          (
            await tx
              .update(users)
              .set({ banned: false, banReason: null, banExpires: null })
              .where(and(eq(users.id, u.id), lapsed))
              .returning({ id: users.id })
          ).length,
        { beforeAsOf },
      ),
    );
  }
  return { cleared };
}

export const job = defineJob({
  queue: QUEUES.moderation,
  name: "ban-expiry",
  description: "Clear timed account suspensions that ran out, with their channel.suspension events",
  data: z.object({}),
  schedule: { pattern: "*/5 * * * *" },
  handler: async (_data, ctx) => clearLapsedBans(ctx),
});
