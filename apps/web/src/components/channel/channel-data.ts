// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel page's pure rules (D2-channel, F2/F9/F12): which tab the URL asks for, the bio and
 * live metadata read from `channels.get`, which VODs and clips a grid shows, when the channel was
 * last live, uptime as a clock, and when a low verified count reads "Just started". Kept apart from
 * the components so the boundaries are unit-tested.
 */
import type * as D from "@commonair/contracts/dto";
import { SOCIAL_PLATFORMS, type ChannelSocial } from "@commonair/contracts/shapes";
import { formatDuration } from "@commonair/ui";
import type { z } from "zod";
import type { Api } from "../../lib/api.ts";
import { clipFilterSearch, parseClipFilter, type ClipFilter, type ClipFilterSearch } from "./clip-filters.tsx";

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

/**
 * `/$channel`'s search params: `?tab=videos|clips|about`; Home is the bare URL. The Clips tab adds
 * its sort and range (`&sort=top&range=7d`), dropped on every other tab.
 */
export interface ChannelSearch extends ClipFilterSearch {
  tab?: Exclude<ChannelTab, "home">;
}

/** The route's `validateSearch`: an unknown or missing `tab` is Home, so a bad link never errors. */
export function parseChannelSearch(search: Record<string, unknown>): ChannelSearch {
  const raw = search.tab;
  if (raw === "clips") return { tab: raw, ...parseClipFilter(search) };
  return raw === "videos" || raw === "about" ? { tab: raw } : {};
}

export function isChannelTab(value: unknown): value is ChannelTab {
  return (CHANNEL_TABS as readonly unknown[]).includes(value);
}

/** The search params for a tab (Home drops the param, so `/name` stays the canonical URL). */
export function tabSearch(tab: ChannelTab): ChannelSearch {
  return tab === "home" ? {} : { tab };
}

/** The Clips tab with a sort and range (the defaults drop out of the URL). */
export function clipsSearch(filter: ClipFilter): ChannelSearch {
  return { tab: "clips", ...clipFilterSearch(filter) };
}

// ── About and live metadata ─────────────────────────────────────────────────────────────────────

export interface ChannelAbout {
  /** `Channel.description`, trimmed; "" when the streamer wrote none. */
  bio: string;
  /** `Channel.socials`, in the streamer's order. (Category and tags are polled: `ChannelSummary`.) */
  socials: ChannelSocial[];
  /**
   * Overhaul wave 5: set when a stream is scheduled (`Channel.nextStreamAt`), so About loads the
   * schedule when opened; absent otherwise (no request for a channel without one).
   */
  schedule?: { channel: string };
}

export const NO_ABOUT: ChannelAbout = Object.freeze({ bio: "", socials: [] });

export function channelAbout(
  c: Pick<ChannelDto, "description" | "socials"> & Partial<Pick<ChannelDto, "slug" | "nextStreamAt">>,
): ChannelAbout {
  // Defensive: a malformed entry (or an older API without the field) never breaks the page.
  const socials = (c.socials as ChannelSocial[] | undefined) ?? [];
  return {
    bio: c.description.trim(),
    socials: socials.filter((s) => SOCIAL_PLATFORMS.includes(s.platform) && isHttpsUrl(s.url)),
    ...(c.slug && c.nextStreamAt ? { schedule: { channel: c.slug } } : {}),
  };
}

/** Only https links without credentials are rendered (the API checks too; this is the page's own guard). */
export function isHttpsUrl(url: string): boolean {
  const parsed = URL.parse(url);
  return parsed !== null && parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
}

/** The link's visible text: the host and path without the scheme or a trailing slash. */
export function socialLabel(url: string): string {
  const parsed = URL.parse(url);
  if (!parsed) return url;
  const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return `${parsed.host.replace(/^www\./, "")}${path}`;
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

/** Append a page, dropping ids already shown (a cursor page can overlap after a new recording). */
export function appendPage<T extends { id: string }>(current: readonly T[], next: readonly T[]): T[] {
  const seen = new Set(current.map((x) => x.id));
  return [...current, ...next.filter((x) => !seen.has(x.id))];
}
