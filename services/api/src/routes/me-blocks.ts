// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `me.blocks.*` (ADR 0012 amendment 1 decision 8): users the caller blocked. A block only changes
 * what the blocker sees (live chat, chat replay), so blocking a moderator or the broadcaster is
 * allowed, and it writes no audit row and no event: nothing else consumes it. Session callers only
 * (the procedures carry no token scope, so access tokens are refused before the handler runs).
 */
import { BLOCK_RULES } from "@commonair/contracts/enums";
import { schema } from "@commonair/db";
import { and, count, desc, eq, sql } from "drizzle-orm";
import { iso } from "../lib/dto.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { badRequest, notFound, precondition } from "../lib/errors.ts";
import { os, requireCaller } from "../lib/orpc.ts";
import { blockTarget, blockedRow } from "../blocks/target.ts";

const { userBlocks: ub, users } = schema;

// The cursor carries milliseconds; created_at has microseconds. Comparing at millisecond
// precision keeps rows that share a millisecond from being skipped between pages.
const createdMs = sql<Date>`date_trunc('milliseconds', ${ub.createdAt})`;

export const meBlocks = {
  list: os.me.blocks.list.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const cur = decodeCursor(input.cursor, isKeyCursor);
    const rows = await context.deps.db
      .select({
        createdAt: ub.createdAt,
        id: users.id,
        username: users.username,
        displayName: users.name,
      })
      .from(ub)
      .innerJoin(users, eq(users.id, ub.blockedUserId))
      .where(
        and(
          eq(ub.userId, caller.user.id),
          cur ? sql`(${createdMs}, ${ub.blockedUserId}) < (${cur.t}::timestamptz, ${cur.id}::uuid)` : undefined,
        ),
      )
      .orderBy(desc(createdMs), desc(ub.blockedUserId))
      .limit(input.limit + 1);
    return pageOf(
      rows,
      input.limit,
      (r) => ({
        user: { id: r.id, username: r.username, displayName: r.displayName },
        createdAt: iso(r.createdAt),
      }),
      (last) => encodeCursor({ t: iso(last.createdAt), id: last.id }),
    );
  }),

  ids: os.me.blocks.ids.handler(async ({ context }) => {
    const caller = requireCaller(context);
    const rows = await context.deps.db
      .select({ id: ub.blockedUserId })
      .from(ub)
      .where(eq(ub.userId, caller.user.id))
      .orderBy(desc(ub.createdAt))
      .limit(BLOCK_RULES.maxPerUser);
    return { userIds: rows.map((r) => r.id) };
  }),

  add: os.me.blocks.add.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const { deps } = context;
    const target = await blockTarget(deps.db, input.username);
    if (!target) throw notFound("User not found");
    if (target.id === caller.user.id) throw badRequest("You cannot block yourself");
    return deps.db.transaction(async (tx) => {
      // Serialize one user's adds so two at once cannot pass the limit together.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`user_blocks:${caller.user.id}`}, 0))`);
      const existing = await blockedRow(tx, caller.user.id, target.id);
      if (existing) return { user: target, createdAt: iso(existing.createdAt) };
      const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(ub).where(eq(ub.userId, caller.user.id));
      if (n >= BLOCK_RULES.maxPerUser)
        throw precondition("block_limit", `You can block at most ${BLOCK_RULES.maxPerUser} users`);
      const [row] = await tx
        .insert(ub)
        // Millisecond precision, the same as the list cursor.
        .values({ userId: caller.user.id, blockedUserId: target.id, createdAt: deps.now() })
        .returning({ createdAt: ub.createdAt });
      if (!row) throw new Error("user_blocks insert returned nothing");
      return { user: target, createdAt: iso(row.createdAt) };
    });
  }),

  remove: os.me.blocks.remove.handler(async ({ context, input }) => {
    const caller = requireCaller(context);
    const { deps } = context;
    // Unknown, deleted or never blocked: already the state the caller asked for.
    const [target] = await deps.db.select({ id: users.id }).from(users).where(eq(users.username, input.username));
    if (target) await deps.db.delete(ub).where(and(eq(ub.userId, caller.user.id), eq(ub.blockedUserId, target.id)));
    return { ok: true as const };
  }),
};
