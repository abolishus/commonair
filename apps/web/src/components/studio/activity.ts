// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The stream manager's activity feed (F21): what happened in the channel while the streamer was
 * live, newest first, from the `op:"event"` frames the chat socket delivers: subs, gifts, tips,
 * raids and giveaway results to everyone, follows only to the broadcaster's and moderators'
 * connections (they name the follower). Pure.
 */
import { EVENTS } from "@commonair/contracts/events";
import { chatEventView } from "../../chat/events.ts";

export type ActivityKind = "follow" | "subscribe" | "gift" | "tip" | "raid" | "giveaway";

export interface ActivityItem {
  /** Stable for React keys and de-duplication. */
  id: string;
  kind: ActivityKind;
  /** Display name; null when anonymous. */
  name: string | null;
  tier: number | null;
  /** Gift subs: how many; giveaways: how many winners. */
  count: number | null;
  amount: { cents: number; currency: string } | null;
  /** Raids: the integrity-verified viewer count. */
  viewers: number | null;
  /** Giveaways: the title, and whether it was drawn (or cancelled). */
  title: string | null;
  drawn: boolean | null;
  /** ISO time the item arrived (or the event's own time, when it carries one). */
  at: string;
}

/** The feed keeps this many; older items fall off the end. */
export const ACTIVITY_MAX = 50;

const base = (kind: ActivityKind, id: string, at: string): ActivityItem => ({
  id,
  kind,
  name: null,
  tier: null,
  count: null,
  amount: null,
  viewers: null,
  title: null,
  drawn: null,
  at,
});

/**
 * One feed item from a platform event frame, or null for a type the feed does not show or a
 * payload that does not validate. `seq` makes ids unique for events with no id of their own.
 */
export function activityFromEvent(type: string, data: unknown, at: string, seq: number): ActivityItem | null {
  if (type === "channel.follow") {
    const p = EVENTS[type].payload.safeParse(data);
    if (!p.success) return null;
    return {
      ...base("follow", `follow:${p.data.user_id}:${p.data.followed_at}`, p.data.followed_at),
      name: p.data.user_name || p.data.user_login,
    };
  }
  if (type === "channel.giveaway.end") {
    const p = EVENTS[type].payload.safeParse(data);
    if (!p.success) return null;
    return {
      ...base("giveaway", `giveaway:${p.data.id}`, p.data.ended_at),
      title: p.data.title,
      count: p.data.winners,
      drawn: p.data.status === "drawn",
    };
  }
  const view = chatEventView(type, data);
  if (!view) return null;
  const id = `${type}:${seq}`;
  switch (view.type) {
    case "channel.subscribe":
      return { ...base("subscribe", id, at), name: view.name, tier: view.tier };
    case "channel.subscription.gift":
      return { ...base("gift", id, at), name: view.name, tier: view.tier, count: view.total };
    case "channel.tip":
      return { ...base("tip", id, at), name: view.name, amount: view.amount };
    case "channel.raid":
      return { ...base("raid", id, at), name: view.name, viewers: view.viewers };
  }
}

/** The feed with `item` on top: a repeated id is ignored, and only the newest `max` are kept. */
export function pushActivity(
  list: readonly ActivityItem[],
  item: ActivityItem,
  max: number = ACTIVITY_MAX,
): ActivityItem[] {
  if (list.some((i) => i.id === item.id)) return [...list];
  return [item, ...list].slice(0, Math.max(0, max));
}
