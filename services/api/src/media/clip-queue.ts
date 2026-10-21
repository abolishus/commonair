// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The API's producer on `QUEUES.clips`; media consumes it (`services/media/src/clips.ts`), cuts the
 * clip, PDQ-checks every second of it and only then publishes. Same job shape and id as media's own
 * `enqueueClip`, so a retried request cannot cut a clip twice.
 */
import { Queue } from "bullmq";
import { Valkey } from "iovalkey";
import { QUEUES } from "@commonair/contracts/internal";
import type { Deps } from "../deps.ts";

export interface ClipQueue {
  enqueue(clipId: string): Promise<void>;
  close(): Promise<void>;
}

export function createClipQueue(valkeyUrl: string, prefix: string): ClipQueue {
  // BullMQ refuses ioredis key prefixes and needs maxRetriesPerRequest: null.
  const conn = new Valkey(valkeyUrl, { maxRetriesPerRequest: null, connectionName: "api-clips-queue" });
  const queue = new Queue(QUEUES.clips, { connection: conn, prefix });
  return {
    async enqueue(clipId) {
      await queue.add(
        "clip",
        { clipId },
        { jobId: clipId, attempts: 3, backoff: { type: "exponential", delay: 2_000 } },
      );
    },
    async close() {
      await queue.close();
      conn.disconnect();
    },
  };
}

const queues = new WeakMap<Deps, ClipQueue>();

/** One producer per deps, created on first use; tests may install their own. */
export function clipQueue(deps: Deps): ClipQueue {
  let q = queues.get(deps);
  if (!q) {
    q = createClipQueue(deps.env.VALKEY_URL, deps.env.WORKER_BULL_PREFIX);
    queues.set(deps, q);
  }
  return q;
}

export function setClipQueue(deps: Deps, q: ClipQueue): void {
  queues.set(deps, q);
}

export async function closeClipQueue(deps: Deps): Promise<void> {
  const q = queues.get(deps);
  queues.delete(deps);
  await q?.close();
}
