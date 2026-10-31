// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** seed-money: subscriptions, tips, payments, disputes, payouts, fraud holds, costs and the ledger. Brief: `.claude/briefs/seed-full/seed-money.md`. */
import type { SeedUnit } from "./types.ts";

const TABLES = [
  "subscriptions",
  "tips",
  "payments",
  "payment_events",
  "disputes",
  "payout_accounts",
  "payouts",
  "payment_fraud_flags",
  "infra_costs",
  "ledger_accounts",
  "ledger_transactions",
  "ledger_entries",
] as const;

export const unit: SeedUnit = {
  name: "money",
  after: ["social"],
  tables: TABLES,
  pending: TABLES,
  async run() {
    return { rows: {}, notes: ["seed-money: not implemented yet"] };
  },
};
