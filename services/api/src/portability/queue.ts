// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The API's producer on `QUEUES.portability` (ADR 0037 decision 5). `imports.preview` enqueues the
 * import job for the preview and waits for it (the issuer's keys are fetched by the worker, never
 * the API); `imports.start` enqueues the apply. Stable job ids, so a retried request never runs one
 * import twice. Tests install their own (`setPortabilityQueue`).
 */
import { Queue, QueueEvents } from "bullmq";
import { Valkey } from "iovalkey";
import { PORTABILITY_JOBS, type PortabilityImportJob, QUEUES, portabilityJobId } from "@commonair/contracts/internal";
import type { Deps } from "../deps.ts";

export const PREVIEW_TIMEOUT_MS = 60_000;

export interface PortabilityQueue {
  /** Run the preview of an import and wait for it (throws on timeout or a failed job). */
  preview(importId: string, timeoutMs?: number): Promise<void>;
  /** Queue the apply of a started import. */
  start(importId: string): Promise<void>;
  close(): Promise<void>;
}

export function createPortabilityQueue(valkeyUrl: string, prefix: string): PortabilityQueue {
  // BullMQ refuses ioredis key prefixes and needs maxRetriesPerRequest: null.
  const conn = new Valkey(valkeyUrl, { maxRetriesPerRequest: null, connectionName: "api-portability-queue" });
  const queue = new Queue(QUEUES.portability, { connection: conn, prefix });
  let events: Promise<{ ev: QueueEvents; conn: Valkey }> | null = null;
  const queueEvents = () => {
    events ??= (async () => {
      const c = new Valkey(valkeyUrl, { maxRetriesPerRequest: null, connectionName: "api-portability-events" });
      const ev = new QueueEvents(QUEUES.portability, { connection: c, prefix });
      await ev.waitUntilReady();
      return { ev, conn: c };
    })();
    events.catch(() => {
      events = null;
    });
    return events;
  };
  return {
    async preview(importId, timeoutMs = PREVIEW_TIMEOUT_MS) {
      const { ev } = await queueEvents();
      const data: PortabilityImportJob = { importId };
      const job = await queue.add(PORTABILITY_JOBS.import, data, {
        jobId: portabilityJobId(PORTABILITY_JOBS.import, `${importId}-preview`),
        // The worker's job fails the preview on its last attempt (`PORTABILITY_JOBS.import`, 3).
        attempts: 3,
        backoff: { type: "fixed", delay: 2_000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      });
      await job.waitUntilFinished(ev, timeoutMs);
    },
    async start(importId) {
      const data: PortabilityImportJob = { importId };
      await queue.add(PORTABILITY_JOBS.import, data, {
        jobId: portabilityJobId(PORTABILITY_JOBS.import, importId),
        attempts: 3,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      });
    },
    async close() {
      await queue.close();
      conn.disconnect();
      const e = await events?.catch(() => null);
      if (e) {
        await e.ev.close();
        e.conn.disconnect();
      }
    },
  };
}

const queues = new WeakMap<Deps, PortabilityQueue>();

/** One producer per deps, created on first use; tests may install their own. */
export function portabilityQueue(deps: Deps): PortabilityQueue {
  let q = queues.get(deps);
  if (!q) {
    q = createPortabilityQueue(deps.env.VALKEY_URL, deps.env.WORKER_BULL_PREFIX);
    queues.set(deps, q);
  }
  return q;
}

export function setPortabilityQueue(deps: Deps, q: PortabilityQueue): void {
  queues.set(deps, q);
}

/** For shutdown (`index.ts`; contract request) and tests. */
export async function closePortabilityQueue(deps: Deps): Promise<void> {
  const q = queues.get(deps);
  queues.delete(deps);
  await q?.close();
}
