// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * An offline channel's hero (F2; `channel-offline-hero`): the latest VOD in the player's poster
 * state, as one link to its watch page. Nothing loads or plays here: the frame is the VOD's own
 * thumbnail (or a plain frame), with a play mark, its length, title and when it was recorded.
 */
import { RelativeTime } from "@commonair/ui";
import { PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { tileTitle, VideoThumbnail, type VideoTile } from "./video-grid.tsx";

export function OfflineHero({ tile }: { tile: VideoTile }): React.JSX.Element {
  const title = tileTitle(tile);
  return (
    <section data-testid="channel-offline-hero" data-vod={tile.id} aria-labelledby={`hero-${tile.id}`}>
      <Link
        to="/$channel/vods/$vodId"
        params={{ channel: tile.channelSlug, vodId: tile.id }}
        className="group flex min-w-0 flex-col gap-3 rounded-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <VideoThumbnail tile={tile} className="border">
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex size-14 items-center justify-center rounded-full bg-overlay text-overlay-foreground transition-transform group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100">
              <HugeiconsIcon icon={PlayIcon} strokeWidth={2} aria-hidden className="size-6" />
            </span>
          </span>
        </VideoThumbnail>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground uppercase">{t("channel.offline.latest")}</span>
          <h2 id={`hero-${tile.id}`} className="line-clamp-2 text-base font-semibold break-words group-hover:underline">
            {title}
          </h2>
          <span className="text-xs text-muted-foreground">
            <RelativeTime date={tile.createdAt} tooltip={false} />
          </span>
        </span>
      </Link>
    </section>
  );
}
