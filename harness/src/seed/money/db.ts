// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * seed-money's direct database work, all as the app role (`ctx.db`):
 *
 * - reads: account ages (the fraud floor's "new payer"), live channel bans (gift eligibility), and
 *   the ledger checks and row counts over what the unit caused through the API;
 * - two timestamp shifts on plain tables (manual adapter only), so the worker's own jobs move a
 *   checkout and a subscription on: an abandoned checkout's `payments.expires_at` (money-expire-
 *   pending fails it and expires what hangs off it) and a paid self subscription's period
 *   (money-renew makes it `past_due` with a pending renewal). Neither table has a trigger; no
 *   ledger, payout or fraud row is written here.
 */
import type { DbHandle } from "@commonair/db";
import type { LedgerSumRow } from "../../money.ts";

/** Postgres's bind-parameter limit is 65 535; stay well under it per statement. */
const IN_CHUNK = 1_000;

function chunks<T>(items: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const toDate = (v: string | Date) => (v instanceof Date ? v : new Date(v));

/** `users.created_at` by id. */
export async function accountAges(
  db: DbHandle,
  ids: readonly string[],
  signal?: AbortSignal,
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  for (const part of chunks(ids)) {
    signal?.throwIfAborted();
    const rows = await db.sql<{ id: string; created_at: string | Date }[]>`
      select id::text as id, created_at from users where id::text in ${db.sql(part)}`;
    for (const r of rows) out.set(r.id, toDate(r.created_at));
  }
  return out;
}

/** Live bans and timeouts as `(channelId, userId)` pairs. */
export async function activeBans(db: DbHandle, now: Date): Promise<{ channelId: string; userId: string }[]> {
  const rows = await db.sql<{ channel_id: string; user_id: string }[]>`
    select channel_id::text as channel_id, user_id::text as user_id from chat_bans
     where lifted_at is null and (expires_at is null or expires_at > ${now.toISOString()}::timestamptz)`;
  return rows.map((r) => ({ channelId: r.channel_id, userId: r.user_id }));
}

/**
 * Manual adapter: let an abandoned checkout lapse now. `money-expire-pending` (every 5 min) then
 * fails the payment, expires its incomplete subscription or fails its tip. Returns rows moved (1).
 */
export async function expireCheckout(db: DbHandle, paymentId: string, at: Date): Promise<number> {
  const rows = await db.sql`
    update payments set expires_at = ${at.toISOString()}::timestamptz
     where id = ${paymentId}::uuid and status = 'pending'
    returning id`;
  return rows.length;
}

/**
 * Manual adapter: move a paid self subscription's period one month back so it ended at `at`.
 * `money-renew` (every 5 min) then adds its pending renewal and turns it `past_due`. Returns rows
 * moved (1).
 */
export async function lapseSubscription(db: DbHandle, paymentId: string, at: Date): Promise<number> {
  const start = new Date(at);
  start.setUTCMonth(start.getUTCMonth() - 1);
  const rows = await db.sql`
    update subscriptions s
       set current_period_start = ${start.toISOString()}::timestamptz,
           current_period_end = ${at.toISOString()}::timestamptz
      from payments p
     where p.id = ${paymentId}::uuid and s.id = p.subscription_id
       and s.status = 'active' and s.provider = 'manual'
    returning s.id`;
  return rows.length;
}

export interface LedgerReport {
  rows: LedgerSumRow[];
  disputes: { id: string; paymentId: string; kind: string; status: string }[];
  /** Distinct rows behind `rows` (for the report). */
  counts: { ledger_transactions: number; ledger_entries: number; ledger_accounts: number };
}

/**
 * Per-transaction, per-currency entry sums for every transaction the unit caused: postings and
 * reversals of `paymentIds` (reversals reference the payment too), and the costs `costRecordedBy`
 * recorded (`infra_costs.ledger_transaction_id`).
 */
export async function ledgerReport(
  db: DbHandle,
  paymentIds: readonly string[],
  costRecordedBy: string | null,
  signal?: AbortSignal,
): Promise<LedgerReport> {
  const { sql } = db;
  const txIds = new Set<string>();
  const disputes: LedgerReport["disputes"] = [];
  for (const part of chunks(paymentIds)) {
    signal?.throwIfAborted();
    for (const r of await sql<{ id: string }[]>`
      select id::text as id from ledger_transactions where ref_id::text in ${sql(part)}`)
      txIds.add(r.id);
    for (const r of await sql<{ id: string; payment_id: string; kind: string; status: string }[]>`
      select id::text as id, payment_id::text as payment_id, kind::text as kind, status::text as status
        from disputes where payment_id::text in ${sql(part)}`)
      disputes.push({ id: r.id, paymentId: r.payment_id, kind: r.kind, status: r.status });
  }
  if (costRecordedBy)
    for (const r of await sql<{ id: string | null }[]>`
      select ledger_transaction_id::text as id from infra_costs where recorded_by = ${costRecordedBy}::uuid`)
      if (r.id) txIds.add(r.id);
  const rows: LedgerSumRow[] = [];
  let entries = 0;
  const accounts = new Set<string>();
  for (const part of chunks([...txIds])) {
    signal?.throwIfAborted();
    const sums = await sql<
      {
        transaction_id: string;
        ref_id: string | null;
        kind: string;
        idempotency_key: string;
        currency: string;
        sum: string;
        n: number;
      }[]
    >`
      select t.id::text as transaction_id, t.ref_id::text as ref_id, t.kind, t.idempotency_key, e.currency,
             sum(e.amount_cents)::text as sum, count(*)::int as n
        from ledger_transactions t
        join ledger_entries e on e.transaction_id = t.id
       where t.id::text in ${sql(part)}
       group by t.id, t.ref_id, t.kind, t.idempotency_key, e.currency`;
    for (const s of sums) {
      rows.push({
        transactionId: s.transaction_id,
        refId: s.ref_id,
        kind: s.kind,
        idempotencyKey: s.idempotency_key,
        currency: s.currency,
        sum: s.sum,
      });
      entries += Number(s.n);
    }
    for (const a of await sql<{ id: string }[]>`
      select distinct account_id::text as id from ledger_entries where transaction_id::text in ${sql(part)}`)
      accounts.add(a.id);
  }
  return {
    rows,
    disputes,
    counts: { ledger_transactions: txIds.size, ledger_entries: entries, ledger_accounts: accounts.size },
  };
}

/** Rows in the split tables that belong to the given channels (all written by the API). */
export async function splitCounts(db: DbHandle, channelIds: readonly string[]): Promise<Record<string, number>> {
  if (channelIds.length === 0) return {};
  const { sql } = db;
  const [r] = await sql<{ splits: number; shares: number; acceptances: number; postings: number }[]>`
    with s as (select id from revenue_splits where channel_id::text in ${sql([...channelIds])})
    select (select count(*) from s)::int as splits,
           (select count(*) from revenue_split_shares where split_id in (select id from s))::int as shares,
           (select count(*) from revenue_split_acceptances where split_id in (select id from s))::int as acceptances,
           (select count(*) from revenue_split_postings where split_id in (select id from s))::int as postings`;
  return {
    revenue_splits: r?.splits ?? 0,
    revenue_split_shares: r?.shares ?? 0,
    revenue_split_acceptances: r?.acceptances ?? 0,
    revenue_split_postings: r?.postings ?? 0,
  };
}

/** Subscriptions and tips the given payments created (self subscriptions, gift subs, tips). */
export async function paymentSideCounts(
  db: DbHandle,
  paymentIds: readonly string[],
): Promise<{ subscriptions: number; tips: number }> {
  const { sql } = db;
  let subscriptions = 0;
  let tips = 0;
  for (const part of chunks(paymentIds)) {
    const [r] = await sql<{ subs: number; tips: number }[]>`
      with p as (select id, subscription_id from payments where id::text in ${sql(part)})
      select (select count(distinct s.id) from subscriptions s
               where s.gift_payment_id in (select id from p)
                  or s.id in (select subscription_id from p))::int as subs,
             (select count(*) from tips where payment_id in (select id from p))::int as tips`;
    subscriptions += r?.subs ?? 0;
    tips += r?.tips ?? 0;
  }
  return { subscriptions, tips };
}
