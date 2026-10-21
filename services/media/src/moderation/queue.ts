// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Media's producer side of `QUEUES.moderation`: `scan` jobs (the RGB frame goes to Valkey with a
 * TTL first) and `t0` jobs (`jobId = t0JobId(...)`, so retries and duplicate matches collapse).
 * Its own connection without a key prefix (BullMQ forbids ioredis prefixes).
 */
import { Queue } from "bullmq";
import { Valkey } from "iovalkey";
import { MODERATION_JOBS, ModerationScanJob, ModerationT0Job, QUEUES, t0JobId } from "@commonair/contracts/internal";

export interface ModerationQueue {
  /** Jobs waiting on the moderation queue (the backlog rule reads it). */
  waitingCount(): Promise<number>;
  addScan(job: ModerationScanJob): Promise<void>;
  addT0(job: ModerationT0Job): Promise<void>;
  /** A T0 job exists for the subject (any state): its media must never be published. */
  hasT0(subjectType: ModerationT0Job["subjectType"], subjectId: string): Promise<boolean>;
  close(): Promise<void>;
}

/** Retention of finished T0 jobs, so a duplicate enqueue still collapses into the first one. */
const T0_KEEP_SECONDS = 30 * 86_400;

export function createModerationQueue(opts: { valkeyUrl: string; prefix?: string }): ModerationQueue {
  const connection = new Valkey(opts.valkeyUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
  const queue = new Queue(QUEUES.moderation, { connection, prefix: opts.prefix });
  return {
    waitingCount: () => queue.getWaitingCount(),
    async addScan(job) {
      await queue.add(MODERATION_JOBS.scan, ModerationScanJob.parse(job), {
        // The frame expires from Valkey after 60 s; a scan job is worthless after that.
        attempts: 2,
        backoff: { type: "fixed", delay: 1_000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      });
    },
    async addT0(job) {
      const data = ModerationT0Job.parse(job);
      await queue.add(MODERATION_JOBS.t0, data, {
        jobId: t0JobId(data.subjectType, data.subjectId),
        // The worker retries its transaction until it lands; these attempts cover a crashed worker.
        attempts: 1000,
        backoff: { type: "fixed", delay: 30_000 },
        removeOnComplete: { age: T0_KEEP_SECONDS },
        removeOnFail: false,
      });
    },
    async hasT0(subjectType, subjectId) {
      return (await queue.getJob(t0JobId(subjectType, subjectId))) !== undefined;
    },
    async close() {
      await queue.close();
      await connection.quit().catch(() => {});
    },
  };
}
