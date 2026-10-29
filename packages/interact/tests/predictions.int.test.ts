// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Prediction settlement against the real database as the app role: payouts sum to the pool and
 * land in the ledger, a resolve nobody bet on refunds, a double settle pays once, and the SQL
 * totals match `summarizeBets`.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { pointsBalance, postPointsInTx, schema, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import {
  lockPredictionInTx,
  predictionBets,
  predictionTotals,
  settlePredictionInTx,
  summarizeBets,
} from "../src/predictions.ts";

let t: TestDatabase;
let app: Database;
beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
}, 120_000);
afterAll(async () => {
  await t?.drop();
});

const rand = () => uuidv7().replace(/-/g, "").slice(-10);

async function user(): Promise<string> {
  const name = `p${rand()}`;
  const [u] = await t.db
    .insert(schema.users)
    .values({ name, username: name, email: `${name}@example.test`, emailVerified: true })
    .returning({ id: schema.users.id });
  return u!.id;
}

async function channel(): Promise<string> {
  const ownerId = await user();
  const slug = `c${rand()}`;
  const [c] = await t.db
    .insert(schema.channels)
    .values({ ownerId, slug, displayName: slug })
    .returning({ id: schema.channels.id });
  return c!.id;
}

async function prediction(channelId: string, outcomes = ["A", "B"]): Promise<string> {
  const id = uuidv7();
  await t.db.insert(schema.predictions).values({
    id,
    channelId,
    title: "Who wins?",
    outcomes: outcomes.map((o) => ({ id: o, title: o, points: 0, users: 0 })),
    windowSeconds: 60,
    locksAt: new Date(Date.now() + 60_000),
  });
  return id;
}

/** A bettor with `grant` points who stakes `points` on `outcomeId` (ledger row and bet row). */
async function placeBet(channelId: string, predictionId: string, outcomeId: string, points: number, grant = points) {
  const userId = await user();
  await app.transaction(async (tx) => {
    await postPointsInTx(tx, { channelId, userId, delta: grant, reason: "moderator_adjust", refId: null });
    await postPointsInTx(tx, { channelId, userId, delta: -points, reason: "prediction_bet", refId: predictionId });
    await tx.insert(schema.predictionBets).values({ predictionId, userId, outcomeId, points });
  });
  return userId;
}

async function lock(id: string) {
  await app.transaction((tx) => lockPredictionInTx(tx, id, new Date()));
}

const events = (channelId: string, type: string) =>
  t.db
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.channelId, channelId), eq(schema.events.type, type)));

describe("settlePredictionInTx", () => {
  test("resolve pays winners by largest remainder; balances and payouts sum to the pool", async () => {
    const c = await channel();
    const p = await prediction(c);
    const a1 = await placeBet(c, p, "A", 100, 1000);
    const a2 = await placeBet(c, p, "A", 300, 1000);
    const b1 = await placeBet(c, p, "B", 200, 1000);
    await lock(p);

    const s = await app.transaction((tx) => settlePredictionInTx(tx, p, "A", new Date()));
    expect(s?.row.status).toBe("resolved");
    expect(s?.pool).toBe(600);
    expect(Object.fromEntries((s?.credits ?? []).map((x) => [x.userId, x.delta]))).toEqual({ [a1]: 150, [a2]: 450 });
    expect(await pointsBalance(app, c, a1)).toBe(1050);
    expect(await pointsBalance(app, c, a2)).toBe(1150);
    expect(await pointsBalance(app, c, b1)).toBe(800);

    const bets = await predictionBets(app, p);
    expect(Object.fromEntries(bets.map((b) => [b.userId, b.payout]))).toEqual({ [a1]: 150, [a2]: 450, [b1]: 0 });
    const [end] = await events(c, "channel.prediction.end");
    expect(end?.payload).toMatchObject({ status: "resolved", winning_outcome_id: "A" });
    // One points.change per payout (none for the loser).
    expect(
      (await events(c, "channel.points.change")).filter((e) => e.payload.reason === "prediction_payout"),
    ).toHaveLength(2);
  });

  test("random stakes: payouts always sum to the pool", async () => {
    const c = await channel();
    for (let round = 0; round < 3; round++) {
      const p = await prediction(c, ["A", "B", "C"]);
      const stakes = Array.from({ length: 7 }, (_, i) => ({
        o: "ABC"[i % 3]!,
        pts: 1 + ((i * 7919 + round * 104729) % 997),
      }));
      for (const s of stakes) await placeBet(c, p, s.o, s.pts);
      await lock(p);
      const s = await app.transaction((tx) => settlePredictionInTx(tx, p, "B", new Date()));
      const pool = stakes.reduce((x, y) => x + y.pts, 0);
      expect(s?.credits.reduce((x, y) => x + y.delta, 0)).toBe(pool);
      const paid = await t.db
        .select({ delta: schema.loyaltyTransactions.delta })
        .from(schema.loyaltyTransactions)
        .where(
          and(eq(schema.loyaltyTransactions.refId, p), eq(schema.loyaltyTransactions.reason, "prediction_payout")),
        );
      expect(paid.reduce((x, y) => x + y.delta, 0)).toBe(pool);
    }
  });

  test("a resolve nobody bet on refunds every bet and ends canceled", async () => {
    const c = await channel();
    const p = await prediction(c);
    const a1 = await placeBet(c, p, "A", 40, 100);
    const a2 = await placeBet(c, p, "A", 60, 100);
    await lock(p);
    const s = await app.transaction((tx) => settlePredictionInTx(tx, p, "B", new Date()));
    expect(s?.row).toMatchObject({ status: "canceled", winningOutcomeId: null });
    expect(s?.credits.every((x) => x.reason === "prediction_refund")).toBe(true);
    expect(await pointsBalance(app, c, a1)).toBe(100);
    expect(await pointsBalance(app, c, a2)).toBe(100);
  });

  test("resolve needs `locked`; cancel works from `active`", async () => {
    const c = await channel();
    const p = await prediction(c);
    const a1 = await placeBet(c, p, "A", 10, 10);
    expect(await app.transaction((tx) => settlePredictionInTx(tx, p, "A", new Date()))).toBeNull();
    const s = await app.transaction((tx) => settlePredictionInTx(tx, p, null, new Date()));
    expect(s?.row.status).toBe("canceled");
    expect(await pointsBalance(app, c, a1)).toBe(10);
  });

  test("two concurrent resolves pay once", async () => {
    const c = await channel();
    const p = await prediction(c);
    const a1 = await placeBet(c, p, "A", 100, 100);
    await placeBet(c, p, "B", 100, 100);
    await lock(p);
    const results = await Promise.all([
      app.transaction((tx) => settlePredictionInTx(tx, p, "A", new Date())),
      app.transaction((tx) => settlePredictionInTx(tx, p, "A", new Date())),
    ]);
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await pointsBalance(app, c, a1)).toBe(200);
  });
});

describe("predictionTotals", () => {
  test("matches summarizeBets: totals per outcome, top 10 by points then user id", async () => {
    const c = await channel();
    const p = await prediction(c);
    for (let i = 0; i < 12; i++) await placeBet(c, p, "A", i < 3 ? 50 : 10);
    await placeBet(c, p, "B", 5);
    const totals = await predictionTotals(app, p);
    const expected = summarizeBets(await predictionBets(app, p));
    expect(totals).toEqual(expected);
    expect(totals.get("A")?.top).toHaveLength(10);
    expect(totals.get("A")?.users).toBe(12);
    expect(totals.get("A")?.points).toBe(3 * 50 + 9 * 10);
  });
});
