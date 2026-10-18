// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Database } from "@commonair/db";
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import type { ObjectStorage } from "@commonair/storage";
import type postgres from "postgres";
import type { QueueName } from "./env.ts";
import type { WebhookSettings } from "./webhooks/settings.ts";

export interface EnqueueOptions {
  /** Deterministic id: a second enqueue with the same id is a no-op (BullMQ dedupe). */
  jobId?: string;
  delayMs?: number;
}

export type Enqueue = (queue: QueueName, name: string, data: unknown, opts?: EnqueueOptions) => Promise<void>;
export type EnqueueBulk = (
  queue: QueueName,
  jobs: readonly { name: string; data: unknown; opts?: EnqueueOptions }[],
) => Promise<void>;

/** Everything a job handler or loop may touch. Built once per process in `createWorker`. */
export interface WorkerContext {
  db: Database;
  sql: postgres.Sql;
  /** Application Valkey connection (may carry a key prefix in tests). */
  valkey: ValkeyClient;
  logger: Logger;
  enqueue: Enqueue;
  enqueueBulk: EnqueueBulk;
  webhooks: WebhookSettings;
  /** Object storage for VOD retention; absent when S3 is not configured. */
  storage?: ObjectStorage;
  mediaBucket: string;
  /** Pub/sub channel the outbox relay publishes to (BUS.events outside tests). */
  busChannel: string;
  /** Stream the segment consumer reads (STREAMS.segments outside tests); never key-prefixed. */
  segmentStream: string;
  now(): Date;
}
