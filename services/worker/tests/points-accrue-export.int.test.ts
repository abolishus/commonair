// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The account export's `interact.json` against a real database: the requester's points, ledger,
 * poll votes, prediction bets and song requests in every channel, and nothing of anyone else's.
 */
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema as s, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { collect } from "../src/exports/collectors.ts";

let t: TestDatabase;
let db: Database;
beforeAll(async () => {
  t = await createTestDatabase();
  db = t.db;
}, 180_000);
afterAll(async () => {
  await t?.drop();
});

let seq = 0;
async function user(): Promise<string> {
  const name = `px${++seq}${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const [u] = await db
    .insert(s.users)
    .values({ name, username: name, email: `${name}@example.test` })
    .returning({ id: s.users.id });
  if (!u) throw new Error("no user");
  return u.id;
}

async function channel(): Promise<{ id: string; slug: string }> {
  const ownerId = await user();
  const slug = `pxc${++seq}${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;
  const [c] = await db
    .insert(s.channels)
    .values({ ownerId, slug, displayName: slug })
    .returning({ id: s.channels.id, slug: s.channels.slug });
  if (!c) throw new Error("no channel");
  return c;
}

/** One of everything for `userId` on channel `c`, marked with `n` so rows are told apart. */
async function activity(c: { id: string }, userId: string, n: number) {
  const at = (offset: number) => new Date(Date.UTC(2026, 9, 1, 12, n, offset));
  await db.insert(s.loyaltyTransactions).values([
    { channelId: c.id, userId, delta: 100 * n, reason: "watch", createdAt: at(0) },
    { channelId: c.id, userId, delta: -n, reason: "poll_vote", createdAt: at(1) },
    { channelId: c.id, userId, delta: -2 * n, reason: "prediction_bet", createdAt: at(2) },
  ]);
  const [poll] = await db
    .insert(s.polls)
    .values({
      channelId: c.id,
      title: `poll ${n}`,
      choices: [
        { id: "a", title: "A", votes: 0 },
        { id: "b", title: "B", votes: 1 },
      ],
      status: "completed",
      durationSeconds: 60,
      pointsPerExtraVote: 1,
      endsAt: at(30),
    })
    .returning({ id: s.polls.id });
  if (!poll) throw new Error("no poll");
  await db
    .insert(s.pollVotes)
    .values({ pollId: poll.id, userId, choiceId: "b", votes: 1 + n, pointsSpent: n, castAt: at(1) });
  const [prediction] = await db
    .insert(s.predictions)
    .values({
      channelId: c.id,
      title: `prediction ${n}`,
      outcomes: [
        { id: "o1", title: "Yes", points: 0, users: 1 },
        { id: "o2", title: "No", points: 0, users: 0 },
      ],
      status: "resolved",
      windowSeconds: 60,
      locksAt: at(40),
    })
    .returning({ id: s.predictions.id });
  if (!prediction) throw new Error("no prediction");
  await db
    .insert(s.predictionBets)
    .values({ predictionId: prediction.id, userId, outcomeId: "o1", points: 2 * n, placedAt: at(2) });
  await db
    .insert(s.songRequests)
    .values({ channelId: c.id, requesterId: userId, url: `https://example.org/song-${n}`, createdAt: at(3) });
  return { pollId: poll.id, predictionId: prediction.id };
}

describe("interact.json", () => {
  test("the requester's points, ledger, votes, bets and song requests in two channels; nobody else's", async () => {
    const me = await user();
    const other = await user();
    const [c1, c2] = [await channel(), await channel()];
    const a1 = await activity(c1, me, 1);
    const a2 = await activity(c2, me, 2);
    await activity(c1, other, 3);

    const files = await db.transaction((tx) => collect(tx, "account", { userId: me, channelId: null }));
    const value = files.get("interact.json") as Record<string, Record<string, unknown>[]>;
    expect(Object.keys(value)).toEqual([
      "pointsBalances",
      "pointsTransactions",
      "pollVotes",
      "predictionBets",
      "songRequests",
    ]);

    const bySlug = (rows: Record<string, unknown>[]) =>
      [...rows].sort((x, y) => String(x.channelSlug).localeCompare(String(y.channelSlug)));
    expect(bySlug(value.pointsBalances ?? [])).toEqual(
      bySlug([
        { channelSlug: c1.slug, points: 97 },
        { channelSlug: c2.slug, points: 194 },
      ]),
    );
    expect((value.pointsTransactions ?? []).map((r) => [r.channelSlug, r.delta, r.reason])).toEqual([
      [c1.slug, 100, "watch"],
      [c1.slug, -1, "poll_vote"],
      [c1.slug, -2, "prediction_bet"],
      [c2.slug, 200, "watch"],
      [c2.slug, -2, "poll_vote"],
      [c2.slug, -4, "prediction_bet"],
    ]);
    expect(value.pointsTransactions?.every((r) => typeof r.id === "string" && r.createdAt instanceof Date)).toBe(true);
    expect(value.pollVotes).toEqual([
      expect.objectContaining({ channelSlug: c1.slug, pollId: a1.pollId, choiceId: "b", votes: 2, pointsSpent: 1 }),
      expect.objectContaining({ channelSlug: c2.slug, pollId: a2.pollId, choiceId: "b", votes: 3, pointsSpent: 2 }),
    ]);
    expect(value.predictionBets).toEqual([
      expect.objectContaining({
        channelSlug: c1.slug,
        predictionId: a1.predictionId,
        outcomeId: "o1",
        points: 2,
        payout: null,
      }),
      expect.objectContaining({ channelSlug: c2.slug, predictionId: a2.predictionId, points: 4 }),
    ]);
    expect(value.songRequests).toEqual([
      expect.objectContaining({ channelSlug: c1.slug, url: "https://example.org/song-1", status: "queued" }),
      expect.objectContaining({ channelSlug: c2.slug, url: "https://example.org/song-2", status: "queued" }),
    ]);

    // Nothing of the other user's activity (n = 3) leaks into the requester's file.
    const text = JSON.stringify(value);
    expect(text).not.toContain("song-3");
    expect(text).not.toContain(other);
    expect(text).not.toContain('"delta":300');
  });

  test("a user with no channel activity gets empty sections", async () => {
    const lonely = await user();
    const files = await db.transaction((tx) => collect(tx, "account", { userId: lonely, channelId: null }));
    expect(files.get("interact.json")).toEqual({
      pointsBalances: [],
      pointsTransactions: [],
      pollVotes: [],
      predictionBets: [],
      songRequests: [],
    });
  });
});
