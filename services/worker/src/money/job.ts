// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Money jobs are recurring jobs on `QUEUES.payments`, each under a Valkey run lock so two worker
 * replicas (or a retry racing the next tick) never run the same one at once.
 */
import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import type { WorkerContext } from "../context.ts";
import { withRunLock } from "../integrity/lock.ts";
import { defineJob, type JobDefinition, type Schedule } from "../runtime/registry.ts";
import { moneyMetrics } from "./metrics.ts";

export const MONEY_JOBS = {
  expirePending: "money-expire-pending",
  renew: "money-renew",
  releaseHolds: "money-release-holds",
} as const;
export type MoneyJobName = (typeof MONEY_JOBS)[keyof typeof MONEY_JOBS];

export const MONEY_LOCK_TTL_MS = 30_000;
export const moneyLockKey = (name: MoneyJobName) => `worker:lock:money:${name}`;

export type MoneyRun = { skipped: true } | Record<string, unknown>;

/** Run `fn` under the job's lock; a run that finds the lock taken is a counted no-op. */
export async function withMoneyLock(
  ctx: WorkerContext,
  name: MoneyJobName,
  maxRunMs: number,
  fn: () => Promise<Record<string, unknown>>,
): Promise<MoneyRun> {
  const r = await withRunLock(
    ctx.valkey,
    moneyLockKey(name),
    { ttlMs: MONEY_LOCK_TTL_MS, maxHoldMs: maxRunMs, job: name, logger: ctx.logger },
    fn,
  );
  moneyMetrics.runs.add(1, { job: name, outcome: r.acquired ? "ran" : "skipped" });
  if (!r.acquired) {
    ctx.logger.debug("money job skipped: previous run still in progress", { job: name });
    return { skipped: true };
  }
  return r.value;
}

export function moneyJob(
  name: MoneyJobName,
  description: string,
  schedule: Schedule,
  maxRunMs: number,
  run: (ctx: WorkerContext) => Promise<Record<string, unknown>>,
): JobDefinition {
  return defineJob({
    queue: QUEUES.payments,
    name,
    description,
    data: z.object({}),
    schedule,
    attempts: 3,
    backoffMs: 10_000,
    handler: async (_data, ctx) => withMoneyLock(ctx, name, maxRunMs, () => run(ctx)),
  });
}
