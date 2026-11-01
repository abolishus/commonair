// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Sign and POST one activity to one remote inbox, retrying on the webhook backoff (ADR 0030 decision 8). */
import { FEDERATION_JOBS, FederationDeliverJob, QUEUES } from "@commonair/contracts/internal";
import { federationConfig } from "../federation/config.ts";
import { runDeliver } from "../federation/deliver.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.federation,
  name: FEDERATION_JOBS.deliver,
  description: "Sign and POST one activity to one remote inbox",
  data: FederationDeliverJob,
  handler: async (data, ctx) => {
    const r = await runDeliver(data, ctx, federationConfig(ctx));
    return { [r.outcome]: 1 };
  },
});
