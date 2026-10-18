// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  /** Fraction of the delay randomized away (0 = none), so clients do not reconnect in lockstep. */
  jitter?: number;
}

/** Exponential reconnect delay for attempt `n` (0-based): base·2ⁿ capped at max, minus up to `jitter`. */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}, random: () => number = Math.random): number {
  const base = opts.baseMs ?? 500;
  const max = opts.maxMs ?? 30_000;
  const jitter = opts.jitter ?? 0.3;
  const exp = Math.min(max, base * 2 ** Math.max(0, Math.min(attempt, 30)));
  return Math.round(exp * (1 - jitter * random()));
}
