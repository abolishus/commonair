// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { assertCurrency, isAccountCode } from "./accounts.ts";

/** Ledger transaction kinds written by the posting rules. */
export const POSTING_KINDS = [
  "payment",
  "hold_release",
  "refund",
  "chargeback",
  "chargeback_reversal",
  "payout_reserve",
  "payout",
  "payout_cancel",
  "period_close",
  "share_purchase",
  "share_refund",
  "infrastructure_cost",
  "patronage_allocation",
  "patronage_payout",
  "manual_confirmation",
] as const;
export type PostingKind = (typeof POSTING_KINDS)[number];

/** Signed amount: debits positive, credits negative (the ledger's convention). */
export interface PostingEntry {
  code: string;
  amountCents: number;
  memo?: string;
}

/**
 * A balanced set of entries ready to post. Descriptions and memos are fixed strings and ids;
 * never personal data (ADR 0004).
 */
export interface Posting {
  kind: PostingKind;
  description: string;
  refType: string | null;
  refId: string | null;
  /** The same key never posts twice. */
  idempotencyKey: string;
  currency: string;
  occurredAt: Date;
  reversesId?: string | null;
  /** Ids and amounts only. `creatorUserId`/`revenueGrossCents` drive patronage revenue. */
  metadata: Record<string, string | number | boolean | null>;
  entries: PostingEntry[];
}

export class UnbalancedPostingError extends Error {
  override name = "UnbalancedPostingError";
}

/** Throws unless the posting is something the database would accept. */
export function validatePosting(p: Posting): void {
  if (!p.idempotencyKey || p.idempotencyKey.length > 200) throw new RangeError("idempotencyKey must be 1–200 chars");
  if (!p.description) throw new RangeError("description is required");
  assertCurrency(p.currency);
  if (Number.isNaN(p.occurredAt.getTime())) throw new RangeError("occurredAt must be a valid date");
  if (p.entries.length < 2) throw new UnbalancedPostingError("a posting needs at least two entries");
  let sum = 0;
  for (const e of p.entries) {
    if (!isAccountCode(e.code)) throw new RangeError(`unknown ledger account code: ${e.code}`);
    if (!Number.isSafeInteger(e.amountCents) || e.amountCents === 0) {
      throw new RangeError(`entry amounts must be non-zero integer cents (${e.code}: ${e.amountCents})`);
    }
    sum += e.amountCents;
  }
  if (sum !== 0) throw new UnbalancedPostingError(`posting ${p.idempotencyKey} is unbalanced by ${sum} cents`);
}

/** Drop zero entries (rules compute some legs that can round to zero). */
export function nonZero(entries: PostingEntry[]): PostingEntry[] {
  return entries.filter((e) => e.amountCents !== 0);
}
