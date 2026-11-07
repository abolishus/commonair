// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * F7 (discovery DS-14): the signed-in viewer's own channel is never recommended back to them. Home
 * shelves, the rail and the mobile sheet read the feed through `withoutOwnChannel`; when the
 * viewer's channel is live, home shows `OwnLiveStatus` instead of a card.
 */
import type { StreamCard } from "@commonair/contracts/dto";
import type { DirectoryHome } from "../../lib/directory-sections.ts";

/** The viewer's channel slug as the API knows it (`channelSlug`), or null when signed out. */
export function ownChannelSlug(me: { channelSlug: string | null } | null): string | null {
  return me?.channelSlug ?? null;
}

export interface OwnFeed {
  home: DirectoryHome;
  /** The viewer's own live card, taken out of the shelves; null when not live or not listed. */
  ownLive: StreamCard | null;
}

/** `home` without any card for channel `slug` (the same object when there is nothing to remove). */
export function withoutOwnChannel(home: DirectoryHome, slug: string | null): OwnFeed {
  if (slug === null) return { home, ownLive: null };
  const mine = (card: { channel: { slug: string } }) => card.channel.slug === slug;
  const ownLive = [...home.spotlight, ...home.newAndLive, ...home.live, ...home.following].find(mine) ?? null;
  const any = ownLive !== null || home.recentlyLive.some(mine) || home.followingOffline.some(mine);
  if (!any) return { home, ownLive: null };
  const others = <T extends { channel: { slug: string } }>(cards: T[]): T[] => cards.filter((c) => !mine(c));
  return {
    home: {
      spotlight: others(home.spotlight),
      newAndLive: others(home.newAndLive),
      live: others(home.live),
      following: others(home.following),
      recentlyLive: others(home.recentlyLive),
      followingOffline: others(home.followingOffline),
    },
    ownLive,
  };
}
