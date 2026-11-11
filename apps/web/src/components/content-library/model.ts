// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/content` (d5-content, D5.5): the channel's videos and clips as library cards, pure for unit
 * tests. Removed rows are left out; a card links to its watch page only once it can play; a
 * video counts the clips cut from it among the loaded clips.
 */
import { CLIP_STATUSES, VISIBILITIES, VOD_STATUSES } from "@commonair/contracts/enums";
import { formatCompactNumber } from "@commonair/ui";
import type { ClipRowData, VodRowData } from "@commonair/ui/blocks/studio";
import { t, type MessageKey } from "../../i18n/index.ts";
import type { ClipDto, VodDto, Visibility } from "../../lib/content.ts";

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

const isVisibility = (v: string): v is Visibility => (VISIBILITIES as readonly string[]).includes(v);

/** The in-app path of a video or clip's watch page. */
export const watchPath = (kind: "vod" | "clip", slug: string, id: string): string =>
  `/${encodeURIComponent(slug)}/${kind === "vod" ? "vods" : "clips"}/${encodeURIComponent(id)}`;

export const viewsLabel = (views: number, locale: string): string =>
  t("content.views", { count: views, formatted: formatCompactNumber(views, locale) });

/** Clips per source video, among `clips` (removed ones left out). */
export function clipCounts(clips: readonly ClipDto[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of clips) if (c.status !== "deleted" && c.vodId) out.set(c.vodId, (out.get(c.vodId) ?? 0) + 1);
  return out;
}

export function vodCards(vods: readonly VodDto[], clips: readonly ClipDto[] | null, locale: string): VodRowData[] {
  const counts = clipCounts(clips ?? []);
  return vods
    .filter((vod) => vod.status !== "deleted")
    .map((vod) => {
      const n = counts.get(vod.id) ?? 0;
      return {
        id: vod.id,
        title: vod.title,
        visibility: vod.visibility,
        visibilityLabel: isVisibility(vod.visibility) ? t(VISIBILITY_KEYS[vod.visibility]) : vod.visibility,
        status: vod.status,
        statusLabel: t(VOD_STATUS_KEYS[vod.status]),
        durationSeconds: vod.durationSeconds,
        createdAt: vod.createdAt,
        thumbnailUrl: vod.thumbnailUrl,
        views: vod.views,
        viewsLabel: viewsLabel(vod.views, locale),
        clips: n,
        // Unknown until the clip list loads; then "No clips" is a fact worth showing.
        clipsLabel: clips === null ? undefined : t("d5Content.clipsCount", { count: n }),
        href: vod.status === "ready" ? watchPath("vod", vod.channelSlug, vod.id) : null,
      };
    });
}

export function clipCards(clips: readonly ClipDto[], locale: string): ClipRowData[] {
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
      views: clip.views,
      viewsLabel: viewsLabel(clip.views, locale),
      thumbnailUrl: clip.thumbnailUrl,
      href: clip.status === "ready" ? watchPath("clip", clip.channelSlug, clip.id) : null,
    }));
}
