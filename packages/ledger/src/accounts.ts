// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Chart of accounts. Every account has a stable code `<type>:<group>[:<param>]`; the row in
 * `ledger_accounts` stores `<code>@<currency>` because codes are unique across currencies.
 * Names and codes carry user ids only, never personal data (ADR 0004).
 */
import { inArray } from "drizzle-orm";
import type { LEDGER_ACCOUNT_TYPES } from "@commonair/contracts/enums";
import { type Executor, schema } from "@commonair/db";

export type AccountType = (typeof LEDGER_ACCOUNT_TYPES)[number];

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SLUG = "[a-z0-9][a-z0-9-]{0,62}";
const CURRENCY = /^[a-z]{3}$/;

interface ChartEntry {
  pattern: RegExp;
  type: AccountType;
  /** The captured parameter is a user id (the account is owned by that user). */
  owned: boolean;
  name: (param: string) => string;
}

/** Order matters only for readability; patterns are mutually exclusive. */
const CHART: readonly ChartEntry[] = [
  { pattern: new RegExp(`^asset:cash:(${SLUG})$`), type: "asset", owned: false, name: (p) => `Cash held at ${p}` },
  {
    pattern: new RegExp(`^asset:receivable:provider:(${SLUG})$`),
    type: "asset",
    owned: false,
    name: (p) => `Receivable from ${p}`,
  },
  {
    pattern: new RegExp(`^asset:receivable:creator:(${UUID})$`),
    type: "asset",
    owned: true,
    name: (p) => `Clawback receivable from creator ${p}`,
  },
  {
    pattern: new RegExp(`^liability:creator:(${UUID})$`),
    type: "liability",
    owned: true,
    name: (p) => `Creator earnings payable ${p}`,
  },
  {
    pattern: new RegExp(`^liability:creator-hold:(${UUID})$`),
    type: "liability",
    owned: true,
    name: (p) => `Creator earnings on hold ${p}`,
  },
  {
    pattern: new RegExp(`^liability:payout-clearing:(${UUID})$`),
    type: "liability",
    owned: true,
    name: (p) => `Payout reserved, not yet sent ${p}`,
  },
  { pattern: /^liability:tax-payable$/, type: "liability", owned: false, name: () => "Sales tax payable" },
  {
    pattern: new RegExp(`^liability:member-share:(${UUID})$`),
    type: "liability",
    owned: true,
    name: (p) => `Refundable member share ${p}`,
  },
  {
    pattern: new RegExp(`^liability:patronage-payable:(${UUID})$`),
    type: "liability",
    owned: true,
    name: (p) => `Patronage payable ${p}`,
  },
  { pattern: /^revenue:platform-cut$/, type: "revenue", owned: false, name: () => "Co-op share of revenue" },
  { pattern: /^expense:payment-fees$/, type: "expense", owned: false, name: () => "Payment processing fees" },
  {
    pattern: new RegExp(`^expense:infrastructure:(${SLUG})$`),
    type: "expense",
    owned: false,
    name: (p) => `Infrastructure: ${p}`,
  },
  { pattern: /^equity:retained-surplus$/, type: "equity", owned: false, name: () => "Retained surplus" },
];

export interface AccountInfo {
  code: string;
  type: AccountType;
  name: string;
  ownerUserId: string | null;
}

/** Parse and validate a chart code; throws on anything outside the chart. */
export function describeAccount(code: string): AccountInfo {
  for (const entry of CHART) {
    const m = entry.pattern.exec(code);
    if (!m) continue;
    const param = m[1] ?? "";
    return { code, type: entry.type, name: entry.name(param), ownerUserId: entry.owned ? param : null };
  }
  throw new RangeError(`unknown ledger account code: ${code}`);
}

export function isAccountCode(code: string): boolean {
  return CHART.some((e) => e.pattern.test(code));
}

function slug(kind: string, value: string): string {
  if (!new RegExp(`^${SLUG}$`).test(value)) throw new RangeError(`invalid ${kind}: ${value}`);
  return value;
}
function userId(value: string): string {
  // Postgres renders uuids in lowercase; normalize so one user never gets two accounts.
  const v = value.toLowerCase();
  if (!new RegExp(`^${UUID}$`).test(v)) throw new RangeError(`invalid user id: ${value}`);
  return v;
}

/** Code builders. Use these instead of string literals so typos fail loudly. */
export const accounts = {
  cash: (provider: string) => `asset:cash:${slug("provider", provider)}`,
  providerReceivable: (provider: string) => `asset:receivable:provider:${slug("provider", provider)}`,
  creatorReceivable: (user: string) => `asset:receivable:creator:${userId(user)}`,
  creator: (user: string) => `liability:creator:${userId(user)}`,
  creatorHold: (user: string) => `liability:creator-hold:${userId(user)}`,
  payoutClearing: (user: string) => `liability:payout-clearing:${userId(user)}`,
  taxPayable: () => "liability:tax-payable",
  memberShare: (user: string) => `liability:member-share:${userId(user)}`,
  patronagePayable: (user: string) => `liability:patronage-payable:${userId(user)}`,
  platformCut: () => "revenue:platform-cut",
  paymentFees: () => "expense:payment-fees",
  infrastructure: (category: string) => `expense:infrastructure:${slug("cost category", category)}`,
  retainedSurplus: () => "equity:retained-surplus",
} as const;

/** The `ledger_accounts.code` value for a chart code in a currency. */
export function storedCode(code: string, currency: string): string {
  assertCurrency(currency);
  return `${code}@${currency}`;
}

/** Inverse of `storedCode`. */
export function parseStoredCode(stored: string): { code: string; currency: string } {
  const at = stored.lastIndexOf("@");
  const code = stored.slice(0, at);
  const currency = stored.slice(at + 1);
  if (at <= 0 || !CURRENCY.test(currency)) throw new RangeError(`not a stored account code: ${stored}`);
  return { code, currency };
}

export function assertCurrency(currency: string): void {
  if (!CURRENCY.test(currency)) throw new RangeError(`currency must be a lowercase ISO 4217 code, got ${currency}`);
}

/** Debit-normal types; the others are credit-normal (their natural balance is −sum). */
export function isDebitNormal(type: AccountType): boolean {
  return type === "asset" || type === "expense";
}

/**
 * Get-or-create the rows for `codes` in `currency`, idempotently and safely under
 * concurrency (insert … on conflict do nothing, then read back). Returns chart code → row id.
 */
export async function ensureAccounts(
  db: Executor,
  codes: readonly string[],
  currency: string,
): Promise<Map<string, string>> {
  // Sorted, so concurrent multi-row inserts take row locks in the same order (no deadlocks).
  const unique = [...new Set(codes)].sort();
  if (unique.length === 0) return new Map();
  const rows = unique.map((code) => {
    const info = describeAccount(code);
    return {
      code: storedCode(code, currency),
      type: info.type,
      name: info.name,
      ownerUserId: info.ownerUserId,
      currency,
    };
  });
  await db.insert(schema.ledgerAccounts).values(rows).onConflictDoNothing({ target: schema.ledgerAccounts.code });
  const found = await db
    .select({ id: schema.ledgerAccounts.id, code: schema.ledgerAccounts.code, type: schema.ledgerAccounts.type })
    .from(schema.ledgerAccounts)
    .where(
      inArray(
        schema.ledgerAccounts.code,
        rows.map((r) => r.code),
      ),
    );
  const byStored = new Map(found.map((f) => [f.code, f]));
  const out = new Map<string, string>();
  for (const r of rows) {
    const f = byStored.get(r.code);
    if (!f) throw new Error(`ledger account ${r.code} could not be created`);
    // A pre-existing row with another type means the chart and the database disagree.
    if (f.type !== r.type) throw new Error(`ledger account ${r.code} has type ${f.type}, expected ${r.type}`);
    out.set(parseStoredCode(r.code).code, f.id);
  }
  return out;
}

/** Get-or-create one account; returns its id. */
export async function getOrCreateAccount(db: Executor, code: string, currency: string): Promise<string> {
  const ids = await ensureAccounts(db, [code], currency);
  const id = ids.get(code);
  if (!id) throw new Error(`ledger account ${code} could not be created`);
  return id;
}
