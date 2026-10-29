// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Goals (ADR 0026 decision 5): one open goal per channel and type (`goals_channel_open_uq`), counted
 * from zero at its start by the worker's outbox-relay hook. `create` and `end` write their
 * `channel.goal.*` event in the same transaction. Owned by E8-raids-goals.
 */
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { schema, type Executor } from "@commonair/db";
import { emitEvent, goalBeginPayload, goalEndPayload, toGoal, type GoalType } from "@commonair/interact";
import type { Deps } from "../../deps.ts";
import { audit } from "../../events/audit.ts";
import { conflict, isUniqueViolation, notFound } from "../../lib/errors.ts";

const { goals } = schema;

type ChannelRow = typeof schema.channels.$inferSelect;
type GoalDto = ReturnType<typeof toGoal>;

/** Ended goals `list` shows after the open ones. */
export const RECENT_ENDED_GOALS = 10;

const openConflict = () => conflict("This channel already has an open goal of that type");

/** The channel's open goals, oldest first (the overlay's bars). */
export async function openGoals(db: Executor, channelId: string): Promise<GoalDto[]> {
  const rows = await db
    .select()
    .from(goals)
    .where(and(eq(goals.channelId, channelId), isNull(goals.endedAt)))
    .orderBy(asc(goals.startedAt), asc(goals.id));
  return rows.map(toGoal);
}

/** Open goals, then the ten most recently ended. */
export async function listGoals(db: Executor, channelId: string): Promise<GoalDto[]> {
  const ended = await db
    .select()
    .from(goals)
    .where(and(eq(goals.channelId, channelId), isNotNull(goals.endedAt)))
    .orderBy(desc(goals.endedAt), desc(goals.id))
    .limit(RECENT_ENDED_GOALS);
  return [...(await openGoals(db, channelId)), ...ended.map(toGoal)];
}

export async function createGoal(
  deps: Deps,
  channel: ChannelRow,
  actorId: string,
  input: { type: GoalType; title: string; target: number },
): Promise<GoalDto> {
  const now = deps.now();
  try {
    return await deps.db.transaction(async (tx) => {
      const [open] = await tx
        .select({ id: goals.id })
        .from(goals)
        .where(and(eq(goals.channelId, channel.id), eq(goals.type, input.type), isNull(goals.endedAt)))
        .limit(1);
      if (open) throw openConflict();
      const [g] = await tx
        .insert(goals)
        .values({ channelId: channel.id, type: input.type, title: input.title, target: input.target, startedAt: now })
        .returning();
      if (!g) throw new Error("goal insert returned no row");
      await audit(tx, {
        actorType: "user",
        actorId,
        action: "goal.create",
        subjectType: "goal",
        subjectId: g.id,
        channelId: channel.id,
        details: { type: g.type, target: g.target },
      });
      await emitEvent(tx, "channel.goal.begin", channel.id, goalBeginPayload(channel, g), now);
      return toGoal(g);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw openConflict();
    throw err;
  }
}

/**
 * End an open goal. A goal that already ended (by the streamer, or by reaching its target in the
 * relay hook a moment earlier) is returned as it is, with no second `end` event.
 */
export async function endGoal(deps: Deps, channel: ChannelRow, actorId: string, id: string): Promise<GoalDto> {
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    const [g] = await tx
      .update(goals)
      .set({ endedAt: now })
      .where(and(eq(goals.id, id), eq(goals.channelId, channel.id), isNull(goals.endedAt)))
      .returning();
    if (!g) {
      const [existing] = await tx
        .select()
        .from(goals)
        .where(and(eq(goals.id, id), eq(goals.channelId, channel.id)))
        .limit(1);
      if (!existing) throw notFound("Goal not found");
      return toGoal(existing);
    }
    const payload = goalEndPayload(channel, g);
    await audit(tx, {
      actorType: "user",
      actorId,
      action: "goal.end",
      subjectType: "goal",
      subjectId: g.id,
      channelId: channel.id,
      details: { achieved: payload.is_achieved },
    });
    await emitEvent(tx, "channel.goal.end", channel.id, payload, now);
    return toGoal(g);
  });
}
