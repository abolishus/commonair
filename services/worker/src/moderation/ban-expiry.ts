// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Timed account suspensions that ran out (decision (z)). A ban with `ban_expires` stops counting
 * by time alone, so no write ever said so: this sweep clears each lapsed ban and writes
 * `channel.suspension {suspended: false}` for the owner's channels it leaves unsuspended, so
 * federation and relays hear about it. A channel suspended in its own right stays suspended (no
 * event). One transaction per account, with its `audit_log` row (`user.ban_lapsed`, `via: "sweep"`).
 *
 * Better Auth's admin plugin also clears a lapsed ban when the member next signs in; the API's
 * after hook then writes the event (`recordLapsedUnsuspension`, decision (g)). That hook runs
 * after the clear has committed, so its event can be lost: `recoverLostUnsuspensions` is the
 * backstop, run by the same job.
 */
import { QUEUES } from "@commonair/contracts/internal";
import { schema } from "@commonair/db";
import { and, asc, eq, isNotNull, lte, sql } from "drizzle-orm";
import { z } from "zod";
import type { WorkerContext } from "../context.ts";
import { suspensionScope, withSuspensionState } from "../media-state.ts";
import { defineJob } from "../runtime/registry.ts";
import { audit, emit } from "./records.ts";

const { users, channels } = schema;

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
    cleared += await ctx.db.transaction(async (tx) => {
      const n = await withSuspensionState(
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
      );
      if (n > 0) {
        const [c] = await tx.select({ id: channels.id }).from(channels).where(eq(channels.ownerId, u.id));
        await audit(
          tx,
          {
            action: "user.ban_lapsed",
            subjectType: "user",
            subjectId: u.id,
            channelId: c?.id ?? null,
            details: { userId: u.id, via: "sweep" },
          },
          now,
        );
      }
      return n;
    });
  }
  return { cleared };
}

/**
 * Suspended by the rule of `channel.suspension` (`media-state.ts`) as of `now`, for a row of
 * `channels` aliased `c`.
 */
const suspendedAt = (now: Date) =>
  sql`(c.suspended_at is not null or exists (select 1 from users su where su.id = c.owner_id and su.banned and (su.ban_expires is null or su.ban_expires > ${now.toISOString()}::timestamptz)))`;

/** The latest `channel.suspension` of the channel aliased `c` says `suspended: true`. */
const lastSaysSuspended = sql`(select (e.payload->>'suspended')::boolean from events e where e.channel_id = c.id and e.type = 'channel.suspension' order by e.occurred_at desc, e.id desc limit 1)`;

/**
 * Decision (g) backstop: a channel whose latest `channel.suspension` still says `suspended: true`
 * while nothing suspends it any more owes `{suspended: false}`. Every other path writes that event
 * in the transaction that unsuspends (`withSuspensionState`), so this finds the events the sign-in
 * hook lost. Owners still marked banned are left out: a lapsed but uncleared ban is
 * `clearLapsedBans`'s to announce, and it would announce it again. Each channel is locked and
 * checked again before writing, as `withSuspensionState` and the API's `recordLapsedUnsuspension`
 * lock it, so a concurrent sign-in, sweep or new suspension serializes with this and the event is
 * written once. Its `audit_log` row says `via: "recovery"`.
 */
export async function recoverLostUnsuspensions(ctx: WorkerContext, batch = 200): Promise<{ recovered: number }> {
  const owed = (now: Date) =>
    sql`(not ${suspendedAt(now)} and not exists (select 1 from users ou where ou.id = c.owner_id and ou.banned) and ${lastSaysSuspended} is true)`;
  const candidates = (await ctx.db.execute(
    sql`select c.id, c.owner_id as "ownerId" from channels c where ${owed(ctx.now())} order by c.id limit ${batch}`,
  )) as unknown as { id: string; ownerId: string }[];
  let recovered = 0;
  for (const cand of candidates) {
    recovered += await ctx.db.transaction(async (tx) => {
      const locked = (await tx.execute(
        sql`select c.id, c.owner_id as "ownerId" from channels c where c.id = ${cand.id}::uuid for update`,
      )) as unknown as { id: string; ownerId: string }[];
      if (locked.length === 0) return 0;
      // Read again under the lock, as of now: whoever held it first may have written the event.
      const asOf = ctx.now();
      const [still] = (await tx.execute(
        sql`select ${owed(asOf)} as owed, (select max(e.occurred_at) from events e where e.channel_id = c.id and e.type = 'channel.suspension') as "lastAt" from channels c where c.id = ${cand.id}::uuid`,
      )) as unknown as { owed: boolean; lastAt: Date | string | null }[];
      if (still?.owed !== true) return 0;
      // "Latest" is by `occurred_at`: the unsuspension must sort after the event it answers, even
      // when that one was stamped by another host's clock a little ahead of ours.
      const lastMs = still.lastAt === null ? -Infinity : new Date(still.lastAt).getTime();
      const now = new Date(Math.max(asOf.getTime(), lastMs + 1));
      await emit(tx, "channel.suspension", cand.id, { channel_id: cand.id, suspended: false }, now);
      await audit(
        tx,
        {
          action: "user.ban_lapsed",
          subjectType: "user",
          subjectId: cand.ownerId,
          channelId: cand.id,
          details: { userId: cand.ownerId, via: "recovery" },
        },
        now,
      );
      return 1;
    });
  }
  if (recovered > 0) ctx.logger.warn("recovered lost channel unsuspensions", { recovered });
  return { recovered };
}

export const job = defineJob({
  queue: QUEUES.moderation,
  name: "ban-expiry",
  description: "Clear timed account suspensions that ran out, with their channel.suspension events",
  data: z.object({}),
  schedule: { pattern: "*/5 * * * *" },
  // Clear first: an owner still banned is skipped by the recovery pass.
  handler: async (_data, ctx) => ({ ...(await clearLapsedBans(ctx)), ...(await recoverLostUnsuspensions(ctx)) }),
});
