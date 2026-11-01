// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `interact.predictions.*` (E8-polls, ADR 0026 decision 3, docs/testing/e8-selectors.md
 * "Predictions"): channel points only, one open prediction per channel, one bet per viewer, and
 * the channel's owner, editors and moderators never bet (they lock and resolve it). Settlement is
 * `settlePredictionInTx` under the row lock.
 *
 * Fair predictions (batch 7 decision (v), ADR 0039 decision 3; docs/testing/b7-selectors.md):
 * a bet is judged by media time (`judgeBetTiming`), needs verified-watch standing where the
 * instance measures it, and a settlement records its resolver and a result card whose payouts are
 * checked against the pool before commit. Refusals: FORBIDDEN `reason: staff` (the team),
 * CONFLICT (closed), PRECONDITION_FAILED `requirement` `not_live` / `behind` / `unverified`.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { KEYS, VerifiedWatchValue } from "@commonair/contracts/internal";
import { ChannelChatSettings } from "@commonair/contracts/shapes";
import { InsufficientPointsError, postPointsInTx, schema, uuidv7, type Database, type Executor } from "@commonair/db";
import {
  betMediaTime,
  changedAtAfterProgress,
  emitEvent,
  hasVerifiedStanding,
  isPredictionTeam,
  judgeBetTiming,
  liveStartedAt,
  lockPrediction,
  lockPredictionInTx,
  pointsChangePayload,
  predictionEventPayload,
  predictionView,
  refreshPredictionOutcomes,
  settlePredictionInTx,
  verifiedWatchMeasured,
  type BetRefusal,
  type PredictionRow,
  type PredictionSettledFacts,
  type PredictionViewDto,
} from "@commonair/interact";
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import type { ApiEnv } from "../../env.ts";
import { audit } from "../../events/audit.ts";
import type { Caller } from "../../lib/access.ts";
import { apiError, badRequest, conflict, isUniqueViolation, notFound, precondition } from "../../lib/errors.ts";
import {
  actorTypeOf,
  assertNotBanned,
  channelById,
  channelBySlug,
  channelPointsEnabled,
  requireAuthority,
  type Authority,
  type ChannelRow,
} from "../polls/shared.ts";

const { predictions, predictionBets, users, channelRoles } = schema;

interface Ctx {
  db: Database;
  now: () => Date;
}

/** A bet also reads the verified-watch key (ADR 0015) and the instance flags that say it exists. */
interface BetCtx extends Ctx {
  valkey: Pick<ValkeyClient, "get">;
  env: Pick<ApiEnv, "CHAT_WATCH_GATE" | "CHAT_SURGE_GUARD">;
  logger: Pick<Logger, "warn">;
}

async function myBet(db: Executor, predictionId: string, userId: string | null) {
  if (userId === null) return null;
  const [b] = await db
    .select({ outcomeId: predictionBets.outcomeId, points: predictionBets.points, payout: predictionBets.payout })
    .from(predictionBets)
    .where(and(eq(predictionBets.predictionId, predictionId), eq(predictionBets.userId, userId)));
  return b ?? null;
}

/** Who settled it and what its bets got back: payouts on a resolve, the stakes on a cancel. */
async function settledFacts(db: Executor, row: PredictionRow): Promise<PredictionSettledFacts> {
  if (row.status !== "resolved" && row.status !== "canceled") return { resolvedBy: null, payoutSum: null };
  const [sums] = await db
    .select({
      paid: sql<string>`coalesce(sum(${predictionBets.payout}), 0)`,
      staked: sql<string>`coalesce(sum(${predictionBets.points}), 0)`,
    })
    .from(predictionBets)
    .where(eq(predictionBets.predictionId, row.id));
  const payoutSum = Number(row.status === "resolved" ? (sums?.paid ?? 0) : (sums?.staked ?? 0));
  if (row.resolvedById === null) return { resolvedBy: null, payoutSum };
  const [by] = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(eq(users.id, row.resolvedById));
  return { resolvedBy: by ?? null, payoutSum };
}

async function viewOf(db: Executor, row: PredictionRow, userId: string | null): Promise<PredictionViewDto> {
  return predictionView(row, await myBet(db, row.id, userId), await settledFacts(db, row));
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

const TEAM_REFUSAL = "The channel's owner, editors and moderators cannot bet on its predictions";

/** A refusal as the contract error the web card reads (`chat-prediction-refused`). */
function betRefusalError(reason: BetRefusal) {
  switch (reason) {
    case "team":
      return apiError("FORBIDDEN", TEAM_REFUSAL, { reason: "staff" });
    case "not_live":
      return precondition("not_live", "Bets are taken only from viewers watching live, not catching up");
    case "behind":
      return precondition("behind", "Your player is too far behind the live stream to bet");
    case "unverified":
      return precondition("unverified", "Watch the stream signed in for a while before betting");
    case "closed":
      return conflict("Betting is closed");
  }
}

/**
 * Verified-watch standing (ADR 0015) where the instance measures it: elsewhere no key is ever
 * written, so nothing can be asked for. A Valkey error refuses (a bet can wait; a fair pool cannot).
 */
async function hasStanding(
  ctx: BetCtx,
  channel: ChannelRow,
  userId: string,
  roles: readonly (typeof channelRoles.$inferSelect.role)[],
): Promise<boolean> {
  const parsed = ChannelChatSettings.safeParse(channel.chatSettings);
  const settings = parsed.success ? parsed.data : ChannelChatSettings.parse({});
  const flags = { watchGate: ctx.env.CHAT_WATCH_GATE === "on", surgeGuard: ctx.env.CHAT_SURGE_GUARD === "on" };
  if (!verifiedWatchMeasured(flags, settings)) return true;
  let value: VerifiedWatchValue | null = null;
  try {
    const raw = await ctx.valkey.get(KEYS.verifiedWatch(channel.id, userId));
    const ok = raw === null ? null : VerifiedWatchValue.safeParse(JSON.parse(raw));
    value = ok?.success ? ok.data : null;
  } catch (err) {
    ctx.logger.warn("prediction bet: verified-watch read failed", { err: (err as Error).name });
    return false;
  }
  return hasVerifiedStanding(value, channel.liveBroadcastId, roles);
}

export async function betPrediction(
  ctx: BetCtx,
  caller: Caller,
  input: {
    id: string;
    outcomeId: string;
    points: number;
    mediaTs?: string | null;
    playbackMode?: "live" | "dvr";
  },
): Promise<PredictionViewDto> {
  const now = ctx.now();
  const userId = caller.user.id;
  const mediaTs = input.mediaTs ? new Date(input.mediaTs) : null;
  return ctx.db.transaction(async (tx) => {
    // The row lock orders bets against lock and settlement, and guards the outcome cache.
    const prediction = await lockPrediction(tx, input.id);
    if (!prediction) throw notFound("Prediction not found");
    const channel = await channelById(tx, prediction.channelId);
    const roles = (
      await tx
        .select({ role: channelRoles.role })
        .from(channelRoles)
        .where(and(eq(channelRoles.channelId, channel.id), eq(channelRoles.userId, userId)))
    ).map((r) => r.role);
    if (isPredictionTeam(userId, channel.ownerId, roles)) throw betRefusalError("team");
    await assertNotBanned(tx, channel.id, userId, now);
    const startedAt = channel.liveBroadcastId === null ? null : await liveStartedAt(tx, channel.id);
    const refusal = judgeBetTiming({
      now,
      mediaTs,
      playbackMode: input.playbackMode ?? "live",
      liveStartedAt: startedAt,
      prediction,
    });
    if (refusal) throw betRefusalError(refusal);
    if (!prediction.outcomes.some((o) => o.id === input.outcomeId)) throw badRequest("No such outcome");
    if (await myBet(tx, prediction.id, userId)) throw conflict("You already bet on this prediction");
    if (!(await channelPointsEnabled(tx, channel.id)))
      throw precondition("points_disabled", "Channel points are off on this channel");
    if (startedAt !== null && !(await hasStanding(ctx, channel, userId, roles))) throw betRefusalError("unverified");

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
      // The playhead as judged (never after receipt); null when the client sent none.
      mediaTs: mediaTs === null ? null : betMediaTime(mediaTs, now),
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
      details: { lockMediaTs: locked.lockMediaTs?.toISOString() ?? null },
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
    const settled = await settlePredictionInTx(tx, row.id, winningOutcomeId, now, caller.user.id);
    if (!settled)
      throw conflict(
        winningOutcomeId === null
          ? "Only an open prediction can be canceled"
          : "Only a locked prediction can be resolved",
      );
    // Decision (v): the result card's figure, read back from the bets, is the pool before commit.
    const facts = await settledFacts(tx, settled.row);
    if (facts.payoutSum !== settled.pool)
      throw new Error(`prediction ${row.id} pays back ${String(facts.payoutSum)}, the pool is ${settled.pool}`);
    await audit(tx, {
      actorType: actorTypeOf(authority),
      actorId: caller.user.id,
      action: winningOutcomeId === null ? "prediction.cancel" : "prediction.resolve",
      subjectType: "prediction",
      subjectId: row.id,
      channelId: channel.id,
      details: {
        status: settled.row.status,
        winningOutcomeId: settled.row.winningOutcomeId,
        bettors: settled.bettors,
        credited: settled.credits.length,
        pool: settled.pool,
        winners: settled.winners,
        payoutSum: facts.payoutSum,
        // A resolve nobody bet on refunds every bet and ends canceled.
        refunded: settled.row.status === "canceled",
      },
    });
    return predictionView(settled.row, await myBet(tx, row.id, caller.user.id), facts);
  });
}
