// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What to watch next under a VOD or clip (F11, D3.9): "Up next" (`watch-up-next`, one card: the
 * item recorded right after this one, else the newest other one), then "More from <channel>"
 * (`watch-more-grid`, D2-channel's shelf with its "View all" link to the Videos or Clips tab),
 * VODs on a VOD page and clips on a clip page, never the item being watched, at most
 * `MORE_FROM_SIZE`. It degrades in steps: loading frames; a failed list says so with Retry (never
 * a silent gap); one other item is Up next alone; nothing else leaves the section out.
 */
import { SkeletonGroup, SkeletonText, SkeletonThumbnail } from "@commonair/ui";
import { Section } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import type { ClipItem, MediaPage, VodItem } from "../channel/channel-data.ts";
import { useMediaList } from "../channel/use-media-list.ts";
import { clipTiles, MediaShelf, VideoTileList, vodTiles, type VideoTile } from "../channel/video-grid.tsx";
import { MORE_FROM_SIZE, moreFrom, upNext, type WatchKind } from "./share.ts";

export type WatchMoreProps = {
  slug: string;
  channelName: string;
  currentId: string;
} & (
  | { kind: "vod"; fetchPage: () => Promise<MediaPage<VodItem>> }
  | { kind: "clip"; fetchPage: () => Promise<MediaPage<ClipItem>> }
);

export function WatchMore(props: WatchMoreProps): React.JSX.Element | null {
  return props.kind === "vod" ? <VodMore {...props} /> : <ClipMore {...props} />;
}

type Common = { slug: string; channelName: string; currentId: string };

function VodMore({ fetchPage, ...p }: Common & { fetchPage: () => Promise<MediaPage<VodItem>> }) {
  const list = useMediaList(
    React.useCallback(() => fetchPage(), [fetchPage]),
    null,
  );
  return <MoreSection {...p} kind="vod" status={list.status} retry={list.retry} tiles={vodTiles(list.items)} />;
}

function ClipMore({ fetchPage, ...p }: Common & { fetchPage: () => Promise<MediaPage<ClipItem>> }) {
  const list = useMediaList(
    React.useCallback(() => fetchPage(), [fetchPage]),
    null,
  );
  return <MoreSection {...p} kind="clip" status={list.status} retry={list.retry} tiles={clipTiles(list.items)} />;
}

/** The shelves to show from a loaded list: Up next, then More from without it. */
export function nextShelves(
  tiles: readonly VideoTile[],
  currentId: string,
): { next: VideoTile | null; more: VideoTile[] } {
  const next = upNext(tiles, currentId);
  const rest = next ? tiles.filter((tile) => tile.id !== next.id) : tiles;
  return { next, more: moreFrom(rest, currentId, MORE_FROM_SIZE) };
}

function MoreSection({
  kind,
  slug,
  channelName,
  currentId,
  status,
  retry,
  tiles,
}: Common & {
  kind: WatchKind;
  status: "loading" | "ready" | "error";
  retry: () => void;
  tiles: readonly VideoTile[];
}): React.JSX.Element | null {
  const heading = t("watch.more.heading", { name: channelName });
  if (status === "error")
    return (
      <div
        data-testid="watch-more-grid"
        data-state="error"
        className="flex min-w-0 flex-wrap items-center gap-3 text-sm text-muted-foreground"
      >
        <output>{t("d3Watch.more.loadFailed", { name: channelName })}</output>
        <Button data-testid="watch-more-retry" size="sm" variant="outline" onClick={retry}>
          {t("d3Watch.more.retry")}
        </Button>
      </div>
    );
  if (status === "loading")
    return (
      <div data-testid="watch-more-grid" data-state="loading" className="min-w-0">
        <SkeletonGroup label={t("watch.more.loading")}>
          <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex min-w-0 flex-col gap-2">
                <SkeletonThumbnail />
                <SkeletonText lines={2} />
              </div>
            ))}
          </div>
        </SkeletonGroup>
      </div>
    );
  const { next, more } = nextShelves(tiles, currentId);
  if (!next) return null;
  return (
    <div className="flex min-w-0 flex-col gap-8">
      <Section data-testid="watch-up-next" data-kind={kind} data-id={next.id} heading={t("d3Watch.upNext.heading")}>
        <VideoTileList tiles={[next]} />
      </Section>
      {more.length > 0 ? (
        <div
          data-testid="watch-more-grid"
          data-state="ready"
          data-kind={kind}
          data-count={more.length}
          className="min-w-0"
        >
          <MediaShelf kind={kind === "vod" ? "vods" : "clips"} tiles={more} heading={heading} channel={slug} />
        </div>
      ) : null}
    </div>
  );
}
