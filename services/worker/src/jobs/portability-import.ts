// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `PORTABILITY_JOBS.import` (ADR 0037 decision 5): for an uploaded bundle, the preview while the
 * import waits for one (enqueued by `portability.imports.preview`, which waits for it), then the
 * apply (`applyBundle`, enqueued by `portability.imports.start`). Retries on a transport failure
 * (the API's upload route down); the last attempt fails the import.
 */
import { PORTABILITY_JOBS, PortabilityImportJob, QUEUES } from "@commonair/contracts/internal";
import { runImportJob } from "../portability/import/index.ts";
import { defineJob } from "../runtime/registry.ts";

const ATTEMPTS = 3;

export const job = defineJob({
  queue: QUEUES.portability,
  name: PORTABILITY_JOBS.import,
  description: "Preview, then apply, an uploaded portability bundle (applyBundle)",
  data: PortabilityImportJob,
  attempts: ATTEMPTS,
  backoffMs: 10_000,
  handler: async ({ importId }, ctx, meta) =>
    runImportJob(ctx, importId, { lastAttempt: meta.attemptsMade + 1 >= ATTEMPTS }),
});
