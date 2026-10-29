// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Polls (E8-polls, ADR 0026): counts, the API view, the `channel.poll.*` payloads and ending a
 * poll. Shared by the API (`interact.polls.*`) and the worker (`interact-tick`). `polls.choices`
 * holds the final counts once a poll ended; while it is active the counts come from `poll_votes`
 * (never read-modify-write `choices` without the row lock).
 */
import { eq, sql } from "drizzle-orm";
import type { PollView } from "@commonair/contracts/dto";
import type { POLL_STATUSES } from "@commonair/contracts/enums";
import type { EventPayload } from "@commonair/contracts/events";
import { schema, type Executor } from "@commonair/db";
import type { z } from "zod";
import { broadcasterFields, emitEvent } from "./outbox.ts";

export type PollRow = typeof schema.polls.$inferSelect;
export type PollStatus = (typeof POLL_STATUSES)[number];
export type PollViewDto = z.infer<typeof PollView>;
/** The channel fields the poll and prediction payloads need. */
export interface PollChannel {
  id: string;
  ownerId: string;
  slug: string;
  displayName: string;
}

/** Votes per choice id: `votes` includes `bought` (the extra votes paid with points). */
export type PollCounts = ReadonlyMap<string, { votes: number; bought: number }>;

/** Sum of `poll_votes.votes` by choice, and the bought part (every vote past a voter's first). */
export async function pollCounts(tx: Executor, pollId: string): Promise<PollCounts> {
  const rows = await tx
    .select({
      choiceId: schema.pollVotes.choiceId,
      votes: sql<number>`coalesce(sum(${schema.pollVotes.votes}), 0)::int`,
      bought: sql<number>`coalesce(sum(${schema.pollVotes.votes} - 1), 0)::int`,
    })
    .from(schema.pollVotes)
    .where(eq(schema.pollVotes.pollId, pollId))
    .groupBy(schema.pollVotes.choiceId);
  return new Map(rows.map((r) => [r.choiceId, { votes: Number(r.votes), bought: Number(r.bought) }]));
}

const countOf = (counts: PollCounts, choiceId: string) => counts.get(choiceId) ?? { votes: 0, bought: 0 };

/** The API view; `mine` is the caller's vote (null when anonymous or not voted). */
export function pollView(
  row: PollRow,
  counts: PollCounts,
  mine: { choiceId: string; votes: number } | null,
): PollViewDto {
  return {
    id: row.id,
    title: row.title,
    choices: row.choices.map((c) => ({ id: c.id, title: c.title, votes: countOf(counts, c.id).votes })),
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    pointsPerExtraVote: row.pointsPerExtraVote,
    myVote: mine?.choiceId ?? null,
    myVotes: mine?.votes ?? 0,
  };
}

type PollEndStatus = Exclude<PollStatus, "active">;

function pollCommon(channel: PollChannel, poll: PollRow, counts: PollCounts) {
  return {
    ...broadcasterFields(channel),
    id: poll.id,
    title: poll.title,
    choices: poll.choices.map((c) => {
      const n = countOf(counts, c.id);
      return { id: c.id, title: c.title, votes: n.votes, channel_points_votes: n.bought };
    }),
    channel_points_voting: { is_enabled: poll.pointsPerExtraVote > 0, amount_per_vote: poll.pointsPerExtraVote },
    started_at: poll.startedAt.toISOString(),
  };
}

/** `channel.poll.begin` / `progress` (same shape) or `end` (the poll must have ended). */
export function pollEventPayload(
  kind: "begin" | "progress",
  channel: PollChannel,
  poll: PollRow,
  counts: PollCounts,
): EventPayload<"channel.poll.begin">;
export function pollEventPayload(
  kind: "end",
  channel: PollChannel,
  poll: PollRow,
  counts: PollCounts,
): EventPayload<"channel.poll.end">;
export function pollEventPayload(
  kind: "begin" | "progress" | "end",
  channel: PollChannel,
  poll: PollRow,
  counts: PollCounts,
): EventPayload<"channel.poll.begin"> | EventPayload<"channel.poll.end"> {
  const common = pollCommon(channel, poll, counts);
  if (kind !== "end") return { ...common, ends_at: poll.endsAt.toISOString() };
  if (poll.status === "active" || poll.endedAt === null) throw new Error("channel.poll.end needs an ended poll");
  return { ...common, status: poll.status, ended_at: poll.endedAt.toISOString() };
}

/** The channel fields of a poll's or prediction's channel. */
export async function pollChannelOf(tx: Executor, channelId: string): Promise<PollChannel> {
  const [c] = await tx
    .select({
      id: schema.channels.id,
      ownerId: schema.channels.ownerId,
      slug: schema.channels.slug,
      displayName: schema.channels.displayName,
    })
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId));
  if (!c) throw new Error(`channel ${channelId} not found`);
  return c;
}

/**
 * Lock a poll row (`FOR UPDATE`; `skipLocked` for the worker, so replicas never wait on each
 * other). Null when missing or, with `skipLocked`, held by another transaction.
 */
export async function lockPoll(tx: Executor, pollId: string, opts: { skipLocked?: boolean } = {}) {
  const q = tx.select().from(schema.polls).where(eq(schema.polls.id, pollId));
  const [row] = await (opts.skipLocked ? q.for("update", { skipLocked: true }) : q.for("update"));
  return row ?? null;
}

/**
 * End a poll under its row lock: an active poll gets `status`, `endedAt = now` and its final
 * counts in `choices`; `archived` also hides an already ended poll from `current` (keeping its
 * `endedAt`). Writes `channel.poll.end`. Returns the updated row, or null when there was nothing to
 * do (already ended, or already archived), so a second end is a no-op.
 */
export async function endPollInTx(
  tx: Executor,
  pollId: string,
  status: PollEndStatus,
  now: Date,
): Promise<PollRow | null> {
  const row = await lockPoll(tx, pollId);
  if (!row) return null;
  const ending = row.status === "active";
  const archiving = status === "archived" && (row.status === "completed" || row.status === "terminated");
  if (!ending && !archiving) return null;
  const counts = await pollCounts(tx, pollId);
  const choices = row.choices.map((c) => ({ ...c, votes: countOf(counts, c.id).votes }));
  const [updated] = await tx
    .update(schema.polls)
    .set({ status, choices, endedAt: row.endedAt ?? now })
    .where(eq(schema.polls.id, pollId))
    .returning();
  if (!updated) return null;
  const channel = await pollChannelOf(tx, updated.channelId);
  await emitEvent(tx, "channel.poll.end", channel.id, pollEventPayload("end", channel, updated, counts), now);
  return updated;
}

/** Whether `changedAt` is newer than the last progress (or the start): a progress event is due. */
export function pollProgressDue(row: { changedAt: Date | null; progressAt: Date | null; startedAt: Date }): boolean {
  if (row.changedAt === null) return false;
  return row.changedAt > (row.progressAt ?? row.startedAt);
}
