// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact.predictions.*` (E8-polls, ADR 0026 decision 3, docs/testing/e8-selectors.md
 * "Predictions"): channel points only, one open prediction per channel, one bet per viewer, and
 * the channel's owner, editors and moderators never bet (they lock and resolve it). Settlement is
 * `settlePredictionInTx` under the row lock.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { InsufficientPointsError, postPointsInTx, schema, uuidv7, type Database, type Executor } from "@commonair/db";
import {
  changedAtAfterProgress,
  emitEvent,
  lockPrediction,
  lockPredictionInTx,
  pointsChangePayload,
  predictionEventPayload,
  predictionView,
  refreshPredictionOutcomes,
  settlePredictionInTx,
  type PredictionRow,
  type PredictionViewDto,
} from "@commonair/interact";
import { audit } from "../../events/audit.ts";
import type { Caller } from "../../lib/access.ts";
import { apiError, badRequest, conflict, isUniqueViolation, notFound, precondition } from "../../lib/errors.ts";
import {
  actorTypeOf,
  assertNotBanned,
  authorityOn,
  channelById,
  channelBySlug,
  channelPointsEnabled,
  requireAuthority,
  type Authority,
  type ChannelRow,
} from "../polls/shared.ts";

const { predictions, predictionBets, users } = schema;

interface Ctx {
  db: Database;
  now: () => Date;
}

async function myBet(db: Executor, predictionId: string, userId: string | null) {
  if (userId === null) return null;
  const [b] = await db
    .select({ outcomeId: predictionBets.outcomeId, points: predictionBets.points, payout: predictionBets.payout })
    .from(predictionBets)
    .where(and(eq(predictionBets.predictionId, predictionId), eq(predictionBets.userId, userId)));
  return b ?? null;
}

async function viewOf(db: Executor, row: PredictionRow, userId: string | null): Promise<PredictionViewDto> {
  return predictionView(row, await myBet(db, row.id, userId));
}

/** The open (active or locked) prediction, else the most recent settled one; null when none. */
export async function currentPrediction(
  ctx: Ctx,
  slug: string,
  caller: Caller | null,
): Promise<PredictionViewDto | null> {
  const channel = await channelBySlug(ctx.db, slug);
  const [row] = await ctx.db
    .select()
    .from(predictions)
    .where(eq(predictions.channelId, channel.id))
    .orderBy(desc(inArray(predictions.status, ["active", "locked"])), desc(predictions.startedAt), desc(predictions.id))
    .limit(1);
  return row ? viewOf(ctx.db, row, caller?.user.id ?? null) : null;
}

export async function createPrediction(
  ctx: Ctx,
  caller: Caller,
  authority: Authority,
  channel: ChannelRow,
  input: { title: string; outcomes: string[]; windowSeconds: number },
): Promise<PredictionViewDto> {
  const now = ctx.now();
  const busy = () => conflict("This channel already has an open prediction");
  try {
    return await ctx.db.transaction(async (tx) => {
      if (!(await channelPointsEnabled(tx, channel.id)))
        throw precondition("points_disabled", "Channel points are off on this channel");
      const [open] = await tx
        .select({ id: predictions.id })
        .from(predictions)
        .where(and(eq(predictions.channelId, channel.id), inArray(predictions.status, ["active", "locked"])));
      if (open) throw busy();
      const [row] = await tx
        .insert(predictions)
        .values({
          id: uuidv7(now.getTime()),
          channelId: channel.id,
          title: input.title,
          outcomes: input.outcomes.map((title) => ({ id: uuidv7(now.getTime()), title, points: 0, users: 0 })),
          status: "active",
          windowSeconds: input.windowSeconds,
          createdById: caller.user.id,
          startedAt: now,
          locksAt: new Date(now.getTime() + input.windowSeconds * 1000),
        })
        .returning();
      if (!row) throw new Error("prediction insert returned nothing");
      await audit(tx, {
        actorType: actorTypeOf(authority),
        actorId: caller.user.id,
        action: "prediction.create",
        subjectType: "prediction",
        subjectId: row.id,
        channelId: channel.id,
        details: { outcomes: row.outcomes.length, windowSeconds: row.windowSeconds },
      });
      await emitEvent(
        tx,
        "channel.prediction.begin",
        channel.id,
        predictionEventPayload("begin", channel, row, new Map()),
        now,
      );
      return predictionView(row, null);
    });
  } catch (err) {
    // `predictions_channel_open_uq` is the backstop when two creates race past the check.
    if (isUniqueViolation(err)) throw busy();
    throw err;
  }
}

export async function betPrediction(
  ctx: Ctx,
  caller: Caller,
  input: { id: string; outcomeId: string; points: number },
): Promise<PredictionViewDto> {
  const now = ctx.now();
  const userId = caller.user.id;
  return ctx.db.transaction(async (tx) => {
    // The row lock orders bets against lock and settlement, and guards the outcome cache.
    const prediction = await lockPrediction(tx, input.id);
    if (!prediction) throw notFound("Prediction not found");
    const channel = await channelById(tx, prediction.channelId);
    if ((await authorityOn(tx, caller, channel)) !== null)
      throw apiError("FORBIDDEN", "The channel's owner, editors and moderators cannot bet on its predictions", {
        reason: "staff",
      });
    await assertNotBanned(tx, channel.id, userId, now);
    if (prediction.status !== "active" || now >= prediction.locksAt) throw conflict("Betting is closed");
    if (!prediction.outcomes.some((o) => o.id === input.outcomeId)) throw badRequest("No such outcome");
    if (await myBet(tx, prediction.id, userId)) throw conflict("You already bet on this prediction");
    if (!(await channelPointsEnabled(tx, channel.id)))
      throw precondition("points_disabled", "Channel points are off on this channel");

    const [me] = await tx
      .select({ id: users.id, username: users.username, name: users.name })
      .from(users)
      .where(eq(users.id, userId));
    if (!me) throw notFound("User not found");
    let balance: number;
    try {
      ({ balance } = await postPointsInTx(tx, {
        channelId: channel.id,
        userId,
        delta: -input.points,
        reason: "prediction_bet",
        refId: prediction.id,
        at: now,
      }));
    } catch (err) {
      if (err instanceof InsufficientPointsError) throw precondition("insufficient_points", "Not enough points");
      throw err;
    }
    await tx.insert(predictionBets).values({
      predictionId: prediction.id,
      userId,
      outcomeId: input.outcomeId,
      points: input.points,
      placedAt: now,
    });
    await emitEvent(
      tx,
      "channel.points.change",
      channel.id,
      pointsChangePayload(channel, me, { delta: -input.points, balance, reason: "prediction_bet" }),
      now,
    );
    const [changed] = await tx
      .update(predictions)
      .set({ changedAt: changedAtAfterProgress(predictions, now) })
      .where(eq(predictions.id, prediction.id))
      .returning();
    const refreshed = await refreshPredictionOutcomes(tx, changed ?? prediction);
    return viewOf(tx, refreshed, userId);
  });
}

/** Load the prediction and check the caller may run it (owner, editor or moderator). */
async function forModerator(ctx: Ctx, caller: Caller, id: string) {
  const [row] = await ctx.db.select().from(predictions).where(eq(predictions.id, id));
  if (!row) throw notFound("Prediction not found");
  const channel = await channelById(ctx.db, row.channelId);
  const authority = await requireAuthority(ctx.db, caller, channel);
  return { row, channel, authority };
}

export async function lockPredictionNow(ctx: Ctx, caller: Caller, id: string): Promise<PredictionViewDto> {
  const { row, channel, authority } = await forModerator(ctx, caller, id);
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const locked = await lockPredictionInTx(tx, row.id, now);
    if (!locked) throw conflict("Only an active prediction can be locked");
    await audit(tx, {
      actorType: actorTypeOf(authority),
      actorId: caller.user.id,
      action: "prediction.lock",
      subjectType: "prediction",
      subjectId: row.id,
      channelId: channel.id,
    });
    return viewOf(tx, locked, caller.user.id);
  });
}

/** `resolve` (a winning outcome, from `locked`) or `cancel` (null, from `active` or `locked`). */
export async function settlePrediction(
  ctx: Ctx,
  caller: Caller,
  id: string,
  winningOutcomeId: string | null,
): Promise<PredictionViewDto> {
  const { row, channel, authority } = await forModerator(ctx, caller, id);
  if (winningOutcomeId !== null && !row.outcomes.some((o) => o.id === winningOutcomeId))
    throw badRequest("No such outcome");
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    const settled = await settlePredictionInTx(tx, row.id, winningOutcomeId, now);
    if (!settled)
      throw conflict(
        winningOutcomeId === null
          ? "Only an open prediction can be canceled"
          : "Only a locked prediction can be resolved",
      );
    await audit(tx, {
      actorType: actorTypeOf(authority),
      actorId: caller.user.id,
      action: winningOutcomeId === null ? "prediction.cancel" : "prediction.resolve",
      subjectType: "prediction",
      subjectId: row.id,
      channelId: channel.id,
      details: {
        status: settled.row.status,
        bettors: settled.bettors,
        credited: settled.credits.length,
        pool: settled.pool,
        // A resolve nobody bet on refunds every bet and ends canceled.
        refunded: settled.row.status === "canceled",
      },
    });
    return viewOf(tx, settled.row, caller.user.id);
  });
}
