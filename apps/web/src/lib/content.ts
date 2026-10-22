// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/content` (studio) logic, pure for unit tests: the channel's VODs and clips as
 * `ContentBoard` rows, with removed ones left out, and the visibility choices.
 */
import { CLIP_STATUSES, VISIBILITIES, VOD_STATUSES } from "@commonair/contracts/enums";
import type { ClipRowData, VodRowData } from "@commonair/ui/blocks/studio";
import { t, type MessageKey } from "../i18n/index.ts";
import type { Api } from "./api.ts";

export type VodDto = Awaited<ReturnType<Api["vods"]["list"]>>["items"][number];
export type ClipDto = Awaited<ReturnType<Api["clips"]["list"]>>["items"][number];
export type Visibility = (typeof VISIBILITIES)[number];

/** Pages fetched per list at most (100 rows each): a studio page, not an archive browser. */
export const CONTENT_MAX_PAGES = 10;
export const CONTENT_PAGE_SIZE = 100;

const VOD_STATUS_KEYS: Record<(typeof VOD_STATUSES)[number], MessageKey> = {
  recording: "content.status.recording",
  processing: "content.status.processing",
  ready: "content.status.ready",
  failed: "content.status.failed",
  deleted: "content.status.deleted",
};

const CLIP_STATUS_KEYS: Record<(typeof CLIP_STATUSES)[number], MessageKey> = {
  processing: "content.status.processing",
  ready: "content.status.ready",
  failed: "content.status.failed",
  deleted: "content.status.deleted",
};

const VISIBILITY_KEYS: Record<Visibility, MessageKey> = {
  public: "content.visibility.public",
  subscribers: "content.visibility.subscribers",
  private: "content.visibility.private",
};

export const isVisibility = (value: string): value is Visibility => (VISIBILITIES as readonly string[]).includes(value);

export function visibilityOptions(): { value: Visibility; label: string }[] {
  return VISIBILITIES.map((value) => ({ value, label: t(VISIBILITY_KEYS[value]) }));
}

export function vodRows(vods: readonly VodDto[]): VodRowData[] {
  return vods
    .filter((vod) => vod.status !== "deleted")
    .map((vod) => ({
      id: vod.id,
      title: vod.title,
      visibility: vod.visibility,
      status: vod.status,
      statusLabel: t(VOD_STATUS_KEYS[vod.status]),
      durationSeconds: vod.durationSeconds,
      createdAt: vod.createdAt,
    }));
}

export function clipRows(clips: readonly ClipDto[], viewsLabel: (views: number) => string): ClipRowData[] {
  return clips
    .filter((clip) => clip.status !== "deleted")
    .map((clip) => ({
      id: clip.id,
      title: clip.title,
      status: clip.status,
      statusLabel: t(CLIP_STATUS_KEYS[clip.status]),
      durationSeconds: clip.durationSeconds,
      createdAt: clip.createdAt,
      creatorName: clip.creator?.displayName ?? null,
      viewsLabel: viewsLabel(clip.views),
    }));
}

/** Every page of a cursor list, up to `maxPages`; the newest rows come first. */
export async function loadAllPages<T>(
  load: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
  maxPages: number = CONTENT_MAX_PAGES,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await load(cursor);
    items.push(...result.items);
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  return items;
}
