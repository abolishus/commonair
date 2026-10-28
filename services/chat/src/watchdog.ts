// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Bounds and diagnostics for awaits that must not hang a client: a dependency that stops
 * answering (a half-open Postgres socket, a stalled DNS lookup) should cost a 503, not a
 * connection attempt that never answers.
 */

export class DeadlineError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`deadline of ${timeoutMs} ms exceeded`);
    this.name = "DeadlineError";
  }
}

/** Resolves like `p`, or rejects with `DeadlineError` once `ms` pass first. `p` is left running. */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError(ms)), ms);
  });
  // The loser must not surface as an unhandled rejection.
  p.catch(() => undefined);
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Calls `onStall(lagMs)` when a timer fires `thresholdMs` or more late: a blocked event loop
 * hangs every socket and upgrade at once, and would otherwise leave no trace in the logs.
 */
export function watchEventLoop(onStall: (lagMs: number) => void, intervalMs = 500, thresholdMs = 1_000): () => void {
  let expected = performance.now() + intervalMs;
  const timer = setInterval(() => {
    const now = performance.now();
    const lag = now - expected;
    expected = now + intervalMs;
    if (lag >= thresholdMs) onStall(Math.round(lag));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
