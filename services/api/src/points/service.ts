// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `bot.points.*` (ADR 0026 decision 2): read a balance, the leaderboard, and a moderator's grant
 * or deduction. Balances are trigger-written from the append-only `loyalty_transactions`; this
 * module only reads them and posts ledger rows through `postPointsInTx`, so the database refuses
 * an overdraw and the refusal maps to `insufficient_points`, never a 500.
 */
import { and, asc, desc, eq, gt, isNull } from "drizzle-orm";
import type { z } from "zod";
import type { LoyaltyBalance as LoyaltyBalanceSchema } from "@commonair/contracts/dto";
import type { POINTS_ADJUST_REASONS } from "@commonair/contracts/enums";
import { BotConfig } from "@commonair/contracts/shapes";
import { InsufficientPointsError, postPointsInTx, pointsBalance, schema as s, type Executor } from "@commonair/db";
import { pointsChangePayload } from "@commonair/interact";
import { audit } from "../events/audit.ts";
import { emit } from "../events/outbox.ts";
import { badRequest, notFound, precondition } from "../lib/errors.ts";

type LoyaltyBalance = z.infer<typeof LoyaltyBalanceSchema>;
type ChannelRef = { id: string; ownerId: string; slug: string; displayName: string };
export type PointsAdjustReason = (typeof POINTS_ADJUST_REASONS)[number];

/** What a channel calls its points and whether they are on (`BotConfig.loyalty`; defaults without a row). */
export async function loyaltyOf(db: Executor, channelId: string): Promise<{ enabled: boolean; pointsName: string }> {
  const [row] = await db
    .select({ config: s.botConfigs.config })
    .from(s.botConfigs)
    .where(eq(s.botConfigs.channelId, channelId));
  const parsed = BotConfig.safeParse(row?.config ?? {});
  const loyalty = parsed.success ? parsed.data.loyalty : BotConfig.parse({}).loyalty;
  return { enabled: loyalty.enabled, pointsName: loyalty.pointsName };
}

async function channelBySlug(db: Executor, slug: string): Promise<ChannelRef> {
  const [c] = await db
    .select({
      id: s.channels.id,
      ownerId: s.channels.ownerId,
      slug: s.channels.slug,
      displayName: s.channels.displayName,
    })
    .from(s.channels)
    .where(eq(s.channels.slug, slug));
  if (!c) throw notFound("Channel not found");
  return c;
}

async function userByUsername(db: Executor, username: string) {
  const [u] = await db
    .select({ id: s.users.id, username: s.users.username, name: s.users.name, accountType: s.users.accountType })
    .from(s.users)
    .where(eq(s.users.username, username));
  if (!u) throw notFound("User not found");
  return u;
}

/** `bot.points.balance`: 0 when the user never had points on the channel. */
export async function balanceOf(db: Executor, input: { channel: string; username: string }): Promise<LoyaltyBalance> {
  const c = await channelBySlug(db, input.channel);
  const u = await userByUsername(db, input.username);
  const [points, loyalty] = await Promise.all([pointsBalance(db, c.id, u.id), loyaltyOf(db, c.id)]);
  return { channelSlug: c.slug, user: { id: u.id, username: u.username }, points, ...loyalty };
}

/** `bot.points.leaderboard`: holders with points, most first (ties by user id); deleted accounts left out. */
export async function leaderboard(db: Executor, input: { channel: string; limit: number }): Promise<LoyaltyBalance[]> {
  const c = await channelBySlug(db, input.channel);
  const [rows, loyalty] = await Promise.all([
    db
      .select({ id: s.users.id, username: s.users.username, points: s.loyaltyBalances.points })
      .from(s.loyaltyBalances)
      .innerJoin(s.users, eq(s.users.id, s.loyaltyBalances.userId))
      .where(
        and(
          eq(s.loyaltyBalances.channelId, c.id),
          gt(s.loyaltyBalances.points, 0),
          isNull(s.users.pseudonymizedAt),
          isNull(s.users.deletedAt),
        ),
      )
      .orderBy(desc(s.loyaltyBalances.points), asc(s.users.id))
      .limit(input.limit),
    loyaltyOf(db, c.id),
  ]);
  return rows.map((r) => ({
    channelSlug: c.slug,
    user: { id: r.id, username: r.username },
    points: r.points,
    ...loyalty,
  }));
}

/**
 * `bot.points.adjust`, in one transaction: the `moderator_adjust` ledger row, the audit row (the
 * reason as its enum code, never free text) and `channel.points.change`. An overdraw is refused
 * by the database and nothing is written.
 */
export async function adjust(
  db: Executor,
  p: {
    channel: ChannelRef;
    username: string;
    delta: number;
    reason: PointsAdjustReason;
    actorId: string;
    now: Date;
  },
): Promise<LoyaltyBalance> {
  if (p.delta === 0) throw badRequest("delta must not be 0");
  const target = await userByUsername(db, p.username);
  if (target.accountType === "bot") throw badRequest("Bot accounts do not hold channel points");
  const loyalty = await loyaltyOf(db, p.channel.id);
  const balance = await db
    .transaction(async (tx) => {
      const posted = await postPointsInTx(tx, {
        channelId: p.channel.id,
        userId: target.id,
        delta: p.delta,
        reason: "moderator_adjust",
        refId: null,
        at: p.now,
      });
      await audit(tx, {
        actorType: "user",
        actorId: p.actorId,
        action: "points.adjust",
        subjectType: "user",
        subjectId: target.id,
        channelId: p.channel.id,
        details: { transactionId: posted.id, delta: p.delta, reason: p.reason },
      });
      await emit(
        tx,
        "channel.points.change",
        p.channel.id,
        pointsChangePayload(p.channel, target, { delta: p.delta, balance: posted.balance, reason: "moderator_adjust" }),
        p.now,
      );
      return posted.balance;
    })
    .catch((err: unknown) => {
      if (err instanceof InsufficientPointsError) throw precondition("insufficient_points", "Not enough points");
      throw err;
    });
  return {
    channelSlug: p.channel.slug,
    user: { id: target.id, username: target.username },
    points: balance,
    ...loyalty,
  };
}
