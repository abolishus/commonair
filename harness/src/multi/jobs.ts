// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Recurring jobs with two workers: BullMQ job schedulers (`upsertJobScheduler`,
 * services/worker/src/runtime/runtime.ts) enqueue one job per tick cluster-wide, with the id
 * `repeat:<scheduler>:<tick millis>`, and a job runs on one worker. What a second worker could
 * break is visible in the completed jobs BullMQ keeps (`removeOnComplete: { count: 100 }`): ticks
 * closer together than the interval (a second scheduler), ticks missing, or a run started more
 * than once (`ats` > 1, or stalled and picked up again). Pure.
 */

export interface JobRun {
  id: string;
  scheduler: string;
  tickMs: number;
  processedOn: number | null;
  finishedOn: number | null;
  /** Times a worker started it (BullMQ `ats`, falling back to `atm`). */
  attemptsStarted: number;
  /** Times it was found stalled (its worker died or blocked) and moved back to wait. */
  stalled: number;
}

/** `repeat:<scheduler>:<millis>` → scheduler and tick, or null for other jobs. */
export function parseSchedulerJobId(id: string): { scheduler: string; tickMs: number } | null {
  const m = /^repeat:(.+):(\d+)$/.exec(id);
  if (!m?.[1] || !m[2]) return null;
  return { scheduler: m[1], tickMs: Number(m[2]) };
}

const int = (v: string | undefined): number | null => {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A completed scheduler job from its id and its BullMQ hash (HGETALL). */
export function jobRunFromHash(id: string, hash: Readonly<Record<string, string>>): JobRun | null {
  const parsed = parseSchedulerJobId(id);
  if (!parsed) return null;
  return {
    id,
    ...parsed,
    processedOn: int(hash.processedOn),
    finishedOn: int(hash.finishedOn),
    attemptsStarted: int(hash.ats) ?? int(hash.atm) ?? int(hash.attemptsMade) ?? 1,
    stalled: int(hash.stc) ?? 0,
  };
}

export interface SchedulerReport {
  scheduler: string;
  everyMs: number;
  /** Distinct ticks completed inside the window. */
  ticks: number;
  /** Ticks the interval allows inside the window (⌊window / every⌋). */
  expectedTicks: number;
  /** Smallest distance between consecutive completed ticks (null with fewer than two). */
  minGapMs: number | null;
  /** Consecutive ticks closer than the interval: a second producer. */
  tooClose: number;
  /** Runs started more than once or recovered from a stall. */
  rerun: string[];
}

/**
 * The runs of one `every` scheduler whose tick lies in [fromMs, toMs). Exactly once per tick
 * means: ticks spaced exactly `everyMs`, as many as the window holds (±1 at the edges), none
 * started twice.
 */
export function schedulerReport(
  runs: readonly JobRun[],
  scheduler: string,
  everyMs: number,
  fromMs: number,
  toMs: number,
): SchedulerReport {
  const mine = runs.filter((r) => r.scheduler === scheduler && r.tickMs >= fromMs && r.tickMs < toMs);
  const ticks = [...new Set(mine.map((r) => r.tickMs))].sort((a, b) => a - b);
  let minGapMs: number | null = null;
  let tooClose = 0;
  for (let i = 1; i < ticks.length; i++) {
    const gap = (ticks[i] as number) - (ticks[i - 1] as number);
    minGapMs = minGapMs === null ? gap : Math.min(minGapMs, gap);
    if (gap < everyMs) tooClose++;
  }
  return {
    scheduler,
    everyMs,
    ticks: ticks.length,
    expectedTicks: Math.floor(Math.max(0, toMs - fromMs) / everyMs),
    minGapMs,
    tooClose,
    rerun: mine.filter((r) => r.attemptsStarted > 1 || r.stalled > 0).map((r) => r.id),
  };
}

export const oncePerTick = (r: SchedulerReport): boolean =>
  r.tooClose === 0 && r.rerun.length === 0 && Math.abs(r.ticks - r.expectedTicks) <= 1 && r.ticks > 0;
