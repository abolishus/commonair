// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The treasurer's payment actions (manual adapter): list, confirm, refund, chargeback and payout
 * accounts. Each runs in one transaction with its ledger posting, outbox events and audit row;
 * state changes are compare-and-set or row-locked so a repeat or a race cannot double-apply.
 */
import { and, desc, eq, inArray, lt } from "drizzle-orm";
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
import { normalizeManualReference } from "@commonair/payments";
import { audit } from "../events/audit.ts";
import { broadcasterFields, emit } from "../events/outbox.ts";
import { decodeCursor, encodeCursor, isKeyCursor, pageOf } from "../lib/cursor.ts";
import { iso, isoOrNull, loadUsersPublic } from "../lib/dto.ts";
import { badRequest, conflict, notFound } from "../lib/errors.ts";
import { os, requireCaller } from "../lib/orpc.ts";
import { confirmedPeriod, disputeOutcome, tierCode } from "./checkout-rules.ts";
import { endSubscriptions, invalidateSubscribers, userEventFields } from "./checkout-shared.ts";

const { payments, subscriptions, tips, channels, disputes, payoutAccounts, payouts, users } = schema;
type PaymentRow = typeof payments.$inferSelect;
type ChannelRow = typeof channels.$inferSelect;

/** The treasurer is platform staff; audit rows name them by id. */
const ACTOR = "admin" as const;

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

/** The subscriptions a payment paid for: its own (self or renewal) or the gifts it bought. */
const paidSubscriptions = (p: PaymentRow) =>
  p.subscriptionId ? eq(subscriptions.id, p.subscriptionId) : eq(subscriptions.giftPaymentId, p.id);

function dispute(kind: "refund" | "chargeback") {
  const procedure = kind === "refund" ? os.money.treasurer.refund : os.money.treasurer.chargeback;
  return procedure.handler(async ({ context, input }) => {
    const { deps } = context;
    const caller = requireCaller(context);
    const reason = input.reason.trim();
    const now = deps.now();
    const done = await deps.db.transaction(async (tx) => {
      // Row lock: a refund racing a chargeback (or itself) waits here and re-reads the rest.
      const p = await lockedPayment(tx, input.paymentId);
      const outcome = disputeOutcome(kind, p, input.amountCents);
      if (!outcome.ok) throw outcome.code === "CONFLICT" ? conflict(outcome.reason) : badRequest(outcome.reason);
      const c = await paymentChannel(tx, p);
      const disputeId = uuidv7();
      await tx.insert(disputes).values({
        id: disputeId,
        paymentId: p.id,
        kind,
        status: kind === "refund" ? "closed" : "lost",
        amountCents: input.amountCents,
        reason,
        resolvedAt: now,
      });
      try {
        // The ledger reverses with the cut recorded on the original posting, not today's.
        await postReversal(tx, { kind, disputeId, paymentId: p.id, amountCents: input.amountCents, occurredAt: now });
      } catch (err) {
        if (err instanceof ReversalExceedsPaymentError) throw badRequest("That is more than is left to reverse");
        if (err instanceof PaymentNotFoundError) throw conflict("This payment was never posted to the ledger");
        throw err;
      }
      await tx
        .update(payments)
        .set({ status: outcome.status, refundedCents: outcome.refundedCents, updatedAt: now })
        .where(eq(payments.id, p.id));
      if (p.tipId) await tx.update(tips).set({ status: outcome.status }).where(eq(tips.id, p.tipId));
      const ended = outcome.endsSubscriptions ? await endSubscriptions(tx, c, paidSubscriptions(p), now) : [];
      await audit(tx, {
        actorType: ACTOR,
        actorId: caller.user.id,
        action: kind === "refund" ? "payment.refund" : "payment.chargeback",
        subjectType: "payment",
        subjectId: p.id,
        channelId: c.id,
        reason,
        details: { disputeId, amountCents: input.amountCents, status: outcome.status, kind: p.kind },
      });
      return { channelId: c.id, ended };
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
      const c = await paymentChannel(tx, p);
      const [updated] = await tx
        .update(payments)
        .set({ status: "succeeded", succeededAt: receivedAt, updatedAt: now })
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
          taxCents: 0,
          feeCents: 0,
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
              currentPeriodEnd: period.end,
              // A renewal is charged at today's price; that becomes the subscription's price.
              priceCents: p.amountCents / p.quantity,
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
              // decimal_places is fixed at 2 by the contract; the instance currency default (usd) has 2.
              amount: { value: tip.amountCents, decimal_places: 2, currency: tip.currency },
              message: tip.message,
            },
            now,
          );
        }
      }

      await audit(tx, {
        actorType: ACTOR,
        actorId: caller.user.id,
        action: "payment.confirm",
        subjectType: "payment",
        subjectId: p.id,
        channelId: c.id,
        reason: note,
        details: { kind: p.kind, amountCents: p.amountCents, quantity: p.quantity, receivedAt: iso(receivedAt) },
      });
      return { channelId: c.id, subscribers };
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
    const now = deps.now();
    await deps.db.transaction(async (tx) => {
      const [u] = await tx.select({ id: users.id }).from(users).where(eq(users.username, input.username));
      if (!u) throw notFound("No user with that name");
      const { payoutRules } = await loadMoneySettings(tx);
      // A payout batch running now would otherwise read the old account and hold a fresh payout.
      await lockPayoutBatch(tx, payoutRules.currency);
      await tx
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
        });
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
