// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The front page and the side rail as data (F7, F8): what goes on which shelf, in which order,
 * with every channel shown once. Pure, so the shelf rules are tested without rendering.
 */
import type { Category, ChannelCard, StreamCard } from "@commonair/contracts/dto";
import { t } from "../i18n/index.ts";

export type DirectorySectionId = "spotlight" | "new" | "live" | "following";

export interface DirectoryHome {
  spotlight: StreamCard[];
  newAndLive: StreamCard[];
  live: StreamCard[];
  following: StreamCard[];
  recentlyLive: ChannelCard[];
  followingOffline: ChannelCard[];
}

export interface DirectorySection {
  id: DirectorySectionId;
  cards: StreamCard[];
}

/** A category with enough live channels on the page to get its own shelf, with "Show all". */
export interface CategoryShelf {
  category: { id: string; slug: string; name: string };
  cards: StreamCard[];
}

/** A category shelf needs more than this many live channels in the category. */
export const CATEGORY_SHELF_MIN = 2;
/** Cards on a category shelf (one row on `lg`); the rest are a "Show all" away. */
export const CATEGORY_SHELF_SIZE = 3;

/** First appearance wins: each card is kept only if its channel has not been seen. */
function claim<T extends { channel: { id: string } }>(cards: readonly T[], seen: Set<string>): T[] {
  const out: T[] = [];
  for (const card of cards) {
    if (seen.has(card.channel.id)) continue;
    seen.add(card.channel.id);
    out.push(card);
  }
  return out;
}

export interface HomeLayout {
  /** The one Spotlight hero (the top spotlight channel the viewer does not follow), or null. */
  hero: StreamCard | null;
  /** The live shelves, in order, each channel once across all of them and the hero. */
  sections: DirectorySection[];
  /** Per-category shelves carved out of the general "Live now" shelf. */
  categoryShelves: CategoryShelf[];
  offline: OfflineSection[];
}

/**
 * The front page: one hero, then spotlight, new, following and live, deduped across every shelf
 * (followed channels stay under Following; any other stays on the first shelf it reaches). Categories with more than
 * {@link CATEGORY_SHELF_MIN} channels left for "Live now" get their own shelf instead.
 * `following` is only shown to signed-in viewers. Empty shelves are dropped.
 */
export function homeLayout(
  home: DirectoryHome,
  signedIn: boolean,
  options: { shelfMin?: number; shelfSize?: number } = {},
): HomeLayout {
  const shelfMin = options.shelfMin ?? CATEGORY_SHELF_MIN;
  const shelfSize = options.shelfSize ?? CATEGORY_SHELF_SIZE;
  const seen = new Set<string>();
  // A followed live channel is always under Following (where a member looks for it), so it claims
  // first; the hero is then the top spotlight channel the viewer does not follow.
  const following = signedIn ? claim(home.following, seen) : [];
  const hero = home.spotlight.find((card) => !seen.has(card.channel.id)) ?? null;
  if (hero) seen.add(hero.channel.id);
  const spotlight = claim(home.spotlight, seen);
  const fresh = claim(home.newAndLive, seen);
  const rest = claim(home.live, seen);

  // Group what is left for "Live now" by category, in the order the ranking put them.
  const byCategory = new Map<string, CategoryShelf>();
  for (const card of rest) {
    const category = card.broadcast.category;
    if (!category) continue;
    const shelf = byCategory.get(category.id) ?? { category, cards: [] };
    shelf.cards.push(card);
    byCategory.set(category.id, shelf);
  }
  const categoryShelves = [...byCategory.values()]
    .filter((shelf) => shelf.cards.length > shelfMin)
    .sort((a, b) => b.cards.length - a.cards.length || a.category.name.localeCompare(b.category.name))
    .map((shelf) => ({ ...shelf, cards: shelf.cards.slice(0, shelfSize) }));
  const shelved = new Set(categoryShelves.map((s) => s.category.id));
  const live = rest.filter((card) => !card.broadcast.category || !shelved.has(card.broadcast.category.id));

  const sections: DirectorySection[] = [
    { id: "spotlight" as const, cards: spotlight },
    { id: "new" as const, cards: fresh },
    { id: "following" as const, cards: following },
    { id: "live" as const, cards: live },
  ].filter((s) => s.cards.length > 0);
  return { hero, sections, categoryShelves, offline: offlineSections(home, signedIn) };
}

/**
 * The live shelves without the hero or category shelves (kept for callers that only list
 * streams): spotlight, new, following, live, each channel once.
 */
export function directorySections(home: DirectoryHome, signedIn: boolean): DirectorySection[] {
  const seen = new Set<string>();
  // Following claims first, as in `homeLayout`; the display order stays spotlight, new, following, live.
  const following = signedIn ? claim(home.following, seen) : [];
  const all: DirectorySection[] = [
    { id: "spotlight", cards: claim(home.spotlight, seen) },
    { id: "new", cards: claim(home.newAndLive, seen) },
    { id: "following", cards: following },
    { id: "live", cards: claim(home.live, seen) },
  ];
  return all.filter((s) => s.cards.length > 0);
}

export type OfflineSectionId = "following-offline" | "recent";

export interface OfflineSection {
  id: OfflineSectionId;
  cards: ChannelCard[];
}

/**
 * The offline sections below the live ones: the viewer's followed channels, then recently live
 * channels they do not already see there. A channel that is live on this page is never listed
 * as offline. Empty sections are dropped.
 */
export function offlineSections(home: DirectoryHome, signedIn: boolean): OfflineSection[] {
  const seen = new Set<string>();
  for (const card of [...home.spotlight, ...home.newAndLive, ...home.live, ...(signedIn ? home.following : [])])
    seen.add(card.channel.id);
  const all: OfflineSection[] = [
    { id: "following-offline", cards: signedIn ? claim(home.followingOffline, seen) : [] },
    { id: "recent", cards: claim(home.recentlyLive, seen) },
  ];
  return all.filter((s) => s.cards.length > 0);
}

/** Case- and accent-insensitive, trimmed: "Nimble Thistle" and "nimble thistle " collide. */
function nameKey(name: string): string {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").trim().toLowerCase();
}

/**
 * Display names that two or more different channels on the page share (by {@link nameKey}).
 * Those cards show `@handle` too, so the two can be told apart (F8).
 */
export function collidingNames(channels: readonly { id: string; displayName: string }[]): Set<string> {
  const owners = new Map<string, Set<string>>();
  for (const channel of channels) {
    const key = nameKey(channel.displayName);
    const ids = owners.get(key) ?? new Set<string>();
    ids.add(channel.id);
    owners.set(key, ids);
  }
  return new Set([...owners].filter(([, ids]) => ids.size > 1).map(([key]) => key));
}

/** Whether this channel's name collides on the page (see {@link collidingNames}). */
export function needsHandle(collisions: ReadonlySet<string>, displayName: string): boolean {
  return collisions.has(nameKey(displayName));
}

/** "Name (@handle)" when the name collides, else the name. */
export function displayLabel(collisions: ReadonlySet<string>, channel: { slug: string; displayName: string }): string {
  return needsHandle(collisions, channel.displayName)
    ? t("discovery.card.nameWithHandle", { name: channel.displayName, handle: channel.slug })
    : channel.displayName;
}

/** Every channel a home layout shows, for {@link collidingNames}. */
export function layoutChannels(layout: HomeLayout): { id: string; displayName: string }[] {
  return [
    ...(layout.hero ? [layout.hero] : []),
    ...layout.sections.flatMap((s) => s.cards),
    ...layout.categoryShelves.flatMap((s) => s.cards),
    ...layout.offline.flatMap((s) => s.cards),
  ].map((card) => card.channel);
}

// --- the side rail ------------------------------------------------------------------------

export type RailEntry = { kind: "live"; card: StreamCard } | { kind: "offline"; card: ChannelCard };

export interface RailSection {
  id: "followed" | "live";
  entries: RailEntry[];
}

/** Rows in the signed-out rail's "Live now". */
export const RAIL_LIVE_LIMIT = 10;

const byViewers = (a: StreamCard, b: StreamCard): number =>
  b.broadcast.viewerCount - a.broadcast.viewerCount || a.channel.slug.localeCompare(b.channel.slug);

const byLastLive = (a: ChannelCard, b: ChannelCard): number => {
  if (a.lastLiveAt === b.lastLiveAt) return a.channel.slug.localeCompare(b.channel.slug);
  if (a.lastLiveAt === null) return 1;
  if (b.lastLiveAt === null) return -1;
  return b.lastLiveAt.localeCompare(a.lastLiveAt);
};

/**
 * The side rail (F7). Signed out: "Live now", the top {@link RAIL_LIVE_LIMIT} live channels by
 * viewers. Signed in: "Followed", live first (by viewers), then offline (most recently live first).
 * A signed-in viewer who follows nobody gets "Live now" instead of an empty rail.
 */
export function railSections(home: DirectoryHome, signedIn: boolean): RailSection[] {
  if (signedIn) {
    const seen = new Set<string>();
    const live = claim(home.following, seen).sort(byViewers);
    const offline = claim(home.followingOffline, seen).sort(byLastLive);
    const entries: RailEntry[] = [
      ...live.map((card) => ({ kind: "live" as const, card })),
      ...offline.map((card) => ({ kind: "offline" as const, card })),
    ];
    if (entries.length > 0) return [{ id: "followed", entries }];
  }
  const seen = new Set<string>();
  const live = claim([...home.live, ...home.spotlight, ...home.newAndLive], seen)
    .sort(byViewers)
    .slice(0, RAIL_LIVE_LIMIT);
  return live.length ? [{ id: "live", entries: live.map((card) => ({ kind: "live" as const, card })) }] : [];
}

// --- the category directory ---------------------------------------------------------------

export interface CategoryStats {
  /** Verified viewers, only when every live channel of the category is on the loaded page. */
  viewers?: number;
  /** The category's live channels' tags, most used first. */
  tags: string[];
}

/** Counts by value, most frequent first, ties alphabetical (case-insensitive values merge). */
function rankTags(tags: Iterable<string>): string[] {
  const counts = new Map<string, { tag: string; n: number }>();
  for (const tag of tags) {
    const key = tag.toLowerCase();
    const entry = counts.get(key) ?? { tag, n: 0 };
    entry.n++;
    counts.set(key, entry);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)).map((e) => e.tag);
}

/**
 * Viewer totals and tags per category, from the live channels loaded. The total is only given
 * when it is exact: the live list was complete and holds as many of the category's channels as its
 * `liveChannels` count. Otherwise the tile shows no total rather than a short one.
 */
export function categoryStats(
  categories: readonly Pick<Category, "id" | "liveChannels">[],
  live: readonly StreamCard[],
  liveComplete: boolean,
): Map<string, CategoryStats> {
  const groups = new Map<string, StreamCard[]>();
  for (const card of live) {
    const id = card.broadcast.category?.id;
    if (!id) continue;
    groups.set(id, [...(groups.get(id) ?? []), card]);
  }
  const out = new Map<string, CategoryStats>();
  for (const category of categories) {
    const cards = groups.get(category.id) ?? [];
    const exact = liveComplete && cards.length === category.liveChannels;
    const stats: CategoryStats = { tags: rankTags(cards.flatMap((c) => c.tags)) };
    if (exact) stats.viewers = cards.reduce((sum, c) => sum + c.broadcast.viewerCount, 0);
    out.set(category.id, stats);
  }
  return out;
}

/**
 * The directory's order (F1): most live channels first, then most viewers (where the total is
 * known), then by name. Stable for equal keys, and does not touch the input.
 */
export function sortCategories<T extends Pick<Category, "id" | "name" | "liveChannels">>(
  categories: readonly T[],
  stats: ReadonlyMap<string, CategoryStats> = new Map(),
): T[] {
  return [...categories].sort(
    (a, b) =>
      b.liveChannels - a.liveChannels ||
      (stats.get(b.id)?.viewers ?? -1) - (stats.get(a.id)?.viewers ?? -1) ||
      a.name.localeCompare(b.name),
  );
}

/** The tag filter's options: every tag on the loaded live channels, most used first. */
export function tagOptions(live: readonly StreamCard[]): string[] {
  return rankTags(live.flatMap((c) => c.tags));
}

/** Adds a page to a loaded list, skipping ids already there (a page boundary can shift between calls). */
export function appendPage<T>(list: readonly T[], page: readonly T[], id: (item: T) => string): T[] {
  const ids = new Set(list.map(id));
  return [...list, ...page.filter((item) => !ids.has(id(item)))];
}
