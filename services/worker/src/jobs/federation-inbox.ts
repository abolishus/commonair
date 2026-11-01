// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Process one ActivityPub inbox item: verify the signature and apply the activity (ADR 0030 decision 5). */
import { FEDERATION_JOBS, FederationInboxJob, QUEUES } from "@commonair/contracts/internal";
import { federationConfig } from "../federation/config.ts";
import { runInbox } from "../federation/inbox.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.federation,
  name: FEDERATION_JOBS.inbox,
  description: "Process one ActivityPub inbox item",
  data: FederationInboxJob,
  handler: async (data, ctx) => {
    const r = await runInbox(data.itemId, ctx, federationConfig(ctx));
    return { [r.outcome]: 1 };
  },
});
