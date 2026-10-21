// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Bounded exponential backoff for work that must land (the T0 transaction, evidence copies).
 * In-process retries ride out a brief database blip; after them the job throws and BullMQ retries
 * it again with its own backoff, so a longer outage still ends with the work applied.
 */

export interface RetryOptions {
  /** Total tries, including the first (≥ 1). */
  attempts: number;
  baseMs: number;
  maxMs: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called after each failed try that will be retried. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

/** Delay before retry number `attempt` (1-based): base · 2^(attempt-1), capped at `maxMs`. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError("attempt is 1-based");
  return Math.min(maxMs, baseMs * 2 ** Math.min(attempt - 1, 30));
}

export async function retryWithBackoff<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const attempts = Math.max(1, Math.floor(opts.attempts));
  const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= attempts) throw err;
      const delay = backoffDelay(attempt, opts.baseMs, opts.maxMs);
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
}
