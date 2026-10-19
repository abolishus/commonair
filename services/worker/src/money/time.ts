// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Pure time arithmetic and the batch loop shared by the money jobs (unit-tested with a fake clock). */

export const DAY_MS = 86_400_000;

/** When a renewal payment opened at `periodEnd` expires unpaid: the period end plus the pending window. */
export function renewalExpiresAt(periodEnd: Date, pendingDays: number): Date {
  if (!Number.isInteger(pendingDays) || pendingDays < 1) throw new RangeError("pendingDays must be a positive integer");
  return new Date(periodEnd.getTime() + pendingDays * DAY_MS);
}

/** A pending payment is expired once `expiresAt` is at or before `now`; no expiry means it never expires. */
export const isExpired = (expiresAt: Date | null, now: Date): boolean =>
  expiresAt !== null && expiresAt.getTime() <= now.getTime();

/** A subscription period is due for renewal handling once its end is at or before `now`. */
export const isPeriodOver = (periodEnd: Date | null, now: Date): boolean =>
  periodEnd !== null && periodEnd.getTime() <= now.getTime();

export interface BatchLoopOptions {
  /** Rows one step may take (≤ 500 per transaction). */
  batchSize: number;
  /** Stop starting new batches once this much time has passed. */
  budgetMs: number;
  /** Milliseconds; injectable for tests. */
  clock?: () => number;
}

export interface BatchLoopResult {
  batches: number;
  rows: number;
  /** True when the budget ran out with rows possibly left for the next tick. */
  exhausted: boolean;
}

/**
 * Run `step(limit)` until it returns fewer rows than the batch (done) or the time budget is spent.
 * `step` returns how many rows it consumed; a full batch means there may be more.
 */
export async function runBatches(
  opts: BatchLoopOptions,
  step: (limit: number) => Promise<number>,
): Promise<BatchLoopResult> {
  if (!Number.isInteger(opts.batchSize) || opts.batchSize < 1) throw new RangeError("batchSize must be positive");
  const clock = opts.clock ?? Date.now;
  const started = clock();
  let batches = 0;
  let rows = 0;
  for (;;) {
    if (clock() - started >= opts.budgetMs) return { batches, rows, exhausted: true };
    const n = await step(opts.batchSize);
    batches += 1;
    rows += n;
    if (n < opts.batchSize) return { batches, rows, exhausted: false };
  }
}
