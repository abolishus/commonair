// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact` step 2 (prediction) (docs/testing/e8-selectors.md, "Scenarios"), over the API:
 * viewers get points by moderator adjust (`reward`); a prediction with two outcomes; bets 100 +
 * 300 on A and 200 on B; lock; resolve A: payouts 150 and 450 (`largestRemainder` over 600), the
 * payouts sum to the pool, balances and `channel.prediction.end` match; a second prediction
 * resolved to an outcome nobody bet on refunds every bet. Needs E8-points (`bot.points.adjust`).
 */
import { pointsBalance } from "@commonair/db";
import { largestRemainder } from "@commonair/ledger";
import type { SignedInUser } from "../users.ts";
import type { E8Run } from "./kit.ts";
import { outboxRows, type OutboxRow } from "./polls.ts";

export const GRANT_POINTS = 1000;
/** Viewer index → [outcome index, points]. */
export const PREDICTION_BETS: readonly (readonly [number, number])[] = [
  [0, 100],
  [0, 300],
  [1, 200],
];
/** The second prediction: both bets on A, resolved to B. */
export const REFUND_BETS: readonly (readonly [number, number])[] = [
  [0, 100],
  [0, 50],
];

export interface HarnessBet {
  userId: string;
  outcomeId: string;
  points: number;
}

/** What each winner gets (ADR 0026 decision 3): the pool by stake, ties to the lower user id. */
export function expectedPayouts(bets: readonly HarnessBet[], winningOutcomeId: string): Map<string, number> {
  const winners = bets
    .filter((b) => b.outcomeId === winningOutcomeId)
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  if (winners.length === 0) return new Map();
  const pool = bets.reduce((s, b) => s + b.points, 0);
  return new Map(
    largestRemainder(
      pool,
      winners.map((b) => ({ key: b.userId, weight: BigInt(b.points) })),
    ).map((p) => [p.key, p.cents]),
  );
}

/** What is wrong with a prediction's `channel.prediction.end` row. Empty when all is well. */
export function predictionEndProblems(
  rows: readonly OutboxRow[],
  predictionId: string,
  want: { status: "resolved" | "canceled"; winningOutcomeId: string | null; payouts: ReadonlyMap<string, number> },
): string[] {
  const ends = rows.filter((r) => r.type === "channel.prediction.end" && r.payload.id === predictionId);
  if (ends.length !== 1) return [`expected 1 channel.prediction.end, got ${ends.length}`];
  const p = ends[0]?.payload ?? {};
  const problems: string[] = [];
  if (p.status !== want.status) problems.push(`status ${String(p.status)}, want ${want.status}`);
  if (p.winning_outcome_id !== want.winningOutcomeId)
    problems.push(`winning_outcome_id ${String(p.winning_outcome_id)}, want ${String(want.winningOutcomeId)}`);
  const outcomes = Array.isArray(p.outcomes) ? (p.outcomes as { top_predictors?: unknown }[]) : [];
  const won = new Map<string, unknown>();
  for (const o of outcomes)
    for (const t of Array.isArray(o.top_predictors) ? o.top_predictors : [])
      won.set(String((t as { user_id?: unknown }).user_id), (t as { channel_points_won?: unknown }).channel_points_won);
  for (const [userId, payout] of want.payouts)
    if (won.get(userId) !== payout) problems.push(`user ${userId} won ${String(won.get(userId))}, want ${payout}`);
  return problems;
}

async function balances(run: E8Run, users: readonly SignedInUser[]): Promise<number[]> {
  return Promise.all(users.map((u) => pointsBalance(run.db, run.streamer.channelId, u.id)));
}

async function placeBets(run: E8Run, id: string, outcomeIds: readonly string[], plan: typeof PREDICTION_BETS) {
  const bets: HarnessBet[] = [];
  for (const [i, [outcome, points]] of plan.entries()) {
    const viewer = run.viewers[i];
    const outcomeId = outcomeIds[outcome];
    if (!viewer || !outcomeId) throw new Error(`missing viewer ${i} or outcome ${outcome}`);
    await viewer.api.client.interact.predictions.bet({ id, outcomeId, points });
    bets.push({ userId: viewer.id, outcomeId, points });
  }
  return bets;
}

export async function stepPrediction(run: E8Run): Promise<void> {
  const { ctx, streamer, viewers } = run;
  const owner = streamer.user.api.client;

  await ctx.step(`viewers get ${GRANT_POINTS} points by moderator adjust`, async () => {
    for (const v of viewers)
      await owner.bot.points.adjust({
        channel: streamer.channel,
        username: v.username,
        delta: GRANT_POINTS,
        reason: "reward",
      });
  });

  const p = await ctx.step("streamer starts a prediction with two outcomes", () =>
    owner.interact.predictions.create({
      channel: streamer.channel,
      title: `Harness prediction ${ctx.runId}`.slice(0, 45),
      outcomes: ["Alpha", "Beta"],
      windowSeconds: 120,
    }),
  );
  const outcomeIds = p.outcomes.map((o) => o.id);
  const before = await balances(run, viewers);
  const bets = await ctx.step("bets: 100 + 300 on A, 200 on B", () =>
    placeBets(run, p.id, outcomeIds, PREDICTION_BETS),
  );

  await ctx.step("lock, then resolve A", async () => {
    const locked = await owner.interact.predictions.lock({ id: p.id });
    ctx.assert("locked", locked.status === "locked", locked);
    const resolved = await owner.interact.predictions.resolve({ id: p.id, winningOutcomeId: outcomeIds[0] ?? "" });
    ctx.assert(
      "resolved to A",
      resolved.status === "resolved" && resolved.winningOutcomeId === outcomeIds[0],
      resolved,
    );
  });

  await ctx.step("payouts 150 and 450 sum to the pool; balances and the end event match", async () => {
    const payouts = expectedPayouts(bets, outcomeIds[0] ?? "");
    const pool = bets.reduce((s, b) => s + b.points, 0);
    const paid = [...payouts.values()].reduce((s, x) => s + x, 0);
    ctx.assert("payouts sum to the pool", paid === pool, { paid, pool });
    ctx.assert("payouts are 150 and 450", [...payouts.values()].sort((a, b) => a - b).join(",") === "150,450", [
      ...payouts,
    ]);
    const after = await balances(run, viewers);
    const want = before.map((b, i) => b - (bets[i]?.points ?? 0) + (payouts.get(viewers[i]?.id ?? "") ?? 0));
    ctx.assert("balances moved by stake and payout", after.join(",") === want.join(","), { before, after, want });
    const rows = await outboxRows(run.db, streamer.channelId, ["channel.prediction.end"]);
    const problems = predictionEndProblems(rows, p.id, {
      status: "resolved",
      winningOutcomeId: outcomeIds[0] ?? null,
      payouts,
    });
    ctx.assert("channel.prediction.end matches", problems.length === 0, problems);
  });

  await ctx.step("a prediction resolved to an outcome nobody bet on refunds every bet", async () => {
    const q = await owner.interact.predictions.create({
      channel: streamer.channel,
      title: `Harness refund ${ctx.runId}`.slice(0, 45),
      outcomes: ["Alpha", "Beta"],
      windowSeconds: 120,
    });
    const ids = q.outcomes.map((o) => o.id);
    const start = await balances(run, viewers);
    await placeBets(run, q.id, ids, REFUND_BETS);
    await owner.interact.predictions.lock({ id: q.id });
    const r = await owner.interact.predictions.resolve({ id: q.id, winningOutcomeId: ids[1] ?? "" });
    ctx.assert("ends canceled", r.status === "canceled" && r.winningOutcomeId === null, r);
    const end = await balances(run, viewers);
    ctx.assert("every bet refunded", end.join(",") === start.join(","), { start, end });
    const rows = await outboxRows(run.db, streamer.channelId, ["channel.prediction.end"]);
    const problems = predictionEndProblems(rows, q.id, {
      status: "canceled",
      winningOutcomeId: null,
      payouts: new Map(),
    });
    ctx.assert("channel.prediction.end canceled", problems.length === 0, problems);
  });
}
