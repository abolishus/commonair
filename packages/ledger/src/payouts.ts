// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { and, eq, sql } from "drizzle-orm";
import { type Executor, schema } from "@commonair/db";
import { assertCurrency, parseStoredCode } from "./accounts.ts";
import { assertCents } from "./math.ts";
import { post } from "./poster.ts";
import { lockCreator } from "./holds.ts";
import { creatorBalances } from "./queries.ts";
import { payout } from "./rules.ts";

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
  /** Rows created as `held` (payout account missing or not enabled). */
  held: number;
  totalCents: number;
  carriedOver: CreatorAvailable[];
}

export const PAYOUT_ACCOUNT_NOT_READY = "payout_account_not_ready";

/**
 * Compute the payout batch for the period and write one `payouts` row per creator whose
 * available balance (released earnings − clawback receivable − payouts already scheduled but
 * not yet posted) reaches the minimum. Idempotent per (user, periodStart): a re-run creates
 * nothing new. Concurrent runs are serialized by an advisory lock.
 */
export async function runPayoutBatch(
  db: Executor,
  opts: { periodStart: Date; periodEnd: Date; currency: string; minimumCents: number },
): Promise<PayoutRunResult> {
  assertCurrency(opts.currency);
  if (!(opts.periodStart < opts.periodEnd)) throw new RangeError("periodStart must be before periodEnd");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ledger:payout-batch:${opts.currency}`}))`);
    const suffix = `@${opts.currency}`;
    const balances = await tx.execute<{ code: string; total: string }>(sql`
      select a.code, coalesce(sum(e.amount_cents), 0)::text as total
      from ledger_accounts a left join ledger_entries e on e.account_id = a.id
      where a.currency = ${opts.currency}
        and (a.code like 'liability:creator:%' or a.code like 'asset:receivable:creator:%')
      group by a.code`);
    const pending = await tx.execute<{ user_id: string; total: string }>(sql`
      select user_id, sum(amount_cents)::text as total from payouts
      where currency = ${opts.currency} and ledger_transaction_id is null
        and status in ('pending', 'scheduled', 'held')
      group by user_id`);

    const available = new Map<string, number>();
    for (const b of balances) {
      if (!b.code.endsWith(suffix)) continue;
      const code = parseStoredCode(b.code).code;
      const userId = code.slice(code.lastIndexOf(":") + 1);
      const raw = Number(b.total);
      // Liability is credit-normal (owed = −raw); the receivable reduces what can be paid (+raw).
      available.set(userId, (available.get(userId) ?? 0) - raw);
    }
    for (const p of pending) {
      if (available.has(p.user_id)) available.set(p.user_id, (available.get(p.user_id) ?? 0) - Number(p.total));
    }

    const batch = computePayoutBatch(
      [...available].map(([userId, availableCents]) => ({ userId, availableCents })),
      opts.minimumCents,
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

    const result: PayoutRunResult = { created: 0, held: 0, totalCents: 0, carriedOver: batch.carriedOver };
    for (const p of batch.payouts) {
      const acct = accountsByUser.get(p.userId);
      const ready = acct?.enabled === true;
      const [row] = await tx
        .insert(schema.payouts)
        .values({
          userId: p.userId,
          periodStart: opts.periodStart,
          periodEnd: opts.periodEnd,
          amountCents: p.amountCents,
          currency: opts.currency,
          status: ready ? "pending" : "held",
          provider: acct?.provider ?? "manual",
          holdReason: ready ? null : PAYOUT_ACCOUNT_NOT_READY,
        })
        .onConflictDoNothing({ target: [schema.payouts.userId, schema.payouts.periodStart] })
        .returning({ id: schema.payouts.id });
      if (!row) continue;
      if (ready) result.created += 1;
      else result.held += 1;
      result.totalCents += p.amountCents;
    }
    return result;
  });
}

export class PayoutStateError extends Error {
  override name = "PayoutStateError";
}

/**
 * Post a scheduled payout to the ledger once the money was sent, and mark the row paid.
 * Idempotent: a payout already posted returns its transaction. Throws
 * `InsufficientBalanceError` if a clawback since the batch left too little available.
 */
export async function postPayout(
  db: Executor,
  opts: {
    payoutId: string;
    paidAt: Date;
    providerRef?: string | null;
    minimumCents: number;
    closingAccount?: boolean;
  },
): Promise<{ transactionId: string; created: boolean }> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(schema.payouts).where(eq(schema.payouts.id, opts.payoutId)).for("update");
    if (!row) throw new PayoutStateError(`payout ${opts.payoutId} not found`);
    if (row.ledgerTransactionId) return { transactionId: row.ledgerTransactionId, created: false };
    if (row.status !== "pending" && row.status !== "scheduled") {
      throw new PayoutStateError(`payout ${opts.payoutId} is ${row.status}`);
    }
    await lockCreator(tx, row.userId);
    const b = await creatorBalances(tx, row.userId, row.currency);
    const r = await post(
      tx,
      payout({
        payoutId: row.id,
        userId: row.userId,
        provider: row.provider,
        amountCents: row.amountCents,
        currency: row.currency,
        occurredAt: opts.paidAt,
        balances: { liabilityCents: b.liabilityCents, receivableCents: b.receivableCents },
        minimumCents: opts.minimumCents,
        closingAccount: opts.closingAccount ?? false,
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
      .where(and(eq(schema.payouts.id, row.id), sql`${schema.payouts.ledgerTransactionId} is null`));
    return r;
  });
}
