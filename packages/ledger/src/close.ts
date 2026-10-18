// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import type { Executor } from "@commonair/db";
import { accounts, assertCurrency, parseStoredCode } from "./accounts.ts";
import { accountBalance } from "./queries.ts";
import { post } from "./poster.ts";
import { periodClose } from "./rules.ts";

export class PeriodCloseError extends Error {
  override name = "PeriodCloseError";
}

export interface CloseResult {
  /** Null when the period had no revenue or expense activity. */
  transactionId: string | null;
  created: boolean;
  /** Revenue − expenses closed into retained surplus (negative for a loss). */
  surplusCents: number;
}

/**
 * Close [periodStart, periodEnd) in one currency: every revenue and expense account's activity
 * in the period is moved into `equity:retained-surplus`. Idempotent for the same period;
 * refuses a period overlapping one already closed, so nothing is closed twice.
 * Activity dated into an already-closed period later (backdated postings) is not re-closed.
 */
export async function closePeriod(
  db: Executor,
  opts: { periodStart: Date; periodEnd: Date; currency: string; occurredAt?: Date },
): Promise<CloseResult> {
  assertCurrency(opts.currency);
  if (!(opts.periodStart < opts.periodEnd)) throw new RangeError("periodStart must be before periodEnd");
  const start = opts.periodStart.toISOString();
  const end = opts.periodEnd.toISOString();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ledger:period-close:${opts.currency}`}))`);
    const prior = await tx.execute<{ id: string; start: string; end: string; surplus: string }>(sql`
      select id, metadata->>'periodStart' as start, metadata->>'periodEnd' as end,
             metadata->>'surplusCents' as surplus
      from ledger_transactions
      where kind = 'period_close' and metadata->>'currency' = ${opts.currency}
        and (metadata->>'periodStart')::timestamptz < ${end}::timestamptz
        and (metadata->>'periodEnd')::timestamptz > ${start}::timestamptz`);
    for (const p of prior) {
      if (
        new Date(p.start).getTime() === opts.periodStart.getTime() &&
        new Date(p.end).getTime() === opts.periodEnd.getTime()
      ) {
        return { transactionId: p.id, created: false, surplusCents: Number(p.surplus) };
      }
      throw new PeriodCloseError(`period overlaps the closed period ${p.start} – ${p.end}`);
    }

    const rows = await tx.execute<{ code: string; total: string }>(sql`
      select a.code, sum(e.amount_cents)::text as total
      from ledger_entries e
      join ledger_accounts a on a.id = e.account_id
      join ledger_transactions t on t.id = e.transaction_id
      where a.currency = ${opts.currency} and (a.code like 'revenue:%' or a.code like 'expense:%')
        and t.kind <> 'period_close'
        and t.occurred_at >= ${start}::timestamptz and t.occurred_at < ${end}::timestamptz
      group by a.code having sum(e.amount_cents) <> 0
      order by a.code`);
    const balances = [...rows].map((r) => ({ code: parseStoredCode(r.code).code, rawCents: Number(r.total) }));
    if (balances.length === 0) return { transactionId: null, created: false, surplusCents: 0 };
    const posting = periodClose({
      periodStart: opts.periodStart,
      periodEnd: opts.periodEnd,
      currency: opts.currency,
      // Inside the period, so monthly views attribute the close to the month it closes.
      occurredAt: opts.occurredAt ?? new Date(opts.periodEnd.getTime() - 1),
      balances,
    });
    const r = await post(tx, posting);
    return { ...r, surplusCents: Number(posting.metadata.surplusCents) };
  });
}

/** Retained surplus in natural terms (positive = surplus the co-op holds and may allocate). */
export function retainedSurplus(db: Executor, currency: string): Promise<number> {
  return accountBalance(db, accounts.retainedSurplus(), currency, "equity");
}
