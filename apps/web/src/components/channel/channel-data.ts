// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel page's pure rules (D2-channel, F2/F9/F12): which tab the URL asks for, the bio and
 * live metadata read from `channels.get`, which VODs and clips a grid shows, when the channel was
 * last live, uptime as a clock, and when a low verified count reads "Just started". Kept apart from
 * the components so the boundaries are unit-tested.
 */
import type * as D from "@commonair/contracts/dto";
import { formatDuration } from "@commonair/ui";
import type { z } from "zod";
import type { Api } from "../../lib/api.ts";

type ChannelDto = Awaited<ReturnType<Api["channels"]["get"]>>;
export type VodItem = z.infer<typeof D.Vod>;
export type ClipItem = z.infer<typeof D.Clip>;

export interface MediaPage<T> {
  items: T[];
  nextCursor: string | null;
}

// ── Tabs ────────────────────────────────────────────────────────────────────────────────────────

export const CHANNEL_TABS = ["home", "videos", "clips", "about"] as const;
export type ChannelTab = (typeof CHANNEL_TABS)[number];

/** `/$channel`'s search params: `?tab=videos|clips|about`; Home is the bare URL. */
export interface ChannelSearch {
  tab?: Exclude<ChannelTab, "home">;
}

/** The route's `validateSearch`: an unknown or missing `tab` is Home, so a bad link never errors. */
export function parseChannelSearch(search: Record<string, unknown>): ChannelSearch {
  const raw = search.tab;
  return raw === "videos" || raw === "clips" || raw === "about" ? { tab: raw } : {};
}

export function isChannelTab(value: unknown): value is ChannelTab {
  return (CHANNEL_TABS as readonly unknown[]).includes(value);
}

/** The search params for a tab (Home drops the param, so `/name` stays the canonical URL). */
export function tabSearch(tab: ChannelTab): ChannelSearch {
  return tab === "home" ? {} : { tab };
}

// ── About and live metadata ─────────────────────────────────────────────────────────────────────

export interface ChannelAbout {
  /** `Channel.description`, trimmed; "" when the streamer wrote none. */
  bio: string;
  /** The live broadcast's category, else the channel's. */
  category: { slug: string; name: string } | null;
  tags: string[];
}

export const NO_ABOUT: ChannelAbout = Object.freeze({ bio: "", category: null, tags: [] });

export function channelAbout(c: Pick<ChannelDto, "description" | "category" | "tags" | "live">): ChannelAbout {
  const category = c.live?.category ?? c.category;
  return {
    bio: c.description.trim(),
    category: category ? { slug: category.slug, name: category.name } : null,
    // Case-insensitive dedupe keeps the first spelling; empty tags are dropped.
    tags: c.tags.reduce<string[]>((out, tag) => {
      const clean = tag.trim();
      if (clean !== "" && !out.some((o) => o.toLowerCase() === clean.toLowerCase())) out.push(clean);
      return out;
    }, []),
  };
}

/**
 * Below this many verified viewers the header shows "Just started" beside `<LiveBadge>` instead of
 * an eye and a tiny number (F12). The count itself is never changed or padded: at or above the
 * threshold `<ViewerCount>` shows exactly the verified number.
 */
export const JUST_STARTED_BELOW = 3;

export function showsJustStarted(viewerCount: number): boolean {
  return !(Number.isFinite(viewerCount) && viewerCount >= JUST_STARTED_BELOW);
}

/** Whole seconds since `startedAt` at `now` (ms); 0 for a future, missing or unparsable start. */
export function uptimeSeconds(startedAt: string, now: number): number {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.floor((now - start) / 1000));
}

/** Uptime as a clock, as Twitch shows it: 0:00, 0:59, 1:00:00, 48:00:00 (hours never roll into days). */
export function formatUptime(seconds: number): string {
  return formatDuration(seconds);
}

/** ISO 8601 duration for `<time dateTime>` (`PT1H2M3S`). */
export function isoDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `PT${h > 0 ? `${h}H` : ""}${m > 0 ? `${m}M` : ""}${s > 0 || total === 0 ? `${s}S` : ""}`;
}

/** The channel's canonical URL, for Share: the instance's public origin plus `/<slug>`. */
export function channelUrl(publicUrl: string, slug: string): string {
  return `${publicUrl.replace(/\/+$/, "")}/${encodeURIComponent(slug)}`;
}

// ── Videos and clips ────────────────────────────────────────────────────────────────────────────

/** One page of a grid; the loader server-renders the first so the hero and shelves never shift. */
export const CHANNEL_MEDIA_PAGE = 12;

/** How many cards a Home shelf shows before "View all". */
export const SHELF_SIZE = 4;

/** Only playable recordings go in a grid (recording, processing and failed ones are the studio's). */
export function playableVods(items: readonly VodItem[]): VodItem[] {
  return items.filter((v) => v.status === "ready");
}

export function playableClips(items: readonly ClipItem[]): ClipItem[] {
  return items.filter((c) => c.status === "ready");
}

/**
 * When the channel was last live, from its newest VOD: the recording starts with the broadcast, so
 * its end is `createdAt + durationSeconds`. Null without a VOD. (`Channel.lastLiveAt` is a contract
 * request; this is the stand-in until `channels.get` serves it.)
 */
export function lastLiveFrom(items: readonly VodItem[]): string | null {
  const newest = items
    .filter((v) => v.status === "ready" || v.status === "processing")
    .reduce<VodItem | null>((best, v) => (best === null || v.createdAt > best.createdAt ? v : best), null);
  if (!newest) return null;
  const start = Date.parse(newest.createdAt);
  if (!Number.isFinite(start)) return null;
  return new Date(start + Math.max(0, newest.durationSeconds) * 1000).toISOString();
}

/** Append a page, dropping ids already shown (a cursor page can overlap after a new recording). */
export function appendPage<T extends { id: string }>(current: readonly T[], next: readonly T[]): T[] {
  const seen = new Set(current.map((x) => x.id));
  return [...current, ...next.filter((x) => !seen.has(x.id))];
}
