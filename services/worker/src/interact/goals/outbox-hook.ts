// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Goal progress in the outbox relay transaction (ADR 0026 decision 5, Amendment 1): advance each
 * channel's open goal of the matching type for the follows, subscriptions and tips in `events`,
 * and write `channel.goal.progress`/`end` in the same transaction. Returns how many goals moved.
 *
 * It runs inside the relay's claim, so it stays bounded: no query at all for a batch with nothing
 * that counts, otherwise one select for the candidate goals and one guarded update per goal that
 * moves (in id order, so two relays never lock goals in opposite orders). A rollback of the batch
 * rolls these updates back with it, so each event counts exactly once.
 *
 * A followers goal counts each account once: a follow whose user already has a relayed follow on
 * that channel since the goal started (an unfollow and refollow) adds nothing. That costs one more
 * select, only when an open followers goal is in play, on `events_channel_type_idx`.
 */
import { and, asc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { BusEvent } from "@commonair/contracts/events";
import { schema, type Executor } from "@commonair/db";
import {
  emitEvent,
  followerId,
  goalAchieved,
  goalEndPayload,
  goalIncrement,
  goalProgressPayload,
  goalTargets,
} from "@commonair/interact";
import type { WorkerContext } from "../../context.ts";

const { channels, events: outbox, goals } = schema;

export async function applyGoalProgress(
  tx: Executor,
  events: readonly BusEvent[],
  ctx: Pick<WorkerContext, "now">,
): Promise<number> {
  const targets = goalTargets(events);
  if (!targets) return 0;
  const open = await tx
    .select({
      id: goals.id,
      channelId: goals.channelId,
      type: goals.type,
      startedAt: goals.startedAt,
      ownerId: channels.ownerId,
      slug: channels.slug,
      displayName: channels.displayName,
    })
    .from(goals)
    .innerJoin(channels, eq(channels.id, goals.channelId))
    .where(and(inArray(goals.channelId, targets.channelIds), inArray(goals.type, targets.types), isNull(goals.endedAt)))
    .orderBy(asc(goals.id));

  const counted = await relayedFollows(tx, events, open);

  const now = ctx.now();
  let moved = 0;
  for (const g of open) {
    const n = goalIncrement(g, events, counted);
    if (n <= 0) continue;
    // Guarded on `ended_at is null`: a goal that another relay or the streamer ended in between
    // takes nothing more. Reaching the target ends it in the same statement.
    const [row] = await tx
      .update(goals)
      .set({
        current: sql`${goals.current} + ${n}`,
        endedAt: sql`case when ${goals.current} + ${n} >= ${goals.target} then ${now.toISOString()}::timestamptz else null end`,
      })
      .where(and(eq(goals.id, g.id), isNull(goals.endedAt)))
      .returning();
    if (!row) continue;
    moved++;
    await emitEvent(tx, "channel.goal.progress", g.channelId, goalProgressPayload(g, row), now);
    // One millisecond later: the relay orders by `occurred_at`, then by a random-tailed id, so the
    // overlay would otherwise sometimes see the last progress after the end.
    if (row.endedAt && goalAchieved(row.current, row.target))
      await emitEvent(tx, "channel.goal.end", g.channelId, goalEndPayload(g, row), new Date(now.getTime() + 1));
  }
  return moved;
}

/**
 * The batch's followers' earlier follows of the same channels that the relay already published,
 * since the earliest open followers goal started. Unpublished ones are left out on purpose: they
 * are counted when their own batch runs, and that batch sees this one's as published.
 */
async function relayedFollows(
  tx: Executor,
  events: readonly BusEvent[],
  open: readonly { channelId: string; type: string; startedAt: Date }[],
): Promise<{ channelId: string; userId: string; occurredAt: Date }[]> {
  const goalsOf = open.filter((g) => g.type === "followers");
  if (goalsOf.length === 0) return [];
  const channelIds = [...new Set(goalsOf.map((g) => g.channelId))];
  const userIds = [
    ...new Set(
      events
        .filter((e) => e.channelId !== null && channelIds.includes(e.channelId))
        .map(followerId)
        .filter((id): id is string => id !== null),
    ),
  ];
  if (userIds.length === 0) return [];
  const since = new Date(Math.min(...goalsOf.map((g) => g.startedAt.getTime())));
  const userId = sql<string>`${outbox.payload} ->> 'user_id'`;
  const rows = await tx
    .select({ channelId: outbox.channelId, userId, occurredAt: outbox.occurredAt })
    .from(outbox)
    .where(
      and(
        inArray(outbox.channelId, channelIds),
        eq(outbox.type, "channel.follow"),
        gte(outbox.occurredAt, since),
        isNotNull(outbox.publishedAt),
        inArray(userId, userIds),
      ),
    );
  return rows.flatMap((r) =>
    r.channelId === null ? [] : [{ channelId: r.channelId, userId: r.userId, occurredAt: r.occurredAt }],
  );
}
