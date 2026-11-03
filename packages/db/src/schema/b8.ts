// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 8 money tables (M1; .claude/briefs/b8/contract-step.md §2.1, ADR 0007 Amendment 1).
 * Migration 0049 guards both: statuses only move forward, amounts never grow past what was owed,
 * provider references are set once, and neither table loses a row to the app role. Ids, cents and
 * opaque codes only: no names, emails or provider messages (ADR 0004).
 */
import { sql } from "drizzle-orm";
import { check, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { patronagePeriods } from "./coop.ts";
import { payouts } from "./money.ts";
import {
  cents,
  createdAt,
  id,
  patronagePayoutStatus,
  paymentProvider,
  payoutTransferStatus,
  ts,
  updatedAt,
} from "./_shared.ts";

/**
 * One Stripe Connect transfer per payout (M1-connect, decision (f)). Created `pending` before the
 * provider is called; `created` once Stripe answered with its id, `failed` on a definite refusal
 * (the payout is cancelled back to the payable), `reversed` once Stripe reversed all of it.
 */
export const payoutTransfers = pgTable(
  "payout_transfers",
  {
    id: id(),
    payoutId: uuid()
      .notNull()
      .references(() => payouts.id, { onDelete: "restrict" }),
    provider: paymentProvider().notNull(),
    /** The provider's transfer id (Stripe `tr_…`), set once. */
    providerRef: text(),
    /** The connected account paid (Stripe `acct_…`). */
    destinationRef: text().notNull(),
    amountCents: cents().notNull(),
    currency: text().notNull(),
    status: payoutTransferStatus().notNull().default("pending"),
    /** Every reversal so far; only ever raised, never above `amountCents`. */
    reversedCents: cents().notNull().default(0),
    /** The key every provider call for this transfer uses (`payout-transfer:<payoutId>`). */
    idempotencyKey: text().notNull(),
    /** An opaque short code (`account_not_ready`, `held`, a provider error code); never a message. */
    failureCode: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("payout_transfers_payout_uq").on(t.payoutId),
    uniqueIndex("payout_transfers_provider_ref_uq")
      .on(t.provider, t.providerRef)
      .where(sql`${t.providerRef} is not null`),
    uniqueIndex("payout_transfers_idempotency_uq").on(t.idempotencyKey),
    index("payout_transfers_status_idx").on(t.status, t.createdAt),
    check("payout_transfers_amount_positive", sql`${t.amountCents} > 0`),
    check("payout_transfers_currency_format", sql`${t.currency} ~ '^[a-z]{3}$'`),
    check("payout_transfers_reversed_bounds", sql`${t.reversedCents} >= 0 and ${t.reversedCents} <= ${t.amountCents}`),
    check("payout_transfers_failure_code_len", sql`${t.failureCode} is null or length(${t.failureCode}) <= 64`),
  ],
);

/**
 * A member's patronage payout for one approved period (M1-coop-money, ADR 0020). At most one open
 * (`pending` or `paid`) row per member and period; a `failed` or `reversed` row is followed by a new
 * one. The paid rows of a member never exceed their `patronage_allocations` amount.
 */
export const patronagePayouts = pgTable(
  "patronage_payouts",
  {
    id: id(),
    periodId: uuid()
      .notNull()
      .references(() => patronagePeriods.id, { onDelete: "restrict" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    amountCents: cents().notNull(),
    currency: text().notNull(),
    provider: paymentProvider().notNull(),
    /** The treasurer's reference (manual) or the provider's transfer id; set once. */
    providerRef: text(),
    status: patronagePayoutStatus().notNull().default("pending"),
    /** `patronage-payout:<id>` (the row's own, so a member can be paid again after a failure). */
    idempotencyKey: text().notNull(),
    createdAt: createdAt(),
    paidAt: ts(),
  },
  (t) => [
    uniqueIndex("patronage_payouts_period_user_uq")
      .on(t.periodId, t.userId)
      .where(sql`${t.status} in ('pending', 'paid')`),
    uniqueIndex("patronage_payouts_idempotency_uq").on(t.idempotencyKey),
    index("patronage_payouts_user_idx").on(t.userId),
    check("patronage_payouts_amount_positive", sql`${t.amountCents} > 0`),
    check("patronage_payouts_currency_format", sql`${t.currency} ~ '^[a-z]{3}$'`),
  ],
);
