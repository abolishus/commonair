// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import type { Executor } from "@commonair/db";
import { assertCurrency } from "./accounts.ts";
import { lockCreator } from "./locks.ts";
import { post } from "./poster.ts";
import { paymentHoldRemaining } from "./queries.ts";
import { holdRelease } from "./rules.ts";

export interface ReleaseResult {
  released: number;
  totalCents: number;
}

/**
 * Release the hold lot of every payment older than `holdDays` at `asOf`. Only lots with a
 * positive remainder are due, and each releases exactly what is still attributed to it, so
 * a lot drained by reversals is never revisited and can never block the batch. Each release
 * is its own idempotent posting, so a crash mid-batch is safe to re-run.
 */
export async function releaseDueHolds(
  db: Executor,
  opts: { asOf: Date; holdDays: number; currency: string; limit?: number },
): Promise<ReleaseResult> {
  assertCurrency(opts.currency);
  if (!Number.isFinite(opts.holdDays) || opts.holdDays < 0) throw new RangeError("holdDays must be non-negative");
  const cutoff = new Date(opts.asOf.getTime() - opts.holdDays * 86_400_000);
  const due = await db.execute<{ payment_id: string; creator: string }>(sql`
    with lots as (
      select e.memo from ledger_entries e join ledger_accounts a on a.id = e.account_id
      where a.currency = ${opts.currency} and a.code like 'liability:creator-hold:%' and e.memo like 'hold:%'
      group by e.memo having sum(e.amount_cents) < 0
    )
    select t.ref_id as payment_id, t.metadata->>'creatorUserId' as creator
    from lots join ledger_transactions t on t.idempotency_key = 'payment:' || substr(lots.memo, 6)
    where t.occurred_at <= ${cutoff.toISOString()}::timestamptz
      and not exists (select 1 from ledger_transactions r where r.idempotency_key = 'hold-release:' || t.ref_id::text)
    order by t.occurred_at, t.id
    limit ${opts.limit ?? 1000}`);

  let released = 0;
  let totalCents = 0;
  for (const row of due) {
    const amount = await db.transaction(async (tx) => {
      await lockCreator(tx, row.creator);
      const cents = await paymentHoldRemaining(tx, row.payment_id, row.creator, opts.currency);
      if (cents === 0) return 0;
      const r = await post(
        tx,
        holdRelease({
          paymentId: row.payment_id,
          creatorUserId: row.creator,
          amountCents: cents,
          currency: opts.currency,
          occurredAt: opts.asOf,
        }),
      );
      return r.created ? cents : 0;
    });
    if (amount > 0) {
      released += 1;
      totalCents += amount;
    }
  }
  return { released, totalCents };
}
