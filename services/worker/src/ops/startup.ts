// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Logger } from "@commonair/observability";
import type { WorkerEnv } from "../env.ts";

/**
 * `OPS_TEST_HOOKS` (harness only, never on a public instance, ADR 0021): the API then serves
 * `POST /internal/ops/tick`, which enqueues account deletion, export cleanup or VOD retention on
 * demand. The worker's jobs behave the same either way; it warns at every start and reports the
 * flag on `/healthz` so an operator sees a test instance for what it is.
 */
export function opsTestHooks(env: Pick<WorkerEnv, "OPS_TEST_HOOKS">, logger: Pick<Logger, "warn">): boolean {
  if (env.OPS_TEST_HOOKS)
    logger.warn("operations test hooks are enabled; do not expose this instance to public traffic", {
      testHooks: true,
    });
  return env.OPS_TEST_HOOKS;
}
