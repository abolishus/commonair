// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Home v2 as data (overhaul wave 2, D3.1): what goes on which shelf, so the rules are tested
 * without rendering. Each channel shows once: the featured stream, then Following (signed in),
 * then Live now; offline "Recently live" never lists a channel that is live on the page.
 */
import type { Category, ChannelCard, FeeScheduleEntry, StreamCard, TransparencyMonth } from "@commonair/contracts/dto";
import type { z } from "zod";
import type { DirectoryHome } from "../../lib/directory-sections.ts";
import { sortCategories } from "../../lib/directory-sections.ts";
import type { ResumePoint } from "../../lib/resume.ts";

/** Cards on Live now: three full rows on the widest grid; the rest is a "See all" away. */
export const LIVE_NOW_LIMIT = 12;
/** Live now is backfilled with labelled videos up to this many tiles (round-2 decision). */
export const LIVE_NOW_MIN = 4;
/** Tiles on Catch up, Fresh clips and Continue watching: one row. */
export const MEDIA_SHELF = 4;
/** Category tiles on home. */
export const HOME_CATEGORY_LIMIT = 12;
/** Channel chips on Recently live. */
export const RECENT_LIMIT = 12;

/** Shelf ids as `trackUi("home.shelf", …, step)` counts them (closed list in the contract). */
export type HomeShelfId = "live" | "continue" | "videos" | "clips" | "categories" | "recent";

export interface HomeLive {
  /** The one featured stream: the top spotlight channel the viewer does not follow. */
  featured: StreamCard | null;
  /** Followed channels live now (signed in only). */
  following: StreamCard[];
  /** Everyone else live, in ranking order (spotlight, new, then the rest), at most {@link LIVE_NOW_LIMIT}. */
  live: StreamCard[];
  /** How many channels are live on the page in all (featured + following + live, before the cap). */
  liveTotal: number;
  /** Offline channels that were live lately, none of them live on the page. */
  recent: ChannelCard[];
}

function claim<T extends { channel: { id: string } }>(cards: readonly T[], seen: Set<string>): T[] {
  const out: T[] = [];
  for (const card of cards) {
    if (seen.has(card.channel.id)) continue;
    seen.add(card.channel.id);
    out.push(card);
  }
  return out;
}

/**
 * The live part of home. A followed channel claims first (it belongs under Following, where a
 * member looks for it); the featured stream is then the top spotlight channel left.
 */
export function homeLive(home: DirectoryHome, signedIn: boolean): HomeLive {
  const seen = new Set<string>();
  const following = signedIn ? claim(home.following, seen) : [];
  const featured = home.spotlight.find((card) => !seen.has(card.channel.id)) ?? null;
  if (featured) seen.add(featured.channel.id);
  const rest = claim([...home.spotlight, ...home.newAndLive, ...home.live], seen);
  const recent = claim(home.recentlyLive, new Set(seen)).slice(0, RECENT_LIMIT);
  return {
    featured,
    following,
    live: rest.slice(0, LIVE_NOW_LIMIT),
    liveTotal: following.length + (featured ? 1 : 0) + rest.length,
    recent,
  };
}

/**
 * With fewer than {@link LIVE_NOW_MIN} cards on Live now, the newest videos fill the row (each
 * labelled "Video"), and Catch up starts after them so no video shows twice.
 */
export function backfill<V>(liveCards: number, videos: readonly V[]): { fill: V[]; catchUp: V[] } {
  const need = Math.max(0, LIVE_NOW_MIN - liveCards);
  const fill = videos.slice(0, need);
  return { fill, catchUp: videos.slice(fill.length, fill.length + MEDIA_SHELF) };
}

/**
 * Home's categories: live ones first (busiest first), then the rest, which draw muted and never
 * show "0 live". At most {@link HOME_CATEGORY_LIMIT}.
 */
export function homeCategories(categories: readonly Category[]): Category[] {
  return sortCategories(categories).slice(0, HOME_CATEGORY_LIMIT);
}

/** Continue watching: the newest resume points with something left to watch, one row. */
export function continueWatching(points: readonly ResumePoint[]): ResumePoint[] {
  return points.filter((p) => p.positionSeconds > 0).slice(0, MEDIA_SHELF);
}

/** Watched share of a resume point, 0 to 1 (0 when the length is unknown). */
export function watchedShare(point: Pick<ResumePoint, "positionSeconds" | "durationSeconds">): number {
  if (!(point.durationSeconds > 0)) return 0;
  return Math.min(1, Math.max(0, point.positionSeconds / point.durationSeconds));
}

// --- the co-op proof number ----------------------------------------------------------------

type Month = z.infer<typeof TransparencyMonth>;
type ScheduleEntry = z.infer<typeof FeeScheduleEntry>;

export interface CoopProof {
  /** The creators' share of every sub and tip as a fraction (0.9), from `platform.cut`; null when unknown. */
  creatorShare: number | null;
  /**
   * Round-2 open question 2: "earned by creators" in the latest month that had revenue (revenue
   * less the co-op's cut), labelled as such; never "paid out". Null when no month had any.
   */
  earned: { cents: number; currency: string; month: string } | null;
}

/** The current `platform.cut` streamer share: the newest decided entry (the schedule is newest first). */
export function creatorShareOf(schedule: readonly ScheduleEntry[]): number | null {
  const entry = schedule.find((e) => e.key === "platform.cut");
  const share = entry?.value.streamerShare;
  return typeof share === "number" && Number.isFinite(share) && share > 0 && share <= 1 ? share : null;
}

/** What creators earned in the newest month with revenue. */
export function earnedOf(months: readonly Month[]): CoopProof["earned"] {
  const withRevenue = months
    .map((m) => ({ month: m.month, currency: m.revenue.currency, cents: m.revenue.cents - m.coopRetained.cents }))
    .filter((m) => m.cents > 0)
    .sort((a, b) => b.month.localeCompare(a.month));
  return withRevenue[0] ?? null;
}
