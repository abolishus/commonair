// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Expiry (docs/testing/e4b-selectors.md): a `pending` payment past `expires_at` becomes `failed`;
 * its `incomplete` subscriptions (own or gifted) become `expired`; a `past_due` subscription whose
 * renewal it was ends as `expired` with `channel.subscription.end`; its tip becomes `failed`; its
 * member share (docs/testing/e5-selectors.md) becomes `cancelled` with `coop.share.update`.
 * Nothing was posted to the ledger for a pending payment, so nothing is reversed.
 */
import { schema, type Executor } from "@commonair/db";
import { emitEvent, systemAudit } from "@commonair/governance";
import { and, eq, inArray, isNotNull, lte, or } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import type { MoneyJobConfig } from "./config.ts";
import { emitSubscriptionEnds, publishBadgeInvalidations, type EndedSubscription } from "./ends.ts";
import { moneyMetrics } from "./metrics.ts";
import { runBatches } from "./time.ts";

export interface ExpireResult {
  payments: number;
  subscriptions: number;
  ended: number;
  tips: number;
  /** Member shares cancelled because their share payment expired. */
  shares: number;
  batches: number;
  exhausted: boolean;
}

const p = schema.payments;
const s = schema.subscriptions;

/** Subscription rows one expiry transaction may touch (a gift payment carries up to 100). */
export const EXPIRY_SUBSCRIPTION_CAP = 500;

/**
 * Take due payments in order while the subscriptions they carry stay under `cap` (a payment's
 * `quantity` bounds its subscriptions: 1 for a self sub or tip, n for n gifts). The first one is
 * always taken, so a batch never stalls.
 */
export function takeWithinCap<T extends { quantity: number }>(rows: readonly T[], cap: number): T[] {
  const out: T[] = [];
  let weight = 0;
  for (const r of rows) {
    if (out.length > 0 && weight + r.quantity > cap) break;
    out.push(r);
    weight += r.quantity;
  }
  return out;
}

/**
 * The member shares of failed `membership_share` payments: `pending → cancelled` (compare-and-set,
 * after the payment rows were locked: lock order payment → share), each with its audit row and
 * `coop.share.update` event. Nothing was posted for a pending share, so nothing is reversed.
 */
async function cancelShares(tx: Executor, paymentIds: readonly string[], now: Date): Promise<number> {
  const ms = schema.membershipShares;
  const cancelled = await tx
    .update(ms)
    .set({ status: "cancelled" })
    .where(and(eq(ms.status, "pending"), inArray(ms.paymentId, [...paymentIds])))
    .returning({ id: ms.id, userId: ms.userId, paymentId: ms.paymentId, amountCents: ms.amountCents });
  for (const sh of cancelled) {
    await systemAudit(
      tx,
      {
        action: "coop.share.cancel",
        subjectType: "membership_share",
        subjectId: sh.id,
        reason: "share payment expired unpaid",
        details: { shareId: sh.id, paymentId: sh.paymentId, amountCents: sh.amountCents },
      },
      now,
    );
    await emitEvent(
      tx,
      "coop.share.update",
      { share_id: sh.id, user_id: sh.userId, status: "cancelled", amount_cents: sh.amountCents },
      now,
    );
  }
  return cancelled.length;
}

/** One transaction: up to `limit` due payments, everything hanging off them, and the end events. */
async function expireBatch(ctx: WorkerContext, now: Date, limit: number, subscriptionCap: number) {
  return ctx.db.transaction(async (tx) => {
    // Lock the due rows (skipping any a confirm holds right now), then flip them by CAS.
    const locked = await tx
      .select({ id: p.id, quantity: p.quantity })
      .from(p)
      .where(and(eq(p.status, "pending"), isNotNull(p.expiresAt), lte(p.expiresAt, now)))
      .orderBy(p.expiresAt, p.id)
      .limit(limit)
      .for("update", { skipLocked: true });
    // Rows past the cap are unlocked again at commit and taken by the next batch.
    const due = takeWithinCap(locked, subscriptionCap);
    const more = locked.length >= limit || due.length < locked.length;
    if (due.length === 0)
      return { payments: [], subscriptions: 0, ended: [] as EndedSubscription[], tips: 0, shares: 0, more: false };
    const failed = await tx
      .update(p)
      .set({ status: "failed", updatedAt: now })
      .where(
        and(
          inArray(
            p.id,
            due.map((d) => d.id),
          ),
          eq(p.status, "pending"),
        ),
      )
      .returning({ id: p.id, kind: p.kind, subscriptionId: p.subscriptionId, tipId: p.tipId });
    const paymentIds = failed.map((f) => f.id);
    const subIds = failed.flatMap((f) => (f.subscriptionId ? [f.subscriptionId] : []));
    const tipIds = failed.flatMap((f) => (f.tipId ? [f.tipId] : []));
    if (paymentIds.length === 0) return { payments: [], subscriptions: 0, ended: [], tips: 0, shares: 0, more };

    const byPayment = or(inArray(s.giftPaymentId, paymentIds), subIds.length > 0 ? inArray(s.id, subIds) : undefined);
    const incomplete = await tx
      .update(s)
      .set({ status: "expired", updatedAt: now })
      .where(and(eq(s.status, "incomplete"), byPayment))
      .returning({ id: s.id });
    // A renewal: the subscription had a paid period and was waiting on this payment.
    const lapsed =
      subIds.length === 0
        ? []
        : await tx
            .update(s)
            .set({ status: "expired", updatedAt: now })
            .where(and(eq(s.status, "past_due"), inArray(s.id, subIds)))
            .returning({
              id: s.id,
              subscriberId: s.subscriberId,
              channelId: s.channelId,
              tier: s.tier,
              giftPaymentId: s.giftPaymentId,
              giftedById: s.giftedById,
            });
    const ended: EndedSubscription[] = lapsed.map((r) => ({
      id: r.id,
      subscriberId: r.subscriberId,
      channelId: r.channelId,
      tier: r.tier,
      isGift: r.giftPaymentId !== null || r.giftedById !== null,
    }));
    await emitSubscriptionEnds(tx, ended, now);

    const tips = await tx
      .update(schema.tips)
      .set({ status: "failed" })
      .where(
        and(
          eq(schema.tips.status, "pending"),
          or(
            inArray(schema.tips.paymentId, paymentIds),
            tipIds.length > 0 ? inArray(schema.tips.id, tipIds) : undefined,
          ),
        ),
      )
      .returning({ id: schema.tips.id });
    const shares = await cancelShares(tx, paymentIds, now);
    return {
      payments: failed,
      subscriptions: incomplete.length + lapsed.length,
      ended,
      tips: tips.length,
      shares,
      more,
    };
  });
}

export async function expirePendingPayments(
  ctx: WorkerContext,
  cfg: Pick<MoneyJobConfig, "batchSize" | "budgetMs">,
  opts: { clock?: () => number; subscriptionCap?: number } = {},
): Promise<ExpireResult> {
  const clock = opts.clock;
  const cap = opts.subscriptionCap ?? EXPIRY_SUBSCRIPTION_CAP;
  const now = ctx.now();
  const totals = { payments: 0, subscriptions: 0, ended: 0, tips: 0, shares: 0 };
  const loop = await runBatches({ batchSize: cfg.batchSize, budgetMs: cfg.budgetMs, clock }, async (limit) => {
    const r = await expireBatch(ctx, now, limit, cap);
    totals.payments += r.payments.length;
    totals.subscriptions += r.subscriptions;
    totals.ended += r.ended.length;
    totals.tips += r.tips;
    totals.shares += r.shares;
    for (const f of r.payments) moneyMetrics.expired.add(1, { kind: f.kind });
    if (r.ended.length) moneyMetrics.ended.add(r.ended.length, { reason: "renewal_unpaid" });
    await publishBadgeInvalidations(ctx, r.ended);
    return { rows: r.payments.length, more: r.more };
  });
  if (totals.payments > 0 || loop.exhausted) ctx.logger.info("expired pending payments", { ...totals, ...loop });
  return { ...totals, batches: loop.batches, exhausted: loop.exhausted };
}
