// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** How much the full seed writes. Units derive their own counts from these (never hard-code them). */
export interface SeedScale {
  /** Generated streamer accounts, each with a channel (on top of the fixed logins). */
  streamers: number;
  /** Generated viewer accounts. */
  viewers: number;
  /** Chat lines across all channels. */
  chatLines: number;
  /** Days of history that backdated rows spread over (broadcasts, revenue, reports). */
  historyDays: number;
  /**
   * Multiplier for everything else (payments, proposals, reports, apps, …): each unit picks a
   * base count that fills every list view at `small` and scales it by this.
   */
  factor: number;
}

export const SEED_SCALES = {
  small: { streamers: 10, viewers: 50, chatLines: 5_000, historyDays: 90, factor: 1 },
  medium: { streamers: 100, viewers: 2_000, chatLines: 200_000, historyDays: 365, factor: 10 },
  large: { streamers: 1_000, viewers: 20_000, chatLines: 2_000_000, historyDays: 730, factor: 100 },
} as const satisfies Record<string, SeedScale>;

export type SeedScaleName = keyof typeof SEED_SCALES;

export const SEED_SCALE_NAMES = Object.keys(SEED_SCALES) as SeedScaleName[];

export function isSeedScaleName(v: string): v is SeedScaleName {
  return Object.hasOwn(SEED_SCALES, v);
}
