// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The API's producer for `TWITCH_JOBS.import` on `QUEUES.portability`. An import starts rarely
 * (once per authorization), so each enqueue opens its own connection and closes it: nothing to
 * shut down with the API. A stable job id, so a retried start never queues one import twice. Tests
 * install their own (`setTwitchImportQueue`).
 */
import { Queue } from "bullmq";
import { Valkey } from "iovalkey";
import { valkeyTls } from "@commonair/service";
import { portabilityJobId, QUEUES, TWITCH_JOBS, type TwitchImportJob } from "@commonair/contracts/internal";
import type { Deps } from "../deps.ts";

export interface TwitchImportQueue {
  enqueue(importId: string): Promise<void>;
}

/** The job's attempts; the worker fails the import on the last one. */
export const TWITCH_IMPORT_ATTEMPTS = 3;

export function createTwitchImportQueue(valkeyUrl: string, prefix: string): TwitchImportQueue {
  return {
    async enqueue(importId) {
      // BullMQ refuses ioredis key prefixes and needs maxRetriesPerRequest: null.
      const conn = new Valkey(valkeyUrl, {
        ...valkeyTls(valkeyUrl),
        maxRetriesPerRequest: null,
        connectionName: "api-twitch-import",
      });
      const queue = new Queue(QUEUES.portability, { connection: conn, prefix });
      try {
        const data: TwitchImportJob = { importId };
        await queue.add(TWITCH_JOBS.import, data, {
          jobId: portabilityJobId(TWITCH_JOBS.import, importId),
          attempts: TWITCH_IMPORT_ATTEMPTS,
          backoff: { type: "exponential", delay: 10_000 },
          removeOnComplete: 1000,
          removeOnFail: 1000,
        });
      } finally {
        await queue.close().catch(() => {});
        conn.disconnect();
      }
    },
  };
}

const queues = new WeakMap<Deps, TwitchImportQueue>();

export function twitchImportQueue(deps: Deps): TwitchImportQueue {
  let q = queues.get(deps);
  if (!q) {
    q = createTwitchImportQueue(deps.env.VALKEY_URL, deps.env.WORKER_BULL_PREFIX);
    queues.set(deps, q);
  }
  return q;
}

export function setTwitchImportQueue(deps: Deps, q: TwitchImportQueue): void {
  queues.set(deps, q);
}
