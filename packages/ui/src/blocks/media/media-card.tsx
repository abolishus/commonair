// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { useRender } from "@base-ui/react/use-render";
import { AspectRatio } from "@commonair/ui/components/aspect-ratio";
import { Badge } from "@commonair/ui/components/badge";
import { Card } from "@commonair/ui/components/card";
import { ChannelAvatar, OverlayBadge, StatusBadge } from "@commonair/ui";
import { cn } from "@commonair/ui/lib/utils";

export interface MediaCardData {
  id: string;
  title: string;
  thumbnailUrl?: string | null;
  accent?: string;
  channelName?: string;
  channelAvatarUrl?: string | null;
  duration?: string;
  ago?: string;
  views?: string;
  clippedBy?: string;
  mature?: boolean;
  kind?: string;
  matureLabel?: string;
  highlightLabel?: string;
}

export interface MediaCardProps extends Omit<React.ComponentProps<"article">, "children"> {
  media: MediaCardData;
  href?: string;
  render?: useRender.RenderProp;
  variant?: "vod" | "clip" | "highlight" | "upload";
  layout?: "card" | "compact";
}

export function MediaCard({
  media,
  href,
  render,
  variant = "vod",
  layout = "card",
  className,
  ...props
}: MediaCardProps): React.JSX.Element {
  const compact = layout === "compact";
  const link = useRender({
    defaultTagName: href ? "a" : "div",
    render,
    props: {
      href,
      className: cn(
        "group block min-w-0 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring",
        compact && "flex items-start gap-3",
      ),
      children: (
        <>
          <AspectRatio
            ratio={16 / 9}
            data-accent={media.accent ?? "zinc"}
            className={cn("relative overflow-hidden bg-channel-accent/15", compact && "w-32 shrink-0")}
          >
            {media.thumbnailUrl && (
              <img src={media.thumbnailUrl} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
            )}
            {media.kind && (
              <StatusBadge tone="neutral" className="absolute start-2 top-2">
                {media.kind}
              </StatusBadge>
            )}
            {media.duration && (
              <OverlayBadge size="sm" className="absolute end-2 bottom-2">
                {media.duration}
              </OverlayBadge>
            )}
            {media.ago && (
              <OverlayBadge size="sm" className="absolute start-2 bottom-2">
                {media.ago}
              </OverlayBadge>
            )}
            {media.mature && media.matureLabel && (
              <OverlayBadge size="sm" className="absolute end-2 top-2">
                {media.matureLabel}
              </OverlayBadge>
            )}
          </AspectRatio>
          <span className={cn("flex min-w-0 gap-2", compact ? "flex-1" : "pt-2")}>
            {media.channelName && (
              <ChannelAvatar name={media.channelName} src={media.channelAvatarUrl} size="sm" decorative />
            )}
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="line-clamp-2 text-sm font-medium">{media.title}</span>
              {media.channelName && <span className="truncate text-xs text-muted-foreground">{media.channelName}</span>}
              {(media.views || media.clippedBy) && (
                <span className="truncate text-xs text-muted-foreground">{media.clippedBy ?? media.views}</span>
              )}
            </span>
            {variant === "highlight" && media.highlightLabel && <Badge variant="outline">{media.highlightLabel}</Badge>}
          </span>
        </>
      ),
    },
  });
  return (
    <article className={cn("min-w-0", className)} {...props}>
      {compact ? link : <Card className="min-w-0 p-2">{link}</Card>}
    </article>
  );
}

export interface MediaGridProps extends React.ComponentProps<"div"> {
  media: MediaCardData[];
  hrefFor?: (item: MediaCardData) => string;
  columns?: 2 | 3 | 4;
}

export function MediaGrid({ media, hrefFor, columns = 3, className, ...props }: MediaGridProps): React.JSX.Element {
  return (
    <div
      className={cn(
        "grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2",
        columns >= 3 && "lg:grid-cols-3",
        columns === 4 && "xl:grid-cols-4",
        className,
      )}
      {...props}
    >
      {media.map((item) => (
        <MediaCard key={item.id} media={item} href={hrefFor?.(item)} />
      ))}
    </div>
  );
}
