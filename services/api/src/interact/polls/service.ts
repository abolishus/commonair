// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact.polls.*` (E8-polls, ADR 0026, docs/testing/e8-selectors.md "Polls"): one active poll
 * per channel, one vote per viewer plus extra votes bought with channel points. Votes write no
 * event; `interact-tick` emits the throttled `channel.poll.progress` and ends polls at `endsAt`.
 */
import { and, desc, eq, ne, sql } from "drizzle-orm";
import { POLL_RULES } from "@commonair/contracts/enums";
import { InsufficientPointsError, postPointsInTx, schema, uuidv7, type Database, type Executor } from "@commonair/db";
import {
  changedAtAfterProgress,
  emitEvent,
  endPollInTx,
  lockPoll,
  pointsChangePayload,
  pollCounts,
  pollEventPayload,
  pollView,
  type PollCounts,
  type PollRow,
  type PollViewDto,
} from "@commonair/interact";
import { audit } from "../../events/audit.ts";
import type { Caller } from "../../lib/access.ts";
import { badRequest, conflict, isUniqueViolation, notFound, precondition } from "../../lib/errors.ts";
import {
  actorTypeOf,
  assertNotBanned,
  channelById,
  channelBySlug,
  channelPointsEnabled,
  requireAuthority,
  type Authority,
  type ChannelRow,
} from "./shared.ts";

const { polls, pollVotes, users } = schema;

interface Ctx {
  db: Database;
  now: () => Date;
}

async function myVote(db: Executor, pollId: string, userId: string | null) {
  if (userId === null) return null;
  const [v] = await db
    .select({ choiceId: pollVotes.choiceId, votes: pollVotes.votes })
    .from(pollVotes)
    .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, userId)));
  return v ?? null;
}

async function viewOf(db: Executor, row: PollRow, userId: string | null): Promise<PollViewDto> {
  return pollView(row, await pollCounts(db, row.id), await myVote(db, row.id, userId));
}

/** The active poll, else the most recent one not archived; null when there is none. */
export async function currentPoll(ctx: Ctx, slug: string, caller: Caller | null): Promise<PollViewDto | null> {
  const channel = await channelBySlug(ctx.db, slug);
  const [row] = await ctx.db
    .select()
    .from(polls)
    .where(and(eq(polls.channelId, channel.id), ne(polls.status, "archived")))
    // `active` sorts first: the one active poll wins over any later-started ended one.
    .orderBy(desc(eq(polls.status, "active")), desc(polls.startedAt), desc(polls.id))
    .limit(1);
  return row ? viewOf(ctx.db, row, caller?.user.id ?? null) : null;
}

export async function createPoll(
  ctx: Ctx,
  caller: Caller,
  authority: Authority,
  channel: ChannelRow,
  input: { title: string; choices: string[]; durationSeconds: number; pointsPerExtraVote: number },
): Promise<PollViewDto> {
  const now = ctx.now();
  const busy = () => conflict("This channel already has an active poll");
  try {
    return await ctx.db.transaction(async (tx) => {
      const [active] = await tx
        .select({ id: polls.id })
        .from(polls)
        .where(and(eq(polls.channelId, channel.id), eq(polls.status, "active")));
      if (active) throw busy();
      const [row] = await tx
        .insert(polls)
        .values({
          id: uuidv7(now.getTime()),
          channelId: channel.id,
          title: input.title,
          choices: input.choices.map((title) => ({ id: uuidv7(now.getTime()), title, votes: 0 })),
          status: "active",
          durationSeconds: input.durationSeconds,
          pointsPerExtraVote: input.pointsPerExtraVote,
          createdById: caller.user.id,
          startedAt: now,
          endsAt: new Date(now.getTime() + input.durationSeconds * 1000),
        })
        .returning();
      if (!row) throw new Error("poll insert returned nothing");
      await audit(tx, {
        actorType: actorTypeOf(authority),
        actorId: caller.user.id,
        action: "poll.create",
        subjectType: "poll",
        subjectId: row.id,
        channelId: channel.id,
        details: {
          choices: row.choices.length,
          durationSeconds: row.durationSeconds,
          pointsPerExtraVote: row.pointsPerExtraVote,
        },
      });
      const counts: PollCounts = new Map();
      await emitEvent(tx, "channel.poll.begin", channel.id, pollEventPayload("begin", channel, row, counts), now);
      return pollView(row, counts, null);
    });
  } catch (err) {
    // `polls_channel_active_uq` is the backstop when two creates race past the check.
    if (isUniqueViolation(err)) throw busy();
    throw err;
  }
}

export async function votePoll(
  ctx: Ctx,
  caller: Caller,
  input: { id: string; choiceId: string; extraVotes: number },
): Promise<PollViewDto> {
  const now = ctx.now();
  const userId = caller.user.id;
  return ctx.db.transaction(async (tx) => {
    // The row lock orders votes against `endPollInTx`, so the final counts include every vote.
    const poll = await lockPoll(tx, input.id);
    if (!poll) throw notFound("Poll not found");
    await assertNotBanned(tx, poll.channelId, userId, now);
    if (poll.status !== "active" || now >= poll.endsAt) throw conflict("This poll has ended");
    if (!poll.choices.some((c) => c.id === input.choiceId)) throw badRequest("No such choice in this poll");

    const prior = await myVote(tx, poll.id, userId);
    if (prior && prior.choiceId !== input.choiceId) throw conflict("You already voted for another choice");
    if (prior && input.extraVotes < 1) throw conflict("You already voted in this poll");
    const extraBefore = prior ? prior.votes - 1 : 0;
    if (extraBefore + input.extraVotes > POLL_RULES.maxExtraVotesPerUser)
      throw conflict(`At most ${POLL_RULES.maxExtraVotesPerUser} extra votes per viewer`);

    let spent = 0;
    if (input.extraVotes > 0) {
      if (poll.pointsPerExtraVote <= 0) throw badRequest("This poll has no extra votes");
      if (!(await channelPointsEnabled(tx, poll.channelId)))
        throw precondition("points_disabled", "Channel points are off on this channel");
      spent = input.extraVotes * poll.pointsPerExtraVote;
      const [me] = await tx
        .select({ id: users.id, username: users.username, name: users.name })
        .from(users)
        .where(eq(users.id, userId));
      if (!me) throw notFound("User not found");
      let balance: number;
      try {
        ({ balance } = await postPointsInTx(tx, {
          channelId: poll.channelId,
          userId,
          delta: -spent,
          reason: "poll_vote",
          refId: poll.id,
          at: now,
        }));
      } catch (err) {
        if (err instanceof InsufficientPointsError) throw precondition("insufficient_points", "Not enough points");
        throw err;
      }
      const channel = await channelById(tx, poll.channelId);
      await emitEvent(
        tx,
        "channel.points.change",
        channel.id,
        pointsChangePayload(channel, me, { delta: -spent, balance, reason: "poll_vote" }),
        now,
      );
    }

    const votes = 1 + input.extraVotes;
    if (prior)
      await tx
        .update(pollVotes)
        .set({ votes: prior.votes + input.extraVotes, pointsSpent: sql`${pollVotes.pointsSpent} + ${spent}` })
        .where(and(eq(pollVotes.pollId, poll.id), eq(pollVotes.userId, userId)));
    else
      await tx
        .insert(pollVotes)
        .values({ pollId: poll.id, userId, choiceId: input.choiceId, votes, pointsSpent: spent, castAt: now });
    const [updated] = await tx
      .update(polls)
      .set({ changedAt: changedAtAfterProgress(polls, now) })
      .where(eq(polls.id, poll.id))
      .returning();
    return viewOf(tx, updated ?? poll, userId);
  });
}

export async function endPoll(
  ctx: Ctx,
  caller: Caller,
  input: { id: string; status: "terminated" | "archived" },
): Promise<PollViewDto> {
  const [poll] = await ctx.db.select().from(polls).where(eq(polls.id, input.id));
  if (!poll) throw notFound("Poll not found");
  const channel = await channelById(ctx.db, poll.channelId);
  const authority = await requireAuthority(ctx.db, caller, channel);
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const ended = await endPollInTx(tx, poll.id, input.status, now);
    if (!ended)
      throw conflict(input.status === "archived" ? "This poll is already archived" : "This poll has already ended");
    await audit(tx, {
      actorType: actorTypeOf(authority),
      actorId: caller.user.id,
      action: "poll.end",
      subjectType: "poll",
      subjectId: ended.id,
      channelId: channel.id,
      details: { status: input.status },
    });
    return viewOf(tx, ended, caller.user.id);
  });
}
