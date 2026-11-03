// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The API's producer on `QUEUES.federation`: the `rotate` job after an admin rotation (it sends
 * `Update{Service}`), and the `deliver` jobs carrying the actor `Delete` when a streamer turns
 * federation off. Stable job ids, so a retried request never queues the same job twice. Tests
 * install their own (`setFederationQueue`).
 */
import { Queue } from "bullmq";
import { Valkey } from "iovalkey";
import { valkeyTls } from "@commonair/service";
import { FEDERATION_JOBS, type FederationDeliverJob, QUEUES, federationJobId } from "@commonair/contracts/internal";
import type { Deps } from "../deps.ts";

export interface FederationQueue {
  rotate(channelId: string, rotationId: string): Promise<void>;
  deliver(job: FederationDeliverJob, jobKey: string): Promise<void>;
  close(): Promise<void>;
}

export function createFederationQueue(valkeyUrl: string, prefix: string): FederationQueue {
  // BullMQ refuses ioredis key prefixes and needs maxRetriesPerRequest: null.
  const conn = new Valkey(valkeyUrl, {
    ...valkeyTls(valkeyUrl),
    maxRetriesPerRequest: null,
    connectionName: "api-federation-queue",
  });
  const queue = new Queue(QUEUES.federation, { connection: conn, prefix });
  const opts = { removeOnComplete: 1000, removeOnFail: 1000 };
  return {
    async rotate(channelId, rotationId) {
      await queue.add(
        FEDERATION_JOBS.rotate,
        { channelId },
        {
          jobId: federationJobId(FEDERATION_JOBS.rotate, rotationId),
          attempts: 5,
          backoff: { type: "exponential", delay: 10_000 },
          ...opts,
        },
      );
    },
    async deliver(job, jobKey) {
      // The deliver job retries itself (its `attempt` field and the webhook backoff).
      await queue.add(FEDERATION_JOBS.deliver, job, {
        jobId: federationJobId(FEDERATION_JOBS.deliver, jobKey),
        attempts: 1,
        ...opts,
      });
    },
    async close() {
      await queue.close();
      conn.disconnect();
    },
  };
}

const queues = new WeakMap<Deps, FederationQueue>();

/** One producer per deps, created on first use; tests may install their own. */
export function federationQueue(deps: Deps): FederationQueue {
  let q = queues.get(deps);
  if (!q) {
    q = createFederationQueue(deps.env.VALKEY_URL, deps.env.WORKER_BULL_PREFIX);
    queues.set(deps, q);
  }
  return q;
}

export function setFederationQueue(deps: Deps, q: FederationQueue): void {
  queues.set(deps, q);
}

/** For shutdown (contract request: `index.ts`) and tests. */
export async function closeFederationQueue(deps: Deps): Promise<void> {
  const q = queues.get(deps);
  queues.delete(deps);
  await q?.close();
}
