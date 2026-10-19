// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { loadEnv, paymentsEnv } from "@commonair/config";

/** Tunables of the money jobs. Cut and payout rules are not here: they come from governance per run. */
export interface MoneyJobConfig {
  /** Instance currency (`CURRENCY`) for renewal payments. */
  currency: string;
  /** `PAYMENT_PENDING_DAYS`: how long a renewal payment stays open after the period ends. */
  pendingDays: number;
  /** Rows per transaction for the expiry sweep, and per page for renewals. */
  batchSize: number;
  /** Time budget of one run; the rest waits for the next tick. */
  budgetMs: number;
}

export const MONEY_BATCH_SIZE = 500;
export const MONEY_BUDGET_MS = 30_000;

const moneyEnv = paymentsEnv.pick({ CURRENCY: true, PAYMENT_PENDING_DAYS: true });
let cached: MoneyJobConfig | undefined;

/**
 * The worker's payment env (validated at startup as part of `workerEnv`), read once per process.
 * The context does not carry env, so the jobs read it here.
 */
export function moneyConfigFromEnv(source?: Record<string, string | undefined>): MoneyJobConfig {
  if (!source && cached) return cached;
  const env = loadEnv(moneyEnv, source ?? process.env);
  const cfg: MoneyJobConfig = {
    currency: env.CURRENCY,
    pendingDays: env.PAYMENT_PENDING_DAYS,
    batchSize: MONEY_BATCH_SIZE,
    budgetMs: MONEY_BUDGET_MS,
  };
  if (!source) cached = cfg;
  return cfg;
}
