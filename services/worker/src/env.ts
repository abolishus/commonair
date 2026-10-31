// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  authEnv,
  coreEnv,
  databaseEnv,
  developerEnv,
  moderationEnv,
  coopEnv,
  interactEnv,
  seedEnv,
  chatEnv,
  internalEnv,
  evidenceSealEnv,
  evidenceStorageEnv,
  mailEnv,
  opsEnv,
  paymentsEnv,
  servicePorts,
  storageEnv,
  valkeyEnv,
  webPushRefinement,
  webPushShape,
  workerEnv as workerTuningEnv,
} from "@commonair/config";
import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
export const QUEUE_NAMES = Object.values(QUEUES) as QueueName[];

export const workerEnv = z
  .object({
    ...coreEnv.shape,
    ...databaseEnv.shape,
    ...valkeyEnv.shape,
    ...authEnv.pick({ AUTH_SECRET: true }).shape,
    ...developerEnv.shape,
    ...paymentsEnv.shape,
    ...servicePorts.pick({ WORKER_PORT: true }).shape,
    ...storageEnv.partial({ S3_ENDPOINT: true, S3_ACCESS_KEY_ID: true, S3_SECRET_ACCESS_KEY: true }).shape,
    ...workerTuningEnv.shape,
    // Trust & safety (ADR 0006): required, so a worker without them refuses to start.
    ...moderationEnv.shape,
    ...evidenceSealEnv.shape,
    ...evidenceStorageEnv.shape,
    ...coopEnv.shape,
    // E6: export emails and the operations test hook (ADR 0021).
    ...mailEnv.shape,
    ...opsEnv.shape,
    // E8: the interactivity test hook (ADR 0026).
    ...interactEnv.shape,
    // The full-coverage seed: points accrue on demo data only while it is on (local and staging).
    ...seedEnv.shape,
    // W1: chat retention, the verified-watch writer and the surge guard (ADR 0012 amendment 1, ADR 0015).
    ...chatEnv.shape,
    // W1: verified-watch jitter (ADR 0015 decision 4)
    ...internalEnv.pick({ INTERNAL_API_SECRET: true }).shape,
    // N1: web push (ADR 0028 decision 1); the worker signs with the VAPID private key.
    ...webPushShape.shape,
  })
  .superRefine((env, ctx) => {
    if (env.MODERATION_CLASSIFIER === "scripted" && !env.MODERATION_TEST_HOOKS)
      ctx.addIssue({
        code: "custom",
        path: ["MODERATION_CLASSIFIER"],
        message: "the scripted classifier needs MODERATION_TEST_HOOKS=true (harness only)",
      });
    // `.shape` drops chatEnv's refine; the retention job reads both.
    if (env.CHAT_REPLAY_MAX_DAYS < env.CHAT_RETENTION_DAYS)
      ctx.addIssue({
        code: "custom",
        path: ["CHAT_REPLAY_MAX_DAYS"],
        message: "CHAT_REPLAY_MAX_DAYS must be at least CHAT_RETENTION_DAYS",
      });
    // Push on without the VAPID pair refuses to start (`.shape` drops webPushEnv's refine too).
    webPushRefinement(env, ctx, true);
  });
export type WorkerEnv = z.output<typeof workerEnv>;

/**
 * `integrity` runs seven recurring jobs: with eight slots a stuck run of one job never
 * starves the others.
 */
const QUEUE_DEFAULTS: Partial<Record<QueueName, number>> = {
  [QUEUES.webhooks]: 32,
  [QUEUES.retention]: 1,
  [QUEUES.integrity]: 8,
  // Classifier inference is CPU-bound; scans, T0 transactions and the clock share these slots,
  // and a scheduled job holding one never blocks a T0 (they finish in seconds).
  [QUEUES.moderation]: 6,
  [QUEUES.deletions]: 1,
};
export const DEFAULT_CONCURRENCY: Record<QueueName, number> = Object.fromEntries(
  QUEUE_NAMES.map((q) => [q, QUEUE_DEFAULTS[q] ?? 4]),
) as Record<QueueName, number>;

/** Parse "queue=n,queue=n" over the defaults; unknown queues and bad numbers are rejected. */
export function parseConcurrency(spec: string): Record<QueueName, number> {
  const out = { ...DEFAULT_CONCURRENCY };
  for (const part of spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const [name, value] = part.split("=").map((s) => s.trim());
    if (!name || !QUEUE_NAMES.includes(name as QueueName))
      throw new Error(`WORKER_CONCURRENCY: unknown queue "${name}"`);
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 1000)
      throw new Error(`WORKER_CONCURRENCY: "${name}" needs an integer between 1 and 1000`);
    out[name as QueueName] = n;
  }
  return out;
}
