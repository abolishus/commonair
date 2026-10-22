// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  authEnv,
  coreEnv,
  databaseEnv,
  developerEnv,
  evidenceOpenEnv,
  evidenceSealEnv,
  internalEnv,
  loadEnv,
  mailEnv,
  mediaEnv,
  moderationEnv,
  coopEnv,
  paymentsEnv,
  playbackEnv,
  servicePorts,
  storageEnv,
  valkeyEnv,
  workerEnv,
} from "@commonair/config/env";
import type { z } from "zod";

/** The API enqueues trust & safety jobs into the worker's BullMQ prefix. */
const bullPrefixEnv = workerEnv.pick({ WORKER_BULL_PREFIX: true });

/** Each schema is parsed on its own: coreEnv carries a refinement, so it cannot be merged with `.extend`. */
const SCHEMAS = [
  coreEnv,
  databaseEnv,
  valkeyEnv,
  internalEnv,
  storageEnv,
  authEnv,
  mailEnv,
  paymentsEnv,
  mediaEnv,
  playbackEnv,
  servicePorts,
  developerEnv,
  // Trust & safety (ADR 0006): missing or invalid configuration refuses to start (fail closed).
  moderationEnv,
  evidenceSealEnv,
  evidenceOpenEnv,
  bullPrefixEnv,
  coopEnv,
] as const;

export type ApiEnv = z.output<typeof coreEnv> &
  z.output<typeof databaseEnv> &
  z.output<typeof valkeyEnv> &
  z.output<typeof internalEnv> &
  z.output<typeof storageEnv> &
  z.output<typeof authEnv> &
  z.output<typeof mailEnv> &
  z.output<typeof paymentsEnv> &
  z.output<typeof mediaEnv> &
  z.output<typeof playbackEnv> &
  z.output<typeof servicePorts> &
  z.output<typeof developerEnv> &
  z.output<typeof moderationEnv> &
  z.output<typeof evidenceSealEnv> &
  z.output<typeof evidenceOpenEnv> &
  z.output<typeof bullPrefixEnv> &
  z.output<typeof coopEnv>;

/** Validate the API's whole environment; throws EnvError listing every problem across schemas. */
export function loadApiEnv(source: Record<string, string | undefined> = process.env): ApiEnv {
  const parts: object[] = [];
  const problems: Error[] = [];
  for (const schema of SCHEMAS) {
    try {
      parts.push(loadEnv(schema as z.ZodType, source) as object);
    } catch (e) {
      problems.push(e as Error);
    }
  }
  if (problems.length > 0) throw new Error(problems.map((p) => p.message).join("\n"));
  return Object.assign({}, ...parts) as ApiEnv;
}
