// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { sql } from "drizzle-orm";
import type { Executor } from "@commonair/db";
import { type AccountType, accounts, assertCurrency, isDebitNormal, parseStoredCode, storedCode } from "./accounts.ts";
import { negate } from "./math.ts";
import type { PostingKind } from "./posting.ts";

/** int8/numeric arrive from the driver as strings. */
const num = (v: string | number | null | undefined): number => (v === null || v === undefined ? 0 : Number(v));

/** Raw balance (sum of entries: debits positive). Zero for an account that does not exist yet. */
export async function rawBalance(db: Executor, code: string, currency: string): Promise<number> {
  const rows = await db.execute<{ total: string | null }>(sql`
    select coalesce(sum(e.amount_cents), 0)::text as total
    from ledger_entries e join ledger_accounts a on a.id = e.account_id
    where a.code = ${storedCode(code, currency)}`);
  return num(rows[0]?.total);
}

/** Balance in the account's natural direction (positive = normal, e.g. owed for a liability). */
export async function accountBalance(db: Executor, code: string, currency: string, type: AccountType): Promise<number> {
  const raw = await rawBalance(db, code, currency);
  return isDebitNormal(type) ? raw : negate(raw);
}

export interface CreatorBalanceSummary {
  /** Released, unpaid earnings. */
  liabilityCents: number;
  /** Earnings still in the chargeback hold window. */
  holdCents: number;
  /** Clawback shortfall the creator owes. */
  receivableCents: number;
  /** liability − receivable: what a payout may pay now. */
  availableCents: number;
}

/** A creator's balances, all in natural terms, from one query. */
export async function creatorBalances(db: Executor, userId: string, currency: string): Promise<CreatorBalanceSummary> {
  const codes = {
    liability: storedCode(accounts.creator(userId), currency),
    hold: storedCode(accounts.creatorHold(userId), currency),
    receivable: storedCode(accounts.creatorReceivable(userId), currency),
  };
  const rows = await db.execute<{ code: string; total: string }>(sql`
    select a.code, coalesce(sum(e.amount_cents), 0)::text as total
    from ledger_accounts a left join ledger_entries e on e.account_id = a.id
    where a.code in (${codes.liability}, ${codes.hold}, ${codes.receivable})
    group by a.code`);
  const by = new Map([...rows].map((r) => [r.code, num(r.total)]));
  const liabilityCents = negate(by.get(codes.liability) ?? 0);
  const holdCents = negate(by.get(codes.hold) ?? 0);
  const receivableCents = by.get(codes.receivable) ?? 0;
  return { liabilityCents, holdCents, receivableCents, availableCents: liabilityCents - receivableCents };
}

/** What remains on hold for one payment: its own postings on the creator's hold account. */
export async function paymentHoldRemaining(
  db: Executor,
  paymentId: string,
  creatorUserId: string,
  currency: string,
): Promise<number> {
  const rows = await db.execute<{ total: string | null }>(sql`
    select coalesce(sum(e.amount_cents), 0)::text as total
    from ledger_entries e
    join ledger_accounts a on a.id = e.account_id
    join ledger_transactions t on t.id = e.transaction_id
    where a.code = ${storedCode(accounts.creatorHold(creatorUserId), currency)}
      and t.ref_type = 'payment' and t.ref_id = ${paymentId}`);
  return Math.max(0, negate(num(rows[0]?.total)));
}

export interface StatementLine {
  entryId: string;
  transactionId: string;
  occurredAt: Date;
  kind: string;
  description: string;
  /** Chart code (without the currency suffix). */
  account: string;
  memo: string | null;
  /** Signed: debits positive, credits negative. */
  amount: { cents: number; currency: string };
}

export interface StatementPage {
  items: StatementLine[];
  nextCursor: string | null;
}

function encodeCursor(at: Date, entryId: string): string {
  return Buffer.from(`${at.toISOString()}|${entryId}`).toString("base64url");
}
function decodeCursor(cursor: string): { at: Date; entryId: string } {
  const [iso, entryId] = Buffer.from(cursor, "base64url").toString().split("|");
  const at = new Date(iso ?? "");
  if (!entryId || Number.isNaN(at.getTime()) || !/^[0-9a-f-]{36}$/.test(entryId)) {
    throw new RangeError("invalid statement cursor");
  }
  return { at, entryId };
}

/**
 * Ledger lines on every account a user owns, newest first, keyset-paged by
 * (occurredAt, entry id) so pages are stable while new postings arrive.
 */
export async function statement(
  db: Executor,
  userId: string,
  opts: { cursor?: string | undefined; limit?: number } = {},
): Promise<StatementPage> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const after = opts.cursor ? decodeCursor(opts.cursor) : null;
  const rows = await db.execute<{
    entry_id: string;
    transaction_id: string;
    occurred_at: string | Date;
    kind: string;
    description: string;
    code: string;
    memo: string | null;
    amount_cents: string;
    currency: string;
  }>(sql`
    select e.id as entry_id, t.id as transaction_id, t.occurred_at, t.kind, t.description,
           a.code, e.memo, e.amount_cents::text as amount_cents, e.currency
    from ledger_entries e
    join ledger_accounts a on a.id = e.account_id
    join ledger_transactions t on t.id = e.transaction_id
    where a.owner_user_id = ${userId}
      ${after ? sql`and (t.occurred_at, e.id) < (${after.at.toISOString()}::timestamptz, ${after.entryId}::uuid)` : sql``}
    order by t.occurred_at desc, e.id desc
    limit ${limit + 1}`);
  const list = [...rows];
  const items = list.slice(0, limit).map((r) => ({
    entryId: r.entry_id,
    transactionId: r.transaction_id,
    occurredAt: new Date(r.occurred_at),
    kind: r.kind,
    description: r.description,
    account: parseStoredCode(r.code).code,
    memo: r.memo,
    amount: { cents: num(r.amount_cents), currency: r.currency },
  }));
  const last = items.at(-1);
  return { items, nextCursor: list.length > limit && last ? encodeCursor(last.occurredAt, last.entryId) : null };
}

export interface MonthlyAggregate {
  /** `YYYY-MM` in UTC. */
  month: string;
  currency: string;
  /** Subscription and tip revenue net of tax, refunds and chargebacks (creator + co-op shares). */
  revenueCents: number;
  /** The co-op's share of that revenue. */
  platformCutCents: number;
  /** Paid to creators (payouts). */
  streamerPayoutsCents: number;
  /** Every expense by category (`payment-fees`, `infrastructure:<category>`). */
  costs: { category: string; cents: number }[];
  totalCostsCents: number;
  /** Platform cut − costs. */
  surplusCents: number;
  patronageDistributedCents: number;
}

const REVENUE_KINDS: PostingKind[] = ["payment", "refund", "chargeback"];

/**
 * Monthly figures for the transparency page, from the ledger alone (so they always agree
 * with it). Months with no postings are omitted.
 */
export async function monthlyAggregates(
  db: Executor,
  range: { from: Date; to: Date; currency: string },
): Promise<MonthlyAggregate[]> {
  assertCurrency(range.currency);
  const rows = await db.execute<{ month: string; code: string; kind: string; total: string }>(sql`
    select to_char(date_trunc('month', t.occurred_at at time zone 'UTC'), 'YYYY-MM') as month,
           a.code, t.kind, sum(e.amount_cents)::text as total
    from ledger_entries e
    join ledger_accounts a on a.id = e.account_id
    join ledger_transactions t on t.id = e.transaction_id
    where e.currency = ${range.currency}
      and t.occurred_at >= ${range.from.toISOString()}::timestamptz
      and t.occurred_at < ${range.to.toISOString()}::timestamptz
    group by 1, 2, 3`);

  const months = new Map<string, MonthlyAggregate & { costMap: Map<string, number> }>();
  for (const r of rows) {
    let m = months.get(r.month);
    if (!m) {
      m = {
        month: r.month,
        currency: range.currency,
        revenueCents: 0,
        platformCutCents: 0,
        streamerPayoutsCents: 0,
        costs: [],
        totalCostsCents: 0,
        surplusCents: 0,
        patronageDistributedCents: 0,
        costMap: new Map(),
      };
      months.set(r.month, m);
    }
    const code = parseStoredCode(r.code).code;
    const total = num(r.total);
    const kind = r.kind as PostingKind;
    const creatorSide =
      code.startsWith("liability:creator:") ||
      code.startsWith("liability:creator-hold:") ||
      code.startsWith("asset:receivable:creator:");
    if (REVENUE_KINDS.includes(kind) && (creatorSide || code === accounts.platformCut())) m.revenueCents -= total;
    if (code === accounts.platformCut()) m.platformCutCents -= total;
    if (kind === "payout" && code.startsWith("asset:cash:")) m.streamerPayoutsCents -= total;
    if (kind === "patronage_allocation" && code === accounts.retainedSurplus()) m.patronageDistributedCents += total;
    if (code.startsWith("expense:")) {
      const category = code.slice("expense:".length);
      m.costMap.set(category, (m.costMap.get(category) ?? 0) + total);
      m.totalCostsCents += total;
    }
  }
  return [...months.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map(({ costMap, ...m }) => ({
      ...m,
      costs: [...costMap]
        .filter(([, cents]) => cents !== 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([category, cents]) => ({ category, cents })),
      surplusCents: m.platformCutCents - m.totalCostsCents,
    }));
}
