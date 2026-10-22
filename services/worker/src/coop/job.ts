// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Co-op jobs (E5, docs/testing/e5-selectors.md) are recurring jobs on `QUEUES.coop` with an
 * empty payload. The API's test hook (`COOP_TEST_HOOKS`) enqueues the same jobs and waits for
 * their `CoopJobResult`. Each run holds a Valkey run lock so replicas do not duplicate work; the
 * database row locks and compare-and-set transitions are the real guard, so an overlapping run
 * is harmless. A run that finds the lock taken waits briefly for it, so a test-hook tick that
 * lands during a scheduled run still does its work once that run finishes.
 */
import { CoopJob, CoopJobResult, QUEUES, type CoopJobName } from "@commonair/contracts/internal";
import type { WorkerContext } from "../context.ts";
import { withRunLock, type LockResult } from "../integrity/lock.ts";
import { defineJob, type JobDefinition, type Schedule } from "../runtime/registry.ts";
import { coopMetrics } from "./metrics.ts";

export const COOP_LOCK_TTL_MS = 30_000;
/** How long a run waits for a run in progress before it gives up as `skipped`. */
export const COOP_LOCK_WAIT_MS = 20_000;
const LOCK_POLL_MS = 200;

export const coopLockKey = (name: CoopJobName) => `worker:lock:coop:${name}`;

export interface CoopLockOptions {
  maxRunMs: number;
  waitMs?: number;
  pollMs?: number;
}

/**
 * Run `fn` under the job's lock, waiting up to `waitMs` for a run in progress. Returns the
 * counts, or `{ skipped: 1 }` when the lock never came free.
 */
export async function withCoopLock(
  ctx: WorkerContext,
  name: CoopJobName,
  opts: CoopLockOptions,
  fn: () => Promise<CoopJobResult>,
): Promise<CoopJobResult> {
  const deadline = Date.now() + (opts.waitMs ?? COOP_LOCK_WAIT_MS);
  let r: LockResult<CoopJobResult>;
  for (;;) {
    r = await withRunLock(
      ctx.valkey,
      coopLockKey(name),
      { ttlMs: COOP_LOCK_TTL_MS, maxHoldMs: opts.maxRunMs, job: name, logger: ctx.logger },
      fn,
    );
    if (r.acquired || Date.now() >= deadline) break;
    await Bun.sleep(opts.pollMs ?? LOCK_POLL_MS);
  }
  coopMetrics.runs.add(1, { job: name, outcome: r.acquired ? "ran" : "skipped" });
  if (!r.acquired) {
    ctx.logger.debug("coop job skipped: another run held the lock", { job: name });
    return { skipped: 1 };
  }
  return r.value;
}

/** Keep only integer counts, the contract's `CoopJobResult`. */
export function counts(o: Record<string, number | boolean | null | undefined>): CoopJobResult {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "number" && Number.isInteger(v)) out[k] = v;
    else if (typeof v === "boolean") out[k] = v ? 1 : 0;
  }
  return CoopJobResult.parse(out);
}

export function coopJob(
  name: CoopJobName,
  description: string,
  schedule: Schedule,
  maxRunMs: number,
  run: (ctx: WorkerContext) => Promise<CoopJobResult>,
): JobDefinition {
  return defineJob({
    queue: QUEUES.coop,
    name,
    description,
    data: CoopJob,
    schedule,
    attempts: 3,
    backoffMs: 5_000,
    handler: async (_data, ctx) => {
      const result = await withCoopLock(ctx, name, { maxRunMs }, () => run(ctx));
      if (Object.values(result).some((v) => v > 0)) ctx.logger.info("coop job ran", { job: name, ...result });
      return result;
    },
  });
}
