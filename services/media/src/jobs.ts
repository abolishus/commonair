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
import { errorCategory } from "./moderation/logging.ts";
import { ClipJob, ClipUnavailableError, markClipFailed, processClip, type ClipDeps } from "./clips.ts";
import { finalizeVod, VodFinalizeJob, type FinalizeDeps } from "./vod/finalize.ts";
import type { FinalizeJobControl, FinalizeJobInfo, FinalizeJobState } from "./vod/reconcile.ts";

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
  /**
   * Start consuming. Workers are created paused so crash recovery can repair local recordings
   * before a finalize job reads their playlists.
   */
  run(): void;
  enqueueVodFinalize(vodId: string): Promise<void>;
  /** State of a VOD's finalize job, for the stale-VOD reconcile. */
  vodFinalize: FinalizeJobControl;
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
    { connection: conn(), prefix, concurrency: opts.concurrency ?? 2, autorun: false },
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
          await markClipFailed(opts.clips.db, clipId, err instanceof ClipUnavailableError ? err.reason : null);
          log.warn("clip failed", { clipId, error: errorCategory(err) });
          if (err instanceof ClipUnavailableError) return "failed";
        }
        throw err;
      }
    },
    { connection: conn(), prefix, concurrency: opts.concurrency ?? 2, autorun: false },
  );

  for (const w of [finalizeWorker, clipsWorker]) {
    w.on("failed", (job, err) => log.warn("job failed", { queue: w.name, jobId: job?.id, error: errorCategory(err) }));
    w.on("error", (err) => log.error("worker error", { queue: w.name, error: errorCategory(err) }));
  }

  const addFinalize = async (vodId: string) => {
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
  };
  let running = false;

  return {
    run() {
      if (running) return;
      running = true;
      for (const w of [finalizeWorker, clipsWorker])
        void w.run().catch((err: unknown) => log.error("worker stopped", { queue: w.name, error: errorCategory(err) }));
    },
    enqueueVodFinalize: addFinalize,
    vodFinalize: {
      async info(vodId): Promise<FinalizeJobInfo> {
        const job = await finalizeQueue.getJob(vodId);
        if (!job) return { state: "unknown", finishedOn: null };
        const state = (await job.getState()) as FinalizeJobState;
        return { state, finishedOn: job.finishedOn ?? null };
      },
      async requeue(vodId) {
        const job = await finalizeQueue.getJob(vodId);
        // Only finished jobs are replaced; an active one is locked by its worker.
        if (job && (await job.isActive())) return;
        if (job) {
          try {
            await job.remove();
          } catch (err) {
            // A worker picked it up between the check and the remove (the job is locked): owned.
            log.debug("finalize job became active during requeue", { vodId, error: errorCategory(err) });
            return;
          }
        }
        await addFinalize(vodId);
      },
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
