// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Process entry point: `bun services/worker/src/main.ts`. */
import { loadEnv } from "@commonair/config";
import { createDb } from "@commonair/db";
import { createLogger, initTelemetry } from "@commonair/observability";
import { runService } from "@commonair/service";
import { createS3Storage } from "@commonair/storage";
import { parseConcurrency, workerEnv } from "./env.ts";
import { ClassifierHolder } from "./integrity/classifier.ts";
import { buildModerationOptions } from "./moderation/startup.ts";
import { defaultWebhookSettings } from "./webhooks/settings.ts";
import { createWorker } from "./worker.ts";

const env = loadEnv(workerEnv);
const telemetry = await initTelemetry({ serviceName: env.OTEL_SERVICE_NAME ?? "worker" });
const logger = createLogger({ service: "worker", level: env.LOG_LEVEL });

const storage =
  env.S3_ENDPOINT && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY
    ? createS3Storage({
        endpoint: env.S3_ENDPOINT,
        publicEndpoint: env.S3_PUBLIC_ENDPOINT,
        region: env.S3_REGION,
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
      })
    : undefined;
if (!storage) throw new Error("worker media storage is required");
const moderation = await buildModerationOptions(env);
if (moderation.testHooks)
  logger.warn("moderation test hooks are enabled; do not expose this worker to public traffic", {
    classifier: env.MODERATION_CLASSIFIER,
    testHooks: true,
  });

// Loaded once here and on SIGHUP, never per scoring run.
const networks = new ClassifierHolder(logger);
networks.reload();
const unwatchSighup = networks.watchSighup();

const db = createDb({ url: env.DATABASE_URL, max: env.DATABASE_POOL_MAX, applicationName: "commonair-worker" });
const worker = createWorker({
  db,
  valkeyUrl: env.VALKEY_URL,
  logger,
  webhooks: defaultWebhookSettings(env.AUTH_SECRET, env.EVENTSUB_ALLOW_INSECURE_CALLBACKS),
  bullPrefix: env.WORKER_BULL_PREFIX,
  concurrency: parseConcurrency(env.WORKER_CONCURRENCY),
  storage,
  mediaBucket: env.S3_BUCKET_MEDIA,
  classifier: () => networks.classifier,
  moderation,
});
if (env.EVENTSUB_ALLOW_INSECURE_CALLBACKS)
  logger.warn("EVENTSUB_ALLOW_INSECURE_CALLBACKS is on: webhook callbacks may reach private networks");

const SHUTDOWN_DEADLINE_MS = 25_000;
await worker.start();
runService({
  name: "worker",
  port: env.WORKER_PORT,
  logger,
  checks: worker.checks,
  health: { moderation_test_hooks: moderation.testHooks },
  fetch: () => new Response("not found", { status: 404 }),
  shutdownTimeoutMs: SHUTDOWN_DEADLINE_MS + 3_000,
  onShutdown: async () => {
    unwatchSighup();
    await worker.stop(SHUTDOWN_DEADLINE_MS);
    await db.close();
    await telemetry.shutdown();
  },
});
