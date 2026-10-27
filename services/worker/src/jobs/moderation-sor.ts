// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { MODERATION_JOBS, QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { defineJob, type JobDefinition } from "../runtime/registry.ts";

/**
 * Statements of reasons (ADR 0019 decision 5). `sor-build` turns allowlisted `audit_log` rows
 * (`ENFORCEMENT_SOURCE_ACTIONS`) into `enforcement_statements` and delivers them; `sor-coverage`
 * counts allowlisted rows older than 5 minutes that have none and alerts.
 *
 * Stubs until W0-sor lands them.
 */
export const sorJobs: readonly JobDefinition[] = [
  defineJob({
    queue: QUEUES.moderation,
    name: MODERATION_JOBS.sorBuild,
    description: "Build and deliver statements of reasons from the audit log",
    data: z.object({}),
    schedule: { every: 15_000 },
    handler: async () => ({ notBuilt: 1 }),
  }),
  defineJob({
    queue: QUEUES.moderation,
    name: MODERATION_JOBS.sorCoverage,
    description: "Daily: alert on enforcement actions with no statement of reasons",
    data: z.object({}),
    schedule: { pattern: "41 4 * * *" },
    handler: async () => ({ notBuilt: 1 }),
  }),
];
