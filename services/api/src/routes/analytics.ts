// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `analytics.*` (W2-rollup-analytics, batch 6 decision (k), feature-wins §4.9): the channel owner's
 * views of the per-broadcast rollup and its share links. Owner only (not editors: cost and revenue
 * are owner-private); no third-party scope yet. A broadcast shows 24 h after it ends, except
 * through the harness's display bypass (`analyticsDisplayBypassed`, hooks on only). The queries
 * are in `../analytics/**`.
 */
import { createShareLink, listShareLinks, revokeShareLink, sharedAnalytics } from "../analytics/share-links.ts";
import { broadcastAnalytics, exclusionsAnalytics, pnlAnalytics, rangeAnalytics } from "../analytics/queries.ts";
import { periodOf } from "../analytics/rules.ts";
import type { Deps } from "../deps.ts";
import { badRequest, forbidden } from "../lib/errors.ts";
import { type Ctx, os, requireCaller, requireChannel } from "../lib/orpc.ts";
import { analyticsDisplayBypassed } from "../ops/analytics-hooks.ts";

/** The caller's own channel (the middleware lets editors through `owner`; analytics does not). */
export function ownChannel(context: Pick<Ctx, "caller" | "channel">) {
  const caller = requireCaller(context);
  const channel = requireChannel(context);
  if (channel.ownerId !== caller.user.id) throw forbidden("Only the channel owner sees its analytics");
  return { caller, channel };
}

/** A validated `[from, to)` range plus the display bypass for the channel. */
export async function rangeOf(deps: Deps, channelId: string, input: { from?: string; to?: string }) {
  const period = periodOf(input, deps.now());
  if (!period) throw badRequest("The range must end after it starts and span at most 400 days");
  return { channelId, ...period, bypassed: await analyticsDisplayBypassed(deps, channelId) };
}

export const analytics = {
  broadcast: os.analytics.broadcast.handler(async ({ context, input }) => {
    const { channel } = ownChannel(context);
    return broadcastAnalytics(context.deps, {
      channelId: channel.id,
      broadcastId: input.broadcastId,
      withCost: true,
      bypassed: await analyticsDisplayBypassed(context.deps, channel.id),
    });
  }),
  range: os.analytics.range.handler(async ({ context, input }) => {
    const { channel } = ownChannel(context);
    return rangeAnalytics(context.deps, await rangeOf(context.deps, channel.id, input));
  }),
  exclusions: os.analytics.exclusions.handler(async ({ context, input }) => {
    const { channel } = ownChannel(context);
    return exclusionsAnalytics(context.deps, await rangeOf(context.deps, channel.id, input));
  }),
  pnl: os.analytics.pnl.handler(async ({ context, input }) => {
    const { channel } = ownChannel(context);
    return pnlAnalytics(context.deps, {
      ...(await rangeOf(context.deps, channel.id, input)),
      ownerId: channel.ownerId,
    });
  }),
  shared: os.analytics.shared.handler(({ context, input }) => sharedAnalytics(context.deps, input.token)),
  shareLink: {
    list: os.analytics.shareLink.list.handler(({ context, input }) => {
      const { channel } = ownChannel(context);
      return listShareLinks(context.deps, { channelId: channel.id, cursor: input.cursor, limit: input.limit });
    }),
    create: os.analytics.shareLink.create.handler(({ context, input }) => {
      const { caller, channel } = ownChannel(context);
      return createShareLink(context.deps, {
        channelId: channel.id,
        creatorId: caller.user.id,
        broadcastId: input.broadcastId,
        expiresInDays: input.expiresInDays,
      });
    }),
    revoke: os.analytics.shareLink.revoke.handler(({ context, input }) => {
      const { channel } = ownChannel(context);
      return revokeShareLink(context.deps, { channelId: channel.id, id: input.id });
    }),
  },
};
