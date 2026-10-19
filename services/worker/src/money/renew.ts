// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Renewal (docs/testing/e4b-selectors.md): at `current_period_end` an `active` subscription
 * either ends (`cancel_at_period_end` → `canceled`, a gift → `expired`, a channel without tiers →
 * `expired`, each with `channel.subscription.end`) or, for a manual self subscription, gets one
 * `pending` renewal payment at today's tier price and turns `past_due`. Stripe self
 * subscriptions are left to Stripe's events.
 */
import { schema, uuidv7, type Executor } from "@commonair/db";
import { manualReference } from "@commonair/payments";
import { and, asc, eq, gt, lte, or, sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import type { MoneyJobConfig } from "./config.ts";
import { emitSubscriptionEnds, publishBadgeInvalidations, type EndedSubscription } from "./ends.ts";
import { moneyMetrics } from "./metrics.ts";
import { renewalExpiresAt, runBatches } from "./time.ts";

const s = schema.subscriptions;

export type RenewOutcome = "renewed" | "canceled" | "gift" | "no_tiers" | "skipped";

export interface RenewResult {
  renewed: number;
  canceled: number;
  giftsEnded: number;
  noTiers: number;
  skipped: number;
  batches: number;
  exhausted: boolean;
}

/** References are random; a clash with an existing one is retried with a fresh reference. */
const REFERENCE_ATTEMPTS = 5;

async function insertRenewalPayment(
  tx: Executor,
  values: Omit<typeof schema.payments.$inferInsert, "providerRef">,
  reference: () => string,
): Promise<string> {
  for (let i = 0; i < REFERENCE_ATTEMPTS; i++) {
    const [row] = await tx
      .insert(schema.payments)
      .values({ ...values, providerRef: reference() })
      .onConflictDoNothing({ target: [schema.payments.provider, schema.payments.providerRef] })
      .returning({ id: schema.payments.id });
    if (row) return row.id;
  }
  throw new Error("could not mint a unique payment reference");
}

/** Handle one due subscription in its own transaction, with the row locked. */
export async function renewOne(
  ctx: WorkerContext,
  subscriptionId: string,
  now: Date,
  cfg: Pick<MoneyJobConfig, "currency" | "pendingDays">,
  reference: () => string = manualReference,
): Promise<{ outcome: RenewOutcome; ended?: EndedSubscription }> {
  return ctx.db.transaction(async (tx) => {
    const [sub] = await tx.select().from(s).where(eq(s.id, subscriptionId)).for("update");
    // Re-check under the lock: another run, a cancel or a Stripe event may have moved it.
    if (!sub || sub.status !== "active" || !sub.currentPeriodEnd || sub.currentPeriodEnd > now) {
      return { outcome: "skipped" as const };
    }
    const isGift = sub.giftPaymentId !== null;
    const end = async (status: "canceled" | "expired", outcome: RenewOutcome) => {
      await tx
        .update(s)
        .set({ status, updatedAt: now })
        .where(and(eq(s.id, sub.id), eq(s.status, "active")));
      const ended: EndedSubscription = {
        id: sub.id,
        subscriberId: sub.subscriberId,
        channelId: sub.channelId,
        tier: sub.tier,
        isGift: isGift || sub.giftedById !== null,
      };
      await emitSubscriptionEnds(tx, [ended], now);
      return { outcome, ended };
    };
    // Gifts never renew, whichever provider took the one-off gift payment.
    if (isGift) return end("expired", "gift");
    if (sub.provider !== "manual") return { outcome: "skipped" as const };
    if (sub.cancelAtPeriodEnd) return end("canceled", "canceled");

    const [tier] = await tx
      .select({ priceCents: schema.channelSubTiers.priceCents })
      .from(schema.channelSubTiers)
      .where(and(eq(schema.channelSubTiers.channelId, sub.channelId), eq(schema.channelSubTiers.tier, sub.tier)));
    if (!tier) return end("expired", "no_tiers");

    // Never a second open renewal for this subscription (the lock above serialises the check).
    const [open] = await tx
      .select({ id: schema.payments.id })
      .from(schema.payments)
      .where(
        and(
          eq(schema.payments.subscriptionId, sub.id),
          eq(schema.payments.status, "pending"),
          eq(schema.payments.kind, "subscription"),
        ),
      )
      .limit(1);
    if (!open) {
      await insertRenewalPayment(
        tx,
        {
          id: uuidv7(now.getTime()),
          provider: "manual",
          kind: "subscription",
          status: "pending",
          userId: sub.subscriberId,
          channelId: sub.channelId,
          subscriptionId: sub.id,
          amountCents: tier.priceCents,
          currency: cfg.currency,
          tier: sub.tier,
          quantity: 1,
          expiresAt: renewalExpiresAt(sub.currentPeriodEnd, cfg.pendingDays),
          createdAt: now,
          updatedAt: now,
        },
        reference,
      );
    }
    // Chat keeps the badge while past_due, so no invalidate here.
    await tx
      .update(s)
      .set({ status: "past_due", updatedAt: now })
      .where(and(eq(s.id, sub.id), eq(s.status, "active")));
    return { outcome: open ? ("skipped" as const) : ("renewed" as const) };
  });
}

export async function renewDueSubscriptions(
  ctx: WorkerContext,
  cfg: MoneyJobConfig,
  opts: { clock?: () => number; reference?: () => string } = {},
): Promise<RenewResult> {
  const now = ctx.now();
  const totals = { renewed: 0, canceled: 0, giftsEnded: 0, noTiers: 0, skipped: 0 };
  // Keyset cursor, so a row that is skipped (Stripe) or fails is never revisited this run.
  let cursor: { end: Date; id: string } | undefined;
  const loop = await runBatches(
    { batchSize: cfg.batchSize, budgetMs: cfg.budgetMs, clock: opts.clock },
    async (limit) => {
      const after = cursor
        ? or(gt(s.currentPeriodEnd, cursor.end), and(eq(s.currentPeriodEnd, cursor.end), gt(s.id, cursor.id)))
        : undefined;
      const page = await ctx.db
        .select({ id: s.id, end: s.currentPeriodEnd })
        .from(s)
        .where(
          and(
            eq(s.status, "active"),
            lte(s.currentPeriodEnd, now),
            // Stripe self subscriptions follow Stripe's events; Stripe gifts still end here.
            or(eq(s.provider, "manual"), sql`${s.giftPaymentId} is not null`),
            after,
          ),
        )
        .orderBy(asc(s.currentPeriodEnd), asc(s.id))
        .limit(limit);
      const ended: EndedSubscription[] = [];
      for (const row of page) {
        try {
          const r = await renewOne(ctx, row.id, now, cfg, opts.reference);
          if (r.outcome === "renewed") totals.renewed += 1;
          else if (r.outcome === "canceled") totals.canceled += 1;
          else if (r.outcome === "gift") totals.giftsEnded += 1;
          else if (r.outcome === "no_tiers") totals.noTiers += 1;
          else totals.skipped += 1;
          if (r.outcome === "renewed") moneyMetrics.renewed.add(1);
          if (r.ended) {
            ended.push(r.ended);
            moneyMetrics.ended.add(1, { reason: r.outcome });
          }
        } catch (err) {
          totals.skipped += 1;
          ctx.logger.error("subscription renewal failed; retried next tick", { subscriptionId: row.id, err });
        }
      }
      await publishBadgeInvalidations(ctx, ended);
      const last = page.at(-1);
      if (last?.end) cursor = { end: last.end, id: last.id };
      return page.length;
    },
  );
  const changed = totals.renewed + totals.canceled + totals.giftsEnded + totals.noTiers;
  if (changed > 0 || loop.exhausted) ctx.logger.info("renewed due subscriptions", { ...totals, ...loop });
  return { ...totals, batches: loop.batches, exhausted: loop.exhausted };
}
