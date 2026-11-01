// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The API's producer for `GIVEAWAY_JOBS.close` on `QUEUES.interact`: `open` schedules the timed
 * close, delayed to `closes_at`, with a job id per giveaway so a retried enqueue schedules it once.
 * The worker closes it. A missed job is harmless: entries are refused past `closes_at` by the 0046
 * trigger, and the API closes a due giveaway the next time it reads it.
 */
import { Queue } from "bullmq";
import { Valkey } from "iovalkey";
import { GIVEAWAY_JOBS, QUEUES, type GiveawayCloseJob } from "@commonair/contracts/internal";
import type { Deps } from "../../deps.ts";

export interface GiveawayCloseQueue {
  schedule(giveawayId: string, closesAt: Date, now: Date): Promise<void>;
  close(): Promise<void>;
}

/** BullMQ custom ids may not contain ":"; one id per giveaway. */
export const closeJobId = (giveawayId: string) => `giveaway-close-${giveawayId}`;

export function createGiveawayCloseQueue(valkeyUrl: string, prefix: string): GiveawayCloseQueue {
  // BullMQ refuses ioredis key prefixes and needs maxRetriesPerRequest: null.
  const conn = new Valkey(valkeyUrl, { maxRetriesPerRequest: null, connectionName: "api-giveaway-queue" });
  const queue = new Queue(QUEUES.interact, { connection: conn, prefix });
  return {
    async schedule(giveawayId, closesAt, now) {
      const data: GiveawayCloseJob = { giveawayId };
      await queue.add(GIVEAWAY_JOBS.close, data, {
        jobId: closeJobId(giveawayId),
        delay: Math.max(0, closesAt.getTime() - now.getTime()),
        attempts: 5,
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

const queues = new WeakMap<Deps, GiveawayCloseQueue>();

/** One producer per deps, created on first use; tests may install their own. */
export function giveawayCloseQueue(deps: Deps): GiveawayCloseQueue {
  let q = queues.get(deps);
  if (!q) {
    q = createGiveawayCloseQueue(deps.env.VALKEY_URL, deps.env.WORKER_BULL_PREFIX);
    queues.set(deps, q);
  }
  return q;
}

export function setGiveawayCloseQueue(deps: Deps, q: GiveawayCloseQueue): void {
  queues.set(deps, q);
}

export async function closeGiveawayCloseQueue(deps: Deps): Promise<void> {
  const q = queues.get(deps);
  queues.delete(deps);
  await q?.close();
}
