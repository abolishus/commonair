// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What an account deletion does to money and co-op standing (fix F0 of the 2026-11 design
 * overhaul). Before this, a deleted account kept paying, and its channel kept billing its
 * subscribers: nothing stopped either.
 *
 * The subscriptions concerned are the ones the user pays for **and** the ones others pay on the
 * user's channels, gifts excepted (they never renew and expire on their own). Their renewal already
 * stopped when the deletion was requested (ADR 0042, services/api/src/moderation/deletion.ts), so
 * the paid time mostly ran out during the grace period; what is still running ends **now**: the
 * account, or the channel, that gave it its value is gone. No prorated refund is made for the
 * unused part of a period (ADR 0042 decision 4: a treasurer can refund by hand).
 *
 * - **Before the transaction** (`stopProviderRenewals`): each provider-managed subscription that
 *   can still renew is cancelled at the provider now. A provider failure throws, so the deletion
 *   is retried and never completes while a card can still be charged; a provider that no longer
 *   knows the subscription (404) counts as done. The idempotency key is stable per subscription,
 *   so a retry is safe.
 * - **In the deletion transaction** (`endMoneyAndMembership`): pending subscription payments
 *   (first payments and renewals) fail, so a late confirm cannot revive them; `active` and
 *   `past_due` subscriptions end (`canceled`, with their end events) and `incomplete` ones expire.
 *   Money the provider still collects afterwards (an invoice already in flight, a checkout paid
 *   late) reaches a subscription that has ended, and the webhook books it, refunds it
 *   automatically and stops the provider (`paid_after_end`, ADR 0007 decision 2). Every active
 *   co-op membership exits, and a held share becomes `refund_pending` for the treasurer when the
 *   bylaws make it refundable on exit (never automatic: ADR 0020).
 *
 * Lock order, as everywhere in money and the co-op: payment → share → subscription → membership.
 * Ids and cents only in audit details, events and logs (ADR 0004).
 */
import { loadEnv, paymentsEnv } from "@commonair/config";
import { type Executor, schema } from "@commonair/db";
import { emitEvent, loadSettings, membershipClassesOf, systemAudit } from "@commonair/governance";
import type { Logger } from "@commonair/observability";
import { type PaymentAdapter, StripeApiError, createAdapter } from "@commonair/payments";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { emitSubscriptionEnds, type EndedSubscription } from "../money/ends.ts";

const s = schema;
export const DELETION_REASON = "account_deleted";

/** The part of a payment adapter the deletion needs; tests pass their own. */
export type RenewalPort = Pick<PaymentAdapter, "provider" | "cancelSubscription">;

const portEnv = paymentsEnv.pick({
  PAYMENTS_PROVIDER: true,
  MANUAL_PAYMENT_INSTRUCTIONS: true,
  STRIPE_SECRET_KEY: true,
  STRIPE_API_BASE: true,
});

/**
 * The instance's provider, or null when it cannot be built (then any provider-managed
 * subscription blocks its deletion until the provider is configured again).
 */
export function renewalPortFromEnv(source: Record<string, string | undefined> = process.env): RenewalPort | null {
  try {
    const adapter = createAdapter(loadEnv(portEnv, source));
    return {
      provider: adapter.provider,
      ...(adapter.cancelSubscription ? { cancelSubscription: adapter.cancelSubscription.bind(adapter) } : {}),
    };
  } catch {
    return null;
  }
}

/** Raised when a provider-managed subscription cannot be cancelled; the deletion is retried. */
export class RenewalCancelError extends Error {
  readonly code = "RENEWAL_CANCEL_FAILED";
  constructor(
    readonly subscriptionId: string,
    readonly provider: string,
    readonly reason: "no_provider" | "provider_mismatch" | "no_reference" | "provider_error",
    readonly providerStatus: number | null = null,
    readonly providerCode: string | null = null,
  ) {
    super("a provider-managed subscription could not be cancelled");
  }
}

/** The user's channels (normally one). */
async function channelIdsOf(db: Executor, userId: string): Promise<string[]> {
  const rows = await db.select({ id: s.channels.id }).from(s.channels).where(eq(s.channels.ownerId, userId));
  return rows.map((r) => r.id);
}

/** Subscriptions the deletion ends: paid by the user, or paid on the user's channels; never gifts. */
function concerned(userId: string, channelIds: readonly string[], statuses: ("incomplete" | "active" | "past_due")[]) {
  return and(
    channelIds.length > 0
      ? or(eq(s.subscriptions.subscriberId, userId), inArray(s.subscriptions.channelId, [...channelIds]))
      : eq(s.subscriptions.subscriberId, userId),
    inArray(s.subscriptions.status, statuses),
    isNull(s.subscriptions.giftedById),
    isNull(s.subscriptions.giftPaymentId),
  );
}

/**
 * Tell the provider to stop charging, now, for each provider-managed subscription the deletion
 * ends. Returns how many were cancelled there.
 */
export async function stopProviderRenewals(
  db: Executor,
  port: RenewalPort | null,
  userId: string,
  logger?: Logger,
): Promise<number> {
  const channelIds = await channelIdsOf(db, userId);
  const rows = await db
    .select({
      id: s.subscriptions.id,
      provider: s.subscriptions.provider,
      ref: s.subscriptions.providerRef,
      status: s.subscriptions.status,
      cancelAtPeriodEnd: s.subscriptions.cancelAtPeriodEnd,
    })
    .from(s.subscriptions)
    .where(and(concerned(userId, channelIds, ["active", "past_due"]), ne(s.subscriptions.provider, "manual")));
  let cancelled = 0;
  for (const r of rows) {
    // Already ending at the provider: it charges nothing more, and the row ends locally below.
    if (r.status === "active" && r.cancelAtPeriodEnd) continue;
    const fail = (e: RenewalCancelError) => {
      logger?.error("account deletion blocked: a provider subscription could not be cancelled", {
        subscriptionId: e.subscriptionId,
        provider: e.provider,
        reason: e.reason,
        providerStatus: e.providerStatus,
        providerCode: e.providerCode,
      });
      return e;
    };
    if (!port?.cancelSubscription) throw fail(new RenewalCancelError(r.id, r.provider, "no_provider"));
    if (port.provider !== r.provider) throw fail(new RenewalCancelError(r.id, r.provider, "provider_mismatch"));
    if (!r.ref) throw fail(new RenewalCancelError(r.id, r.provider, "no_reference"));
    try {
      await port.cancelSubscription(r.ref, { atPeriodEnd: false, idempotencyKey: `deletion-cancel-${r.id}-now` });
    } catch (err) {
      // The provider no longer has it (cancelled there already, its webhook still on the way).
      if (err instanceof StripeApiError && err.status === 404) continue;
      throw fail(
        new RenewalCancelError(
          r.id,
          r.provider,
          "provider_error",
          err instanceof StripeApiError ? err.status : null,
          err instanceof StripeApiError ? err.code : null,
        ),
      );
    }
    cancelled++;
  }
  return cancelled;
}

export interface MoneyAndMembership {
  /** `active` or `past_due` subscriptions ended now; their subscribers' badges go after commit. */
  ended: EndedSubscription[];
  /** `incomplete` subscriptions expired. */
  incompleteExpired: number;
  /** Pending subscription payments (first payments and renewals) failed. */
  paymentsFailed: number;
  membershipsExited: number;
  sharesRefundPending: number;
  /** The share now owed back, for the completed notice (how to claim it by reference). */
  shareRefund: ShareRefundOwed | null;
}

export interface ShareRefundOwed {
  shareId: string;
  amountCents: number;
  currency: string;
  /** What the member quotes to claim it: the bank-transfer reference, else the share id. */
  reference: string;
}

/** The share's reference for the member: its manual payment's bank-transfer reference, else its id. */
export function shareReferenceOf(
  share: { id: string },
  payment: { provider: string; providerRef: string | null } | undefined,
): string {
  return payment?.provider === "manual" && payment.providerRef ? payment.providerRef : share.id;
}

/** In the deletion transaction: end the subscriptions, then leave the co-op. */
export async function endMoneyAndMembership(tx: Executor, userId: string, now: Date): Promise<MoneyAndMembership> {
  const channelIds = await channelIdsOf(tx, userId);
  const where = concerned(userId, channelIds, ["incomplete", "active", "past_due"]);
  const ids = (await tx.select({ id: s.subscriptions.id }).from(s.subscriptions).where(where)).map((r) => r.id);

  // 1. Payments: their pending payments, so no confirm can activate or renew them later.
  let paymentsFailed = 0;
  if (ids.length > 0) {
    const open = await tx
      .select({ id: s.payments.id })
      .from(s.payments)
      .where(and(inArray(s.payments.subscriptionId, ids), eq(s.payments.status, "pending")))
      .for("update");
    if (open.length > 0)
      paymentsFailed = (
        await tx
          .update(s.payments)
          .set({ status: "failed", updatedAt: now })
          .where(
            and(
              inArray(
                s.payments.id,
                open.map((o) => o.id),
              ),
              eq(s.payments.status, "pending"),
            ),
          )
          .returning({ id: s.payments.id })
      ).length;
  }

  // 2. The user's held share.
  const [share] = await tx
    .select()
    .from(s.membershipShares)
    .where(and(eq(s.membershipShares.userId, userId), eq(s.membershipShares.status, "held")))
    .for("update");

  // 3. Subscriptions (re-read under the lock: a confirm or the renewal job may have moved one).
  const ended: EndedSubscription[] = [];
  let incompleteExpired = 0;
  if (ids.length > 0) {
    const subs = await tx
      .select()
      .from(s.subscriptions)
      .where(and(inArray(s.subscriptions.id, ids), where))
      .for("update");
    for (const sub of subs) {
      if (sub.status === "incomplete") {
        const [row] = await tx
          .update(s.subscriptions)
          .set({ status: "expired", updatedAt: now })
          .where(and(eq(s.subscriptions.id, sub.id), eq(s.subscriptions.status, "incomplete")))
          .returning({ id: s.subscriptions.id });
        if (row) incompleteExpired++;
        continue;
      }
      const [row] = await tx
        .update(s.subscriptions)
        .set({ status: "canceled", cancelAtPeriodEnd: false, updatedAt: now })
        .where(and(eq(s.subscriptions.id, sub.id), inArray(s.subscriptions.status, ["active", "past_due"])))
        .returning({ id: s.subscriptions.id });
      if (row)
        ended.push({
          id: sub.id,
          subscriberId: sub.subscriberId,
          channelId: sub.channelId,
          tier: sub.tier,
          isGift: false,
        });
    }
    await emitSubscriptionEnds(tx, ended, now);
  }

  // 4. Memberships, then the share they were bought with.
  const exited = await tx
    .update(s.memberships)
    .set({ status: "exited", exitedAt: now })
    .where(and(eq(s.memberships.userId, userId), eq(s.memberships.status, "active")))
    .returning();
  for (const m of exited) {
    await systemAudit(
      tx,
      {
        action: "membership.exit",
        subjectType: "membership",
        subjectId: m.id,
        reason: DELETION_REASON,
        details: { class: m.class, basis: m.basis },
      },
      now,
    );
    await emitEvent(
      tx,
      "coop.membership.update",
      { membership_id: m.id, user_id: m.userId, class: m.class, status: m.status, basis: m.basis },
      now,
    );
  }
  let sharesRefundPending = 0;
  let shareRefund: ShareRefundOwed | null = null;
  // Settings are read only when there is a share to judge, so a deletion never waits on them.
  if (share && membershipClassesOf(await loadSettings(tx)).viewer.shareRefundableOnExit) {
    const [pending] = await tx
      .update(s.membershipShares)
      .set({ status: "refund_pending" })
      .where(and(eq(s.membershipShares.id, share.id), eq(s.membershipShares.status, "held")))
      .returning();
    if (pending) {
      await systemAudit(
        tx,
        {
          action: "coop.share.refund_request",
          subjectType: "membership_share",
          subjectId: share.id,
          reason: DELETION_REASON,
          details: { shareId: share.id, amountCents: share.amountCents },
        },
        now,
      );
      await emitEvent(
        tx,
        "coop.share.update",
        { share_id: share.id, user_id: share.userId, status: pending.status, amount_cents: share.amountCents },
        now,
      );
      sharesRefundPending = 1;
      const [p] = share.paymentId
        ? await tx
            .select({ provider: s.payments.provider, providerRef: s.payments.providerRef })
            .from(s.payments)
            .where(eq(s.payments.id, share.paymentId))
        : [];
      shareRefund = {
        shareId: share.id,
        amountCents: share.amountCents,
        currency: share.currency,
        reference: shareReferenceOf(share, p),
      };
    }
  }
  return {
    ended,
    incompleteExpired,
    paymentsFailed,
    membershipsExited: exited.length,
    sharesRefundPending,
    shareRefund,
  };
}
