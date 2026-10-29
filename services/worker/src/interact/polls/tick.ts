// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact-tick` (E8-polls, every 2 s): end polls past `endsAt` (`completed`), lock predictions
 * past `locksAt`, and emit one `progress` event for each active poll or prediction whose votes or
 * bets changed since its last one, so progress is throttled to one per tick, never one per vote.
 * One transaction per item; each re-reads its row `FOR UPDATE SKIP LOCKED` with the due
 * condition, so two workers (or a tick racing the API) never end or lock the same row twice.
 */
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@commonair/db";
import {
  emitEvent,
  endPollInTx,
  lockPredictionInTx,
  pollChannelOf,
  pollCounts,
  pollEventPayload,
  pollProgressDue,
  predictionEventPayload,
  predictionTotals,
} from "@commonair/interact";

const { polls, predictions } = schema;

/** Upper bound per kind per tick; anything left is due again on the next tick. */
export const TICK_BATCH = 200;

export interface TickResult {
  pollsEnded: number;
  predictionsLocked: number;
  progress: number;
}

const changedSinceProgress = (t: typeof polls | typeof predictions) =>
  sql`${t.changedAt} > coalesce(${t.progressAt}, ${t.startedAt})`;

async function endDuePolls(db: Database, now: Date): Promise<number> {
  const due = await db
    .select({ id: polls.id })
    .from(polls)
    .where(and(eq(polls.status, "active"), lte(polls.endsAt, now)))
    .orderBy(polls.endsAt)
    .limit(TICK_BATCH);
  let ended = 0;
  for (const { id } of due) {
    const done = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: polls.id })
        .from(polls)
        .where(and(eq(polls.id, id), eq(polls.status, "active"), lte(polls.endsAt, now)))
        .for("update", { skipLocked: true });
      if (!row) return false;
      return (await endPollInTx(tx, id, "completed", now)) !== null;
    });
    if (done) ended++;
  }
  return ended;
}

async function lockDuePredictions(db: Database, now: Date): Promise<number> {
  const due = await db
    .select({ id: predictions.id })
    .from(predictions)
    .where(and(eq(predictions.status, "active"), lte(predictions.locksAt, now)))
    .orderBy(predictions.locksAt)
    .limit(TICK_BATCH);
  let locked = 0;
  for (const { id } of due) {
    const done = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ id: predictions.id })
        .from(predictions)
        .where(and(eq(predictions.id, id), eq(predictions.status, "active"), lte(predictions.locksAt, now)))
        .for("update", { skipLocked: true });
      if (!row) return false;
      return (await lockPredictionInTx(tx, id, now)) !== null;
    });
    if (done) locked++;
  }
  return locked;
}

async function pollProgress(db: Database, now: Date): Promise<number> {
  const changed = await db
    .select({ id: polls.id })
    .from(polls)
    .where(and(eq(polls.status, "active"), isNotNull(polls.changedAt), changedSinceProgress(polls)))
    .limit(TICK_BATCH);
  let sent = 0;
  for (const { id } of changed) {
    const done = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(polls)
        .where(and(eq(polls.id, id), eq(polls.status, "active")))
        .for("update", { skipLocked: true });
      if (!row || !pollProgressDue(row)) return false;
      const channel = await pollChannelOf(tx, row.channelId);
      const counts = await pollCounts(tx, id);
      await emitEvent(tx, "channel.poll.progress", channel.id, pollEventPayload("progress", channel, row, counts), now);
      await tx.update(polls).set({ progressAt: now }).where(eq(polls.id, id));
      return true;
    });
    if (done) sent++;
  }
  return sent;
}

async function predictionProgress(db: Database, now: Date): Promise<number> {
  const changed = await db
    .select({ id: predictions.id })
    .from(predictions)
    .where(and(eq(predictions.status, "active"), isNotNull(predictions.changedAt), changedSinceProgress(predictions)))
    .limit(TICK_BATCH);
  let sent = 0;
  for (const { id } of changed) {
    const done = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(predictions)
        .where(and(eq(predictions.id, id), eq(predictions.status, "active")))
        .for("update", { skipLocked: true });
      if (!row || !pollProgressDue(row)) return false;
      const channel = await pollChannelOf(tx, row.channelId);
      const totals = await predictionTotals(tx, id);
      await emitEvent(
        tx,
        "channel.prediction.progress",
        channel.id,
        predictionEventPayload("progress", channel, row, totals),
        now,
      );
      await tx.update(predictions).set({ progressAt: now }).where(eq(predictions.id, id));
      return true;
    });
    if (done) sent++;
  }
  return sent;
}

/**
 * One tick. Due items end or lock first: a poll that ends this tick gets its `end` event and no
 * `progress` (the progress pass reads only active rows).
 */
export async function runInteractTick(db: Database, now: Date): Promise<TickResult> {
  const pollsEnded = await endDuePolls(db, now);
  const predictionsLocked = await lockDuePredictions(db, now);
  const progress = (await pollProgress(db, now)) + (await predictionProgress(db, now));
  return { pollsEnded, predictionsLocked, progress };
}
