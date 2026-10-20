// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `moderation.thresholds` governance setting and the score → tier mapping. The database
 * range-checks the setting (migration 0016); `parseThresholds` checks it again with the same
 * ranges and falls back to the defaults if it is somehow invalid (fail closed).
 */
import { MODERATION_CATEGORIES, type ModerationCategory } from "@commonair/contracts/enums";
import type { ModerationScores } from "@commonair/contracts/internal";

export interface Thresholds {
  t1: Record<ModerationCategory, number>;
  t2: { sexual: number };
  sampleSeconds: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  t1: { sexual: 0.97, graphic_violence: 0.9, weapons: 0.95, self_harm: 0.9 },
  t2: { sexual: 0.8 },
  sampleSeconds: 10,
};

/** Inclusive ranges, identical to `commonair_validate_moderation`. */
export const THRESHOLD_RANGES = {
  t1: {
    sexual: [0.85, 0.995],
    graphic_violence: [0.5, 0.995],
    weapons: [0.5, 0.995],
    self_harm: [0.5, 0.995],
  } satisfies Record<ModerationCategory, readonly [number, number]>,
  t2Sexual: [0.5, 0.95],
  sampleSeconds: [5, 60],
} as const;

const inRange = (v: unknown, [lo, hi]: readonly [number, number]): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/** The setting's value, or `null` if any part is missing or out of range. */
export function validThresholds(value: unknown): Thresholds | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as { t1?: Record<string, unknown>; t2?: Record<string, unknown>; sampleSeconds?: unknown };
  if (typeof v.t1 !== "object" || v.t1 === null || typeof v.t2 !== "object" || v.t2 === null) return null;
  const t1 = {} as Record<ModerationCategory, number>;
  for (const c of MODERATION_CATEGORIES) {
    const x = v.t1[c];
    if (!inRange(x, THRESHOLD_RANGES.t1[c])) return null;
    t1[c] = x;
  }
  const t2 = v.t2.sexual;
  if (!inRange(t2, THRESHOLD_RANGES.t2Sexual) || t2 >= t1.sexual) return null;
  const s = v.sampleSeconds;
  if (!inRange(s, THRESHOLD_RANGES.sampleSeconds) || !Number.isInteger(s)) return null;
  return { t1, t2: { sexual: t2 }, sampleSeconds: s };
}

/** Fail closed: an invalid setting means the defaults, never "off". */
export const parseThresholds = (value: unknown): { thresholds: Thresholds; valid: boolean } => {
  const t = validThresholds(value);
  return t ? { thresholds: t, valid: true } : { thresholds: DEFAULT_THRESHOLDS, valid: false };
};

/** The effective live sample interval: the smaller of the env value and the setting. */
export const effectiveSampleSeconds = (envSeconds: number, thresholds: Thresholds) =>
  Math.min(envSeconds, thresholds.sampleSeconds);

export type TierDecision =
  | { tier: "t1"; category: ModerationCategory; score: number }
  | { tier: "t2"; category: "sexual"; score: number }
  | { tier: null };

/**
 * Map classifier scores to the action tier. T1 wins over T2; among T1 categories the one
 * furthest above its threshold wins. Unscored categories (absent) never fire. T2 applies only to
 * a channel not already labelled mature.
 */
export function tierFor(scores: ModerationScores, thresholds: Thresholds, ctx: { mature: boolean }): TierDecision {
  let best: { category: ModerationCategory; score: number; margin: number } | null = null;
  for (const c of MODERATION_CATEGORIES) {
    const s = scores[c];
    if (s === undefined || !Number.isFinite(s)) continue;
    const margin = s - thresholds.t1[c];
    if (margin >= 0 && (best === null || margin > best.margin)) best = { category: c, score: s, margin };
  }
  if (best) return { tier: "t1", category: best.category, score: best.score };
  const sexual = scores.sexual;
  if (!ctx.mature && sexual !== undefined && Number.isFinite(sexual) && sexual >= thresholds.t2.sexual)
    return { tier: "t2", category: "sexual", score: sexual };
  return { tier: null };
}
