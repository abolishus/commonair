// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Builders for the boards' stream tiles. Thumbnails stay empty: the boards show the accent placeholder. */
import type { Accent, StreamCardData } from "@commonair/ui";

export interface StreamRow {
  title: string;
  name: string;
  accent: Accent;
  category: string;
  viewers: number;
  reason?: StreamCardData["reason"];
  tags?: string[];
  mature?: boolean;
}

let seq = 0;
const nextId = (): string => `0190a8b0-0000-7000-8000-${String(++seq).padStart(12, "0")}`;

export function liveStream(row: StreamRow): StreamCardData {
  const slug = row.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return {
    channel: { id: nextId(), slug, displayName: row.name, avatarUrl: null, accent: row.accent },
    broadcast: {
      id: nextId(),
      title: row.title,
      category: { id: nextId(), slug: row.category.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: row.category },
      startedAt: "2026-10-17T16:00:00Z",
      mature: row.mature ?? false,
      viewerCount: row.viewers,
      thumbnailUrl: null,
    },
    tags: row.tags ?? [],
    language: "en",
    reason: row.reason ?? "popular",
  };
}

export const channelHref = (stream: StreamCardData): string => `#channel/${stream.channel.slug}`;
