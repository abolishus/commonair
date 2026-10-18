// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

const MINUTE = 60_000;

/** Delays before retries 1–4; with 5 attempts in total a delivery spans about 2.6 h. */
export const DEFAULT_BACKOFF_MS = [1 * MINUTE, 5 * MINUTE, 30 * MINUTE, 120 * MINUTE] as const;

/** ±fraction of the base delay; spreads retries so a recovering receiver is not hit in lockstep. */
export const JITTER = 0.1;

/**
 * Delay before the attempt after `attempt` (1-based), or null when no attempt remains.
 * Past the end of the schedule the last delay repeats, so a larger maxAttempts still works.
 */
export function nextRetryDelay(
  attempt: number,
  maxAttempts: number,
  schedule: readonly number[] = DEFAULT_BACKOFF_MS,
  random: () => number = Math.random,
): number | null {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt >= maxAttempts || schedule.length === 0) return null;
  const base = schedule[Math.min(attempt - 1, schedule.length - 1)] ?? 0;
  const jitter = base * JITTER * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}
