// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact` step 1 (poll) (docs/testing/e8-selectors.md, "Scenarios"), over the API: the
 * streamer starts a 20 s poll with three choices and no bought votes; three viewers vote (two on
 * choice 1); after `endsAt` and one `interact-tick` it is `completed` with 2/1/0; the outbox has
 * `channel.poll.begin`, at least one `progress` and `end` with the same counts. A vote after
 * `endsAt` is refused.
 */
import type { Database } from "@commonair/db";
import { apiError } from "../safety.ts";
import { sleep, waitFor } from "../wait.ts";
import { API_SETTLE_MS, type E8Run } from "./kit.ts";

export const POLL_SECONDS = 20;
/** Choice index per viewer: two on choice 1, one on choice 2. */
export const POLL_VOTES = [0, 0, 1] as const;

export interface OutboxRow {
  type: string;
  payload: Record<string, unknown>;
}

/** Votes per choice for `choices` choices given each voter's choice index. */
export function expectedVotes(votes: readonly number[], choices: number): number[] {
  const out = Array.from({ length: choices }, () => 0);
  for (const v of votes) out[v] = (out[v] ?? 0) + 1;
  return out;
}

const choiceVotes = (payload: Record<string, unknown>): number[] =>
  Array.isArray(payload.choices) ? payload.choices.map((c) => Number((c as { votes?: unknown }).votes)) : [];

/**
 * What is wrong with a poll's outbox rows: one `begin`, at least one `progress`, one `end` with
 * `status` and the final counts. Empty when all is well.
 */
export function pollOutboxProblems(
  rows: readonly OutboxRow[],
  pollId: string,
  want: { votes: readonly number[]; status: string },
): string[] {
  const mine = rows.filter((r) => r.payload.id === pollId);
  const count = (type: string) => mine.filter((r) => r.type === type);
  const problems: string[] = [];
  if (count("channel.poll.begin").length !== 1)
    problems.push(`expected 1 channel.poll.begin, got ${count("channel.poll.begin").length}`);
  if (count("channel.poll.progress").length < 1) problems.push("expected at least 1 channel.poll.progress, got 0");
  const ends = count("channel.poll.end");
  if (ends.length !== 1) problems.push(`expected 1 channel.poll.end, got ${ends.length}`);
  const end = ends[0];
  if (end) {
    if (end.payload.status !== want.status)
      problems.push(`end status ${String(end.payload.status)}, want ${want.status}`);
    const got = choiceVotes(end.payload);
    if (got.join(",") !== want.votes.join(","))
      problems.push(`end votes ${got.join("/")}, want ${want.votes.join("/")}`);
  }
  return problems;
}

/** The API refused with this oRPC code. */
export const refusedWith = (err: unknown, code: string): boolean => apiError(err).code === code;

/** The channel's outbox rows of these types (the owner connection reads `events`). */
export async function outboxRows(db: Database, channelId: string, types: readonly string[]): Promise<OutboxRow[]> {
  // The harness has no drizzle-orm of its own: the relational API hands over the operators.
  const rows = await db.query.events.findMany({
    columns: { type: true, payload: true },
    where: (e, { and, eq, inArray }) => and(eq(e.channelId, channelId), inArray(e.type, [...types])),
  });
  return rows;
}

export async function stepPoll(run: E8Run): Promise<void> {
  const { ctx, streamer, viewers } = run;
  const owner = streamer.user.api.client;
  const poll = await ctx.step("streamer starts a 20 s poll with three choices", () =>
    owner.interact.polls.create({
      channel: streamer.channel,
      title: `Harness poll ${ctx.runId}`.slice(0, 60),
      choices: ["First", "Second", "Third"],
      durationSeconds: POLL_SECONDS,
      pointsPerExtraVote: 0,
    }),
  );
  ctx.data("poll", { id: poll.id, endsAt: poll.endsAt });

  await ctx.step("three viewers vote (two on choice 1)", async () => {
    for (const [i, choice] of POLL_VOTES.entries()) {
      const viewer = viewers[i];
      const choiceId = poll.choices[choice]?.id;
      if (!viewer || !choiceId) throw new Error(`missing viewer ${i} or choice ${choice}`);
      const v = await viewer.api.client.interact.polls.vote({ id: poll.id, choiceId, extraVotes: 0 });
      ctx.assert(`viewer ${i + 1}'s vote recorded`, v.myVote === choiceId && v.myVotes === 1, v);
    }
  });

  await ctx.step("a tick emits channel.poll.progress", async () => {
    await run.hooks.tick("interact-tick");
    await waitFor(
      "channel.poll.progress in the outbox",
      async () =>
        (await outboxRows(run.db, streamer.channelId, ["channel.poll.progress"])).some((r) => r.payload.id === poll.id),
      { timeoutMs: API_SETTLE_MS, intervalMs: 250, signal: ctx.signal },
    );
  });

  await ctx.step("after endsAt and one interact-tick the poll is completed", async () => {
    await sleep(Math.max(0, Date.parse(poll.endsAt) - Date.now()) + 500, ctx.signal);
    await run.hooks.tick("interact-tick");
    // The scheduled tick may have ended it first; either way it ends once.
    const ended = await waitFor(
      "poll completed",
      async () => {
        const c = await owner.interact.polls.current({ channel: streamer.channel });
        return c?.id === poll.id && c.status === "completed" ? c : null;
      },
      { timeoutMs: API_SETTLE_MS, intervalMs: 250, signal: ctx.signal },
    );
    const want = expectedVotes(POLL_VOTES, poll.choices.length);
    ctx.assert("votes 2/1/0", ended.choices.map((c) => c.votes).join(",") === want.join(","), ended.choices);
  });

  await ctx.step("a vote after endsAt is refused", async () => {
    const choiceId = poll.choices[2]?.id ?? "";
    const err = await run.admin.api.client.interact.polls.vote({ id: poll.id, choiceId, extraVotes: 0 }).then(
      () => null,
      (e: unknown) => e,
    );
    ctx.assert("late vote refused with CONFLICT", refusedWith(err, "CONFLICT"), apiError(err));
  });

  await ctx.step("outbox: begin, progress and end with the same counts", async () => {
    const rows = await outboxRows(run.db, streamer.channelId, [
      "channel.poll.begin",
      "channel.poll.progress",
      "channel.poll.end",
    ]);
    const problems = pollOutboxProblems(rows, poll.id, {
      votes: expectedVotes(POLL_VOTES, poll.choices.length),
      status: "completed",
    });
    ctx.assert("poll outbox rows", problems.length === 0, problems);
  });
}
