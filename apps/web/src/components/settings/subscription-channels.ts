// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * F38: `/settings/subscriptions` lists channels by display name. A subscription carries only the
 * channel's slug, so the page reads each channel once (`channels.get`) and falls back to the slug
 * for one that does not answer. A `channel` object on the subscription DTO would make this one
 * request (filed as a contract request); until then the lookups run a few at a time.
 */
import * as React from "react";
import { api } from "../../lib/api.ts";
import type { SubscriptionDto } from "../../lib/support.ts";
import { runLimited } from "../portability/grants.tsx";
import type { SubscriptionChannel } from "../support/subscription-list.tsx";

export type ChannelLookup = (slug: string) => Promise<SubscriptionChannel>;

const lookupChannel: ChannelLookup = async (slug) => {
  const c = await api().channels.get({ channel: slug });
  return { displayName: c.displayName, avatarUrl: c.avatarUrl, accent: c.theme.accent ?? null };
};

/** Lookups in flight at once, so a long subscription list does not fan out N requests. */
export const LOOKUP_CONCURRENCY = 4;

/** One lookup per distinct slug; failed ones are left out (the row shows the slug). */
export async function loadSubscriptionChannels(
  slugs: readonly string[],
  lookup: ChannelLookup = lookupChannel,
): Promise<Map<string, SubscriptionChannel>> {
  const unique = [...new Set(slugs)];
  const found = new Map<string, SubscriptionChannel>();
  await runLimited(unique, LOOKUP_CONCURRENCY, async (slug) => {
    found.set(slug, await lookup(slug));
  });
  // In the order asked, not the order answered.
  const out = new Map<string, SubscriptionChannel>();
  for (const slug of unique) {
    const channel = found.get(slug);
    if (channel) out.set(slug, channel);
  }
  return out;
}

export function useSubscriptionChannels(
  subscriptions: readonly SubscriptionDto[] | null,
  lookup?: ChannelLookup,
): ReadonlyMap<string, SubscriptionChannel> | undefined {
  const [channels, setChannels] = React.useState<ReadonlyMap<string, SubscriptionChannel>>();
  const key = subscriptions === null ? null : [...new Set(subscriptions.map((s) => s.channelSlug))].sort().join(",");
  React.useEffect(() => {
    if (key === null || key === "") return;
    let live = true;
    void loadSubscriptionChannels(key.split(","), lookup).then((map) => {
      if (live) setChannels(map);
    });
    return () => {
      live = false;
    };
  }, [key, lookup]);
  return channels;
}
