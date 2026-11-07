// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { QUEUES } from "@commonair/contracts/internal";
import { z } from "zod";
import { runAccountDeletions } from "../deletion/account-deletion.ts";
import { type RenewalPort, renewalPortFromEnv } from "../deletion/money.ts";
import { withRunLock } from "../integrity/lock.ts";
import { defineJob } from "../runtime/registry.ts";

export const ACCOUNT_DELETION_JOB = "account-deletion";

let port: RenewalPort | null | undefined;
/** The payment provider, built once per process (tests pass their own to `runAccountDeletions`). */
const portOf = () => (port === undefined ? (port = renewalPortFromEnv()) : port);

export const job = defineJob({
  queue: QUEUES.deletions,
  name: ACCOUNT_DELETION_JOB,
  description: "Complete due account deletions: delete or pseudonymize the user's data, keep held records",
  data: z.object({}),
  schedule: { every: 5 * 60_000 },
  attempts: 3,
  backoffMs: 30_000,
  handler: async (_data, ctx) => {
    const r = await withRunLock(
      ctx.valkey,
      "worker:lock:deletions:account-deletion",
      { ttlMs: 30_000, maxHoldMs: 30 * 60_000, job: ACCOUNT_DELETION_JOB, logger: ctx.logger },
      () => runAccountDeletions(ctx, 20, portOf()),
    );
    return r.acquired ? r.value : { skipped: 1 };
  },
});
