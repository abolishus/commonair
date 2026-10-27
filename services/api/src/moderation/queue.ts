// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The API's producer on `QUEUES.moderation` (ADR 0006): `t0` for rejected uploads,
 * `t0-escalated` after a legal confirmation, `ncii-hash` after an NCII removal, `dmca-disable`
 * after a DMCA notice is actioned, and the `ncii-clock` / `dmca-restore` runs of the test hooks. The worker owns every T0 transaction; the API only enqueues.
 * Payloads are validated against the contract before they leave, and job ids collapse retries.
 */
import { Queue, QueueEvents } from "bullmq";
import { Valkey } from "iovalkey";
import {
  DmcaDisableJob,
  DmcaRestoreResult,
  MODERATION_JOBS,
  ModerationT0EscalatedJob,
  ModerationT0Job,
  NciiClockResult,
  NciiHashJob,
  QUEUES,
  t0JobId,
} from "@commonair/contracts/internal";

export interface ModerationQueue {
  t0(job: ModerationT0Job): Promise<void>;
  t0Escalated(job: ModerationT0EscalatedJob): Promise<void>;
  nciiHash(job: NciiHashJob): Promise<void>;
  /** Run the NCII clock once as of `asOf` and wait for the worker's result (test hooks only). */
  nciiClock(asOf: string, timeoutMs?: number): Promise<NciiClockResult>;
  /** Move an actioned DMCA notice's objects to the private prefix (durable, one job per notice). */
  dmcaDisable(job: DmcaDisableJob): Promise<void>;
  /** Run the DMCA restore once as of `asOf` and wait for the worker's result (test hooks only). */
  dmcaRestoreTick(asOf: string, timeoutMs?: number): Promise<DmcaRestoreResult>;
  close(): Promise<void>;
}

/** Retried until it lands: losing one of these loses a T0 action or an NCII removal. */
export const DURABLE_JOB = {
  attempts: 50,
  backoff: { type: "exponential" as const, delay: 2000 },
  removeOnComplete: { age: 7 * 86_400 },
  removeOnFail: false,
};

/** BullMQ allows a `:` in custom ids only as `a:b:c`; our other ids use `-`. */
export const t0EscalatedJobId = (caseId: string) => `t0-escalated-${caseId}`;
export const nciiHashJobId = (requestId: string) => `ncii-hash-${requestId}`;
export const dmcaDisableJobId = (noticeId: string) => `dmca-disable-${noticeId}`;

export async function createModerationQueue(valkeyUrl: string, prefix: string): Promise<ModerationQueue> {
  // BullMQ refuses ioredis key prefixes and needs maxRetriesPerRequest: null.
  const conn = new Valkey(valkeyUrl, { maxRetriesPerRequest: null, connectionName: "api-moderation-queue" });
  const queue = new Queue(QUEUES.moderation, { connection: conn, prefix });
  let events: { ev: QueueEvents; conn: InstanceType<typeof Valkey> } | null = null;
  const queueEvents = async () => {
    if (!events) {
      const c = new Valkey(valkeyUrl, { maxRetriesPerRequest: null, connectionName: "api-moderation-events" });
      const ev = new QueueEvents(QUEUES.moderation, { connection: c, prefix });
      await ev.waitUntilReady();
      events = { ev, conn: c };
    }
    return events.ev;
  };
  return {
    async t0(job) {
      const data = ModerationT0Job.parse(job);
      await queue.add(MODERATION_JOBS.t0, data, { ...DURABLE_JOB, jobId: t0JobId(data.subjectType, data.subjectId) });
    },
    async t0Escalated(job) {
      const data = ModerationT0EscalatedJob.parse(job);
      await queue.add(MODERATION_JOBS.t0Escalated, data, { ...DURABLE_JOB, jobId: t0EscalatedJobId(data.caseId) });
    },
    async nciiHash(job) {
      const data = NciiHashJob.parse(job);
      await queue.add(MODERATION_JOBS.nciiHash, data, { ...DURABLE_JOB, jobId: nciiHashJobId(data.requestId) });
    },
    async nciiClock(asOf, timeoutMs = 30_000) {
      const ev = await queueEvents();
      const job = await queue.add(MODERATION_JOBS.nciiClock, { asOf }, { removeOnComplete: 100, removeOnFail: 100 });
      return NciiClockResult.parse(await job.waitUntilFinished(ev, timeoutMs));
    },
    async dmcaDisable(job) {
      const data = DmcaDisableJob.parse(job);
      await queue.add(MODERATION_JOBS.dmcaDisable, data, { ...DURABLE_JOB, jobId: dmcaDisableJobId(data.noticeId) });
    },
    async dmcaRestoreTick(asOf, timeoutMs = 30_000) {
      const ev = await queueEvents();
      const job = await queue.add(MODERATION_JOBS.dmcaRestore, { asOf }, { removeOnComplete: 100, removeOnFail: 100 });
      return DmcaRestoreResult.parse(await job.waitUntilFinished(ev, timeoutMs));
    },
    async close() {
      await queue.close();
      conn.disconnect();
      const e = events as { ev: QueueEvents; conn: InstanceType<typeof Valkey> } | null;
      if (e) {
        await e.ev.close();
        e.conn.disconnect();
      }
    },
  };
}

/**
 * A queue that validates and records jobs in memory. Integration tests of the API use it (the
 * worker's own tests consume the real queue); `nciiClock` answers with `clockResult`, and
 * `dmcaRestoreTick` with `restoreResult`.
 */
export function recordingQueue(
  clockResult: NciiClockResult = { escalated24: 0, escalated36: 0, autoHidden: 0 },
  restoreResult: DmcaRestoreResult = { restored: 0, counters: 0 },
) {
  const jobs: { name: string; id: string; data: unknown }[] = [];
  const q: ModerationQueue & { jobs: typeof jobs; clockCalls: string[]; restoreCalls: string[] } = {
    jobs,
    clockCalls: [],
    restoreCalls: [],
    async t0(job) {
      const data = ModerationT0Job.parse(job);
      jobs.push({ name: MODERATION_JOBS.t0, id: t0JobId(data.subjectType, data.subjectId), data });
    },
    async t0Escalated(job) {
      const data = ModerationT0EscalatedJob.parse(job);
      jobs.push({ name: MODERATION_JOBS.t0Escalated, id: t0EscalatedJobId(data.caseId), data });
    },
    async nciiHash(job) {
      const data = NciiHashJob.parse(job);
      jobs.push({ name: MODERATION_JOBS.nciiHash, id: nciiHashJobId(data.requestId), data });
    },
    async nciiClock(asOf) {
      q.clockCalls.push(asOf);
      return clockResult;
    },
    async dmcaDisable(job) {
      const data = DmcaDisableJob.parse(job);
      jobs.push({ name: MODERATION_JOBS.dmcaDisable, id: dmcaDisableJobId(data.noticeId), data });
    },
    async dmcaRestoreTick(asOf) {
      q.restoreCalls.push(asOf);
      return restoreResult;
    },
    async close() {},
  };
  return q;
}
