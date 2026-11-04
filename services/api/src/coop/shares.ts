// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Member shares paid by card (batch 8, M1-coop-money; ADR 0020): the rules `buyShare`, the
 * treasurer's share refund and the Stripe webhook share.
 *
 * - **How a share is paid.** By bank transfer (the manual adapter) by default. By Stripe Checkout
 *   only when the instance runs Stripe **and** the co-op voted `shares.cardPayments` on (an ordinary
 *   setting, seeded off). Otherwise a Stripe instance keeps answering `manual_shares`, except under
 *   `COOP_TEST_HOOKS`, where a share stays a manual bank transfer so a seeded stripe-mock stack has
 *   shares too.
 * - **Booking a paid share** (`bookShareTx`): payment `succeeded`, the `sharePurchase` posting, the
 *   share `held`, and a viewer membership with basis `share`, with their audit rows and events, in
 *   the caller's transaction. A card share whose member left the co-op (or deleted the account)
 *   while the checkout was open is booked and then set `refund_pending` for the treasurer, never
 *   activated.
 * - **A failed checkout** (`releaseShareTx`) cancels the pending share as the manual expiry does.
 * - **Refunds** follow the bylaws: never automatic on leaving. For a card share the treasurer's
 *   refund is asked of Stripe through the shared request guard (`requestProviderRefund`), and the
 *   `shareRefund` posting follows Stripe's `charge.refunded` (`shareChargeRefunded`).
 *
 * Lock order, as everywhere in the co-op: payment → share → membership. Ids and cents only in
 * audit details, events and ledger metadata (ADR 0004).
 */
import { ORPCError } from "@orpc/server";
import { and, desc, eq, gte, inArray, isNotNull } from "drizzle-orm";
import { SharesCardPaymentsSetting } from "@commonair/contracts/shapes";
import { type Executor, schema, uuidv7 } from "@commonair/db";
import type { SettingsMap } from "@commonair/governance";
import { post, shareRefund, sharePurchase } from "@commonair/ledger";
import { type PaymentAdapter, type StripeAction, createAdapter } from "@commonair/payments";
import type { Deps } from "../deps.ts";
import { audit } from "../events/audit.ts";
import { emit } from "../events/outbox.ts";
import { conflict, precondition } from "../lib/errors.ts";
import { requestProviderRefund } from "../money/stripe-refunds.ts";
import { STAFF } from "./shared.ts";

const { memberships, membershipShares, payments, users, disputes } = schema;
type PaymentRow = typeof payments.$inferSelect;
type ShareRow = typeof membershipShares.$inferSelect;
type MembershipRow = typeof memberships.$inferSelect;

export const SHARES_CARD_PAYMENTS = "shares.cardPayments";
/** What the share trigger counts as open: one per user. */
export const OPEN_SHARE = ["pending", "held", "refund_pending"] as const;

/** How a share is bought on this instance now: by card, by bank transfer, or not at all. */
export type ShareCheckoutMode = "card" | "manual" | "refused";

/** Whether the co-op voted card payments for shares on (`shares.cardPayments`; off when unreadable). */
export function cardPaymentsEnabled(settings: SettingsMap): boolean {
  const parsed = SharesCardPaymentsSetting.safeParse(settings[SHARES_CARD_PAYMENTS]);
  return parsed.success && parsed.data.enabled;
}

/** The rule above, pure (unit-tested). */
export function shareCheckoutMode(
  env: { PAYMENTS_PROVIDER: "manual" | "stripe"; COOP_TEST_HOOKS: boolean },
  settings: SettingsMap,
): ShareCheckoutMode {
  if (env.PAYMENTS_PROVIDER === "manual") return "manual";
  if (env.PAYMENTS_PROVIDER === "stripe" && cardPaymentsEnabled(settings)) return "card";
  return env.COOP_TEST_HOOKS ? "manual" : "refused";
}

// ── The card adapter (injectable for tests) ─────────────────────────────────────────────────

const adapters = new WeakMap<Deps, PaymentAdapter>();

/** The instance's provider adapter for card shares; tests may install their own. */
export function shareAdapter(deps: Deps): PaymentAdapter {
  return adapters.get(deps) ?? createAdapter(deps.env);
}

export function setShareAdapter(deps: Deps, adapter: PaymentAdapter | null): void {
  if (adapter) adapters.set(deps, adapter);
  else adapters.delete(deps);
}

/**
 * Start (or show again) a share checkout. A provider that refuses or does not answer is a clear
 * PRECONDITION_FAILED, never a 500; the caller's transaction then rolls back, so nothing is left
 * pending (a session Stripe may have opened is never paid against a payment we do not hold).
 */
export async function startShareCheckout(
  adapter: PaymentAdapter,
  request: Parameters<PaymentAdapter["startCheckout"]>[0],
): Promise<Awaited<ReturnType<PaymentAdapter["startCheckout"]>>> {
  try {
    return await adapter.startCheckout(request);
  } catch (err) {
    if (err instanceof Error && !(err instanceof ORPCError))
      throw precondition("payment_provider", "The payment provider could not start the checkout; try again");
    throw err;
  }
}

// ── Events ──────────────────────────────────────────────────────────────────────────────────

export async function shareEvent(
  tx: Executor,
  s: Pick<ShareRow, "id" | "userId" | "status" | "amountCents">,
  now: Date,
): Promise<void> {
  await emit(
    tx,
    "coop.share.update",
    null,
    { share_id: s.id, user_id: s.userId, status: s.status, amount_cents: s.amountCents },
    now,
  );
}

export async function membershipEvent(
  tx: Executor,
  m: Pick<MembershipRow, "id" | "userId" | "class" | "status" | "basis">,
  now: Date,
): Promise<void> {
  await emit(
    tx,
    "coop.membership.update",
    null,
    { membership_id: m.id, user_id: m.userId, class: m.class, status: m.status, basis: m.basis },
    now,
  );
}

/** Insert an active membership unless one exists in that class (a concurrent sync may win). */
export async function activateMembership(
  tx: Executor,
  userId: string,
  cls: MembershipRow["class"],
  basis: MembershipRow["basis"],
  now: Date,
): Promise<MembershipRow | null> {
  const [row] = await tx
    .insert(memberships)
    .values({ id: uuidv7(), userId, class: cls, basis, joinedAt: now, lastEligibilityCheckAt: now })
    .onConflictDoNothing({
      target: [memberships.userId, memberships.class],
      where: eq(memberships.status, "active"),
    })
    .returning();
  return row ?? null;
}

// ── Booking a paid share ────────────────────────────────────────────────────────────────────

/** Who booked it: the treasurer confirming a bank transfer, or the system (a Stripe event). */
export type ShareActor = { type: typeof STAFF; id: string } | { type: "system"; id: null };

export interface BookShareOptions {
  /** When the money arrived (`purchased_at`, the posting's date). */
  receivedAt: Date;
  now: Date;
  actor: ShareActor;
  /** Replace the pending reference with the provider's payment id (Stripe: the PaymentIntent). */
  providerRef?: string;
  /**
   * Card shares: refund rather than activate when the member left while the checkout was open. The
   * manual confirm keeps today's behaviour (a treasurer confirms a transfer they can see).
   */
  refundIfLeft?: boolean;
}

export type BookShareOutcome = "activated" | "already_member" | "refund_pending";

/**
 * Whether the member left during the checkout: their account is deleted, or they exited the viewer
 * class after the share was requested (pure; unit-tested).
 */
export function leftDuringCheckout(
  share: Pick<ShareRow, "createdAt">,
  user: { deletedAt: Date | null } | null,
  viewerExits: readonly { exitedAt: Date | null }[],
): boolean {
  if (!user || user.deletedAt !== null) return true;
  return viewerExits.some((m) => m.exitedAt !== null && m.exitedAt.getTime() >= share.createdAt.getTime());
}

async function memberLeft(tx: Executor, share: ShareRow): Promise<boolean> {
  const [user] = await tx.select({ deletedAt: users.deletedAt }).from(users).where(eq(users.id, share.userId));
  const exits = await tx
    .select({ exitedAt: memberships.exitedAt })
    .from(memberships)
    .where(
      and(
        eq(memberships.userId, share.userId),
        eq(memberships.class, "viewer"),
        isNotNull(memberships.exitedAt),
        gte(memberships.exitedAt, share.createdAt),
      ),
    );
  return leftDuringCheckout(share, user ?? null, exits);
}

/**
 * Book a locked, pending `membership_share` payment in the caller's transaction (see the module
 * comment). The caller writes its own `payment.confirm` audit row when a treasurer confirmed it.
 */
export async function bookShareTx(tx: Executor, p: PaymentRow, o: BookShareOptions): Promise<BookShareOutcome> {
  const { receivedAt, now } = o;
  const [share] = await tx.select().from(membershipShares).where(eq(membershipShares.paymentId, p.id)).for("update");
  if (!share) throw conflict("This payment has no member share");
  if (share.status !== "pending") throw conflict(`This share is ${share.status}, not pending`);
  const [paid] = await tx
    .update(payments)
    .set({
      status: "succeeded",
      succeededAt: receivedAt,
      ...(o.providerRef ? { providerRef: o.providerRef } : {}),
      updatedAt: now,
    })
    .where(and(eq(payments.id, p.id), eq(payments.status, "pending")))
    .returning({ id: payments.id });
  if (!paid) throw conflict("This payment is no longer pending");
  await post(
    tx,
    sharePurchase({
      shareId: share.id,
      userId: share.userId,
      provider: p.provider,
      settlement: "cash",
      amountCents: share.amountCents,
      currency: share.currency,
      occurredAt: receivedAt,
    }),
  );
  const [held] = await tx
    .update(membershipShares)
    .set({ status: "held", purchasedAt: receivedAt })
    .where(and(eq(membershipShares.id, share.id), eq(membershipShares.status, "pending")))
    .returning();
  if (!held) throw conflict("This share changed; reload and try again");
  await shareEvent(tx, held, now);

  if (o.refundIfLeft && (await memberLeft(tx, share))) {
    // Booked (the money arrived), never activated: the treasurer refunds it per the bylaws.
    const [pending] = await tx
      .update(membershipShares)
      .set({ status: "refund_pending" })
      .where(and(eq(membershipShares.id, share.id), eq(membershipShares.status, "held")))
      .returning();
    if (!pending) throw conflict("This share changed; reload and try again");
    await audit(tx, {
      actorType: o.actor.type,
      actorId: o.actor.id,
      action: "coop.share.refund_request",
      subjectType: "membership_share",
      subjectId: share.id,
      details: { shareId: share.id, paymentId: p.id, amountCents: share.amountCents, reason: "left_during_checkout" },
    });
    await shareEvent(tx, pending, now);
    return "refund_pending";
  }

  const m = await activateMembership(tx, share.userId, "viewer", "share", now);
  if (!m) return "already_member";
  await audit(tx, {
    actorType: o.actor.type,
    actorId: o.actor.id,
    action: "membership.activate",
    subjectType: "membership",
    subjectId: m.id,
    details: { class: "viewer", basis: "share", userId: share.userId, shareId: share.id },
  });
  await membershipEvent(tx, m, now);
  return "activated";
}

// ── A checkout that never paid ──────────────────────────────────────────────────────────────

/**
 * The pending shares of a failed share payment become `cancelled` (as the manual expiry,
 * `services/worker/src/money/expire.ts`), with their audit rows and events. Nothing was posted for
 * a pending share, so nothing is reversed. The payment is locked (or already failed) by the caller.
 */
export async function releaseShareTx(tx: Executor, paymentId: string, now: Date, reason: string): Promise<number> {
  const cancelled = await tx
    .update(membershipShares)
    .set({ status: "cancelled" })
    .where(and(eq(membershipShares.paymentId, paymentId), eq(membershipShares.status, "pending")))
    .returning();
  for (const sh of cancelled) {
    await audit(tx, {
      actorType: "system",
      actorId: null,
      action: "coop.share.cancel",
      subjectType: "membership_share",
      subjectId: sh.id,
      reason,
      details: { shareId: sh.id, paymentId, amountCents: sh.amountCents },
    });
    await shareEvent(tx, sh, now);
  }
  return cancelled.length;
}

/** The user's latest open share with its payment, under the caller's per-user share lock. */
export async function openShareOf(
  tx: Executor,
  userId: string,
): Promise<{ share: ShareRow; payment: PaymentRow | null } | null> {
  const [row] = await tx
    .select({ share: membershipShares, payment: payments })
    .from(membershipShares)
    .leftJoin(payments, eq(payments.id, membershipShares.paymentId))
    .where(and(eq(membershipShares.userId, userId), inArray(membershipShares.status, [...OPEN_SHARE])))
    .orderBy(desc(membershipShares.createdAt))
    .limit(1);
  return row ?? null;
}

// ── Refunds ─────────────────────────────────────────────────────────────────────────────────

/**
 * A treasurer refunds a card share: the refund is asked of Stripe through the shared request guard
 * (one outstanding request per payment, ADR 0007 decision 3). The share stays `refund_pending`; the
 * `shareRefund` posting follows `charge.refunded`. Throws CONFLICT while an earlier request blocks
 * and PRECONDITION_FAILED when the provider refused or did not answer.
 */
export async function requestShareProviderRefund(
  deps: Deps,
  share: Pick<ShareRow, "id" | "amountCents">,
  payment: Pick<PaymentRow, "id" | "provider">,
  o: { actorId: string; note: string },
): Promise<void> {
  const adapter = shareAdapter(deps);
  if (adapter.provider !== payment.provider)
    throw precondition("payment_provider", "This instance cannot refund through that payment provider");
  await requestProviderRefund(deps, adapter, {
    paymentId: payment.id,
    amountCents: share.amountCents,
    reason: o.note,
    actorId: o.actorId,
  });
}

type ChargeRefunded = Extract<StripeAction, { type: "charge.refunded" }>;

export type ShareRefundOutcome = "share_refunded" | "no_new_refund" | "share_refund_unmatched";

/** The refunds in a `charge.refunded` not booked yet (pure; the cumulative path when Stripe lists none). */
export function freshRefunds(
  a: Pick<ChargeRefunded, "refunds" | "amountRefunded" | "chargeId">,
  prior: readonly { ref: string | null; amount: number }[],
): { id: string; amountCents: number }[] {
  const seen = new Set(prior.flatMap((d) => (d.ref ? [d.ref] : [])));
  const already = prior.reduce((sum, d) => sum + d.amount, 0);
  if (a.refunds) return a.refunds.filter((r) => !seen.has(r.id));
  return a.amountRefunded > already
    ? [{ id: `${a.chargeId}:${a.amountRefunded}`, amountCents: a.amountRefunded - already }]
    : [];
}

const UNMATCHED = "coop.share.refund_unmatched";

/**
 * `charge.refunded` for a card share, in the webhook's transaction with the payment row locked. A
 * full refund of a `refund_pending` share posts `shareRefund` (Dr the member share, Cr
 * `cash:stripe`), records the refund (the request guard reads it), marks the payment refunded and
 * the share refunded, with its audit row and event. A redelivery finds nothing new.
 *
 * A share is refunded in full or not at all, and only once the member left (`refund_pending`). Any
 * other refund (partial, or of a share still held: a dashboard refund) books nothing: it writes one
 * `coop.share.refund_unmatched` system audit row per refund for the treasurer to reconcile.
 */
export async function shareChargeRefunded(
  tx: Executor,
  p: PaymentRow,
  a: ChargeRefunded,
  now: Date,
): Promise<ShareRefundOutcome> {
  const prior = await tx
    .select({ ref: disputes.providerRef, amount: disputes.amountCents })
    .from(disputes)
    .where(and(eq(disputes.paymentId, p.id), eq(disputes.kind, "refund")));
  const fresh = freshRefunds(a, prior);
  if (fresh.length === 0) return "no_new_refund";
  const [share] = await tx.select().from(membershipShares).where(eq(membershipShares.paymentId, p.id)).for("update");
  let outcome: ShareRefundOutcome = "no_new_refund";
  for (const r of fresh) {
    const whole = r.amountCents === p.amountCents && p.refundedCents === 0;
    if (!share || share.status !== "refund_pending" || !whole) {
      if (await unmatchedRecorded(tx, p.id, r.id)) continue;
      await audit(tx, {
        actorType: "system",
        actorId: null,
        action: UNMATCHED,
        subjectType: "payment",
        subjectId: p.id,
        details: {
          paymentId: p.id,
          shareId: share?.id ?? null,
          refundRef: r.id,
          amountCents: r.amountCents,
          shareStatus: share?.status ?? null,
        },
      });
      outcome = "share_refund_unmatched";
      continue;
    }
    await tx.insert(disputes).values({
      id: uuidv7(),
      paymentId: p.id,
      kind: "refund",
      status: "closed",
      amountCents: r.amountCents,
      providerRef: r.id,
      reason: null,
      resolvedAt: now,
    });
    await post(
      tx,
      shareRefund({
        shareId: share.id,
        userId: share.userId,
        provider: p.provider,
        settlement: "cash",
        amountCents: share.amountCents,
        currency: share.currency,
        occurredAt: now,
      }),
    );
    await tx
      .update(payments)
      .set({ status: "refunded", refundedCents: p.amountCents, updatedAt: now })
      .where(eq(payments.id, p.id));
    const [refunded] = await tx
      .update(membershipShares)
      .set({ status: "refunded", refundedAt: now })
      .where(and(eq(membershipShares.id, share.id), eq(membershipShares.status, "refund_pending")))
      .returning();
    if (!refunded) throw conflict("This share changed; reload and try again");
    await audit(tx, {
      actorType: "system",
      actorId: null,
      action: "coop.share.refund",
      subjectType: "membership_share",
      subjectId: share.id,
      details: { shareId: share.id, userId: share.userId, amountCents: share.amountCents, refundRef: r.id },
    });
    await shareEvent(tx, refunded, now);
    return "share_refunded";
  }
  return outcome;
}

async function unmatchedRecorded(tx: Executor, paymentId: string, refundRef: string): Promise<boolean> {
  const rows = await tx
    .select({ details: schema.auditLog.details })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.subjectType, "payment"),
        eq(schema.auditLog.subjectId, paymentId),
        eq(schema.auditLog.action, UNMATCHED),
      ),
    );
  return rows.some((r) => (r.details as Record<string, unknown>).refundRef === refundRef);
}
