// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Channel points accrual (ADR 0026 decision 1), owned by E8-points. Points accrue only for
 * gate-eligible watch time, in whole blocks, up to a daily cap per viewer per channel. The math is
 * pure; `readPointsAccrual` reads the instance setting the worker's `points-accrue` job applies.
 */
import { eq } from "drizzle-orm";
import { PointsAccrualSetting } from "@commonair/contracts/shapes";
import { schema, type Executor } from "@commonair/db";

export const POINTS_ACCRUAL_KEY = "interact.points.accrual";

/** The seeded default (`DEFAULT_GOVERNANCE_SETTINGS`): 10 points per 5 minutes, 1,000 a day. */
export const DEFAULT_POINTS_ACCRUAL: PointsAccrualSetting = Object.freeze({
  pointsPerBlock: 10,
  blockMinutes: 5,
  dailyCapPerChannel: 1000,
});

/** A viewer's accrual state on one channel (`loyalty_accruals`). */
export interface AccrualState {
  /** Eligible seconds not yet worth a whole block. */
  carrySeconds: number;
  /** The UTC day (`YYYY-MM-DD`) `dayPoints` counts. */
  day: string;
  dayPoints: number;
}

export interface AccrualResult {
  state: AccrualState;
  /** Points to credit now (0 when nothing is due or the cap is reached). */
  points: number;
}

/** `YYYY-MM-DD` of `at` in UTC. */
export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

const wholeNonNegative = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

/**
 * Add `eligibleSeconds` of gate-eligible watch time to `state` (null: the viewer's first time on
 * the channel). A new UTC day resets `dayPoints` but keeps the carry. Every whole block is used
 * up: blocks under the cap are credited, the rest are dropped (the cap is reached exactly, so a
 * block that crosses it is credited only up to the cap), and the remainder under one block is
 * carried, also at the cap.
 */
export function accrue(
  setting: PointsAccrualSetting,
  state: AccrualState | null,
  eligibleSeconds: number,
  now: Date,
): AccrualResult {
  const today = utcDay(now);
  const carry = wholeNonNegative(state?.carrySeconds ?? 0);
  const dayPoints = state && state.day === today ? wholeNonNegative(state.dayPoints) : 0;
  const total = carry + wholeNonNegative(eligibleSeconds);
  const blockSeconds = setting.blockMinutes * 60;
  const blocks = Math.floor(total / blockSeconds);
  const room = Math.max(0, setting.dailyCapPerChannel - dayPoints);
  const points = Math.min(blocks * setting.pointsPerBlock, room);
  return {
    state: { carrySeconds: total - blocks * blockSeconds, day: today, dayPoints: dayPoints + points },
    points,
  };
}

/**
 * How many of a viewer's new seconds on one channel count, when several sessions grew since the
 * last run: one viewer's concurrent sessions count once (decided 2026-10-29). At most the
 * wall-clock seconds since the previous run (`sinceLastRunSeconds`, null on the first run), but
 * never less than the largest single session's growth: heartbeats land on their own clock, so one
 * session can report a little more than the time between two runs, and that time is real.
 */
export function creditableSeconds(newSecondsPerSession: readonly number[], sinceLastRunSeconds: number | null): number {
  const grown = newSecondsPerSession.map(wholeNonNegative);
  const sum = grown.reduce((a, b) => a + b, 0);
  const largest = grown.reduce((a, b) => Math.max(a, b), 0);
  if (sinceLastRunSeconds === null) return largest;
  return Math.min(sum, Math.max(wholeNonNegative(sinceLastRunSeconds), largest));
}

type ErrorLog = { error(msg: string, fields?: Record<string, unknown>): void };

/**
 * A stored `interact.points.accrual` value, or the defaults (logged) when it is missing or invalid.
 * The database range-checks the value, so the fallback is a belt-and-braces path, not an expected one.
 */
export function parsePointsAccrual(value: unknown, log?: ErrorLog): PointsAccrualSetting {
  const parsed = PointsAccrualSetting.safeParse(value);
  if (parsed.success) return parsed.data;
  log?.error("points accrual setting missing or invalid; using the defaults", {
    key: POINTS_ACCRUAL_KEY,
    missing: value === undefined,
    issues: parsed.error.issues.map((i) => i.path.join(".")),
  });
  return { ...DEFAULT_POINTS_ACCRUAL };
}

/**
 * The `interact.points.accrual` governance setting, read on every run so a decision takes effect
 * without a deploy (the pattern of `packages/integrity/src/thresholds.ts`).
 */
export async function readPointsAccrual(db: Executor, log?: ErrorLog): Promise<PointsAccrualSetting> {
  const [row] = await db
    .select({ value: schema.governanceSettings.value })
    .from(schema.governanceSettings)
    .where(eq(schema.governanceSettings.key, POINTS_ACCRUAL_KEY));
  return parsePointsAccrual(row?.value, log);
}
