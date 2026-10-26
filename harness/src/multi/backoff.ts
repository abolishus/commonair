// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The web chat client's reconnect backoff (`apps/web/src/chat/backoff.ts`), so the harness
 * reconnects the way browsers do. A unit test keeps the two identical.
 */
export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Fraction of the delay randomized away (0 = none). */
  jitter?: number;
}

/** Delay before reconnect attempt `n` (0-based): base·2ⁿ capped at max, minus up to `jitter`. */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}, random: () => number = Math.random): number {
  const base = opts.baseMs ?? 500;
  const max = opts.maxMs ?? 30_000;
  const jitter = opts.jitter ?? 0.3;
  const exp = Math.min(max, base * 2 ** Math.max(0, Math.min(attempt, 30)));
  return Math.round(exp * (1 - jitter * random()));
}

/** The first `n` delays a client waits through while every attempt fails. */
export function backoffSchedule(n: number, random: () => number = Math.random, opts: BackoffOptions = {}): number[] {
  return Array.from({ length: n }, (_, i) => backoffDelay(i, opts, random));
}
