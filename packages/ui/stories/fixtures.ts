// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Story data. Images are inline SVG data URIs: Storybook must never load remote resources. */
import type { StreamCard } from "@commonair/contracts/dto";
import type { ACCENTS } from "@commonair/contracts/shapes";

type Accent = (typeof ACCENTS)[number];

const HUES: Record<Accent, number> = {
  zinc: 240,
  red: 0,
  orange: 25,
  amber: 45,
  lime: 85,
  green: 140,
  teal: 175,
  sky: 200,
  blue: 220,
  indigo: 240,
  violet: 265,
  pink: 330,
};

/** A 16:9 gradient "video frame" for thumbnails. */
export function thumbnail(accent: Accent, variant = 0): string {
  const hue = HUES[accent] + variant * 20;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 70% 45%)"/><stop offset="1" stop-color="hsl(${hue + 40} 60% 15%)"/></linearGradient></defs><rect width="320" height="180" fill="url(#g)"/><circle cx="${90 + variant * 40}" cy="80" r="38" fill="hsl(${hue} 80% 75% / 0.35)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function avatarImage(accent: Accent): string {
  const hue = HUES[accent];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="hsl(${hue} 50% 30%)"/><circle cx="32" cy="26" r="12" fill="hsl(${hue} 60% 80%)"/><rect x="14" y="42" width="36" height="22" rx="11" fill="hsl(${hue} 60% 80%)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

let seq = 0;
const id = (): string => `0190a8a0-0000-7000-8000-${String(++seq).padStart(12, "0")}`;

export function makeStream(
  overrides: {
    accent?: Accent;
    displayName?: string;
    title?: string;
    category?: string | null;
    viewers?: number;
    tags?: string[];
    reason?: StreamCard["reason"];
    mature?: boolean;
    thumbnail?: string | null;
    avatar?: boolean;
    language?: string;
  } = {},
): StreamCard {
  const accent = overrides.accent ?? "teal";
  return {
    channel: {
      id: id(),
      slug: "pixel_pioneer",
      displayName: overrides.displayName ?? "Pixel Pioneer",
      avatarUrl: overrides.avatar === false ? null : avatarImage(accent),
      accent,
    },
    broadcast: {
      id: id(),
      title: overrides.title ?? "Speedrunning every co-op classic, one controller each",
      category:
        overrides.category === null ? null : { id: id(), slug: "retro", name: overrides.category ?? "Retro games" },
      startedAt: "2026-06-15T10:00:00Z",
      mature: overrides.mature ?? false,
      viewerCount: overrides.viewers ?? 15_300,
      thumbnailUrl: overrides.thumbnail === undefined ? thumbnail(accent) : overrides.thumbnail,
    },
    tags: overrides.tags ?? ["speedrun", "co-op", "chill"],
    language: overrides.language ?? "en",
    reason: overrides.reason ?? "popular",
  };
}

export const LONG_TITLE =
  "An extremely long stream title that keeps going well past two lines so we can see the clamp and make sure nothing overflows the card at narrow widths";
export const LONG_NAME = "TheChannelWithTheLongestDisplayNameAllowedOnThePlatform";
