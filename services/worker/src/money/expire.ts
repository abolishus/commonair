// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Expiry (docs/testing/e4b-selectors.md): a `pending` payment past `expires_at` becomes `failed`;
 * its `incomplete` subscriptions (own or gifted) become `expired`; a `past_due` subscription whose
 * renewal it was ends as `expired` with `channel.subscription.end`; its tip becomes `failed`.
 * Nothing was posted to the ledger for a pending payment, so nothing is reversed.
 */
import { schema } from "@commonair/db";
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
  batches: number;
  exhausted: boolean;
}

const p = schema.payments;
const s = schema.subscriptions;

/** One transaction: up to `limit` due payments, everything hanging off them, and the end events. */
async function expireBatch(ctx: WorkerContext, now: Date, limit: number) {
  return ctx.db.transaction(async (tx) => {
    // Lock the due rows (skipping any a confirm holds right now), then flip them by CAS.
    const due = await tx
      .select({ id: p.id })
      .from(p)
      .where(and(eq(p.status, "pending"), isNotNull(p.expiresAt), lte(p.expiresAt, now)))
      .orderBy(p.expiresAt, p.id)
      .limit(limit)
      .for("update", { skipLocked: true });
    if (due.length === 0) return { payments: [], subscriptions: 0, ended: [] as EndedSubscription[], tips: 0 };
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
    if (paymentIds.length === 0) return { payments: [], subscriptions: 0, ended: [], tips: 0 };

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
    return { payments: failed, subscriptions: incomplete.length + lapsed.length, ended, tips: tips.length };
  });
}

export async function expirePendingPayments(
  ctx: WorkerContext,
  cfg: Pick<MoneyJobConfig, "batchSize" | "budgetMs">,
  clock?: () => number,
): Promise<ExpireResult> {
  const now = ctx.now();
  const totals = { payments: 0, subscriptions: 0, ended: 0, tips: 0 };
  const loop = await runBatches({ batchSize: cfg.batchSize, budgetMs: cfg.budgetMs, clock }, async (limit) => {
    const r = await expireBatch(ctx, now, limit);
    totals.payments += r.payments.length;
    totals.subscriptions += r.subscriptions;
    totals.ended += r.ended.length;
    totals.tips += r.tips;
    for (const f of r.payments) moneyMetrics.expired.add(1, { kind: f.kind });
    if (r.ended.length) moneyMetrics.ended.add(r.ended.length, { reason: "renewal_unpaid" });
    await publishBadgeInvalidations(ctx, r.ended);
    return r.payments.length;
  });
  if (totals.payments > 0 || loop.exhausted) ctx.logger.info("expired pending payments", { ...totals, ...loop });
  return { ...totals, batches: loop.batches, exhausted: loop.exhausted };
}
