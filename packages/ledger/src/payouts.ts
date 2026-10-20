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
import { accounts, assertCurrency, parseStoredCode, storedCode } from "./accounts.ts";
import { lockCreator, lockPayoutBatch } from "./locks.ts";
import { assertCents, negate } from "./math.ts";
import { type PostResult, post } from "./poster.ts";
import { creatorBalances } from "./queries.ts";
import { InsufficientBalanceError, payoutCancel, payoutReserve, payoutSent } from "./rules.ts";

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

export interface PayableBalances {
  /** Released earnings not yet reserved (natural terms: owed). */
  liabilityCents: number;
  /** Clawback shortfall the creator owes. */
  receivableCents: number;
}

/**
 * Creators' liability and receivable counting only postings dated at or before `asOf`, in one
 * statement. All creators in the currency, or just `userId`.
 */
async function payableAsOf(
  tx: Executor,
  currency: string,
  asOf: Date,
  userId?: string,
): Promise<Map<string, PayableBalances>> {
  const owner = userId
    ? sql`and a.code in (${storedCode(accounts.creator(userId), currency)}, ${storedCode(accounts.creatorReceivable(userId), currency)})`
    : sql`and (a.code like 'liability:creator:%' or a.code like 'asset:receivable:creator:%')`;
  const rows = await tx.execute<{ code: string; total: string }>(sql`
    select a.code,
           coalesce(sum(e.amount_cents) filter (where t.occurred_at <= ${asOf.toISOString()}::timestamptz), 0)::text as total
    from ledger_accounts a
    left join ledger_entries e on e.account_id = a.id
    left join ledger_transactions t on t.id = e.transaction_id
    where a.currency = ${currency} ${owner}
    group by a.code`);
  const out = new Map<string, PayableBalances>();
  for (const b of rows) {
    const code = parseStoredCode(b.code).code;
    const id = code.slice(code.lastIndexOf(":") + 1);
    const cur = out.get(id) ?? { liabilityCents: 0, receivableCents: 0 };
    // Liability is credit-normal (owed = −raw); the receivable is debit-normal.
    if (code.startsWith("liability:")) cur.liabilityCents = negate(Number(b.total));
    else cur.receivableCents = Number(b.total);
    out.set(id, cur);
  }
  return out;
}

/**
 * The lowest running available balance (liability − receivable) of one creator at any posting
 * date after `asOf`, counting every posting whatever its date (later reservations, cancels,
 * reversals, releases, and anything dated in the future); null when nothing is dated after it.
 * Postings sharing a timestamp count together.
 */
async function lowestAvailableAfter(
  tx: Executor,
  userId: string,
  currency: string,
  asOf: Date,
): Promise<number | null> {
  const rows = await tx.execute<{ lowest: string | null }>(sql`
    with d as (
      select t.occurred_at as at, -sum(e.amount_cents) as delta
      from ledger_entries e
      join ledger_accounts a on a.id = e.account_id
      join ledger_transactions t on t.id = e.transaction_id
      where a.code in (${storedCode(accounts.creator(userId), currency)}, ${storedCode(accounts.creatorReceivable(userId), currency)})
      group by t.occurred_at
    ), r as (
      select at, sum(delta) over (order by at) as running from d
    )
    select min(running)::text as lowest from r where at > ${asOf.toISOString()}::timestamptz`);
  const v = rows[0]?.lowest;
  return v === null || v === undefined ? null : Number(v);
}

/**
 * What a payout for the period ending at `periodEnd` may reserve: the available balance as of
 * `periodEnd`, capped by what is available now and by the lowest running available balance at
 * any posting date after `periodEnd` (`lowestAfterCents`). The reservation is dated
 * `periodEnd`, so it lowers every later running balance too; the cap keeps all of them from
 * going below zero (a later reversal, or a later period's reservation, may already have drawn
 * on the money). Only the receivable owed by `periodEnd` is netted. Returns the balances to
 * hand `payoutReserve`, shaped so that it reserves exactly `amountCents` and nets exactly
 * `nettedCents`.
 */
export function reservableAt(
  atPeriodEnd: PayableBalances,
  now: PayableBalances,
  lowestAfterCents: number | null = null,
): { amountCents: number; nettedCents: number; balances: PayableBalances } {
  const amountCents = Math.min(
    atPeriodEnd.liabilityCents - atPeriodEnd.receivableCents,
    now.liabilityCents - now.receivableCents,
    lowestAfterCents ?? Number.POSITIVE_INFINITY,
  );
  // Never net more than is owed now (a later netting may have settled part of it).
  const nettedCents = Math.max(0, Math.min(atPeriodEnd.receivableCents, now.receivableCents));
  return {
    amountCents,
    nettedCents,
    balances: { liabilityCents: amountCents + nettedCents, receivableCents: nettedCents },
  };
}

/**
 * Compute the payout batch for the period: every creator whose available balance at
 * `periodEnd` reaches the minimum gets a `payouts` row and a ledger reservation of that amount,
 * atomically, dated `periodEnd`. Only postings dated at or before `periodEnd` count, so holds
 * released (or clawbacks owed) after it fall into the next period's run and the period's
 * statement never shows more paid out than was available at its end. Nor more than stayed
 * available at every posting date since (see `reservableAt`), so a late run never drives a
 * creator's running balance below zero at any date. Idempotent per
 * (user, periodStart). Each creator's balance is re-read under the creator lock right before
 * reserving, so concurrent reversals and releases are accounted for.
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
    const atEnd = await payableAsOf(tx, opts.currency, opts.periodEnd);
    const candidates = computePayoutBatch(
      [...atEnd].map(([userId, b]) => ({ userId, availableCents: b.liabilityCents - b.receivableCents })),
      opts.minimumCents,
    );
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
      const then = (await payableAsOf(tx, opts.currency, opts.periodEnd, c.userId)).get(c.userId);
      const now = await creatorBalances(tx, c.userId, opts.currency);
      const lowest = await lowestAvailableAfter(tx, c.userId, opts.currency, opts.periodEnd);
      const r = then ? reservableAt(then, now, lowest) : null;
      if (!r || r.amountCents <= 0 || r.amountCents < opts.minimumCents) {
        result.carriedOver.push({ userId: c.userId, availableCents: r?.amountCents ?? 0 });
        continue;
      }
      // payoutReserve checks only the shaped balances; check against today's real ones too.
      if (r.amountCents > now.availableCents || r.amountCents + r.nettedCents > now.liabilityCents) {
        throw new InsufficientBalanceError(
          `payout of ${r.amountCents} (+${r.nettedCents} netted) exceeds the available ${now.availableCents} cents`,
        );
      }
      const acct = accountsByUser.get(c.userId);
      const ready = acct?.enabled === true;
      const [row] = await tx
        .insert(schema.payouts)
        .values({
          userId: c.userId,
          periodStart: opts.periodStart,
          periodEnd: opts.periodEnd,
          amountCents: r.amountCents,
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
          amountCents: r.amountCents,
          currency: opts.currency,
          occurredAt: opts.periodEnd,
          balances: r.balances,
          minimumCents: opts.minimumCents,
        }),
      );
      if (ready) result.created += 1;
      else result.held += 1;
      result.totalCents += r.amountCents;
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
