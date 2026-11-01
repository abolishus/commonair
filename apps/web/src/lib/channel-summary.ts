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
  /** The caller's follow state; null when anonymous (or the API did not say). */
  following: boolean | null;
  /** `Channel.movedTo` (ADR 0037): where the channel moved and when; null when it has not moved. */
  movedTo: { url: string; at: string } | null;
  /** When the browser poll that produced this started (ms); absent for the SSR snapshot. */
  requestedAt?: number;
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
    followerCount: c.followerCount,
    following: c.viewer?.following ?? null,
    movedTo: c.movedTo ?? null,
  };
}
