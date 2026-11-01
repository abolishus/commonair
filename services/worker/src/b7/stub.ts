// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 7 contract step: the handler every not-yet-built batch 7 job runs. It does nothing and
 * says so, so a queued job completes instead of failing. Each unit replaces it in its own job file.
 */
import type { WorkerContext } from "../context.ts";

export const stubHandler =
  (name: string) =>
  async (_data: unknown, ctx: WorkerContext): Promise<Record<string, number>> => {
    ctx.logger.debug("batch 7 job stub ran", { job: name });
    return { stub: 1 };
  };
