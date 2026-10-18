// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  authEnv,
  coreEnv,
  databaseEnv,
  developerEnv,
  servicePorts,
  storageEnv,
  valkeyEnv,
  workerEnv as workerTuningEnv,
} from "@commonair/config";
import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
export const QUEUE_NAMES = Object.values(QUEUES) as QueueName[];

export const workerEnv = z.object({
  ...coreEnv.shape,
  ...databaseEnv.shape,
  ...valkeyEnv.shape,
  ...authEnv.pick({ AUTH_SECRET: true }).shape,
  ...developerEnv.shape,
  ...servicePorts.pick({ WORKER_PORT: true }).shape,
  ...storageEnv.partial({ S3_ENDPOINT: true, S3_ACCESS_KEY_ID: true, S3_SECRET_ACCESS_KEY: true }).shape,
  ...workerTuningEnv.shape,
});
export type WorkerEnv = z.output<typeof workerEnv>;

export const DEFAULT_CONCURRENCY: Record<QueueName, number> = Object.fromEntries(
  QUEUE_NAMES.map((q) => [q, q === QUEUES.webhooks ? 32 : q === QUEUES.retention ? 1 : 4]),
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
