// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Channel points from watch time, through the worker: after the seeded sessions land, run the
 * worker's `points-accrue` job through the interactivity test hook (`INTERACT_TEST_HOOKS`) until
 * every seeded session has its high-water mark (`loyalty_accrual_sessions`). The worker credits
 * demo users only with `DEMO_SEED_FULL=true`, so a run that credits nothing fails at once and says
 * so. The worker's own one-minute schedule may credit some sessions first; that counts too.
 */
import { INTERACT_JOBS } from "@commonair/contracts/internal";
import type { DbHandle } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import { type InteractHooks, InteractHooksOff } from "../../e8/kit.ts";
import { HOUR_MS, WATCH_LOOKBACK_MS } from "./plan.ts";
import { SEED_USER_AGENT } from "./write.ts";

/** Pairs the worker handles per run (`ACCRUAL_MAX_VIEWERS`). */
export const ACCRUAL_PAIRS_PER_RUN = 5_000;

export interface AccrualOutcome {
  ms: number;
  runs: number;
  /** Seeded sessions the worker has counted. */
  counted: number;
  /** `watch` points credited on the seeded sessions' channels. */
  points: number;
}

/** How many ticks to try before giving up: enough runs for every pair, plus slack. Pure. */
export function accrualRuns(sessions: number): number {
  return Math.ceil(sessions / ACCRUAL_PAIRS_PER_RUN) + 3;
}

/** Room left inside the worker's look-back for the accrual runs themselves. */
export const WATCH_LOOKBACK_MARGIN_MS = 2 * HOUR_MS;

/**
 * Throws when the oldest seeded session was scored too long ago for the worker to still read it
 * (`SCORED_LOOKBACK_MS`, 6 h, less a margin for the accrual runs), so a stale anchor fails with
 * its real cause instead of the DEMO_SEED_FULL hint. Pure.
 */
export function assertWatchInLookback(scoredAt: readonly Date[], nowMs: number): void {
  if (scoredAt.length === 0) return;
  const oldest = Math.min(...scoredAt.map((d) => d.getTime()));
  const age = nowMs - oldest;
  if (age > WATCH_LOOKBACK_MS - WATCH_LOOKBACK_MARGIN_MS)
    throw new Error(
      `seed-interact: the seeded watch sessions were scored ${(age / HOUR_MS).toFixed(1)} h ago, outside the worker's 6 h scoring look-back less ${WATCH_LOOKBACK_MARGIN_MS / HOUR_MS} h for the accrual runs: their timestamps were anchored too long before accrual`,
    );
}

export const DEMO_SEED_FULL_HINT =
  "points accrual credited nothing to the seeded viewers: set DEMO_SEED_FULL=true on the worker (it credits demo users only then) and INTERACT_TEST_HOOKS=true on the api and worker";

async function progress(h: DbHandle): Promise<{ counted: number; points: number }> {
  const [c] = await h.sql<{ n: number }[]>`
    select count(*)::int as n from loyalty_accrual_sessions las
      join playback_sessions ps on ps.id = las.session_id
     where ps.user_agent = ${SEED_USER_AGENT}`;
  const [p] = await h.sql<{ n: string }[]>`
    select coalesce(sum(delta), 0)::text as n from loyalty_transactions where reason = 'watch'`;
  return { counted: Number(c?.n ?? 0), points: Number(p?.n ?? 0) };
}

export async function runAccrual(
  h: DbHandle,
  hooks: InteractHooks,
  sessions: number,
  o: { signal: AbortSignal; log: Pick<Logger, "info" | "warn"> },
): Promise<AccrualOutcome> {
  const started = Date.now();
  if (sessions === 0) return { ms: 0, runs: 0, counted: 0, points: 0 };
  let runs = 0;
  let state = await progress(h);
  for (let i = 0; i < accrualRuns(sessions) && state.counted < sessions; i++) {
    o.signal.throwIfAborted();
    try {
      runs++;
      const r = await hooks.tick(INTERACT_JOBS.pointsAccrue);
      o.log.info("seed-interact: points-accrue run", { viewers: r.viewers ?? null, points: r.points ?? null });
    } catch (err) {
      if (err instanceof InteractHooksOff) throw err;
      // A large run can outlast the hook's wait while the job carries on; the count says where it got.
      o.log.warn("seed-interact: points-accrue tick did not finish in time", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    state = await progress(h);
    if (state.points === 0) throw new Error(`seed-interact: ${DEMO_SEED_FULL_HINT}`);
  }
  if (state.counted < sessions)
    throw new Error(
      `seed-interact: the worker counted ${state.counted} of ${sessions} seeded sessions after ${runs} points-accrue runs`,
    );
  return { ms: Date.now() - started, runs, counted: state.counted, points: state.points };
}
