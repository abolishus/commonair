// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The API's producer of the worker's `vod-placement` job (ADR 0009 amendment 1, decision 3):
 * `vods.update` (visibility) and `vods.remove` enqueue it after commit so the VOD's objects move
 * at once rather than at the next one-minute sweep. A failed enqueue is only logged: the sweep
 * picks the VOD up anyway, and the origin's state check already refuses it.
 *
 * Deduplicated per VOD while a job is waiting or running (BullMQ deduplication, not a fixed job
 * id: a completed job's id is kept for an hour and would swallow the next change).
 */
import { Queue } from "bullmq";
import { Valkey } from "iovalkey";
import { QUEUES } from "@commonair/contracts/internal";
import type { Deps } from "../deps.ts";

/** The worker's job name (`services/worker/src/jobs/vod-placement.ts`). */
export const VOD_PLACEMENT_JOB = "vod-placement";
export const vodPlacementDedupeId = (vodId: string) => `vod-placement-${vodId}`;

export interface VodPlacementQueue {
  enqueue(vodId: string): Promise<void>;
  close(): Promise<void>;
}

export function createVodPlacementQueue(valkeyUrl: string, prefix: string): VodPlacementQueue {
  // BullMQ refuses ioredis key prefixes and needs maxRetriesPerRequest: null.
  const conn = new Valkey(valkeyUrl, { maxRetriesPerRequest: null, connectionName: "api-vod-placement-queue" });
  const queue = new Queue(QUEUES.retention, { connection: conn, prefix });
  return {
    async enqueue(vodId) {
      await queue.add(
        VOD_PLACEMENT_JOB,
        { vodId },
        {
          deduplication: { id: vodPlacementDedupeId(vodId) },
          attempts: 5,
          backoff: { type: "exponential", delay: 5_000 },
          removeOnComplete: { age: 3600, count: 5000 },
          removeOnFail: { age: 7 * 24 * 3600, count: 10_000 },
        },
      );
    },
    async close() {
      await queue.close();
      conn.disconnect();
    },
  };
}

const queues = new WeakMap<Deps, VodPlacementQueue>();

/** One producer per deps, created on first use; tests may install their own. */
export function vodPlacementQueue(deps: Deps): VodPlacementQueue {
  let q = queues.get(deps);
  if (!q) {
    q = createVodPlacementQueue(deps.env.VALKEY_URL, deps.env.WORKER_BULL_PREFIX);
    queues.set(deps, q);
  }
  return q;
}

export function setVodPlacementQueue(deps: Deps, q: VodPlacementQueue): void {
  queues.set(deps, q);
}

export async function closeVodPlacementQueue(deps: Deps): Promise<void> {
  const q = queues.get(deps);
  queues.delete(deps);
  await q?.close();
}

/**
 * How long a request waits for the enqueue. The producer's connection queues commands while
 * Valkey is unreachable (BullMQ needs `maxRetriesPerRequest: null`), so an outage would otherwise
 * hold the already committed request open until Valkey came back.
 */
export const VOD_PLACEMENT_ENQUEUE_TIMEOUT_MS = 2_000;

/**
 * Enqueue after commit; never throws and never waits longer than `timeoutMs` (the sweep is the
 * fallback; an enqueue still pending then may land later, deduplicated). Logs the VOD id only.
 */
export async function requestVodPlacement(
  deps: Deps,
  vodId: string,
  timeoutMs = VOD_PLACEMENT_ENQUEUE_TIMEOUT_MS,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const enqueue = vodPlacementQueue(deps).enqueue(vodId);
    // A late failure after the timeout has nothing left to tell.
    enqueue.catch(() => {});
    const r = await Promise.race([enqueue, timedOut]);
    if (r === "timeout") deps.logger.warn("vod-placement enqueue timed out; the sweep will move it", { vodId });
  } catch {
    deps.logger.warn("vod-placement enqueue failed; the sweep will move it", { vodId });
  } finally {
    clearTimeout(timer);
  }
}
