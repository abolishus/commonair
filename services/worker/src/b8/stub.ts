// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 8 contract step: the handler every not-yet-built batch 8 job runs. It does nothing and
 * says so, so a queued or scheduled job completes instead of failing. Each unit replaces it in its
 * own job file.
 */
import type { WorkerContext } from "../context.ts";

export const b8Stub =
  (name: string) =>
  async (_data: unknown, ctx: WorkerContext): Promise<{ skipped: "stub" }> => {
    ctx.logger.debug("batch 8 job stub ran", { job: name });
    return { skipped: "stub" };
  };
