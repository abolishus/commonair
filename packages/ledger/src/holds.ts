// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import type { Executor } from "@commonair/db";
import { assertCurrency } from "./accounts.ts";
import { post } from "./poster.ts";
import { creatorBalances, paymentHoldRemaining } from "./queries.ts";
import { holdRelease, holdReleaseAmount } from "./rules.ts";

/**
 * Serialize money movements for one creator within a database transaction, so balance reads
 * and the posting that depends on them cannot interleave with another such posting.
 */
export async function lockCreator(tx: Executor, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ledger:creator:${userId}`}))`);
}

export interface ReleaseResult {
  released: number;
  totalCents: number;
}

/**
 * Release the hold on every payment older than `holdDays` at `asOf` that has not been
 * released yet. Each release is its own idempotent posting, so a crash mid-batch is safe to
 * re-run. Payments whose hold was fully consumed by reversals post nothing.
 */
export async function releaseDueHolds(
  db: Executor,
  opts: { asOf: Date; holdDays: number; currency: string; limit?: number },
): Promise<ReleaseResult> {
  assertCurrency(opts.currency);
  const cutoff = new Date(opts.asOf.getTime() - opts.holdDays * 86_400_000);
  const due = await db.execute<{ payment_id: string; creator: string }>(sql`
    select t.ref_id as payment_id, t.metadata->>'creatorUserId' as creator
    from ledger_transactions t
    where t.kind = 'payment' and t.ref_type = 'payment' and t.occurred_at <= ${cutoff.toISOString()}::timestamptz
      and exists (select 1 from ledger_entries e where e.transaction_id = t.id and e.currency = ${opts.currency})
      and not exists (
        select 1 from ledger_transactions r where r.idempotency_key = 'hold-release:' || t.ref_id::text)
      -- Skip payments whose own hold was already consumed by refunds, so they never clog the batch.
      and (select coalesce(sum(he.amount_cents), 0) from ledger_entries he
           join ledger_accounts ha on ha.id = he.account_id
           join ledger_transactions ht on ht.id = he.transaction_id
           where ht.ref_type = 'payment' and ht.ref_id = t.ref_id
             and ha.code like 'liability:creator-hold:%') < 0
    order by t.occurred_at, t.id
    limit ${opts.limit ?? 1000}`);

  let released = 0;
  let totalCents = 0;
  for (const row of due) {
    const amount = await db.transaction(async (tx) => {
      await lockCreator(tx, row.creator);
      const own = await paymentHoldRemaining(tx, row.payment_id, row.creator, opts.currency);
      const { holdCents } = await creatorBalances(tx, row.creator, opts.currency);
      const cents = holdReleaseAmount(own, holdCents);
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
