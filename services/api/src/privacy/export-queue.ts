// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The API's producer on `QUEUES.exports`: `me.exports.create` enqueues `EXPORT_JOBS.build` with
 * the export id as the job id, so a retried enqueue never builds one export twice. The worker
 * builds the archive (services/worker).
 */
import { Queue } from "bullmq";
import { Valkey } from "iovalkey";
import { EXPORT_JOBS, QUEUES, type ExportBuildJob } from "@commonair/contracts/internal";
import type { Deps } from "../deps.ts";

export interface ExportQueue {
  enqueue(exportId: string): Promise<void>;
  close(): Promise<void>;
}

export function createExportQueue(valkeyUrl: string, prefix: string): ExportQueue {
  // BullMQ refuses ioredis key prefixes and needs maxRetriesPerRequest: null.
  const conn = new Valkey(valkeyUrl, { maxRetriesPerRequest: null, connectionName: "api-exports-queue" });
  const queue = new Queue(QUEUES.exports, { connection: conn, prefix });
  return {
    async enqueue(exportId) {
      const data: ExportBuildJob = { exportId };
      await queue.add(EXPORT_JOBS.build, data, {
        jobId: exportId,
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: 1000,
        removeOnFail: 1000,
      });
    },
    async close() {
      await queue.close();
      conn.disconnect();
    },
  };
}

const queues = new WeakMap<Deps, ExportQueue>();

/** One producer per deps, created on first use; tests may install their own. */
export function exportQueue(deps: Deps): ExportQueue {
  let q = queues.get(deps);
  if (!q) {
    q = createExportQueue(deps.env.VALKEY_URL, deps.env.WORKER_BULL_PREFIX);
    queues.set(deps, q);
  }
  return q;
}

export function setExportQueue(deps: Deps, q: ExportQueue): void {
  queues.set(deps, q);
}

export async function closeExportQueue(deps: Deps): Promise<void> {
  const q = queues.get(deps);
  queues.delete(deps);
  await q?.close();
}
