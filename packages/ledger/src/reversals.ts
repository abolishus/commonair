// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Refunds, chargebacks and won chargebacks posted from the ledger's own record of the
 * payment. Everything a reversal depends on (the original split, what was already reversed,
 * the creator's balances) is read inside one transaction under the payment and creator locks,
 * so concurrent disputes can never reverse more than was paid.
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type Executor, schema } from "@commonair/db";
import { lockCreator, lockPayment } from "./locks.ts";
import { IdempotencyConflictError, type PostResult, post } from "./poster.ts";
import { creatorBalances, holdLots } from "./queries.ts";
import { chargeback, chargebackReversal, refund } from "./rules.ts";

export class PaymentNotFoundError extends Error {
  override name = "PaymentNotFoundError";
}
export class ReversalExceedsPaymentError extends Error {
  override name = "ReversalExceedsPaymentError";
}

const Settlement = z.enum(["cash", "receivable"]);

/** Metadata written by `paymentSucceeded`. */
const PaymentMeta = z.object({
  creatorUserId: z.uuid(),
  provider: z.string(),
  settlement: Settlement,
  revenueGrossCents: z.number().int().positive(),
  taxCents: z.number().int().nonnegative(),
  streamerShare: z.number(),
  coopShare: z.number(),
});

/** Metadata written by `chargeback`. */
const ChargebackMeta = z.object({
  creatorUserId: z.uuid(),
  provider: z.string(),
  settlement: Settlement,
  revenueGrossCents: z.number().int().negative(),
  taxCents: z.number().int().nonpositive(),
  creatorCents: z.number().int().nonpositive(),
  coopCents: z.number().int().nonpositive(),
});

async function existing(tx: Executor, key: string, refId: string): Promise<PostResult | null> {
  const [row] = await tx
    .select({ id: schema.ledgerTransactions.id, refId: schema.ledgerTransactions.refId })
    .from(schema.ledgerTransactions)
    .where(eq(schema.ledgerTransactions.idempotencyKey, key));
  if (!row) return null;
  if (row.refId !== refId) throw new IdempotencyConflictError(`${key} was already posted for another payment`);
  return { transactionId: row.id, created: false };
}

async function transactionCurrency(tx: Executor, transactionId: string): Promise<string> {
  const [row] = await tx
    .select({ currency: schema.ledgerEntries.currency })
    .from(schema.ledgerEntries)
    .where(eq(schema.ledgerEntries.transactionId, transactionId))
    .limit(1);
  if (!row) throw new Error(`ledger transaction ${transactionId} has no entries`);
  return row.currency;
}

/** Net amount already reversed for a payment: refunds + chargebacks − won chargebacks. */
async function alreadyReversed(tx: Executor, paymentId: string): Promise<number> {
  const rows = await tx.execute<{ total: string }>(sql`
    select coalesce(sum((metadata->>'revenueGrossCents')::bigint), 0)::text as total
    from ledger_transactions
    where ref_type = 'payment' and ref_id = ${paymentId}
      and kind in ('refund', 'chargeback', 'chargeback_reversal')`);
  const sum = Number(rows[0]?.total ?? 0);
  return sum === 0 ? 0 : -sum;
}

export interface PostReversalInput {
  kind: "refund" | "chargeback";
  /** The dispute row; keys the posting (`refund:<id>` / `chargeback:<id>`). */
  disputeId: string;
  paymentId: string;
  amountCents: number;
  occurredAt: Date;
  /** Chargebacks only. */
  disputeFeeCents?: number;
}

/**
 * Post a refund or chargeback for a payment already in the ledger. Idempotent per dispute.
 * Throws `ReversalExceedsPaymentError` if the payment has not that much left to reverse.
 */
export async function postReversal(db: Executor, i: PostReversalInput): Promise<PostResult> {
  return db.transaction(async (tx) => {
    await lockPayment(tx, i.paymentId);
    const replay = await existing(tx, `${i.kind}:${i.disputeId}`, i.paymentId);
    if (replay) return replay;

    const [original] = await tx
      .select({ id: schema.ledgerTransactions.id, metadata: schema.ledgerTransactions.metadata })
      .from(schema.ledgerTransactions)
      .where(eq(schema.ledgerTransactions.idempotencyKey, `payment:${i.paymentId}`));
    if (!original) throw new PaymentNotFoundError(`payment ${i.paymentId} is not in the ledger`);
    const meta = PaymentMeta.parse(original.metadata);
    const currency = await transactionCurrency(tx, original.id);
    const already = await alreadyReversed(tx, i.paymentId);
    if (already + i.amountCents > meta.revenueGrossCents) {
      throw new ReversalExceedsPaymentError(
        `payment ${i.paymentId} has ${meta.revenueGrossCents - already} cents left to reverse, not ${i.amountCents}`,
      );
    }

    await lockCreator(tx, meta.creatorUserId);
    const balances = await creatorBalances(tx, meta.creatorUserId, currency);
    const lots = await holdLots(tx, meta.creatorUserId, currency);
    const input = {
      disputeId: i.disputeId,
      paymentId: i.paymentId,
      originalTransactionId: original.id,
      provider: meta.provider,
      settlement: meta.settlement,
      creatorUserId: meta.creatorUserId,
      currency,
      occurredAt: i.occurredAt,
      original: { grossCents: meta.revenueGrossCents, taxCents: meta.taxCents },
      cut: { streamerShare: meta.streamerShare, coopShare: meta.coopShare },
      alreadyReversedCents: already,
      amountCents: i.amountCents,
      balances: { liabilityCents: balances.liabilityCents, holdLots: lots },
    };
    const posting =
      i.kind === "refund" ? refund(input) : chargeback({ ...input, disputeFeeCents: i.disputeFeeCents ?? 0 });
    return post(tx, posting);
  });
}

/**
 * Reverse a chargeback the co-op won. Idempotent per dispute; refuses if the chargeback was
 * never posted.
 */
export async function postChargebackReversal(
  db: Executor,
  i: { disputeId: string; occurredAt: Date; feeRefundCents?: number },
): Promise<PostResult> {
  return db.transaction(async (tx) => {
    const [cb] = await tx
      .select({
        id: schema.ledgerTransactions.id,
        refId: schema.ledgerTransactions.refId,
        metadata: schema.ledgerTransactions.metadata,
      })
      .from(schema.ledgerTransactions)
      .where(
        and(
          eq(schema.ledgerTransactions.idempotencyKey, `chargeback:${i.disputeId}`),
          eq(schema.ledgerTransactions.kind, "chargeback"),
        ),
      );
    if (!cb?.refId) throw new PaymentNotFoundError(`no chargeback posted for dispute ${i.disputeId}`);
    const paymentId = cb.refId;
    await lockPayment(tx, paymentId);
    const replay = await existing(tx, `chargeback-reversal:${i.disputeId}`, paymentId);
    if (replay) return replay;
    const meta = ChargebackMeta.parse(cb.metadata);
    const currency = await transactionCurrency(tx, cb.id);
    await lockCreator(tx, meta.creatorUserId);
    const balances = await creatorBalances(tx, meta.creatorUserId, currency);
    return post(
      tx,
      chargebackReversal({
        disputeId: i.disputeId,
        paymentId,
        creatorUserId: meta.creatorUserId,
        provider: meta.provider,
        settlement: meta.settlement,
        currency,
        occurredAt: i.occurredAt,
        chargebackTransactionId: cb.id,
        chargeback: {
          amountCents: -meta.revenueGrossCents,
          taxCents: Math.abs(meta.taxCents),
          creatorCents: Math.abs(meta.creatorCents),
          coopCents: Math.abs(meta.coopCents),
        },
        receivableCents: balances.receivableCents,
        feeRefundCents: i.feeRefundCents ?? 0,
      }),
    );
  });
}
