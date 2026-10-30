// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The API's producer on `QUEUES.notifications` (N1, ADR 0028): `notifications.discord.test`
 * enqueues `NOTIFY_JOBS.discord` with `test: true`. The job id carries the minute, so repeated
 * clicks within one minute enqueue one post. The worker posts (services/worker).
 */
import { Queue } from "bullmq";
import { Valkey } from "iovalkey";
import { NOTIFY_JOBS, QUEUES, type DiscordJob } from "@commonair/contracts/internal";
import type { Deps } from "../deps.ts";

export interface NotifyQueue {
  /** `minute`: whole minutes since the epoch (the dedupe window). */
  enqueueDiscordTest(channelId: string, minute: number): Promise<void>;
  close(): Promise<void>;
}

export function createNotifyQueue(valkeyUrl: string, prefix: string): NotifyQueue {
  // BullMQ refuses ioredis key prefixes and needs maxRetriesPerRequest: null.
  const conn = new Valkey(valkeyUrl, { maxRetriesPerRequest: null, connectionName: "api-notify-queue" });
  const queue = new Queue(QUEUES.notifications, { connection: conn, prefix });
  return {
    async enqueueDiscordTest(channelId, minute) {
      const data: DiscordJob = { channelId, eventId: null, broadcastId: null, test: true };
      await queue.add(NOTIFY_JOBS.discord, data, {
        jobId: `discord-test-${channelId}-${minute}`,
        attempts: 5,
        backoff: { type: "exponential", delay: 60_000 },
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

const queues = new WeakMap<Deps, NotifyQueue>();

/** One producer per deps, created on first use; tests may install their own. */
export function notifyQueue(deps: Deps): NotifyQueue {
  let q = queues.get(deps);
  if (!q) {
    q = createNotifyQueue(deps.env.VALKEY_URL, deps.env.WORKER_BULL_PREFIX);
    queues.set(deps, q);
  }
  return q;
}

export function setNotifyQueue(deps: Deps, q: NotifyQueue): void {
  queues.set(deps, q);
}

export async function closeNotifyQueue(deps: Deps): Promise<void> {
  const q = queues.get(deps);
  queues.delete(deps);
  await q?.close();
}
