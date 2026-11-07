// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Automatic retries for loads that hit a busy (429) or unreachable (502/503/504, network) API
 * (F2). A few spaced attempts, the server's `retryAfterSeconds` when it gives one, and then the
 * page's Retry button is all that is left: retrying forever would only add to the load.
 */
import { isTransientFailure, retryAfterSeconds } from "./load-failure.ts";

export interface BackoffOptions {
  /** Automatic retries after the first failure (default 3). */
  attempts?: number;
  /** The first wait without a server hint, doubled on each retry (default 2 s). */
  baseMs?: number;
  /** No wait is longer (default 30 s). */
  maxMs?: number;
  /** For tests: the jitter source (default `Math.random`). */
  random?: () => number;
}

export const AUTO_RETRY_ATTEMPTS = 3;
export const AUTO_RETRY_BASE_MS = 2_000;
export const AUTO_RETRY_MAX_MS = 30_000;
/** A hint of 0 s still waits this long, so a burst of clients does not come straight back. */
export const AUTO_RETRY_MIN_MS = 1_000;

/**
 * How long to wait before automatic retry number `attempt` (0 for the first) after `err`, or null
 * when there is none: the failure is not transient, or the retries ran out. Without a hint the wait
 * doubles from `baseMs` with ±25 % jitter, so clients that failed together do not retry together.
 */
export function autoRetryDelay(err: unknown, attempt: number, opts: BackoffOptions = {}): number | null {
  const { attempts = AUTO_RETRY_ATTEMPTS, baseMs = AUTO_RETRY_BASE_MS, maxMs = AUTO_RETRY_MAX_MS } = opts;
  if (!isTransientFailure(err) || attempt < 0 || attempt >= attempts) return null;
  const hinted = retryAfterSeconds(err);
  if (hinted !== null) return Math.min(maxMs, Math.max(AUTO_RETRY_MIN_MS, Math.ceil(hinted * 1000)));
  const random = opts.random ?? Math.random;
  const jitter = 0.75 + Math.min(1, Math.max(0, random())) * 0.5;
  return Math.min(maxMs, Math.max(AUTO_RETRY_MIN_MS, Math.round(baseMs * 2 ** attempt * jitter)));
}

/** Whether the automatic retries for `err` ran out after `attempt` of them (Retry is all that is left). */
export function autoRetriesExhausted(err: unknown, attempt: number, opts: BackoffOptions = {}): boolean {
  return isTransientFailure(err) && autoRetryDelay(err, attempt, opts) === null;
}

/** Resolves after `ms`, or rejects with the signal's reason once it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface WithBackoffOptions extends BackoffOptions {
  signal?: AbortSignal;
  /** Called before each wait (for a "Retrying in N seconds" note). */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** For tests. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** `load()`, retried by itself on busy or unreachable answers; the last failure is rethrown. */
export async function withBackoff<T>(load: () => Promise<T>, opts: WithBackoffOptions = {}): Promise<T> {
  const wait = opts.wait ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await load();
    } catch (error) {
      const delayMs = autoRetryDelay(error, attempt, opts);
      if (delayMs === null || opts.signal?.aborted) throw error;
      opts.onRetry?.({ attempt, delayMs, error });
      await wait(delayMs, opts.signal);
    }
  }
}
