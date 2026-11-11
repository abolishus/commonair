// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/following` as data (D3.5): Live now first (busiest first), then the offline channels as rows,
 * most recently live first. `me.follows` is the list; the shared home feed adds what it knows
 * (a live card's tags, an offline channel's last stream and category).
 */
import type { BroadcastSummary, StreamCard } from "@commonair/contracts/dto";
import type { DirectoryHome } from "../../lib/directory-sections.ts";

export interface FollowRow {
  channel: StreamCard["channel"];
  live: BroadcastSummary | null;
  followedAt: string;
  notify: boolean;
}

export interface OfflineFollow {
  channel: StreamCard["channel"];
  notify: boolean;
  lastLiveAt: string | null;
  category: { id: string; slug: string; name: string } | null;
}

export interface FollowingView {
  live: { card: StreamCard; notify: boolean }[];
  offline: OfflineFollow[];
}

/** Follows per page from `me.follows`. */
export const FOLLOWS_PAGE = 100;

export function followingView(rows: readonly FollowRow[], feed: DirectoryHome | null): FollowingView {
  const liveCards = new Map((feed?.following ?? []).map((c) => [c.channel.id, c]));
  const offlineCards = new Map((feed?.followingOffline ?? []).map((c) => [c.channel.id, c]));
  const seen = new Set<string>();
  const live: FollowingView["live"] = [];
  const offline: OfflineFollow[] = [];
  for (const row of rows) {
    if (seen.has(row.channel.id)) continue;
    seen.add(row.channel.id);
    if (row.live) {
      const known = liveCards.get(row.channel.id);
      const card: StreamCard = known
        ? { ...known, broadcast: row.live }
        : { channel: row.channel, broadcast: row.live, tags: [], language: "", reason: "following" };
      live.push({ card, notify: row.notify });
    } else {
      const known = offlineCards.get(row.channel.id);
      offline.push({
        channel: row.channel,
        notify: row.notify,
        lastLiveAt: known?.lastLiveAt ?? null,
        category: known?.category ?? null,
      });
    }
  }
  live.sort(
    (a, b) =>
      b.card.broadcast.viewerCount - a.card.broadcast.viewerCount ||
      a.card.channel.slug.localeCompare(b.card.channel.slug),
  );
  // Most recently live first; a channel the feed knows nothing about keeps the follow order.
  const order = new Map(rows.map((r, i) => [r.channel.id, i]));
  offline.sort((a, b) => {
    if (a.lastLiveAt !== b.lastLiveAt) {
      if (a.lastLiveAt === null) return 1;
      if (b.lastLiveAt === null) return -1;
      return b.lastLiveAt.localeCompare(a.lastLiveAt);
    }
    return (order.get(a.channel.id) ?? 0) - (order.get(b.channel.id) ?? 0);
  });
  return { live, offline };
}

/** One row's alert setting changed, the rest unchanged. */
export function withNotify(rows: readonly FollowRow[], channelId: string, notify: boolean): FollowRow[] {
  return rows.map((r) => (r.channel.id === channelId ? { ...r, notify } : r));
}
