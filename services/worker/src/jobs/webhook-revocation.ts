// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Owned by E9-subs; the contract step registered it with its final queue and schema and a no-op handler. */
import { QUEUES } from "@commonair/contracts/internal";
import { defineJob } from "../runtime/registry.ts";
import { RevocationJob, WEBHOOK_JOBS } from "./names.ts";

export const job = defineJob({
  queue: QUEUES.webhooks,
  name: WEBHOOK_JOBS.revocation,
  description: "Tell a webhook receiver once that the API revoked its subscription (grant revoked, app suspended)",
  data: RevocationJob,
  attempts: 3,
  handler: async () => ({ sent: 0 }),
});
