// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Predictions (E8-polls, ADR 0026 decision 3): channel points only, never money. Totals, the API
 * view, the `channel.prediction.*` payloads, locking and settling. Shared by the API
 * (`interact.predictions.*`) and the worker (`interact-tick` locks at `locksAt`).
 *
 * `predictions.outcomes` (`points`/`users` per outcome) is a cache of `prediction_bets`: it is
 * refreshed under the prediction's row lock only. Every settlement is one transaction under that
 * lock, so a second resolve or cancel finds the status changed and pays nothing.
 */
import { and, eq, sql } from "drizzle-orm";
import type { PredictionView } from "@commonair/contracts/dto";
import type { PREDICTION_STATUSES } from "@commonair/contracts/enums";
import type { EventPayload } from "@commonair/contracts/events";
import { postPointsInTx, schema, type Executor } from "@commonair/db";
import { largestRemainder } from "@commonair/ledger";
import type { z } from "zod";
import { broadcasterFields, emitEvent, pointsChangePayload, userFields } from "./outbox.ts";
import { pollChannelOf, type PollChannel } from "./polls.ts";

export type PredictionRow = typeof schema.predictions.$inferSelect;
export type PredictionStatus = (typeof PREDICTION_STATUSES)[number];
export type PredictionViewDto = z.infer<typeof PredictionView>;

/** EventSub caps `top_predictors` at 10 per outcome. */
export const TOP_PREDICTORS = 10;

/** One bet with the bettor's public fields (`payout` null until settled). */
export interface PredictionBet {
  userId: string;
  username: string;
  name: string;
  outcomeId: string;
  points: number;
  payout: number | null;
}

export interface OutcomeTotals {
  points: number;
  users: number;
  /** Ordered by points used (descending), then user id; at most `TOP_PREDICTORS`. */
  top: PredictionBet[];
}
export type PredictionTotals = ReadonlyMap<string, OutcomeTotals>;

const byStakeThenUser = (a: PredictionBet, b: PredictionBet) =>
  b.points - a.points || (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0);

/** Points and bettors per outcome and the top predictors of each, from every bet. Pure. */
export function summarizeBets(bets: readonly PredictionBet[], cap = TOP_PREDICTORS): PredictionTotals {
  const groups = new Map<string, PredictionBet[]>();
  for (const b of bets) groups.set(b.outcomeId, [...(groups.get(b.outcomeId) ?? []), b]);
  return new Map(
    [...groups].map(([outcomeId, list]) => [
      outcomeId,
      {
        points: list.reduce((s, b) => s + b.points, 0),
        users: list.length,
        top: [...list].sort(byStakeThenUser).slice(0, cap),
      },
    ]),
  );
}

/**
 * Totals for a prediction without loading every bet: aggregates and the top 10 per outcome in
 * one query (the same order as `summarizeBets`; Postgres orders uuids as their hex strings).
 */
export async function predictionTotals(tx: Executor, predictionId: string): Promise<PredictionTotals> {
  const rows = await tx.execute<{
    outcome_id: string;
    user_id: string;
    username: string;
    name: string;
    points: string | number;
    payout: string | number | null;
    users: string | number;
    total: string | number;
  }>(sql`
    select outcome_id, user_id, username, name, points, payout, users, total from (
      select b.outcome_id, b.user_id, u.username, u.name, b.points, b.payout,
        row_number() over (partition by b.outcome_id order by b.points desc, b.user_id) as rn,
        count(*) over (partition by b.outcome_id) as users,
        sum(b.points) over (partition by b.outcome_id) as total
      from ${schema.predictionBets} b
      join ${schema.users} u on u.id = b.user_id
      where b.prediction_id = ${predictionId}
    ) ranked
    where rn <= ${TOP_PREDICTORS}
    order by outcome_id, rn`);
  const totals = new Map<string, OutcomeTotals>();
  for (const r of rows) {
    const t = totals.get(r.outcome_id) ?? { points: Number(r.total), users: Number(r.users), top: [] };
    t.top.push({
      userId: r.user_id,
      username: r.username,
      name: r.name,
      outcomeId: r.outcome_id,
      points: Number(r.points),
      payout: r.payout === null ? null : Number(r.payout),
    });
    totals.set(r.outcome_id, t);
  }
  return totals;
}

/** Every bet of a prediction, ordered by user id (the payout order). */
export async function predictionBets(tx: Executor, predictionId: string): Promise<PredictionBet[]> {
  return (
    await tx
      .select({
        userId: schema.predictionBets.userId,
        username: schema.users.username,
        name: schema.users.name,
        outcomeId: schema.predictionBets.outcomeId,
        points: schema.predictionBets.points,
        payout: schema.predictionBets.payout,
      })
      .from(schema.predictionBets)
      .innerJoin(schema.users, eq(schema.users.id, schema.predictionBets.userId))
      .where(eq(schema.predictionBets.predictionId, predictionId))
      .orderBy(schema.predictionBets.userId)
  ).map((b) => ({ ...b, points: Number(b.points) }));
}

/**
 * Split the pool (every bet) between the bets on `winningOutcomeId` in proportion to their stake,
 * largest remainder, ties to the lower user id. Empty when nobody bet on the winner (the caller
 * refunds instead, ADR 0026 decision 3). The parts always sum to the pool. Pure.
 */
export function predictionPayouts(
  bets: readonly Pick<PredictionBet, "userId" | "outcomeId" | "points">[],
  winningOutcomeId: string,
): { userId: string; payout: number }[] {
  const winners = bets
    .filter((b) => b.outcomeId === winningOutcomeId)
    .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  if (winners.length === 0) return [];
  const pool = bets.reduce((s, b) => s + b.points, 0);
  const split = largestRemainder(
    pool,
    winners.map((b) => ({ key: b.userId, weight: BigInt(b.points) })),
  ).map((p) => ({ userId: p.key, payout: p.cents }));
  const paid = split.reduce((s, p) => s + p.payout, 0);
  if (paid !== pool) throw new Error(`prediction payouts ${paid} do not sum to the pool ${pool}`);
  return split;
}

/** The API view from the row's outcome cache; `mine` is the caller's bet. */
export function predictionView(
  row: PredictionRow,
  mine: { outcomeId: string; points: number; payout: number | null } | null,
): PredictionViewDto {
  return {
    id: row.id,
    title: row.title,
    outcomes: row.outcomes.map((o) => ({ id: o.id, title: o.title, points: o.points, users: o.users })),
    status: row.status,
    startedAt: row.startedAt.toISOString(),
    locksAt: row.locksAt.toISOString(),
    lockedAt: row.lockedAt?.toISOString() ?? null,
    endedAt: row.resolvedAt?.toISOString() ?? null,
    winningOutcomeId: row.winningOutcomeId,
    myBet: mine ? { outcomeId: mine.outcomeId, points: mine.points, payout: mine.payout } : null,
  };
}

function outcomesPayload(row: PredictionRow, totals: PredictionTotals) {
  const resolved = row.status === "resolved";
  return row.outcomes.map((o) => {
    const t = totals.get(o.id);
    return {
      id: o.id,
      title: o.title,
      users: t?.users ?? 0,
      channel_points: t?.points ?? 0,
      top_predictors: (t?.top ?? []).map((b) => ({
        ...userFields({ id: b.userId, username: b.username, name: b.name }),
        channel_points_used: b.points,
        channel_points_won: resolved ? (b.payout ?? 0) : null,
      })),
    };
  });
}

type PredictionPayloads = {
  begin: EventPayload<"channel.prediction.begin">;
  progress: EventPayload<"channel.prediction.progress">;
  lock: EventPayload<"channel.prediction.lock">;
  end: EventPayload<"channel.prediction.end">;
};

/** The `channel.prediction.<kind>` payload for the row as it is now. */
export function predictionEventPayload<K extends keyof PredictionPayloads>(
  kind: K,
  channel: PollChannel,
  row: PredictionRow,
  totals: PredictionTotals,
): PredictionPayloads[K] {
  const common = {
    ...broadcasterFields(channel),
    id: row.id,
    title: row.title,
    outcomes: outcomesPayload(row, totals),
    started_at: row.startedAt.toISOString(),
  };
  const stamp = (d: Date | null, what: string) => {
    if (d === null) throw new Error(`channel.prediction.${kind} needs ${what}`);
    return d.toISOString();
  };
  if (kind === "begin" || kind === "progress")
    return { ...common, locks_at: row.locksAt.toISOString() } as PredictionPayloads[K];
  if (kind === "lock") return { ...common, locked_at: stamp(row.lockedAt, "lockedAt") } as PredictionPayloads[K];
  if (row.status !== "resolved" && row.status !== "canceled")
    throw new Error("channel.prediction.end needs a settled prediction");
  return {
    ...common,
    winning_outcome_id: row.winningOutcomeId,
    status: row.status,
    ended_at: stamp(row.resolvedAt, "resolvedAt"),
  } as PredictionPayloads[K];
}

/** Lock a prediction row (`skipLocked` for the worker). Null when missing or skipped. */
export async function lockPrediction(tx: Executor, predictionId: string, opts: { skipLocked?: boolean } = {}) {
  const q = tx.select().from(schema.predictions).where(eq(schema.predictions.id, predictionId));
  const [row] = await (opts.skipLocked ? q.for("update", { skipLocked: true }) : q.for("update"));
  return row ?? null;
}

/** Recompute the `outcomes` cache from the bets. Call only while holding the row lock. */
export async function refreshPredictionOutcomes(tx: Executor, row: PredictionRow): Promise<PredictionRow> {
  const sums = await tx
    .select({
      outcomeId: schema.predictionBets.outcomeId,
      points: sql<string>`coalesce(sum(${schema.predictionBets.points}), 0)`,
      users: sql<string>`count(*)`,
    })
    .from(schema.predictionBets)
    .where(eq(schema.predictionBets.predictionId, row.id))
    .groupBy(schema.predictionBets.outcomeId);
  const by = new Map(sums.map((s) => [s.outcomeId, s]));
  const outcomes = row.outcomes.map((o) => ({
    ...o,
    points: Number(by.get(o.id)?.points ?? 0),
    users: Number(by.get(o.id)?.users ?? 0),
  }));
  const [updated] = await tx
    .update(schema.predictions)
    .set({ outcomes })
    .where(eq(schema.predictions.id, row.id))
    .returning();
  if (!updated) throw new Error(`prediction ${row.id} vanished under its lock`);
  return updated;
}

/** `active` → `locked` with `lockedAt` and the `lock` event. Null when not active (no-op). */
export async function lockPredictionInTx(tx: Executor, predictionId: string, now: Date): Promise<PredictionRow | null> {
  const row = await lockPrediction(tx, predictionId);
  if (!row || row.status !== "active") return null;
  const [updated] = await tx
    .update(schema.predictions)
    .set({ status: "locked", lockedAt: now })
    .where(eq(schema.predictions.id, predictionId))
    .returning();
  if (!updated) return null;
  const channel = await pollChannelOf(tx, updated.channelId);
  const totals = await predictionTotals(tx, predictionId);
  await emitEvent(
    tx,
    "channel.prediction.lock",
    channel.id,
    predictionEventPayload("lock", channel, updated, totals),
    now,
  );
  return updated;
}

export interface Settlement {
  row: PredictionRow;
  /** Bettors (all of them, ordered by user id) and what each got back: a payout or a refund. */
  credits: { userId: string; delta: number; reason: "prediction_payout" | "prediction_refund" }[];
  pool: number;
  bettors: number;
}

/**
 * Settle under the row lock. `winningOutcomeId` resolves (only from `locked`); null cancels (from
 * `active` or `locked`). A resolve nobody bet on refunds like a cancel and ends `canceled`.
 * Winners get one `prediction_payout` row each (none for a zero share), every bet records its
 * payout (0 for a loss); a cancel refunds every bet. Each move emits `channel.points.change`;
 * the `end` event closes it. Null when the status does not allow it (a second settle is a no-op).
 */
export async function settlePredictionInTx(
  tx: Executor,
  predictionId: string,
  winningOutcomeId: string | null,
  now: Date,
): Promise<Settlement | null> {
  const locked = await lockPrediction(tx, predictionId);
  if (!locked) return null;
  const allowed: readonly PredictionStatus[] = winningOutcomeId === null ? ["active", "locked"] : ["locked"];
  if (!allowed.includes(locked.status)) return null;
  if (winningOutcomeId !== null && !locked.outcomes.some((o) => o.id === winningOutcomeId)) return null;

  const row = await refreshPredictionOutcomes(tx, locked);
  const bets = await predictionBets(tx, predictionId);
  const pool = bets.reduce((s, b) => s + b.points, 0);
  const payouts = winningOutcomeId === null ? [] : predictionPayouts(bets, winningOutcomeId);
  const resolved = payouts.length > 0;
  const payoutOf = new Map(payouts.map((p) => [p.userId, p.payout]));
  const channel = await pollChannelOf(tx, row.channelId);

  const credits: Settlement["credits"] = [];
  for (const b of bets) {
    const delta = resolved ? (payoutOf.get(b.userId) ?? 0) : b.points;
    const reason = resolved ? "prediction_payout" : "prediction_refund";
    if (resolved) {
      await tx
        .update(schema.predictionBets)
        .set({ payout: delta })
        .where(and(eq(schema.predictionBets.predictionId, predictionId), eq(schema.predictionBets.userId, b.userId)));
      b.payout = delta;
    }
    if (delta === 0) continue;
    const { balance } = await postPointsInTx(tx, {
      channelId: row.channelId,
      userId: b.userId,
      delta,
      reason,
      refId: predictionId,
      at: now,
    });
    await emitEvent(
      tx,
      "channel.points.change",
      row.channelId,
      pointsChangePayload(channel, { id: b.userId, username: b.username, name: b.name }, { delta, balance, reason }),
      now,
    );
    credits.push({ userId: b.userId, delta, reason });
  }
  const credited = credits.reduce((s, c) => s + c.delta, 0);
  if (credited !== pool) throw new Error(`prediction settlement moved ${credited} points, the pool is ${pool}`);

  const [settled] = await tx
    .update(schema.predictions)
    .set({
      status: resolved ? "resolved" : "canceled",
      winningOutcomeId: resolved ? winningOutcomeId : null,
      resolvedAt: now,
    })
    .where(eq(schema.predictions.id, predictionId))
    .returning();
  if (!settled) throw new Error(`prediction ${predictionId} vanished under its lock`);
  await emitEvent(
    tx,
    "channel.prediction.end",
    channel.id,
    predictionEventPayload("end", channel, settled, summarizeBets(bets)),
    now,
  );
  return { row: settled, credits, pool, bettors: bets.length };
}
