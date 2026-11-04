// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * "More from <channel>" under a VOD or clip (F11, `watch-more-grid`): D2-channel's shelf (its cards
 * and its "View all" link to the Videos or Clips tab), VODs on a VOD page and clips on a clip page,
 * without the item being watched, at most `MORE_FROM_SIZE`. Secondary content: when the list
 * fails or the channel has nothing else, the section is left out rather than shown empty.
 */
import { SkeletonGroup, SkeletonText, SkeletonThumbnail } from "@commonair/ui";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import type { ClipItem, MediaPage, VodItem } from "../channel/channel-data.ts";
import { useMediaList } from "../channel/use-media-list.ts";
import { clipTiles, MediaShelf, vodTiles } from "../channel/video-grid.tsx";
import { MORE_FROM_SIZE, moreFrom, type WatchKind } from "./share.ts";

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
  return <MoreSection {...p} kind="vod" status={list.status} tiles={vodTiles(list.items)} />;
}

function ClipMore({ fetchPage, ...p }: Common & { fetchPage: () => Promise<MediaPage<ClipItem>> }) {
  const list = useMediaList(
    React.useCallback(() => fetchPage(), [fetchPage]),
    null,
  );
  return <MoreSection {...p} kind="clip" status={list.status} tiles={clipTiles(list.items)} />;
}

function MoreSection({
  kind,
  slug,
  channelName,
  currentId,
  status,
  tiles,
}: Common & {
  kind: WatchKind;
  status: "loading" | "ready" | "error";
  tiles: ReturnType<typeof vodTiles>;
}): React.JSX.Element | null {
  if (status === "error") return null;
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
  const shown = moreFrom(tiles, currentId, MORE_FROM_SIZE);
  if (shown.length === 0) return null;
  return (
    <div
      data-testid="watch-more-grid"
      data-state="ready"
      data-kind={kind}
      data-count={shown.length}
      className="min-w-0"
    >
      <MediaShelf
        kind={kind === "vod" ? "vods" : "clips"}
        tiles={shown}
        heading={t("watch.more.heading", { name: channelName })}
        channel={slug}
      />
    </div>
  );
}
