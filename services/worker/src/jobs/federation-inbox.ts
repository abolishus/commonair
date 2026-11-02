// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Process one ActivityPub inbox item: verify the signature and apply the activity (ADR 0030
 * decision 5). A transient key or actor fetch failure retries (5 s, then 10 s); the last attempt
 * rejects the item.
 */
import { FEDERATION_JOBS, FederationInboxJob, QUEUES } from "@commonair/contracts/internal";
import { federationConfig } from "../federation/config.ts";
import { runInbox } from "../federation/inbox.ts";
import { defineJob } from "../runtime/registry.ts";

const ATTEMPTS = 3;

export const job = defineJob({
  queue: QUEUES.federation,
  name: FEDERATION_JOBS.inbox,
  description: "Process one ActivityPub inbox item",
  data: FederationInboxJob,
  attempts: ATTEMPTS,
  backoffMs: 5_000,
  handler: async (data, ctx, meta) => {
    const r = await runInbox(data.itemId, ctx, federationConfig(ctx), {
      lastAttempt: meta.attemptsMade + 1 >= ATTEMPTS,
    });
    return { [r.outcome]: 1 };
  },
});
