// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import type { Executor } from "@commonair/db";
import { assertCurrency } from "./accounts.ts";
import { lockCreator } from "./locks.ts";
import { post } from "./poster.ts";
import { paymentHoldRemaining } from "./queries.ts";
import { holdRelease, holdReleaseDueAt, parseHoldMemo } from "./rules.ts";
import { loadMoneySettings } from "./settings.ts";

/** Clock skew tolerated between the caller's `asOf` and this process. */
const MAX_ASOF_SKEW_MS = 60_000;
const DAY_MS = 86_400_000;

/** When a release is dated: the moment it fell due, capped at the run's `asOf`. */
function dueAt(succeededAt: Date, holdDays: number, asOf: Date): Date {
  const due = holdReleaseDueAt(succeededAt, holdDays);
  return due < asOf ? due : asOf;
}

export interface ReleaseResult {
  released: number;
  totalCents: number;
  /** Of `released`, the crew lots withheld into split suspense (ADR 0013 decision 7). */
  withheld?: number;
}

/**
 * Whether a recipient's released share is withheld (ADR 0013 decision 7): suspended (banned with
 * no expiry, or one still running), deleted, terminated (a live `dmca_termination`) or under a
 * legal hold that was never released.
 */
export async function recipientWithheld(db: Executor, userId: string, asOf: Date): Promise<boolean> {
  const rows = await db.execute<{ withheld: boolean }>(sql`
    select (
      exists (select 1 from users u where u.id = ${userId}
                and (u.deleted_at is not null
                     or (u.banned and (u.ban_expires is null or u.ban_expires > ${asOf.toISOString()}::timestamptz))))
      or exists (select 1 from account_actions x where x.user_id = ${userId}
                   and x.action = 'dmca_termination' and x.reversed_at is null)
      or exists (select 1 from legal_holds h where h.user_id = ${userId} and h.released_at is null)
    ) as withheld`);
  return rows[0]?.withheld === true;
}

/**
 * Release every due hold lot at `asOf`. A lot is one recipient's slice of one payment (memo
 * `hold:<paymentId>:<userId>`, ADR 0013 decision 1): due `holdDays` after the payment, or, for a
 * crew recipient who never had a crew lot released before, `holdDays + newRecipientHoldDays`
 * (decision (i)). Only lots with a positive remainder are due, and each releases exactly what is
 * still attributed to it, so a lot drained by reversals is never revisited and can never block
 * the batch. Each lot is its own idempotent posting (`hold-release:<paymentId>:<userId>`) under
 * that recipient's creator lock, so a crash mid-batch is safe to re-run and one recipient's
 * release never touches another's lot. A withheld crew recipient's lot goes to split suspense.
 *
 * A release is dated when it fell due (never after `asOf`), not when the job happened to run: a
 * payout run for a month counts exactly the holds due by its end, however late the job or the run.
 */
export async function releaseDueHolds(
  db: Executor,
  opts: { asOf: Date; holdDays: number; currency: string; limit?: number; newRecipientHoldDays?: number },
): Promise<ReleaseResult> {
  assertCurrency(opts.currency);
  if (!Number.isFinite(opts.holdDays) || opts.holdDays < 0) throw new RangeError("holdDays must be non-negative");
  // Releases are dated up to `asOf`; a future date would release early and post future-dated
  // lines that every payout run would read as already available.
  if (opts.asOf.getTime() > Date.now() + MAX_ASOF_SKEW_MS) throw new RangeError("asOf must not be in the future");
  const extraDays = opts.newRecipientHoldDays ?? (await loadMoneySettings(db)).payoutRules.splitNewRecipientHoldDays;
  if (!Number.isFinite(extraDays) || extraDays < 0) throw new RangeError("newRecipientHoldDays must be non-negative");
  const cutoff = new Date(opts.asOf.getTime() - opts.holdDays * DAY_MS);
  const crewCutoff = new Date(cutoff.getTime() - extraDays * DAY_MS);
  const due = await db.execute<{
    payment_id: string;
    recipient: string;
    memo: string;
    owner: string;
    occurred_at: string | Date;
    first_crew: boolean;
  }>(sql`
    with lots as (
      select a.owner_user_id as recipient, e.memo
      from ledger_entries e join ledger_accounts a on a.id = e.account_id
      where a.currency = ${opts.currency} and a.code like 'liability:creator-hold:%' and e.memo like 'hold:%:%'
      group by a.owner_user_id, e.memo having sum(e.amount_cents) < 0
    ), parsed as (
      select recipient, memo, split_part(memo, ':', 2) as payment_id, split_part(memo, ':', 3) as memo_user from lots
    ), candidates as (
      select p.payment_id, p.recipient, p.memo, p.memo_user, t.id as tx_id, t.occurred_at,
             t.metadata->>'creatorUserId' as owner,
             (t.metadata->>'creatorUserId') is distinct from p.memo_user
               and not exists (select 1 from ledger_transactions r
                               where r.kind = 'hold_release' and r.metadata->>'recipientUserId' = p.memo_user
                                 and r.metadata->>'role' = 'crew') as first_crew
      from parsed p join ledger_transactions t on t.idempotency_key = 'payment:' || p.payment_id
      where t.occurred_at <= ${cutoff.toISOString()}::timestamptz
        and not exists (select 1 from ledger_transactions r
                        where r.idempotency_key = 'hold-release:' || p.payment_id || ':' || p.memo_user)
    )
    select payment_id, recipient::text as recipient, memo, owner, occurred_at, first_crew from candidates
    where not first_crew or occurred_at <= ${crewCutoff.toISOString()}::timestamptz
    order by occurred_at, tx_id, memo_user
    limit ${opts.limit ?? 1000}`);

  let released = 0;
  let totalCents = 0;
  let withheld = 0;
  for (const row of due) {
    const lot = parseHoldMemo(row.memo);
    // The recipient comes from the memo and must own the account it sits on.
    if (!lot || lot.paymentId !== row.payment_id || lot.userId !== row.recipient.toLowerCase()) continue;
    const isCrew = lot.userId !== row.owner.toLowerCase();
    const r = await db.transaction(async (tx) => {
      await lockCreator(tx, lot.userId);
      const cents = await paymentHoldRemaining(tx, lot.paymentId, lot.userId, opts.currency);
      if (cents === 0) return { cents: 0, withheld: false };
      const hold = isCrew && (await recipientWithheld(tx, lot.userId, opts.asOf));
      const p = await post(
        tx,
        holdRelease({
          paymentId: lot.paymentId,
          creatorUserId: lot.userId,
          ownerUserId: row.owner,
          amountCents: cents,
          currency: opts.currency,
          withheld: hold,
          occurredAt: dueAt(new Date(row.occurred_at), opts.holdDays + (row.first_crew ? extraDays : 0), opts.asOf),
        }),
      );
      return p.created ? { cents, withheld: hold } : { cents: 0, withheld: false };
    });
    if (r.cents > 0) {
      released += 1;
      totalCents += r.cents;
      if (r.withheld) withheld += 1;
    }
  }
  return { released, totalCents, withheld };
}
