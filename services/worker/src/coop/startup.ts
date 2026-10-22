// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Logger } from "@commonair/observability";
import type { WorkerEnv } from "../env.ts";

/**
 * `COOP_TEST_HOOKS` (harness only, never on a public instance): the API then serves
 * `POST /internal/coop/tick`, which enqueues co-op jobs on demand. The worker's jobs behave the
 * same either way; it warns at every start and reports the flag on `/healthz` so an operator
 * sees a test instance for what it is.
 */
export function coopTestHooks(env: Pick<WorkerEnv, "COOP_TEST_HOOKS">, logger: Pick<Logger, "warn">): boolean {
  if (env.COOP_TEST_HOOKS)
    logger.warn("co-op test hooks are enabled; do not expose this instance to public traffic", { testHooks: true });
  return env.COOP_TEST_HOOKS;
}
