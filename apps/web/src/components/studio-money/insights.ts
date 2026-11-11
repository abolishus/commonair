// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * d5-money (overhaul D5.6, creator-studio P6): the "What's working" insights, computed from
 * `analytics.range` and the follower list. Deterministic arithmetic over settled (verified)
 * figures, no model: best day and hour to stream, average verified watch per session, follows
 * per hour streamed, and the stream that brought the most follows. Each is null when the data
 * cannot support it, and the page says what would.
 */
import type { AnalyticsRange } from "@commonair/contracts/dto";

type Broadcast = AnalyticsRange["broadcasts"][number];

/** Day of week (0 = Sunday) and hour of an instant, in the viewer's own time zone by default. */
export type LocalSlot = (ms: number) => { weekday: number; hour: number };
export const localSlot: LocalSlot = (ms) => {
  const d = new Date(ms);
  return { weekday: d.getDay(), hour: d.getHours() };
};

export interface BestSlot {
  weekday: number;
  hour: number;
  /** Verified viewers on average: verified watch seconds per second streamed in that slot. */
  averageViewers: number;
  /** The slot's best stream, for the tile's link. */
  broadcastId: string;
}

/**
 * The start slot (day and hour) whose streams averaged the most verified viewers (verified watch
 * time per hour streamed). Needs streams in at least two slots: one slot is not a comparison.
 */
export function bestSlot(broadcasts: readonly Broadcast[], slot: LocalSlot = localSlot): BestSlot | null {
  const slots = new Map<
    string,
    { weekday: number; hour: number; seconds: number; streamed: number; best: Broadcast }
  >();
  for (const b of broadcasts) {
    if (b.durationSeconds <= 0) continue;
    const { weekday, hour } = slot(Date.parse(b.startedAt));
    const id = `${weekday}|${hour}`;
    const s = slots.get(id) ?? { weekday, hour, seconds: 0, streamed: 0, best: b };
    s.seconds += b.totals.verifiedViewerSeconds;
    s.streamed += b.durationSeconds;
    if (b.totals.verifiedViewerSeconds > s.best.totals.verifiedViewerSeconds) s.best = b;
    slots.set(id, s);
  }
  if (slots.size < 2) return null;
  let top: BestSlot | null = null;
  for (const s of slots.values()) {
    const averageViewers = s.seconds / s.streamed;
    // Ties go to the earlier slot in the week, so the answer does not depend on input order.
    const earlier = top !== null && s.weekday * 24 + s.hour < top.weekday * 24 + top.hour;
    if (top === null || averageViewers > top.averageViewers || (averageViewers === top.averageViewers && earlier))
      top = { weekday: s.weekday, hour: s.hour, averageViewers, broadcastId: s.best.broadcastId };
  }
  return top && top.averageViewers > 0 ? top : null;
}

/** Verified watch seconds per viewing session over the period; null with no sessions. */
export function averageWatchSeconds(totals: AnalyticsRange["totals"]): number | null {
  if (totals.sessions <= 0) return null;
  return Math.round(totals.verifiedViewerSeconds / totals.sessions);
}

/** Follows made while streams in the list were live. */
function followsDuring(b: Broadcast, followedAt: readonly number[]): number {
  const from = Date.parse(b.startedAt);
  const to = from + b.durationSeconds * 1000;
  return followedAt.filter((at) => at >= from && at < to).length;
}

/**
 * New follows in the period per hour streamed, one decimal; null without the follower list or
 * with nothing streamed.
 */
export function followsPerHour(
  broadcasts: readonly Broadcast[],
  followedAt: readonly string[] | null,
  period: { from: string; to: string },
): number | null {
  if (followedAt === null) return null;
  const streamed = broadcasts.reduce((sum, b) => sum + Math.max(0, b.durationSeconds), 0);
  if (streamed <= 0) return null;
  const from = Date.parse(period.from);
  const to = Date.parse(period.to);
  const follows = followedAt.filter((a) => {
    const ms = Date.parse(a);
    return ms >= from && ms < to;
  }).length;
  return Math.round((follows / (streamed / 3600)) * 10) / 10;
}

export interface TopGrowth {
  broadcastId: string;
  title: string;
  follows: number;
}

/** The stream with the most follows made while it was live; null when none brought any. */
export function topGrowth(broadcasts: readonly Broadcast[], followedAt: readonly string[] | null): TopGrowth | null {
  if (followedAt === null) return null;
  const at = followedAt.map((a) => Date.parse(a));
  let top: TopGrowth | null = null;
  for (const b of broadcasts) {
    const follows = followsDuring(b, at);
    if (follows > 0 && (top === null || follows > top.follows))
      top = { broadcastId: b.broadcastId, title: b.title, follows };
  }
  return top;
}
