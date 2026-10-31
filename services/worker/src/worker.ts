// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Composition root: the BullMQ runtime, the outbox relay loop and the segment
 * consumer loop over one Postgres pool and two Valkey connections (application
 * keys, and an unprefixed one for BullMQ, which manages its own prefix).
 */
import { BUS } from "@commonair/contracts/events";
import { STREAMS } from "@commonair/contracts/internal";
import type { InstanceSite } from "@commonair/config/site";
import type { DbHandle } from "@commonair/db";
import type { Mailer } from "@commonair/email";
import type { NetworkClassifier } from "@commonair/integrity";
import type { Logger } from "@commonair/observability";
import { createValkey, valkeyCheck, type ReadinessCheck, type ValkeyClient } from "@commonair/service";
import type { ObjectStorage } from "@commonair/storage";
import { Valkey } from "iovalkey";
import type { WorkerContext } from "./context.ts";
import { DEFAULT_CONCURRENCY, type QueueName } from "./env.ts";
import { JOBS } from "./jobs/index.ts";
import { metrics } from "./metrics.ts";
import { type ModerationOptions, resolveModeration } from "./moderation/runtime.ts";
import { type MoneyJobConfig, moneyConfigFromEnv } from "./money/config.ts";
import { startOutboxRelay } from "./outbox.ts";
import type { LoopHandle } from "./runtime/loop.ts";
import { buildRegistry, type JobDefinition } from "./runtime/registry.ts";
import { JobRuntime } from "./runtime/runtime.ts";
import { startSegmentConsumer, type SegmentConsumerOptions } from "./segments/consumer.ts";
import type { WebPushSettings } from "./notify/settings.ts";
import type { WebhookSettings } from "./webhooks/settings.ts";

export interface CreateWorkerOptions {
  db: DbHandle;
  valkeyUrl: string;
  logger: Logger;
  webhooks: WebhookSettings;
  /** Prefix for application keys (tests only; production keys are unprefixed). */
  keyPrefix?: string;
  bullPrefix?: string;
  concurrency?: Partial<Record<QueueName, number>>;
  storage?: ObjectStorage;
  mediaBucket?: string;
  exportsBucket?: string;
  mailer?: Mailer;
  site?: InstanceSite;
  /** Origin export mail may link presigned archives on (see `mailableStorageOrigin`). */
  storageOrigin?: string;
  busChannel?: string;
  segmentStream?: string;
  jobs?: readonly JobDefinition[];
  outbox?: boolean | { batchSize?: number };
  segments?: boolean | SegmentConsumerOptions;
  /** Network list for integrity scoring; see `ClassifierHolder`. */
  classifier?: () => NetworkClassifier | undefined;
  /** Money job tunables; read from env (`CURRENCY`, `PAYMENT_PENDING_DAYS`) when absent. */
  money?: MoneyJobConfig;
  /** Trust & safety runtime; `main.ts` always passes it (and exits when it cannot build it). */
  moderation?: ModerationOptions;
  /** Web push (N1); `main.ts` passes `webPushSettings(env, site)`, absent when push is off. */
  webPush?: WebPushSettings;
  /** DEMO_SEED_FULL (local and staging only); see `WorkerContext.demoSeedFull`. */
  demoSeedFull?: boolean;
  now?: () => Date;
}

export interface WorkerHandle {
  ctx: WorkerContext;
  runtime: JobRuntime;
  checks: Record<string, ReadinessCheck>;
  start(): Promise<void>;
  /** Stop loops, then let in-flight jobs finish up to `deadlineMs`, then close connections. */
  stop(deadlineMs?: number): Promise<void>;
}

export function createWorker(opts: CreateWorkerOptions): WorkerHandle {
  const valkey: ValkeyClient = createValkey(opts.valkeyUrl, { keyPrefix: opts.keyPrefix, name: "worker" });
  // BullMQ refuses keyPrefix and needs maxRetriesPerRequest: null for its blocking commands.
  const bullConnection = new Valkey(opts.valkeyUrl, { maxRetriesPerRequest: null, connectionName: "worker-bullmq" });
  const runtime = new JobRuntime({
    connection: bullConnection,
    prefix: opts.bullPrefix ?? "bull",
    registry: buildRegistry(opts.jobs ?? JOBS),
    concurrency: { ...DEFAULT_CONCURRENCY, ...opts.concurrency },
    logger: opts.logger,
  });
  const ctx: WorkerContext = {
    db: opts.db.db,
    sql: opts.db.sql,
    valkey,
    logger: opts.logger,
    enqueue: runtime.enqueue,
    enqueueBulk: runtime.enqueueBulk,
    webhooks: opts.webhooks,
    storage: opts.storage,
    mediaBucket: opts.mediaBucket ?? "commonair-media",
    exportsBucket: opts.exportsBucket ?? "commonair-exports",
    ...(opts.mailer ? { mailer: opts.mailer } : {}),
    ...(opts.site ? { site: opts.site } : {}),
    ...(opts.storageOrigin ? { storageOrigin: opts.storageOrigin } : {}),
    busChannel: opts.busChannel ?? BUS.events,
    segmentStream: opts.segmentStream ?? STREAMS.segments,
    classifier: opts.classifier ?? (() => undefined),
    money: opts.money ?? moneyConfigFromEnv(),
    moderation: opts.moderation ? resolveModeration(opts.moderation, valkey) : undefined,
    ...(opts.webPush ? { webPush: opts.webPush } : {}),
    ...(opts.demoSeedFull ? { demoSeedFull: true } : {}),
    now: opts.now ?? (() => new Date()),
  };

  const loops: LoopHandle[] = [];
  const depthGauge = async (result: { observe(v: number, attrs?: Record<string, string>): void }) => {
    try {
      for (const [queue, n] of Object.entries(await runtime.depth())) result.observe(n, { queue });
    } catch {
      // A scrape during a Valkey outage reports nothing rather than failing the export.
    }
  };

  const checks: Record<string, ReadinessCheck> = {
    postgres: async () => {
      await opts.db.sql`select 1`;
    },
    valkey: valkeyCheck(valkey),
    queues: valkeyCheck(bullConnection),
  };

  return {
    ctx,
    runtime,
    checks,
    async start() {
      await runtime.start(ctx);
      metrics.queueDepth.addCallback(depthGauge);
      if (opts.outbox !== false) loops.push(startOutboxRelay(ctx, typeof opts.outbox === "object" ? opts.outbox : {}));
      if (opts.segments !== false)
        loops.push(startSegmentConsumer(ctx, typeof opts.segments === "object" ? opts.segments : {}));
    },
    async stop(deadlineMs = 10_000) {
      metrics.queueDepth.removeCallback(depthGauge);
      await Promise.all(loops.map((l) => l.stop()));
      await runtime.close(deadlineMs);
      await Promise.allSettled([valkey.quit(), bullConnection.quit()]);
    },
  };
}
