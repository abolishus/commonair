// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Remove the remote followers of a channel that turned federation off (decision (h)). Queued by
 * the outbox relay with the actor `Delete` deliveries, in the same bulk, so every inbox it removes
 * already has its `Delete` queued (the deliver job carries the inbox). Followers that arrived after
 * the change (federation turned back on) are kept. The rows hold remote people's handles (ADR 0030
 * decision 6), so they go even when the channel federates again before this runs.
 */
import { QUEUES } from "@commonair/contracts/internal";
import { schema as s } from "@commonair/db";
import { and, eq, sql } from "drizzle-orm";
import { defineJob } from "../runtime/registry.ts";
import { FEDERATION_FOLLOWER_CLEANUP, FederationFollowerCleanupJob } from "./names.ts";

export const job = defineJob({
  queue: QUEUES.federation,
  name: FEDERATION_FOLLOWER_CLEANUP,
  description: "Remove the remote followers of a channel that turned federation off",
  data: FederationFollowerCleanupJob,
  handler: async (data, ctx) => {
    const gone = await ctx.db
      .delete(s.federationFollowers)
      .where(
        and(
          eq(s.federationFollowers.channelId, data.channelId),
          // The cut-off has milliseconds; created_at has microseconds.
          sql`date_trunc('milliseconds', ${s.federationFollowers.createdAt}) <= ${data.upTo}::timestamptz`,
        ),
      )
      .returning({ id: s.federationFollowers.id });
    return { removed: gone.length };
  },
});
