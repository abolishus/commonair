// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The API's producer on `QUEUES.webhooks`; the worker consumes it (`services/worker/src/jobs/webhook-*.ts`).
 * Callback verification after a subscribe, test events, redeliveries and revocation notices
 * (ADR 0027). Callers pass a job id so a retried request cannot enqueue the same job twice.
 */
import { Queue } from "bullmq";
import { Valkey } from "iovalkey";
import { QUEUES, WEBHOOK_JOBS } from "@commonair/contracts/internal";
import type { Deps } from "../deps.ts";

export type WebhookJobName =
  | typeof WEBHOOK_JOBS.verifyCallback
  | typeof WEBHOOK_JOBS.testEvent
  | typeof WEBHOOK_JOBS.redeliver
  | typeof WEBHOOK_JOBS.revocation;

/** Mirrors the worker's job definitions (`attempts`), which apply only to jobs the worker enqueues itself. */
const ATTEMPTS: Record<WebhookJobName, number> = {
  [WEBHOOK_JOBS.verifyCallback]: 1,
  [WEBHOOK_JOBS.testEvent]: 1,
  [WEBHOOK_JOBS.redeliver]: 1,
  [WEBHOOK_JOBS.revocation]: 3,
};

export interface WebhookQueue {
  enqueue(name: WebhookJobName, data: Record<string, unknown>, jobId: string): Promise<void>;
  close(): Promise<void>;
}

export function createWebhookQueue(valkeyUrl: string, prefix: string): WebhookQueue {
  // BullMQ refuses ioredis key prefixes and needs maxRetriesPerRequest: null.
  const conn = new Valkey(valkeyUrl, { maxRetriesPerRequest: null, connectionName: "api-webhooks-queue" });
  const queue = new Queue(QUEUES.webhooks, { connection: conn, prefix });
  return {
    async enqueue(name, data, jobId) {
      await queue.add(name, data, {
        jobId,
        attempts: ATTEMPTS[name],
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { age: 3600, count: 5000 },
        removeOnFail: { age: 7 * 24 * 3600, count: 10_000 },
      });
    },
    async close() {
      await queue.close();
      conn.disconnect();
    },
  };
}

const queues = new WeakMap<Deps, WebhookQueue>();

/** One producer per deps, created on first use; tests may install their own. */
export function webhookQueue(deps: Deps): WebhookQueue {
  let q = queues.get(deps);
  if (!q) {
    q = createWebhookQueue(deps.env.VALKEY_URL, deps.env.WORKER_BULL_PREFIX);
    queues.set(deps, q);
  }
  return q;
}

export function setWebhookQueue(deps: Deps, q: WebhookQueue): void {
  queues.set(deps, q);
}

export async function closeWebhookQueue(deps: Deps): Promise<void> {
  const q = queues.get(deps);
  queues.delete(deps);
  await q?.close();
}
