// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact-tick` (E8-polls): ends due polls exactly once across concurrent runs, locks due
 * predictions, and emits one progress event per changed poll or prediction, none for unchanged.
 */
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { changedAtAfterProgress } from "@commonair/interact";
import { runInteractTick } from "../src/interact/polls/tick.ts";
import { makeUser, setup, type TestEnv } from "./fixtures.ts";

let env: TestEnv;
beforeAll(async () => {
  env = await setup({ jobs: [], outbox: false, segments: false });
}, 120_000);
afterAll(() => env.close());

const db = () => env.t.db;
const ctx = () => env.worker.ctx;
const SEC = 1000;
const byString = (a: string, b: string) => a.localeCompare(b);

async function poll(channelId: string, endsInSeconds: number, over: Partial<typeof schema.polls.$inferInsert> = {}) {
  const now = Date.now();
  const id = uuidv7();
  await db()
    .insert(schema.polls)
    .values({
      id,
      channelId,
      title: "Best map?",
      choices: [
        { id: "x", title: "Ex", votes: 0 },
        { id: "y", title: "Why", votes: 0 },
      ],
      durationSeconds: 20,
      startedAt: new Date(now - 30 * SEC),
      endsAt: new Date(now + endsInSeconds * SEC),
      ...over,
    });
  return id;
}

async function prediction(
  channelId: string,
  locksInSeconds: number,
  over: Partial<typeof schema.predictions.$inferInsert> = {},
) {
  const now = Date.now();
  const id = uuidv7();
  await db()
    .insert(schema.predictions)
    .values({
      id,
      channelId,
      title: "Who wins?",
      outcomes: [
        { id: "A", title: "A", points: 0, users: 0 },
        { id: "B", title: "B", points: 0, users: 0 },
      ],
      windowSeconds: 60,
      startedAt: new Date(now - 60 * SEC),
      locksAt: new Date(now + locksInSeconds * SEC),
      ...over,
    });
  return id;
}

async function vote(pollId: string, choiceId: string, votes = 1) {
  const { user } = await makeUser(db());
  await db().insert(schema.pollVotes).values({ pollId, userId: user.id, choiceId, votes });
}

const eventsFor = async (type: string, ids: readonly string[]) =>
  (await db().select().from(schema.events).where(eq(schema.events.type, type))).filter((e) =>
    ids.includes(String(e.payload.id)),
  );

describe("interact-tick", () => {
  test("ends due polls once across two concurrent runs, with the final counts", async () => {
    const [a, b, c] = await Promise.all([makeUser(db()), makeUser(db()), makeUser(db())]);
    const dueA = await poll(a.channel.id, -1);
    const dueB = await poll(b.channel.id, -5);
    const later = await poll(c.channel.id, 60);
    await vote(dueA, "x", 3);
    await vote(dueA, "y");

    const now = ctx().now();
    const [r1, r2] = await Promise.all([runInteractTick(ctx().db, now), runInteractTick(ctx().db, now)]);
    expect(r1.pollsEnded + r2.pollsEnded).toBe(2);

    const rows = await db()
      .select()
      .from(schema.polls)
      .where(inArray(schema.polls.id, [dueA, dueB, later]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(dueA)?.status).toBe("completed");
    expect(byId.get(dueA)?.choices.map((ch) => ch.votes)).toEqual([3, 1]);
    expect(byId.get(dueB)?.status).toBe("completed");
    expect(byId.get(later)?.status).toBe("active");

    const ends = await eventsFor("channel.poll.end", [dueA, dueB, later]);
    expect(ends.map((e) => String(e.payload.id)).sort(byString)).toEqual([dueA, dueB].sort(byString));
    const endA = ends.find((e) => e.payload.id === dueA);
    expect(endA?.payload).toMatchObject({ status: "completed" });
    const endChoices = (endA?.payload.choices ?? []) as { votes: number; channel_points_votes: number }[];
    expect(endChoices.map((ch) => ch.votes)).toEqual([3, 1]);
    expect(endChoices[0]?.channel_points_votes).toBe(2);

    // Nothing left to do: a third run ends nothing.
    expect((await runInteractTick(ctx().db, ctx().now())).pollsEnded).toBe(0);
  });

  test("locks due predictions once and leaves the rest open", async () => {
    const [a, b] = await Promise.all([makeUser(db()), makeUser(db())]);
    const due = await prediction(a.channel.id, -1);
    const open = await prediction(b.channel.id, 60);
    const now = ctx().now();
    const [r1, r2] = await Promise.all([runInteractTick(ctx().db, now), runInteractTick(ctx().db, now)]);
    expect(r1.predictionsLocked + r2.predictionsLocked).toBe(1);
    const [d] = await db().select().from(schema.predictions).where(eq(schema.predictions.id, due));
    expect(d).toMatchObject({ status: "locked" });
    expect(d?.lockedAt).not.toBeNull();
    const [o] = await db().select().from(schema.predictions).where(eq(schema.predictions.id, open));
    expect(o?.status).toBe("active");
    expect(await eventsFor("channel.prediction.lock", [due, open])).toHaveLength(1);
  });

  test("one progress per changed poll or prediction, none for an unchanged one", async () => {
    const [a, b, c, d] = await Promise.all([makeUser(db()), makeUser(db()), makeUser(db()), makeUser(db())]);
    const changedAt = new Date(Date.now() - 10 * SEC);
    const changedPoll = await poll(a.channel.id, 60, { changedAt });
    const quietPoll = await poll(b.channel.id, 60);
    const changedPred = await prediction(c.channel.id, 60, { changedAt });
    const quietPred = await prediction(d.channel.id, 60);
    await vote(changedPoll, "y", 2);

    const first = await runInteractTick(ctx().db, ctx().now());
    expect(first.progress).toBe(2);
    expect(await eventsFor("channel.poll.progress", [changedPoll, quietPoll])).toHaveLength(1);
    expect(await eventsFor("channel.prediction.progress", [changedPred, quietPred])).toHaveLength(1);
    const [p] = await eventsFor("channel.poll.progress", [changedPoll]);
    expect(((p?.payload.choices ?? []) as { votes: number }[]).map((ch) => ch.votes)).toEqual([0, 2]);

    // No new vote or bet: the next tick sends nothing.
    expect((await runInteractTick(ctx().db, ctx().now())).progress).toBe(0);

    // A later vote: exactly one more.
    await db().update(schema.polls).set({ changedAt: ctx().now() }).where(eq(schema.polls.id, changedPoll));
    await Bun.sleep(5);
    expect((await runInteractTick(ctx().db, ctx().now())).progress).toBe(1);
    expect(await eventsFor("channel.poll.progress", [changedPoll])).toHaveLength(2);
  });

  test("a vote or bet that waited on the tick's lock still gets a progress event", async () => {
    const [a, b] = await Promise.all([makeUser(db()), makeUser(db())]);
    const p = await poll(a.channel.id, 60);
    const q = await prediction(b.channel.id, 60);
    // The vote and bet took `now` before the tick did, then committed after it (they were waiting on
    // its row lock): they write `changedAt` with that earlier clock.
    const voteNow = new Date(Date.now() - 5 * SEC);
    await vote(p, "x");
    await db().update(schema.polls).set({ changedAt: voteNow }).where(eq(schema.polls.id, p));
    await db().update(schema.predictions).set({ changedAt: voteNow }).where(eq(schema.predictions.id, q));
    expect((await runInteractTick(ctx().db, ctx().now())).progress).toBe(2);

    await vote(p, "y");
    await db()
      .update(schema.polls)
      .set({ changedAt: changedAtAfterProgress(schema.polls, voteNow) })
      .where(eq(schema.polls.id, p));
    await db()
      .update(schema.predictions)
      .set({ changedAt: changedAtAfterProgress(schema.predictions, voteNow) })
      .where(eq(schema.predictions.id, q));
    expect((await runInteractTick(ctx().db, ctx().now())).progress).toBe(2);
    const progress = await eventsFor("channel.poll.progress", [p]);
    expect(progress).toHaveLength(2);
    const votesOf = (e: (typeof progress)[number]) => (e.payload.choices as { votes: number }[]).map((ch) => ch.votes);
    expect(progress.map(votesOf)).toContainEqual([1, 1]);
    expect(await eventsFor("channel.prediction.progress", [q])).toHaveLength(2);
  });
});
