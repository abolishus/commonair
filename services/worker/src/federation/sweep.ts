// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The daily sweep (ADR 0030 decisions 5, 7 and 8):
 *
 * - inbox items older than `FEDERATION_RULES.dropAfterDays` are deleted (they hold raw remote
 *   requests);
 * - an inbox that has failed every attempt for `dropAfterDays` loses its followers and is marked
 *   `dropped`;
 * - followers on a blocked domain are removed (the API drops them when a block is added; this
 *   catches a race with an inbox job);
 * - a channel whose streamer turned federation off while it still has followers sends `Delete`
 *   of the actor to them, and they are removed (only while the instance flag is on: with it off
 *   nothing is sent).
 */
import { FEDERATION_RULES } from "@commonair/contracts/enums";
import { schema as s } from "@commonair/db";
import { and, eq, inArray, isNotNull, lte, or, sql } from "drizzle-orm";
import type { WorkerContext } from "../context.ts";
import type { FederationConfig } from "./config.ts";
import { deleteActor } from "./fanout.ts";
import { blockedDomains, domainMatches, loadChannel } from "./local.ts";

const DAY = 86_400_000;

type Ctx = Pick<WorkerContext, "db" | "logger" | "enqueueBulk" | "now">;

export interface SweepResult {
  inboxItems: number;
  droppedInboxes: number;
  droppedFollowers: number;
  blockedFollowers: number;
  actorDeletes: number;
}

export async function runSweep(ctx: Ctx, cfg: FederationConfig): Promise<SweepResult> {
  const now = ctx.now();
  const cutoff = new Date(now.getTime() - FEDERATION_RULES.dropAfterDays * DAY);
  const items = await ctx.db
    .delete(s.federationInboxItems)
    .where(lte(s.federationInboxItems.receivedAt, cutoff))
    .returning({ id: s.federationInboxItems.id });

  // Inboxes failing since before the cutoff with no success since.
  const failing = await ctx.db
    .select({ inbox: s.federationDeliveries.inbox })
    .from(s.federationDeliveries)
    .where(
      and(
        eq(s.federationDeliveries.status, "failing"),
        isNotNull(s.federationDeliveries.firstFailedAt),
        lte(s.federationDeliveries.firstFailedAt, cutoff),
      ),
    );
  const inboxes = failing.map((f) => f.inbox);
  let droppedFollowers = 0;
  if (inboxes.length > 0) {
    droppedFollowers = (
      await ctx.db
        .delete(s.federationFollowers)
        .where(or(inArray(s.federationFollowers.inbox, inboxes), inArray(s.federationFollowers.sharedInbox, inboxes)))
        .returning({ id: s.federationFollowers.id })
    ).length;
    await ctx.db
      .update(s.federationDeliveries)
      .set({ status: "dropped" })
      .where(inArray(s.federationDeliveries.inbox, inboxes));
  }

  const blocks = await blockedDomains(ctx.db);
  let blockedFollowers = 0;
  if (blocks.length > 0) {
    const rows = await ctx.db
      .select({ id: s.federationFollowers.id, domain: s.federationFollowers.domain })
      .from(s.federationFollowers);
    const ids = rows.filter((r) => blocks.some((d) => domainMatches(r.domain, d))).map((r) => r.id);
    if (ids.length > 0)
      blockedFollowers = (
        await ctx.db
          .delete(s.federationFollowers)
          .where(inArray(s.federationFollowers.id, ids))
          .returning({ id: s.federationFollowers.id })
      ).length;
  }

  // Channels with followers that no longer federate by their streamer's choice.
  let actorDeletes = 0;
  if (cfg.enabled) {
    const off = await ctx.db
      .selectDistinct({ channelId: s.federationFollowers.channelId })
      .from(s.federationFollowers)
      .innerJoin(s.channels, eq(s.channels.id, s.federationFollowers.channelId))
      .where(sql`coalesce((${s.channels.federationSettings} ->> 'enabled')::boolean, false) = false`);
    for (const { channelId } of off) {
      const ch = await loadChannel(ctx.db, cfg, channelId);
      if (!ch?.actor) continue;
      await deleteActor(ctx, ch);
      actorDeletes++;
    }
  }

  const result = {
    inboxItems: items.length,
    droppedInboxes: inboxes.length,
    droppedFollowers,
    blockedFollowers,
    actorDeletes,
  };
  ctx.logger.info("federation sweep", { ...result });
  return result;
}
