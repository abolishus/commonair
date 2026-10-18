// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The job registry. Each job lives in `src/jobs/<name>.ts` and exports a
 * definition made with `defineJob`; `src/jobs/index.ts` lists them. The runtime
 * creates one BullMQ worker per queue that dispatches by job name.
 */
import type { z } from "zod";
import type { WorkerContext } from "../context.ts";
import { QUEUE_NAMES, type QueueName } from "../env.ts";

export type Schedule = { every: number } | { pattern: string; tz?: string };

export interface JobMeta {
  id: string | undefined;
  /** BullMQ attempts already made before this run (0 on the first run). */
  attemptsMade: number;
}

export interface JobDefinition<S extends z.ZodType = z.ZodType> {
  queue: QueueName;
  name: string;
  description: string;
  /** Payload schema, enforced before the handler runs. */
  data: S;
  /** Present for recurring jobs: registered as a BullMQ job scheduler (one run per tick cluster-wide). */
  schedule?: Schedule;
  /**
   * BullMQ-level retries for infrastructure errors (DB/Valkey down). Webhook HTTP
   * retries are not these: they are scheduled explicitly as new jobs.
   */
  attempts?: number;
  handler: (data: z.output<S>, ctx: WorkerContext, meta: JobMeta) => Promise<unknown>;
}

export const defineJob = <S extends z.ZodType>(def: JobDefinition<S>): JobDefinition<S> => def;

export type Registry = ReadonlyMap<QueueName, ReadonlyMap<string, JobDefinition>>;

/** Validate a list of definitions and index them by queue and name. */
export function buildRegistry(defs: readonly JobDefinition[]): Registry {
  const byQueue = new Map<QueueName, Map<string, JobDefinition>>();
  for (const def of defs) {
    if (!QUEUE_NAMES.includes(def.queue)) throw new Error(`job "${def.name}": unknown queue "${def.queue}"`);
    if (!/^[a-z][a-z0-9-]*$/.test(def.name)) throw new Error(`job "${def.name}": names are kebab-case`);
    if (def.schedule && "every" in def.schedule && !(def.schedule.every >= 1000))
      throw new Error(`job "${def.name}": schedules run at most once per second`);
    const jobs = byQueue.get(def.queue) ?? new Map<string, JobDefinition>();
    if (jobs.has(def.name)) throw new Error(`job "${def.name}" registered twice on queue "${def.queue}"`);
    jobs.set(def.name, def);
    byQueue.set(def.queue, jobs);
  }
  return byQueue;
}

export const scheduledJobs = (registry: Registry): JobDefinition[] =>
  [...registry.values()].flatMap((jobs) => [...jobs.values()].filter((j) => j.schedule));
