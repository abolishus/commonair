// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { InstanceSite } from "@commonair/config/site";
import type { Database } from "@commonair/db";
import type { Mailer } from "@commonair/email";
import type { NetworkClassifier } from "@commonair/integrity";
import type { Logger } from "@commonair/observability";
import type { ValkeyClient } from "@commonair/service";
import type { ObjectStorage } from "@commonair/storage";
import type postgres from "postgres";
import type { QueueName } from "./env.ts";
import type { ModerationRuntime } from "./moderation/runtime.ts";
import type { MoneyJobConfig } from "./money/config.ts";
import type { WebPushSettings } from "./notify/settings.ts";
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
  /** Bucket holding data export archives (`exportObjectKey`); nothing else is written there. */
  exportsBucket: string;
  /** Transactional mail (export ready, deletion completed); absent in tests that do not send. */
  mailer?: Mailer;
  /** The instance identity for mail links; required whenever `mailer` is set. */
  site?: InstanceSite;
  /** Origin browsers download objects from; the mailer accepts presigned links there. */
  storageOrigin?: string;
  /** Pub/sub channel the outbox relay publishes to (BUS.events outside tests). */
  busChannel: string;
  /** Stream the segment consumer reads (STREAMS.segments outside tests); never key-prefixed. */
  segmentStream: string;
  /** The operator's network list for integrity scoring (reloadable, hence a function). */
  classifier(): NetworkClassifier | undefined;
  /** Money job tunables; `createWorker` reads them from env once. Read via `moneyConfig(ctx)`. */
  money?: MoneyJobConfig;
  /**
   * Trust & safety (classifier, evidence sealing key and bucket). `main.ts` always builds it and
   * refuses to start without it; moderation jobs throw rather than run without it.
   */
  moderation?: ModerationRuntime;
  /** Web push (N1); absent when WEB_PUSH_ENABLED is off. */
  webPush?: WebPushSettings;
  now(): Date;
}
