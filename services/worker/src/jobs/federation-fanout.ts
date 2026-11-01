// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Turn one outbox event into an activity and one delivery per follower inbox (ADR 0030 decisions 3, 7, 8). */
import { FEDERATION_JOBS, FederationFanoutJob, QUEUES } from "@commonair/contracts/internal";
import { federationConfig } from "../federation/config.ts";
import { runFanout } from "../federation/fanout.ts";
import { defineJob } from "../runtime/registry.ts";

export const job = defineJob({
  queue: QUEUES.federation,
  name: FEDERATION_JOBS.fanout,
  description: "Turn one outbox event into deliveries to the channel's followers",
  data: FederationFanoutJob,
  handler: async (data, ctx) => {
    const r = await runFanout(data.eventId, ctx, federationConfig(ctx));
    return { [r.outcome]: 1, deliveries: r.deliveries };
  },
});
