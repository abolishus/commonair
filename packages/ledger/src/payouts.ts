// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Payout batch and lifecycle. The batch reserves each payout in the ledger (creator liability
 * → payout clearing) in the same transaction that writes the `payouts` row, so the reserved
 * money is no longer "available" to anything else: a later batch cannot pay it twice, and a
 * later chargeback cannot draw on it. Sending moves clearing → cash and is never refused;
 * a failed payout cancels the reservation.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { type Executor, schema } from "@commonair/db";
import { assertCurrency, parseStoredCode } from "./accounts.ts";
import { lockCreator, lockPayoutBatch } from "./locks.ts";
import { assertCents } from "./math.ts";
import { type PostResult, post } from "./poster.ts";
import { creatorBalances } from "./queries.ts";
import { payoutCancel, payoutReserve, payoutSent } from "./rules.ts";

export interface CreatorAvailable {
  userId: string;
  availableCents: number;
}

export interface PayoutBatch {
  payouts: { userId: string; amountCents: number }[];
  /** Below the minimum (or nothing available): carried to the next period. */
  carriedOver: CreatorAvailable[];
}

/** Pure: who gets paid this period. Ordered by user id for determinism. */
export function computePayoutBatch(creators: readonly CreatorAvailable[], minimumCents: number): PayoutBatch {
  assertCents("minimum", minimumCents);
  const sorted = [...creators].sort((a, b) => a.userId.localeCompare(b.userId));
  const batch: PayoutBatch = { payouts: [], carriedOver: [] };
  for (const c of sorted) {
    if (c.availableCents > 0 && c.availableCents >= minimumCents) {
      batch.payouts.push({ userId: c.userId, amountCents: c.availableCents });
    } else {
      batch.carriedOver.push(c);
    }
  }
  return batch;
}

export interface PayoutRunResult {
  /** Rows created as `pending` (payout account ready). */
  created: number;
  /** Rows created as `held` (payout account missing or not enabled); the money is reserved. */
  held: number;
  totalCents: number;
  carriedOver: CreatorAvailable[];
}

export const PAYOUT_ACCOUNT_NOT_READY = "payout_account_not_ready";

/** Every creator's available balance (liability − receivable) in one statement. */
async function availableByCreator(tx: Executor, currency: string): Promise<CreatorAvailable[]> {
  const rows = await tx.execute<{ code: string; total: string }>(sql`
    select a.code, coalesce(sum(e.amount_cents), 0)::text as total
    from ledger_accounts a left join ledger_entries e on e.account_id = a.id
    where a.currency = ${currency}
      and (a.code like 'liability:creator:%' or a.code like 'asset:receivable:creator:%')
    group by a.code`);
  const available = new Map<string, number>();
  for (const b of rows) {
    const code = parseStoredCode(b.code).code;
    const userId = code.slice(code.lastIndexOf(":") + 1);
    // Liability is credit-normal (owed = −raw); the receivable reduces what can be paid (+raw).
    available.set(userId, (available.get(userId) ?? 0) - Number(b.total));
  }
  return [...available].map(([userId, availableCents]) => ({ userId, availableCents }));
}

/**
 * Compute the payout batch for the period: every creator whose available balance reaches the
 * minimum gets a `payouts` row and a ledger reservation of that amount, atomically.
 * Idempotent per (user, periodStart). Each creator's balance is re-read under the creator lock
 * right before reserving, so concurrent reversals and releases are accounted for.
 */
export async function runPayoutBatch(
  db: Executor,
  opts: { periodStart: Date; periodEnd: Date; currency: string; minimumCents: number },
): Promise<PayoutRunResult> {
  assertCurrency(opts.currency);
  assertCents("minimum", opts.minimumCents);
  if (!(opts.periodStart < opts.periodEnd)) throw new RangeError("periodStart must be before periodEnd");
  return db.transaction(async (tx) => {
    await lockPayoutBatch(tx, opts.currency);
    const candidates = computePayoutBatch(await availableByCreator(tx, opts.currency), opts.minimumCents);
    const already = new Set(
      (
        await tx
          .select({ userId: schema.payouts.userId })
          .from(schema.payouts)
          .where(eq(schema.payouts.periodStart, opts.periodStart))
      ).map((r) => r.userId),
    );
    const accountsByUser = new Map(
      (
        await tx
          .select({
            userId: schema.payoutAccounts.userId,
            provider: schema.payoutAccounts.provider,
            enabled: schema.payoutAccounts.payoutsEnabled,
          })
          .from(schema.payoutAccounts)
      ).map((a) => [a.userId, a]),
    );

    const result: PayoutRunResult = { created: 0, held: 0, totalCents: 0, carriedOver: candidates.carriedOver };
    for (const c of candidates.payouts) {
      if (already.has(c.userId)) continue;
      await lockCreator(tx, c.userId);
      const b = await creatorBalances(tx, c.userId, opts.currency);
      if (b.availableCents <= 0 || b.availableCents < opts.minimumCents) {
        result.carriedOver.push({ userId: c.userId, availableCents: b.availableCents });
        continue;
      }
      const acct = accountsByUser.get(c.userId);
      const ready = acct?.enabled === true;
      const [row] = await tx
        .insert(schema.payouts)
        .values({
          userId: c.userId,
          periodStart: opts.periodStart,
          periodEnd: opts.periodEnd,
          amountCents: b.availableCents,
          currency: opts.currency,
          status: ready ? "pending" : "held",
          provider: acct?.provider ?? "manual",
          holdReason: ready ? null : PAYOUT_ACCOUNT_NOT_READY,
        })
        .onConflictDoNothing({ target: [schema.payouts.userId, schema.payouts.periodStart] })
        .returning({ id: schema.payouts.id });
      if (!row) continue;
      await post(
        tx,
        payoutReserve({
          payoutId: row.id,
          userId: c.userId,
          amountCents: b.availableCents,
          currency: opts.currency,
          occurredAt: opts.periodEnd,
          balances: { liabilityCents: b.liabilityCents, receivableCents: b.receivableCents },
          minimumCents: opts.minimumCents,
        }),
      );
      if (ready) result.created += 1;
      else result.held += 1;
      result.totalCents += b.availableCents;
    }
    result.carriedOver.sort((a, b) => a.userId.localeCompare(b.userId));
    return result;
  });
}

export class PayoutStateError extends Error {
  override name = "PayoutStateError";
}

const ReserveMeta = z.object({ amountCents: z.number().int().positive(), receivableNettedCents: z.number().int() });

async function lockedPayout(tx: Executor, payoutId: string) {
  const [peek] = await tx
    .select({ currency: schema.payouts.currency })
    .from(schema.payouts)
    .where(eq(schema.payouts.id, payoutId));
  if (!peek) throw new PayoutStateError(`payout ${payoutId} not found`);
  await lockPayoutBatch(tx, peek.currency);
  const [row] = await tx.select().from(schema.payouts).where(eq(schema.payouts.id, payoutId)).for("update");
  if (!row) throw new PayoutStateError(`payout ${payoutId} not found`);
  const [reservation] = await tx
    .select({ id: schema.ledgerTransactions.id, metadata: schema.ledgerTransactions.metadata })
    .from(schema.ledgerTransactions)
    .where(eq(schema.ledgerTransactions.idempotencyKey, `payout-reserve:${payoutId}`));
  return { row, reservation };
}

/**
 * Record that a payout was sent: post clearing → cash and mark the row paid. Never refused
 * for balance reasons (the money has left). Idempotent.
 */
export async function postPayout(
  db: Executor,
  opts: { payoutId: string; paidAt: Date; providerRef?: string | null },
): Promise<PostResult> {
  return db.transaction(async (tx) => {
    const { row, reservation } = await lockedPayout(tx, opts.payoutId);
    if (row.ledgerTransactionId) return { transactionId: row.ledgerTransactionId, created: false };
    if (row.status !== "pending" && row.status !== "scheduled") {
      throw new PayoutStateError(`payout ${row.id} is ${row.status}`);
    }
    if (!reservation) throw new PayoutStateError(`payout ${row.id} was never reserved in the ledger`);
    const r = await post(
      tx,
      payoutSent({
        payoutId: row.id,
        userId: row.userId,
        provider: row.provider,
        amountCents: row.amountCents,
        currency: row.currency,
        occurredAt: opts.paidAt,
      }),
    );
    await tx
      .update(schema.payouts)
      .set({
        status: "paid",
        paidAt: opts.paidAt,
        providerRef: opts.providerRef ?? row.providerRef,
        ledgerTransactionId: r.transactionId,
      })
      .where(and(eq(schema.payouts.id, row.id), isNull(schema.payouts.ledgerTransactionId)));
    return r;
  });
}

/**
 * A payout failed (or was cancelled) before money left: release the reservation back to the
 * creator's earnings (restoring any netted receivable) and mark the row failed. Idempotent.
 */
export async function cancelPayout(
  db: Executor,
  opts: { payoutId: string; at: Date; reason?: string },
): Promise<PostResult | null> {
  return db.transaction(async (tx) => {
    const { row, reservation } = await lockedPayout(tx, opts.payoutId);
    if (row.status === "paid" || row.ledgerTransactionId) throw new PayoutStateError(`payout ${row.id} was paid`);
    let result: PostResult | null = null;
    if (reservation) {
      const meta = ReserveMeta.parse(reservation.metadata);
      await lockCreator(tx, row.userId);
      result = await post(
        tx,
        payoutCancel({
          payoutId: row.id,
          userId: row.userId,
          amountCents: meta.amountCents,
          receivableNettedCents: meta.receivableNettedCents,
          currency: row.currency,
          occurredAt: opts.at,
        }),
      );
    }
    if (row.status !== "failed") {
      await tx
        .update(schema.payouts)
        .set({ status: "failed", holdReason: opts.reason ?? row.holdReason })
        .where(eq(schema.payouts.id, row.id));
    }
    return result;
  });
}
