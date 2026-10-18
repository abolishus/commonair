// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * BullMQ runtime: one Queue per queue name (created on first use), one Worker per
 * queue that has registered jobs, and a job scheduler per recurring job.
 */
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import { Queue, UnrecoverableError, Worker, type Job } from "bullmq";
import type { EnqueueOptions, WorkerContext } from "../context.ts";
import type { QueueName } from "../env.ts";
import { metrics } from "../metrics.ts";
import { scheduledJobs, type JobDefinition, type Registry } from "./registry.ts";

export interface RuntimeOptions {
  /** Dedicated Valkey connection without keyPrefix and with maxRetriesPerRequest: null. */
  connection: ValkeyClient;
  /** BullMQ key prefix (tests use a unique one). */
  prefix: string;
  registry: Registry;
  concurrency: Record<QueueName, number>;
  logger: Logger;
}

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 5_000;

export class JobRuntime {
  private readonly queues = new Map<QueueName, Queue>();
  private readonly workers: Worker[] = [];
  private readonly opts: RuntimeOptions;

  constructor(opts: RuntimeOptions) {
    this.opts = opts;
  }

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.opts.connection, prefix: this.opts.prefix });
      q.on("error", (err) => this.opts.logger.error("queue error", { queue: name, err }));
      this.queues.set(name, q);
    }
    return q;
  }

  private definition(queue: QueueName, name: string): JobDefinition | undefined {
    return this.opts.registry.get(queue)?.get(name);
  }

  private prepare(queue: QueueName, name: string, data: unknown, opts: EnqueueOptions) {
    const def = this.definition(queue, name);
    // Validate locally registered payloads at the producer, where a bug is easiest to trace.
    const payload: unknown = def ? def.data.parse(data) : data;
    return {
      name,
      data: payload,
      opts: {
        jobId: opts.jobId,
        delay: opts.delayMs,
        attempts: def?.attempts ?? DEFAULT_ATTEMPTS,
        backoff: { type: "exponential", delay: def?.backoffMs ?? DEFAULT_BACKOFF_MS },
        removeOnComplete: { age: 3600, count: 5000 },
        removeOnFail: { age: 7 * 24 * 3600, count: 10_000 },
      },
    };
  }

  readonly enqueue = async (queue: QueueName, name: string, data: unknown, opts: EnqueueOptions = {}) => {
    const job = this.prepare(queue, name, data, opts);
    await this.queue(queue).add(job.name, job.data, job.opts);
  };

  /** Many jobs in one round trip (one MULTI). */
  readonly enqueueBulk = async (
    queue: QueueName,
    jobs: readonly { name: string; data: unknown; opts?: EnqueueOptions }[],
  ) => {
    if (jobs.length === 0) return;
    await this.queue(queue).addBulk(jobs.map((j) => this.prepare(queue, j.name, j.data, j.opts ?? {})));
  };

  private processor(queue: QueueName, ctx: WorkerContext) {
    return async (job: Job) => {
      const def = this.definition(queue, job.name);
      if (!def) throw new UnrecoverableError(`no handler for job "${job.name}" on queue "${queue}"`);
      const parsed = def.data.safeParse(job.data);
      if (!parsed.success) throw new UnrecoverableError(`invalid payload for "${job.name}": ${parsed.error.message}`);
      const started = performance.now();
      try {
        return await def.handler(parsed.data, ctx, { id: job.id, attemptsMade: job.attemptsMade });
      } catch (err) {
        metrics.jobFailures.add(1, { queue, job: job.name });
        throw err;
      } finally {
        metrics.jobDuration.record(performance.now() - started, { queue, job: job.name });
      }
    };
  }

  /** Start workers and (re)register schedulers. Schedulers no longer in the registry are removed. */
  async start(ctx: WorkerContext): Promise<void> {
    const { registry, connection, prefix, concurrency, logger } = this.opts;
    for (const [queue, jobs] of registry) {
      if (jobs.size === 0) continue;
      const worker = new Worker(queue, this.processor(queue, ctx), {
        connection,
        prefix,
        concurrency: concurrency[queue],
      });
      worker.on("failed", (job, err) =>
        logger.warn("job failed", { queue, job: job?.name, jobId: job?.id, attempts: job?.attemptsMade, err }),
      );
      worker.on("error", (err) => logger.error("worker error", { queue, err }));
      this.workers.push(worker);
    }
    const wanted = new Set<string>();
    for (const def of scheduledJobs(registry)) {
      if (!def.schedule) continue;
      // Scheduler ids are per queue, so the job name is unique enough.
      wanted.add(`${def.queue}/${def.name}`);
      await this.queue(def.queue).upsertJobScheduler(def.name, def.schedule, {
        name: def.name,
        data: {},
        opts: { removeOnComplete: { age: 3600, count: 100 }, removeOnFail: { age: 24 * 3600, count: 100 } },
      });
    }
    for (const [queue] of registry) {
      for (const s of await this.queue(queue).getJobSchedulers()) {
        const id = s.id ?? s.key;
        if (!wanted.has(`${queue}/${id}`)) await this.queue(queue).removeJobScheduler(id);
      }
    }
    await Promise.all(this.workers.map((w) => w.waitUntilReady()));
  }

  /** Waiting + delayed jobs per queue, for metrics and readiness. */
  async depth(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const [name, q] of this.queues) {
      const c = await q.getJobCounts("waiting", "delayed", "prioritized");
      out[name] = (c.waiting ?? 0) + (c.delayed ?? 0) + (c.prioritized ?? 0);
    }
    return out;
  }

  /** Let in-flight jobs finish up to the deadline, then force-close. */
  async close(deadlineMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceful = Promise.all(this.workers.map((w) => w.close())).then(() => true);
    const timedOut = new Promise<false>((r) => (timer = setTimeout(() => r(false), deadlineMs)));
    const finished = await Promise.race([graceful, timedOut]);
    clearTimeout(timer);
    if (!finished) {
      this.opts.logger.warn("shutdown deadline reached; force-closing workers");
      await Promise.all(this.workers.map((w) => w.close(true)));
    }
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
