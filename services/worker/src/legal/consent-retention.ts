// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Retention for signed-out cookie-consent records. A signed-out visitor's choice is stored with a
 * random first-party id (`consent_records.anonymous_id`); once the cookie carrying that id has long
 * expired the row proves nothing about anyone, so it goes. Signed-in rows stay: they are deleted
 * with the account (`on delete cascade`).
 *
 * Scheduled retention, not a moderator or admin decision, so it writes no audit row.
 */
import type { WorkerContext } from "../context.ts";

const DAY_MS = 86_400_000;

/**
 * About 13 months: the usual lifetime of a consent cookie (and the longest European regulators
 * accept before asking again), after which the record of that choice has no further use.
 * A policy choice: the cookie and privacy policies should state it.
 */
export const ANONYMOUS_CONSENT_RETENTION_DAYS = 395;

/** Rows per delete statement: short transactions, no long lock on the table. */
export const CONSENT_RETENTION_BATCH = 1_000;

/** Wall-clock budget per run; whatever is left waits for the next daily run. */
export const CONSENT_RETENTION_BUDGET_MS = 30_000;

export interface ConsentRetentionOptions {
  retentionDays?: number;
  batchSize?: number;
  budgetMs?: number;
  /** Milliseconds from any fixed origin (tests advance it to exhaust the budget). */
  clock?: () => number;
}

export async function deleteOldAnonymousConsent(
  ctx: Pick<WorkerContext, "sql" | "logger" | "now">,
  opts: ConsentRetentionOptions = {},
): Promise<{ deleted: number }> {
  const retentionDays = opts.retentionDays ?? ANONYMOUS_CONSENT_RETENTION_DAYS;
  const batchSize = opts.batchSize ?? CONSENT_RETENTION_BATCH;
  const budgetMs = opts.budgetMs ?? CONSENT_RETENTION_BUDGET_MS;
  const clock = opts.clock ?? (() => performance.now());
  const cutoff = new Date(ctx.now().getTime() - retentionDays * DAY_MS).toISOString();
  const started = clock();
  let deleted = 0;
  let batches = 0;
  let complete = false;
  while (!complete) {
    // Each batch is chosen by id so the partial index on created_at (where user_id is null) serves it.
    const r = await ctx.sql`
      delete from consent_records
       where id in (
         select id from consent_records
          where user_id is null and created_at < ${cutoff}::timestamptz
          order by created_at
          limit ${batchSize})`;
    deleted += r.count;
    batches += 1;
    complete = r.count < batchSize;
    if (!complete && clock() - started >= budgetMs) break;
  }
  if (deleted > 0) ctx.logger.info("anonymous consent records deleted", { deleted, batches, complete });
  return { deleted };
}
