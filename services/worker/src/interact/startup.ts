// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Logger } from "@commonair/observability";
import type { WorkerEnv } from "../env.ts";

/**
 * `INTERACT_TEST_HOOKS` (harness only, never on a public instance, ADR 0026): the API then serves
 * `POST /internal/interact/tick`, which enqueues an interactivity job on demand. The worker's jobs
 * behave the same either way; it warns at every start and reports the flag on `/healthz` so an
 * operator sees a test instance for what it is.
 */
export function interactTestHooks(env: Pick<WorkerEnv, "INTERACT_TEST_HOOKS">, logger: Pick<Logger, "warn">): boolean {
  if (env.INTERACT_TEST_HOOKS)
    logger.warn("interactivity test hooks are enabled; do not expose this instance to public traffic", {
      testHooks: true,
    });
  return env.INTERACT_TEST_HOOKS;
}
