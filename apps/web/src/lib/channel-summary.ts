// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Accent } from "@commonair/ui";
import type { Api } from "./api.ts";

type ChannelDto = Awaited<ReturnType<Api["channels"]["get"]>>;

export interface ChannelSummary {
  /** Channel id (report subject). */
  id: string;
  slug: string;
  displayName: string;
  title: string;
  avatarUrl: string | null;
  /** The channel's accent token (`theme.accent`); null when the channel never picked one. */
  accent: Accent | null;
  /** Labelled mature (18+ gate). */
  mature: boolean;
  live: {
    /** Broadcast id (report subject). */
    id: string;
    title: string;
    viewerCount: number;
    /** Verified viewers rewound in DVR mode, apart from `viewerCount` (ADR 0016 decision 6); 0 = none. */
    catchingUpCount: number;
    startedAt: string;
    mature: boolean;
    /** `under_review` while a T1 moderation case restricts the broadcast. */
    restricted: "under_review" | null;
  } | null;
  followerCount: number;
  /** The live broadcast's category, else the channel's; polled, so the header's link follows a change. */
  category: { id: string; slug: string; name: string } | null;
  /** `Channel.tags`, trimmed and deduped case-insensitively (first spelling kept). */
  tags: string[];
  /** `Channel.lastLiveAt`: when the last broadcast ended; null when it never did. */
  lastLiveAt: string | null;
  /** The caller's follow state; null when anonymous (or the API did not say). */
  following: boolean | null;
  /** The caller asked to be told if the channel moves (decision (l)); null when anonymous or unknown. */
  portabilityGrant?: boolean | null;
  /** `Channel.viewer.notify`: the caller's go-live alerts while following; null when unknown. */
  notify?: boolean | null;
  /**
   * `Channel.viewer.subscribed` (w5-watch), for the subscribers-only gate before chat joins. The
   * contract leaves it out when false, so a signed-in caller without it does not subscribe; null
   * when anonymous.
   */
  subscribed?: boolean | null;
  /** `Channel.movedTo` (ADR 0037): where the channel moved and when; null when it has not moved. */
  movedTo: { url: string; at: string } | null;
  /** When the browser poll that produced this started (ms); absent for the SSR snapshot. */
  requestedAt?: number;
}

type CategoryRef = ChannelDto["category"];

/** Trimmed, empty ones dropped, deduped case-insensitively keeping the first spelling. */
export function cleanTags(tags: readonly string[] | undefined): string[] {
  return (tags ?? []).reduce<string[]>((out, tag) => {
    const clean = tag.trim();
    if (clean !== "" && !out.some((o) => o.toLowerCase() === clean.toLowerCase())) out.push(clean);
    return out;
  }, []);
}

// Older callers (and test doubles) may leave the field out: treat that as no category.
function categoryRef(category: CategoryRef | undefined): ChannelSummary["category"] {
  return category ? { id: category.id, slug: category.slug, name: category.name } : null;
}

export function summarize(c: ChannelDto): ChannelSummary {
  return {
    id: c.id,
    slug: c.slug,
    displayName: c.displayName,
    title: c.title,
    avatarUrl: c.avatarUrl,
    accent: c.theme.accent ?? null,
    mature: c.mature === true,
    live: c.live
      ? {
          id: c.live.id,
          title: c.live.title,
          viewerCount: c.live.viewerCount,
          catchingUpCount: c.live.catchingUpCount ?? 0,
          startedAt: c.live.startedAt,
          mature: c.live.mature === true,
          restricted: c.live.restricted ?? null,
        }
      : null,
    category: categoryRef(c.live?.category ?? c.category),
    tags: cleanTags(c.tags),
    lastLiveAt: c.lastLiveAt ?? null,
    followerCount: c.followerCount,
    following: c.viewer?.following ?? null,
    portabilityGrant: c.viewer ? (c.viewer.portabilityGrant ?? false) : null,
    notify: c.viewer?.notify ?? null,
    subscribed: c.viewer ? c.viewer.subscribed === true : null,
    movedTo: c.movedTo ?? null,
  };
}
