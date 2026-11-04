// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * F38: `/settings/subscriptions` lists channels by display name. A subscription carries only the
 * channel's slug, so the page reads each channel once (`channels.get`) and falls back to the slug
 * for one that does not answer. A `channel` object on the subscription DTO would make this one
 * request (filed as a contract request).
 */
import * as React from "react";
import { api } from "../../lib/api.ts";
import type { SubscriptionDto } from "../../lib/support.ts";
import type { SubscriptionChannel } from "../support/subscription-list.tsx";

export type ChannelLookup = (slug: string) => Promise<SubscriptionChannel>;

const lookupChannel: ChannelLookup = async (slug) => {
  const c = await api().channels.get({ channel: slug });
  return { displayName: c.displayName, avatarUrl: c.avatarUrl };
};

/** One lookup per distinct slug; failed ones are left out (the row shows the slug). */
export async function loadSubscriptionChannels(
  slugs: readonly string[],
  lookup: ChannelLookup = lookupChannel,
): Promise<Map<string, SubscriptionChannel>> {
  const unique = [...new Set(slugs)];
  const answers = await Promise.allSettled(unique.map((slug) => lookup(slug)));
  const out = new Map<string, SubscriptionChannel>();
  answers.forEach((a, i) => {
    const slug = unique[i];
    if (a.status === "fulfilled" && slug !== undefined) out.set(slug, a.value);
  });
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
