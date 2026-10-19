// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pure helpers for the revenue, payout and transparency reports (no I/O, unit-tested). */
import type { REVENUE_LINE_TYPES } from "@commonair/contracts/enums";

export type RevenueLineType = (typeof REVENUE_LINE_TYPES)[number];

const DAY_MS = 86_400_000;
/** Bounds the `daily` series and the scan; a year and a bit covers every dashboard filter. */
export const MAX_PERIOD_DAYS = 400;

export class PeriodError extends RangeError {
  override name = "PeriodError";
}

export interface Period {
  from: Date;
  to: Date;
}

/** 00:00 UTC on the first day of the month containing `d`. */
export function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** 00:00 UTC on the first day of the month `n` months after the month containing `d`. */
export function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

/** `YYYY-MM` in UTC. */
export function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/**
 * The reporting period `[from, to)`. With neither bound it is the current UTC month; with only
 * `from`, it runs to the start of the month after `from`; with only `to`, it starts at the
 * beginning of the month containing the instant just before `to`.
 */
export function parsePeriod(from: string | undefined, to: string | undefined, now: Date): Period {
  const f = from === undefined ? null : new Date(from);
  const t = to === undefined ? null : new Date(to);
  if ((f && Number.isNaN(f.getTime())) || (t && Number.isNaN(t.getTime()))) throw new PeriodError("invalid date");
  let period: Period;
  if (f && t) period = { from: f, to: t };
  else if (f) period = { from: f, to: addMonths(f, 1) };
  else if (t) period = { from: monthStart(new Date(t.getTime() - 1)), to: t };
  else period = { from: monthStart(now), to: addMonths(now, 1) };
  if (!(period.from < period.to)) throw new PeriodError("from must be before to");
  if (period.to.getTime() - period.from.getTime() > MAX_PERIOD_DAYS * DAY_MS) {
    throw new PeriodError(`the period may span at most ${MAX_PERIOD_DAYS} days`);
  }
  return period;
}

/** The period of the same length that ends where `p` starts. */
export function previousPeriod(p: Period): Period {
  const len = p.to.getTime() - p.from.getTime();
  return { from: new Date(p.from.getTime() - len), to: p.from };
}

/** Every UTC date (`YYYY-MM-DD`) that overlaps `[from, to)`, in order. */
export function utcDays(p: Period): string[] {
  const days: string[] = [];
  const first = Date.UTC(p.from.getUTCFullYear(), p.from.getUTCMonth(), p.from.getUTCDate());
  for (let t = first; t < p.to.getTime(); t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
  return days;
}

/**
 * The payout batch month for a run ending at `periodEnd`: `periodEnd` is an exclusive end, so a
 * run at exactly 00:00 on the 1st closes the month before.
 */
export function payoutMonth(periodEnd: Date): Period {
  const from = monthStart(new Date(periodEnd.getTime() - 1));
  return { from, to: periodEnd };
}

/** Where a payment's creator share came from on the dashboard. */
export type RevenueSource = "subscriptions" | "gifts" | "tips";

export interface PaymentFacts {
  kind: "subscription" | "tip" | "membership_share";
  quantity: number;
  /** A subscription row was bought by this payment as a gift (`gift_payment_id`). */
  giftSubscription: boolean;
}

export function revenueSource(p: PaymentFacts): RevenueSource {
  if (p.kind === "tip") return "tips";
  return p.quantity > 1 || p.giftSubscription ? "gifts" : "subscriptions";
}

/** Ledger posting kinds that put a row on a creator's revenue ledger. Hold releases are internal moves. */
export const REVENUE_LEDGER_KINDS = [
  "payment",
  "refund",
  "chargeback",
  "chargeback_reversal",
  "payout_reserve",
  "payout_cancel",
] as const;
export type RevenueLedgerKind = (typeof REVENUE_LEDGER_KINDS)[number];

/** Kinds whose amounts are revenue (payments and their reversals), as opposed to payouts. */
export const REVENUE_KINDS = ["payment", "refund", "chargeback", "chargeback_reversal"] as const;

export const isRevenueLedgerKind = (k: string): k is RevenueLedgerKind =>
  (REVENUE_LEDGER_KINDS as readonly string[]).includes(k);
export const isRevenueKind = (k: string): k is (typeof REVENUE_KINDS)[number] =>
  (REVENUE_KINDS as readonly string[]).includes(k);

/**
 * The revenue-ledger `type` of a posting. A won chargeback is shown as a (positive) chargeback
 * row and a cancelled payout as a (positive) payout row, so the type set stays small.
 */
export function revenueLineType(kind: RevenueLedgerKind, payment: PaymentFacts | null): RevenueLineType {
  switch (kind) {
    case "payment": {
      if (!payment) return "subscription";
      const source = revenueSource(payment);
      return source === "tips" ? "tip" : source === "gifts" ? "gift" : "subscription";
    }
    case "refund":
      return "refund";
    case "chargeback":
    case "chargeback_reversal":
      return "chargeback";
    case "payout_reserve":
    case "payout_cancel":
      return "payout";
  }
}

/**
 * A reference safe to put in a CSV cell as is: a provider token such as `CA-7K2M9QXD` or
 * `pi_3Nx…`. Anything else (a treasurer's free-text payout note, a value that a spreadsheet
 * would run as a formula) becomes null.
 */
export function csvSafeReference(ref: string | null | undefined): string | null {
  if (!ref) return null;
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(ref) ? ref : null;
}

/** Infrastructure cost categories become ledger account codes: a lowercase slug. */
export const isCategorySlug = (s: string): boolean => /^[a-z0-9][a-z0-9-]{0,39}$/.test(s);

/** Transparency cost category from a ledger expense category (`infrastructure:hosting` → `hosting`). */
export const costCategory = (ledgerCategory: string): string =>
  ledgerCategory.startsWith("infrastructure:") ? ledgerCategory.slice("infrastructure:".length) : ledgerCategory;
