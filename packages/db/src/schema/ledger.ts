// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Append-only double-entry ledger. Database triggers (see the ledger migration)
 * reject UPDATE and DELETE on all three tables and reject any transaction whose
 * entries do not sum to zero per currency at commit time.
 * Convention: debits are positive, credits negative.
 * No personal data in descriptions, memos or metadata: reference users by id only,
 * so pseudonymizing a deleted account never requires rewriting the ledger.
 */
import { sql } from "drizzle-orm";
import { type AnyPgColumn, bigint, check, index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { createdAt, id, ledgerAccountType, ts } from "./_shared.ts";

export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: id(),
    /** Stable code, e.g. `liability:creator:<userId>`; see packages/ledger for the chart. */
    code: text().notNull().unique(),
    type: ledgerAccountType().notNull(),
    name: text().notNull(),
    ownerUserId: uuid().references(() => users.id, { onDelete: "set null" }),
    currency: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("ledger_accounts_owner_idx").on(t.ownerUserId),
    check("ledger_accounts_currency_format", sql`${t.currency} ~ '^[a-z]{3}$'`),
  ],
);

export const ledgerTransactions = pgTable(
  "ledger_transactions",
  {
    id: id(),
    kind: text().notNull(),
    description: text().notNull(),
    occurredAt: ts().notNull(),
    /** What caused it, e.g. ("payment", id) or ("patronage_period", id). */
    refType: text(),
    refId: uuid(),
    /** Posting is idempotent: the same key never posts twice. */
    idempotencyKey: text().notNull().unique(),
    /** For reversals: the transaction this one reverses. */
    reversesId: uuid().references((): AnyPgColumn => ledgerTransactions.id, {
      onDelete: "restrict",
    }),
    /** Database transaction id that created the row (set by trigger); entries may only be added in that same transaction. */
    txid: bigint({ mode: "number" })
      .notNull()
      .default(sql`txid_current()`),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("ledger_transactions_ref_idx").on(t.refType, t.refId),
    // money-reconcile reads the payments posted since its cursor.
    index("ledger_transactions_ref_created_idx").on(t.refType, t.createdAt),
    index("ledger_transactions_time_idx").on(t.occurredAt),
  ],
);

export const ledgerEntries = pgTable(
  "ledger_entries",
  {
    id: id(),
    transactionId: uuid()
      .notNull()
      .references(() => ledgerTransactions.id, { onDelete: "restrict" }),
    accountId: uuid()
      .notNull()
      .references(() => ledgerAccounts.id, { onDelete: "restrict" }),
    amountCents: bigint({ mode: "number" }).notNull(),
    currency: text().notNull(),
    memo: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index("ledger_entries_tx_idx").on(t.transactionId),
    index("ledger_entries_account_idx").on(t.accountId, t.createdAt),
    check("ledger_entries_nonzero", sql`${t.amountCents} <> 0`),
    check("ledger_entries_currency_format", sql`${t.currency} ~ '^[a-z]{3}$'`),
  ],
);
