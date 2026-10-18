// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * BullMQ consumers owned by media (`QUEUES.clips`, `QUEUES.vodFinalize`) and the vodFinalize
 * producer. Each queue object gets its own connection without a key prefix (BullMQ forbids
 * ioredis prefixes; isolation uses BullMQ's own `prefix`).
 */
import { Queue, Worker, type Job } from "bullmq";
import { Valkey } from "iovalkey";
import { QUEUES } from "@commonair/contracts/internal";
import type { Logger } from "@commonair/observability";
import { ClipJob, ClipUnavailableError, markClipFailed, processClip, type ClipDeps } from "./clips.ts";
import { finalizeVod, VodFinalizeJob, type FinalizeDeps } from "./vod/finalize.ts";

export interface JobsOptions {
  valkeyUrl: string;
  /** BullMQ key prefix (default `bull`); tests use a unique one. */
  prefix?: string;
  logger: Logger;
  finalize: FinalizeDeps;
  clips: ClipDeps;
  concurrency?: number;
}

export interface Jobs {
  enqueueVodFinalize(vodId: string): Promise<void>;
  /** Producer for clips, used by tests and the harness (the API enqueues in production). */
  enqueueClip(clipId: string): Promise<void>;
  close(): Promise<void>;
}

const connection = (url: string) => new Valkey(url, { maxRetriesPerRequest: null, enableReadyCheck: true });

export function startJobs(opts: JobsOptions): Jobs {
  const prefix = opts.prefix;
  const log = opts.logger.child({ component: "jobs" });
  const conns: Valkey[] = [];
  const conn = () => {
    const c = connection(opts.valkeyUrl);
    conns.push(c);
    return c;
  };
  const finalizeQueue = new Queue(QUEUES.vodFinalize, { connection: conn(), prefix });
  const clipsQueue = new Queue(QUEUES.clips, { connection: conn(), prefix });

  const finalizeWorker = new Worker(
    QUEUES.vodFinalize,
    async (job: Job) => {
      const { vodId } = VodFinalizeJob.parse(job.data);
      return finalizeVod(opts.finalize, vodId);
    },
    { connection: conn(), prefix, concurrency: opts.concurrency ?? 2 },
  );

  const clipsWorker = new Worker(
    QUEUES.clips,
    async (job: Job) => {
      const parsed = ClipJob.safeParse(job.data);
      if (!parsed.success) {
        log.warn("discarding malformed clip job", { jobId: job.id });
        return "invalid";
      }
      const { clipId } = parsed.data;
      try {
        return await processClip(opts.clips, clipId);
      } catch (err) {
        const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
        if (err instanceof ClipUnavailableError || lastAttempt) {
          await markClipFailed(opts.clips.db, clipId);
          log.warn("clip failed", { clipId, err });
          if (err instanceof ClipUnavailableError) return "failed";
        }
        throw err;
      }
    },
    { connection: conn(), prefix, concurrency: opts.concurrency ?? 2 },
  );

  for (const w of [finalizeWorker, clipsWorker]) {
    w.on("failed", (job, err) => log.warn("job failed", { queue: w.name, jobId: job?.id, err }));
    w.on("error", (err) => log.error("worker error", { queue: w.name, err }));
  }

  return {
    async enqueueVodFinalize(vodId) {
      // jobId = vodId: duplicate enqueues (offline + reconcile) collapse into one job.
      await finalizeQueue.add(
        "finalize",
        { vodId },
        {
          jobId: vodId,
          attempts: 5,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      );
    },
    async enqueueClip(clipId) {
      await clipsQueue.add(
        "clip",
        { clipId },
        { jobId: clipId, attempts: 3, backoff: { type: "exponential", delay: 2_000 } },
      );
    },
    async close() {
      await Promise.allSettled([finalizeWorker.close(), clipsWorker.close()]);
      await Promise.allSettled([finalizeQueue.close(), clipsQueue.close()]);
      await Promise.allSettled(conns.map((c) => c.quit()));
    },
  };
}
