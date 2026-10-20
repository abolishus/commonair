// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The treasurer's payment actions (manual adapter): list, confirm, refund, chargeback and payout
 * accounts. Each runs in one transaction with its ledger posting, outbox events and audit row;
 * state changes are compare-and-set or row-locked so a repeat or a race cannot double-apply.
 */
import { and, count, desc, eq, inArray, lt } from "drizzle-orm";
import { minorUnits } from "@commonair/contracts/currency";
import { type Executor, schema, uuidv7 } from "@commonair/db";
import {
  PAYOUT_ACCOUNT_NOT_READY,
  PaymentNotFoundError,
  ReversalExceedsPaymentError,
  loadMoneySettings,
  lockPayoutBatch,
  paymentSucceeded,
  post,
  postReversal,
} from "@commonair/ledger";
import { createAdapter, normalizeManualReference } from "@commonair/payments";
import { audit } from "../events/audit.ts";
import { broadcasterFields, emit } from "../events/outbox.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { iso, isoOrNull, loadUsersPublic } from "../lib/dto.ts";
import { badRequest, conflict, notFound, precondition } from "../lib/errors.ts";
import { os, requireCaller } from "../lib/orpc.ts";
import { confirmedPeriod, disputeOutcome, tierCode } from "./checkout-rules.ts";
import { endSubscriptions, invalidateSubscribers, userEventFields } from "./checkout-shared.ts";

const { payments, subscriptions, tips, channels, disputes, payoutAccounts, payouts, users, auditLog } = schema;
type PaymentRow = typeof payments.$inferSelect;
type ChannelRow = typeof channels.$inferSelect;

/** The treasurer is platform staff; audit rows name them by id. */
const ACTOR = "admin" as const;

/** created_at is stamped by Postgres and receivedAt by the treasurer's clock; allow them to disagree a little. */
const CLOCK_SKEW_MS = 60_000;

async function lockedPayment(tx: Executor, paymentId: string): Promise<PaymentRow> {
  const [p] = await tx.select().from(payments).where(eq(payments.id, paymentId)).for("update");
  if (!p) throw notFound("Payment not found");
  return p;
}

async function paymentChannel(tx: Executor, p: PaymentRow): Promise<ChannelRow> {
  const [c] = p.channelId ? await tx.select().from(channels).where(eq(channels.id, p.channelId)) : [];
  if (!c) throw conflict("This payment has no channel to credit");
  return c;
}

/**
 * The price a confirmed subscription carries. A gift keeps the price it was created with; a
 * self subscription or renewal (quantity 1) is charged at today's price, which becomes its price.
 */
function confirmedPrice(p: PaymentRow, s: typeof subscriptions.$inferSelect): number {
  if (p.subscriptionId === null) return s.priceCents;
  if (p.quantity === 1) return p.amountCents;
  // Integer cents only: an uneven split would mean the payment was not quantity × price.
  if (p.amountCents % p.quantity !== 0) throw conflict("This payment does not divide evenly per subscription");
  return p.amountCents / p.quantity;
}

/** The subscriptions a payment paid for: its own (self or renewal) or the gifts it bought. */
const paidSubscriptions = (p: PaymentRow) =>
  p.subscriptionId ? eq(subscriptions.id, p.subscriptionId) : eq(subscriptions.giftPaymentId, p.id);

export interface ConfirmOptions {
  /** When the money arrived (the subscription period starts here). */
  receivedAt: Date;
  now: Date;
  feeCents: number;
  taxCents: number;
  /** Replace the pending reference with the provider's payment id (Stripe: the PaymentIntent). */
  providerRef?: string;
  /** The provider's own period end for subscriptions (Stripe's invoice line), when it has one. */
  periodEnd?: Date | null;
}

/**
 * Confirm a locked `pending` payment in the caller's transaction: status `succeeded`, the
 * `paymentSucceeded` posting (with fee and tax), subscriptions `active` (a renewal continues its
 * period and emits no `channel.subscribe`), the tip, and their events. Manual and provider paths
 * share it; the caller writes its own audit row.
 */
export async function confirmPaymentTx(
  tx: Executor,
  p: PaymentRow,
  o: ConfirmOptions,
): Promise<{ channelId: string; subscribers: string[] }> {
  const { receivedAt, now } = o;
  const c = await paymentChannel(tx, p);
  const [updated] = await tx
    .update(payments)
    .set({
      status: "succeeded",
      succeededAt: receivedAt,
      feeCents: o.feeCents,
      taxCents: o.taxCents,
      ...(o.providerRef ? { providerRef: o.providerRef } : {}),
      updatedAt: now,
    })
    .where(and(eq(payments.id, p.id), eq(payments.status, "pending")))
    .returning({ id: payments.id });
  if (!updated) throw conflict("This payment is no longer pending");

  const { cut } = await loadMoneySettings(tx);
  await post(
    tx,
    paymentSucceeded({
      paymentId: p.id,
      paymentKind: p.kind === "tip" ? "tip" : "subscription",
      provider: p.provider,
      settlement: "cash",
      creatorUserId: c.ownerId,
      grossCents: p.amountCents,
      taxCents: o.taxCents,
      feeCents: o.feeCents,
      currency: p.currency,
      cut,
      occurredAt: receivedAt,
    }),
  );

  const subscribers: string[] = [];
  if (p.kind === "subscription") {
    const gift = p.subscriptionId === null;
    if (gift && p.tier !== null) {
      await emit(
        tx,
        "channel.subscription.gift",
        c.id,
        {
          ...broadcasterFields(c),
          ...((await userEventFields(tx, p.userId)) ?? { user_id: null, user_login: null, user_name: null }),
          total: p.quantity,
          tier: tierCode(p.tier),
          is_anonymous: false,
        },
        now,
      );
    }
    const subs = await tx
      .select()
      .from(subscriptions)
      .where(and(paidSubscriptions(p), inArray(subscriptions.status, ["incomplete", "past_due"])))
      .for("update");
    for (const s of subs) {
      const period = confirmedPeriod(s, receivedAt);
      const [activated] = await tx
        .update(subscriptions)
        .set({
          status: "active",
          currentPeriodStart: period.start,
          currentPeriodEnd: o.periodEnd && o.periodEnd > period.start ? o.periodEnd : period.end,
          priceCents: confirmedPrice(p, s),
          currency: p.currency,
          updatedAt: now,
        })
        .where(and(eq(subscriptions.id, s.id), eq(subscriptions.status, s.status)))
        .returning();
      if (!activated) continue;
      subscribers.push(activated.subscriberId);
      if (period.renewal) continue;
      const user = await userEventFields(tx, activated.subscriberId);
      if (user)
        await emit(
          tx,
          "channel.subscribe",
          c.id,
          { ...broadcasterFields(c), ...user, tier: tierCode(activated.tier), is_gift: gift },
          now,
        );
    }
  } else if (p.tipId) {
    const [tip] = await tx
      .update(tips)
      .set({ status: "succeeded" })
      .where(and(eq(tips.id, p.tipId), eq(tips.status, "pending")))
      .returning();
    if (tip) {
      const from = tip.anonymous ? null : await userEventFields(tx, tip.fromUserId);
      await emit(
        tx,
        "channel.tip",
        c.id,
        {
          ...broadcasterFields(c),
          ...(from ?? { user_id: null, user_login: null, user_name: null }),
          is_anonymous: tip.anonymous || from === null,
          amount: { value: tip.amountCents, decimal_places: minorUnits(tip.currency), currency: tip.currency },
          message: tip.message,
        },
        now,
      );
    }
  }

  return { channelId: c.id, subscribers };
}

export interface ReverseOptions {
  kind: "refund" | "chargeback";
  amountCents: number;
  /** Treasurer's words (manual) or null (provider events). Never goes to the ledger. */
  reason: string | null;
  /** The provider's refund or dispute id (Stripe); null for manual. */
  providerRef: string | null;
  /** Chargebacks: `lost` (manual, clawed back for good) or `open` (Stripe, still contested). */
  disputeStatus: "closed" | "lost" | "open";
  disputeFeeCents?: number;
  now: Date;
}

/**
 * Refund or charge back a locked payment in the caller's transaction: `disputes` row,
 * `postReversal`, payment and tip status, and the subscriptions it paid for end when the outcome
 * says so. Returns the dispute id and the subscribers whose chat badge must be refreshed.
 */
export async function reversePaymentTx(
  tx: Executor,
  p: PaymentRow,
  o: ReverseOptions,
): Promise<{ disputeId: string; channelId: string; ended: string[]; status: PaymentRow["status"] }> {
  const outcome = disputeOutcome(o.kind, p, o.amountCents);
  if (!outcome.ok) throw outcome.code === "CONFLICT" ? conflict(outcome.reason) : badRequest(outcome.reason);
  const c = await paymentChannel(tx, p);
  const disputeId = uuidv7();
  await tx.insert(disputes).values({
    id: disputeId,
    paymentId: p.id,
    kind: o.kind,
    status: o.kind === "refund" ? "closed" : o.disputeStatus,
    amountCents: o.amountCents,
    providerRef: o.providerRef,
    reason: o.reason,
    resolvedAt: o.disputeStatus === "open" ? null : o.now,
  });
  try {
    // The ledger reverses with the cut recorded on the original posting, not today's.
    await postReversal(tx, {
      kind: o.kind,
      disputeId,
      paymentId: p.id,
      amountCents: o.amountCents,
      occurredAt: o.now,
      ...(o.kind === "chargeback" && o.disputeFeeCents ? { disputeFeeCents: o.disputeFeeCents } : {}),
    });
  } catch (err) {
    if (err instanceof ReversalExceedsPaymentError) throw badRequest("That is more than is left to reverse");
    if (err instanceof PaymentNotFoundError) throw conflict("This payment was never posted to the ledger");
    throw err;
  }
  await tx
    .update(payments)
    .set({ status: outcome.status, refundedCents: outcome.refundedCents, updatedAt: o.now })
    .where(eq(payments.id, p.id));
  if (p.tipId) await tx.update(tips).set({ status: outcome.status }).where(eq(tips.id, p.tipId));
  const ended = outcome.endsSubscriptions ? await endSubscriptions(tx, c, paidSubscriptions(p), o.now) : [];
  return { disputeId, channelId: c.id, ended, status: outcome.status };
}

function dispute(kind: "refund" | "chargeback") {
  const procedure = kind === "refund" ? os.money.treasurer.refund : os.money.treasurer.chargeback;
  return procedure.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const reason = input.reason.trim();
    const now = deps.now();
    const [current] = await deps.db.select().from(payments).where(eq(payments.id, input.paymentId));
    if (!current) throw notFound("Payment not found");
    if (current.provider !== "manual") {
      // Card payments: disputes come from the provider; a refund is asked of it and posted when
      // its refund event arrives (stripe-events.ts), so the ledger follows what the provider did.
      if (kind === "chargeback") throw conflict("Chargebacks on card payments arrive from the payment provider");
      const adapter = createAdapter(deps.env);
      if (adapter.provider !== current.provider || !adapter.refund)
        throw precondition("payment_provider", "This instance cannot refund through that payment provider");
      const refund = adapter.refund.bind(adapter);
      await deps.db.transaction(async (tx) => {
        // Row lock: two treasurers (or a double click) cannot both pass the pending check.
        const p = await lockedPayment(tx, input.paymentId);
        const outcome = disputeOutcome(kind, p, input.amountCents);
        if (!outcome.ok) throw outcome.code === "CONFLICT" ? conflict(outcome.reason) : badRequest(outcome.reason);
        // One request at a time: until Stripe's charge.refunded posts the last one, refunded_cents
        // (and so the rest and the idempotency key) would be stale.
        const [asked] = await tx
          .select({ n: count() })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.action, "payment.refund_requested"),
              eq(auditLog.subjectType, "payment"),
              eq(auditLog.subjectId, p.id),
            ),
          );
        const [posted] = await tx
          .select({ n: count() })
          .from(disputes)
          .where(and(eq(disputes.paymentId, p.id), eq(disputes.kind, "refund")));
        if ((asked?.n ?? 0) > (posted?.n ?? 0))
          throw conflict("An earlier refund of this payment is still waiting for the payment provider");
        const requested = await refund({
          paymentId: p.id,
          providerRef: p.providerRef,
          amountCents: input.amountCents,
          idempotencyKey: `refund-${p.id}-${p.refundedCents}-${input.amountCents}`,
        });
        await audit(tx, {
          actorType: ACTOR,
          actorId: caller.user.id,
          action: "payment.refund_requested",
          subjectType: "payment",
          subjectId: p.id,
          channelId: p.channelId,
          reason,
          details: { amountCents: input.amountCents, provider: p.provider, refundRef: requested.providerRef },
        });
      });
      return { ok: true as const };
    }
    const done = await deps.db.transaction(async (tx) => {
      // Row lock: a refund racing a chargeback (or itself) waits here and re-reads the rest.
      const p = await lockedPayment(tx, input.paymentId);
      const r = await reversePaymentTx(tx, p, {
        kind,
        amountCents: input.amountCents,
        reason,
        providerRef: null,
        disputeStatus: kind === "refund" ? "closed" : "lost",
        now,
      });
      await audit(tx, {
        actorType: ACTOR,
        actorId: caller.user.id,
        action: kind === "refund" ? "payment.refund" : "payment.chargeback",
        subjectType: "payment",
        subjectId: p.id,
        channelId: r.channelId,
        reason,
        details: { disputeId: r.disputeId, amountCents: input.amountCents, status: r.status, kind: p.kind },
      });
      return { channelId: r.channelId, ended: r.ended };
    });
    await invalidateSubscribers(deps, done.channelId, done.ended);
    return { ok: true as const };
  });
}

export const treasurerCheckoutHandlers = {
  payments: os.money.treasurer.payments.handler(async ({ context, input }) => {
    const { deps } = context;
    let where;
    if (input.reference !== undefined) {
      const ref = normalizeManualReference(input.reference) ?? input.reference.trim();
      if (!ref) return { items: [], nextCursor: null };
      where = eq(payments.providerRef, ref);
    } else {
      const cur = decodeCursor(input.cursor, isKeyCursor);
      where = and(eq(payments.status, input.status), cur ? lt(payments.id, cur.id) : undefined);
    }
    const rows = await deps.db
      .select({ p: payments, slug: channels.slug })
      .from(payments)
      .leftJoin(channels, eq(channels.id, payments.channelId))
      .where(where)
      .orderBy(desc(payments.id))
      .limit(input.limit + 1);
    const people = await loadUsersPublic(
      deps,
      rows.flatMap((r) => (r.p.userId ? [r.p.userId] : [])),
    );
    return pageOf(
      rows,
      input.limit,
      ({ p, slug }) => ({
        paymentId: p.id,
        reference: p.providerRef,
        kind: p.kind,
        status: p.status,
        amount: { cents: p.amountCents, currency: p.currency },
        refunded: { cents: p.refundedCents, currency: p.currency },
        tier: p.tier,
        quantity: p.quantity,
        user: p.userId ? (people.get(p.userId) ?? null) : null,
        channelSlug: slug,
        createdAt: iso(p.createdAt),
        succeededAt: isoOrNull(p.succeededAt),
        expiresAt: isoOrNull(p.expiresAt),
      }),
      (last) => encodeCursor({ t: iso(last.p.createdAt), id: last.p.id }),
    );
  }),

  confirm: os.money.treasurer.confirm.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const receivedAt = new Date(input.receivedAt);
    const now = deps.now();
    if (receivedAt.getTime() > now.getTime()) throw badRequest("The payment cannot be received in the future");
    const note = input.note.trim();
    const done = await deps.db.transaction(async (tx) => {
      const p = await lockedPayment(tx, input.paymentId);
      if (p.status !== "pending") throw conflict(`This payment is ${p.status}, not pending`);
      if (p.kind === "membership_share") throw conflict("Member shares are not confirmed here");
      if (p.provider !== "manual") throw conflict("Card payments are confirmed by the payment provider");
      // Backdating before checkout would skip the creator hold and could start an already-ended period.
      if (receivedAt.getTime() < p.createdAt.getTime() - CLOCK_SKEW_MS)
        throw badRequest("The payment cannot be received before its checkout was created");
      const r = await confirmPaymentTx(tx, p, { receivedAt, now, feeCents: 0, taxCents: 0 });
      await audit(tx, {
        actorType: ACTOR,
        actorId: caller.user.id,
        action: "payment.confirm",
        subjectType: "payment",
        subjectId: p.id,
        channelId: r.channelId,
        reason: note,
        details: { kind: p.kind, amountCents: p.amountCents, quantity: p.quantity, receivedAt: iso(receivedAt) },
      });
      return r;
    });
    await invalidateSubscribers(deps, done.channelId, done.subscribers);
    return { ok: true as const };
  }),

  refund: dispute("refund"),
  chargeback: dispute("chargeback"),

  setPayoutAccount: os.money.treasurer.setPayoutAccount.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const reference = input.reference.trim();
    if (input.payoutsEnabled && !reference) throw badRequest("Enabling payouts needs an account reference");
    const now = deps.now();
    await deps.db.transaction(async (tx) => {
      const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.username, input.username));
      if (!u) throw notFound("No user with that name");
      const { payoutRules } = await loadMoneySettings(tx);
      // A payout batch running now would otherwise read the old account and hold a fresh payout.
      await lockPayoutBatch(tx, payoutRules.currency);
      const [written] = await tx
        .insert(payoutAccounts)
        .values({
          userId: u.id,
          provider: "manual",
          providerAccountId: reference,
          payoutsEnabled: input.payoutsEnabled,
        })
        .onConflictDoUpdate({
          target: payoutAccounts.userId,
          set: {
            provider: "manual",
            providerAccountId: reference,
            payoutsEnabled: input.payoutsEnabled,
            updatedAt: now,
          },
          // A provider-managed account (e.g. Stripe Connect) is owned by its adapter, not typed in here.
          setWhere: eq(payoutAccounts.provider, "manual"),
        })
        .returning({ userId: payoutAccounts.userId });
      if (!written) throw conflict("This creator's payout account is managed by a payment provider");
      const released = input.payoutsEnabled
        ? await tx
            .update(payouts)
            .set({ status: "pending", holdReason: null })
            .where(
              and(
                eq(payouts.userId, u.id),
                eq(payouts.status, "held"),
                eq(payouts.holdReason, PAYOUT_ACCOUNT_NOT_READY),
              ),
            )
            .returning({ id: payouts.id })
        : [];
      await audit(tx, {
        actorType: ACTOR,
        actorId: caller.user.id,
        action: "payout_account.set",
        subjectType: "user",
        subjectId: u.id,
        details: { provider: "manual", payoutsEnabled: input.payoutsEnabled, payoutsReleased: released.length },
      });
    });
    return { ok: true as const };
  }),
};
