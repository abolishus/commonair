// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The channel's VOD and clip grids (F2; `channel-video-grid`, `data-kind="vods|clips"`). A card is
 * a link to the watch page: thumbnail, length, title, `<RelativeTime>`, and views where the API has
 * them (clips). D3-watch reuses `VideoGrid` and `VideoCard` for "More from". Nothing is invented: a
 * missing thumbnail is a plain frame, a VOD has no view count, and an empty grid says so.
 */
import {
  EmptyState,
  formatDuration,
  OverlayBadge,
  RelativeTime,
  SkeletonGroup,
  SkeletonText,
  SkeletonThumbnail,
} from "@commonair/ui";
import { Section } from "@commonair/ui/blocks/headers";
import { AspectRatio } from "@commonair/ui/components/aspect-ratio";
import { Button } from "@commonair/ui/components/button";
import { AlertCircleIcon, Film02Icon, Scissor01Icon, Video01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { cn } from "@commonair/ui/lib/utils";
import { playableClips, playableVods, tabSearch, type ClipItem, type VodItem } from "./channel-data.ts";
import type { MediaList } from "./use-media-list.ts";

export type MediaKind = "vods" | "clips";

/** What one card shows, from a VOD or a clip. */
export interface VideoTile {
  id: string;
  kind: MediaKind;
  channelSlug: string;
  title: string;
  thumbnailUrl: string | null;
  durationSeconds: number;
  createdAt: string;
  /** Clips only: `Clip.views`. VODs have no view count, so none is shown. */
  views: number | null;
  /** Clips only: who cut it. */
  clippedBy: string | null;
}

export function vodTile(v: VodItem): VideoTile {
  return {
    id: v.id,
    kind: "vods",
    channelSlug: v.channelSlug,
    title: v.title,
    thumbnailUrl: v.thumbnailUrl,
    durationSeconds: v.durationSeconds,
    createdAt: v.createdAt,
    views: null,
    clippedBy: null,
  };
}

export function clipTile(c: ClipItem): VideoTile {
  return {
    id: c.id,
    kind: "clips",
    channelSlug: c.channelSlug,
    title: c.title,
    thumbnailUrl: c.thumbnailUrl,
    durationSeconds: c.durationSeconds,
    createdAt: c.createdAt,
    views: c.views,
    clippedBy: c.creator?.displayName ?? null,
  };
}

/** The ready items of a VOD or clip list, as tiles. */
export function vodTiles(items: readonly VodItem[]): VideoTile[] {
  return playableVods(items).map(vodTile);
}

export function clipTiles(items: readonly ClipItem[]): VideoTile[] {
  return playableClips(items).map(clipTile);
}

function WatchLink({
  tile,
  className,
  children,
  ...props
}: {
  tile: VideoTile;
  className?: string;
  children: React.ReactNode;
  "aria-label"?: string;
  "data-testid"?: string;
}): React.JSX.Element {
  return tile.kind === "vods" ? (
    <Link
      to="/$channel/vods/$vodId"
      params={{ channel: tile.channelSlug, vodId: tile.id }}
      className={className}
      {...props}
    >
      {children}
    </Link>
  ) : (
    <Link
      to="/$channel/clips/$clipId"
      params={{ channel: tile.channelSlug, clipId: tile.id }}
      className={className}
      {...props}
    >
      {children}
    </Link>
  );
}

export function tileTitle(tile: VideoTile): string {
  return tile.title.trim() || (tile.kind === "vods" ? t("channel.tabs.untitledVideo") : t("channel.tabs.untitledClip"));
}

/** A thumbnail frame: the image, or a plain frame with the kind's icon (never a made-up picture). */
export function VideoThumbnail({
  tile,
  className,
  children,
}: {
  tile: VideoTile;
  className?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <AspectRatio ratio={16 / 9} className={cn("relative overflow-hidden bg-muted", className)}>
      {tile.thumbnailUrl ? (
        <img src={tile.thumbnailUrl} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
      ) : (
        <span className="flex size-full items-center justify-center text-muted-foreground">
          <HugeiconsIcon icon={tile.kind === "vods" ? Film02Icon : Scissor01Icon} strokeWidth={2} aria-hidden />
        </span>
      )}
      <OverlayBadge size="sm" className="absolute end-2 bottom-2">
        <span className="sr-only">{t("channel.tabs.length")} </span>
        {formatDuration(tile.durationSeconds)}
      </OverlayBadge>
      {children}
    </AspectRatio>
  );
}

/** `showChannel`: lists that mix channels (a category's) name the channel on each card. */
export function VideoCard({
  tile,
  showChannel = false,
}: {
  tile: VideoTile;
  showChannel?: boolean;
}): React.JSX.Element {
  return (
    <article data-testid="channel-video-card" data-kind={tile.kind} data-id={tile.id} className="min-w-0">
      <WatchLink
        tile={tile}
        className="group flex min-w-0 flex-col gap-2 rounded-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <VideoThumbnail tile={tile} />
        <span className="line-clamp-2 text-sm font-medium break-words group-hover:underline">{tileTitle(tile)}</span>
        {showChannel ? (
          <span data-testid="channel-video-card-channel" className="truncate text-xs text-muted-foreground">
            {tile.channelSlug}
          </span>
        ) : null}
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <RelativeTime date={tile.createdAt} tooltip={false} />
          {tile.views !== null ? <span>{t("channel.tabs.views", { count: tile.views })}</span> : null}
          {tile.clippedBy ? (
            <span className="min-w-0 truncate">{t("channel.tabs.clippedBy", { name: tile.clippedBy })}</span>
          ) : null}
        </span>
      </WatchLink>
    </article>
  );
}

const GRID = "grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3";

export function VideoTileList({
  tiles,
  className,
  showChannel,
}: {
  tiles: readonly VideoTile[];
  className?: string;
  showChannel?: boolean;
}) {
  return (
    <ul className={cn(GRID, className)}>
      {tiles.map((tile) => (
        <li key={tile.id} className="min-w-0">
          <VideoCard tile={tile} showChannel={showChannel} />
        </li>
      ))}
    </ul>
  );
}

function GridSkeleton({ count = 3 }: { count?: number }): React.JSX.Element {
  return (
    <SkeletonGroup label={t("channel.tabs.loading")}>
      <div className={GRID}>
        {Array.from({ length: count }, (_, i) => (
          <div key={i} className="flex min-w-0 flex-col gap-2">
            <SkeletonThumbnail />
            <SkeletonText lines={2} />
          </div>
        ))}
      </div>
    </SkeletonGroup>
  );
}

export interface VideoGridProps {
  kind: MediaKind;
  tiles: readonly VideoTile[];
  list: Pick<MediaList<unknown>, "status" | "hasMore" | "loadingMore" | "moreFailed" | "loadMore" | "retry">;
  /** Shown when the list loaded and has nothing playable. */
  empty: React.ReactNode;
  /** Name the channel on each card (a list across channels). */
  showChannel?: boolean;
}

/** A full grid (the Videos and Clips tabs): loading frames, the error with Try again, empty, "Show more". */
export function VideoGrid({ kind, tiles, list, empty, showChannel }: VideoGridProps): React.JSX.Element {
  return (
    <div
      data-testid="channel-video-grid"
      data-kind={kind}
      data-state={list.status}
      data-count={tiles.length}
      className="flex min-w-0 flex-col gap-4"
    >
      {list.status === "loading" ? (
        <GridSkeleton />
      ) : list.status === "error" ? (
        <EmptyState
          icon={AlertCircleIcon}
          title={t("channel.tabs.loadFailed")}
          action={
            <Button variant="outline" onClick={list.retry}>
              {t("channel.tabs.retry")}
            </Button>
          }
        />
      ) : tiles.length === 0 && !list.hasMore ? (
        empty
      ) : (
        <>
          <VideoTileList tiles={tiles} showChannel={showChannel} />
          {list.hasMore ? (
            <div className="flex flex-col items-center gap-2">
              <Button
                variant="outline"
                data-testid="channel-video-grid-more"
                disabled={list.loadingMore}
                aria-busy={list.loadingMore}
                onClick={list.loadMore}
              >
                {list.loadingMore ? t("channel.tabs.loadingMore") : t("channel.tabs.showMore")}
              </Button>
              {list.moreFailed ? (
                <output className="text-xs text-muted-foreground">{t("channel.tabs.moreFailed")}</output>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** A grid's empty state: an action to the stream manager for the owner, none for visitors. */
export function MediaEmptyState({
  kind,
  own,
  channelName,
}: {
  kind: MediaKind;
  own: boolean;
  channelName: string;
}): React.JSX.Element {
  const videos = kind === "vods";
  return (
    <EmptyState
      data-testid="channel-media-empty"
      data-kind={kind}
      data-own={own ? "true" : "false"}
      icon={videos ? Video01Icon : Scissor01Icon}
      title={videos ? t("channel.tabs.videosEmpty") : t("channel.tabs.clipsEmpty")}
      description={
        own
          ? videos
            ? t("channel.tabs.videosEmptyOwner")
            : t("channel.tabs.clipsEmptyOwner")
          : videos
            ? t("channel.tabs.videosEmptyVisitor", { name: channelName })
            : t("channel.tabs.clipsEmptyVisitor", { name: channelName })
      }
      action={
        own ? (
          <Button data-testid="empty-state-action" nativeButton={false} render={<Link to="/dashboard" />}>
            {t("channel.tabs.streamManager")}
          </Button>
        ) : undefined
      }
    />
  );
}

/** The Clips tab under a sort or range that matched nothing (the channel may still have clips). */
export function ClipsFilteredEmpty(): React.JSX.Element {
  return (
    <EmptyState
      data-testid="clips-filtered-empty"
      icon={Scissor01Icon}
      title={t("fuChannel.clips.rangeEmpty")}
      description={t("fuChannel.clips.rangeEmptyHint")}
    />
  );
}

/** A Home shelf: a heading, the first few cards and "View all" (a link to the tab). Nothing when empty. */
export function MediaShelf({
  kind,
  tiles,
  heading,
  channel,
}: {
  kind: MediaKind;
  tiles: readonly VideoTile[];
  heading: string;
  /** The channel's slug: "View all" links to its Videos or Clips tab. */
  channel: string;
}): React.JSX.Element | null {
  if (tiles.length === 0) return null;
  return (
    <Section
      data-testid="channel-shelf"
      data-kind={kind}
      heading={heading}
      action={
        <Button
          data-testid="channel-shelf-view-all"
          variant="ghost"
          size="sm"
          nativeButton={false}
          render={<Link to="/$channel" params={{ channel }} search={tabSearch(kind === "vods" ? "videos" : "clips")} />}
        >
          {t("channel.tabs.viewAll")}
        </Button>
      }
    >
      <VideoTileList tiles={tiles} />
    </Section>
  );
}
