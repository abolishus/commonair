// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { useRender } from "@base-ui/react/use-render";
import type { StreamCard as StreamCardData } from "@commonair/contracts/dto";
import { Badge } from "../components/badge.tsx";
import { useUiMessages } from "../lib/locale.tsx";
import { cn } from "../lib/utils.ts";
import { ChannelAvatar } from "./channel-avatar.tsx";
import { LiveBadge } from "./live-badge.tsx";
import { OverlayBadge } from "./overlay-badge.tsx";
import { StatusBadge } from "./status-badge.tsx";
import { ViewerCount } from "./viewer-count.tsx";

export type { StreamCardData };

export interface StreamCardProps extends Omit<React.ComponentProps<"article">, "children"> {
  stream: StreamCardData;
  /** Channel URL. */
  href: string;
  /** Custom link element (e.g. the router's `<Link>`); receives `href`, `className` and children. */
  render?: useRender.RenderProp;
  locale?: string;
  /** Overrides `messages.discoveryReason[stream.reason]`. */
  reasonLabel?: string;
  /** Hide the "why is this shown" chip (e.g. on the following page where it is redundant). */
  showReason?: boolean;
  maxTags?: number;
  headingLevel?: 2 | 3 | 4;
  /** Lazy-load the thumbnail (default); set false for the first row above the fold. */
  lazy?: boolean;
}

/** The live stream tile used by every directory, search and recommendation grid. */
export function StreamCard({
  stream,
  href,
  render,
  locale,
  reasonLabel,
  showReason = true,
  maxTags = 3,
  headingLevel = 3,
  lazy = true,
  className,
  ...props
}: StreamCardProps): React.JSX.Element {
  const messages = useUiMessages();
  // A missing or broken thumbnail falls back to the accent placeholder instead of a broken-image icon.
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const { channel, broadcast } = stream;
  const imgRef = React.useRef<HTMLImageElement>(null);
  // A server-rendered <img> can fail before React hydrates and attaches onError; catch that case too.
  React.useLayoutEffect(() => {
    const img = imgRef.current;
    if (img && img.complete && img.naturalWidth === 0 && broadcast.thumbnailUrl) setFailedSrc(broadcast.thumbnailUrl);
  }, [broadcast.thumbnailUrl]);
  const accent = channel.accent ?? "zinc";
  const Heading = `h${headingLevel}` as const;
  const tags = stream.tags.slice(0, Math.max(0, maxTags));

  const link = useRender({
    defaultTagName: "a",
    render,
    props: {
      href,
      "data-slot": "stream-card-link",
      className:
        "group/stream-card-link flex min-w-0 flex-col gap-2 rounded-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      children: (
        <>
          <div className="relative aspect-video w-full overflow-hidden bg-muted ring-channel-accent transition-shadow group-hover/stream-card-link:ring-2">
            {broadcast.thumbnailUrl && failedSrc !== broadcast.thumbnailUrl ? (
              <img
                ref={imgRef}
                src={broadcast.thumbnailUrl}
                alt=""
                loading={lazy ? "lazy" : "eager"}
                decoding="async"
                onError={() => setFailedSrc(broadcast.thumbnailUrl)}
                className="size-full object-cover"
              />
            ) : (
              <div aria-hidden className="flex size-full items-center justify-center bg-channel-accent/15">
                <ChannelAvatar name={channel.displayName} accent={accent} size="lg" locale={locale} decorative />
              </div>
            )}
            <LiveBadge size="sm" className="absolute start-2 top-2" />
            {broadcast.mature && <OverlayBadge className="absolute end-2 top-2">{messages.mature}</OverlayBadge>}
            <ViewerCount
              count={broadcast.viewerCount}
              locale={locale}
              variant="overlay"
              size="sm"
              className="absolute start-2 bottom-2"
            />
          </div>
          <div className="flex min-w-0 gap-2">
            <ChannelAvatar
              name={channel.displayName}
              src={channel.avatarUrl}
              accent={accent}
              size="sm"
              locale={locale}
              decorative
              className="mt-0.5"
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <Heading
                dir="auto"
                lang={stream.language || undefined}
                className="line-clamp-2 text-sm font-medium break-words text-foreground"
              >
                {broadcast.title}
              </Heading>
              <span dir="auto" className="truncate text-xs text-muted-foreground">
                {channel.displayName}
              </span>
              {broadcast.category && (
                <span dir="auto" className="truncate text-xs text-muted-foreground">
                  {broadcast.category.name}
                </span>
              )}
            </div>
          </div>
        </>
      ),
    },
  });

  const showChips = tags.length > 0 || showReason;
  return (
    <article
      data-slot="stream-card"
      data-accent={accent}
      className={cn("flex min-w-0 flex-col gap-2", className)}
      {...props}
    >
      {link}
      {showChips && (
        <ul className="flex min-w-0 flex-wrap gap-1 ps-10">
          {showReason && (
            <li className="min-w-0">
              <StatusBadge tone="accent" data-reason={stream.reason} className="max-w-full">
                <span className="truncate">{reasonLabel ?? messages.discoveryReason[stream.reason]}</span>
              </StatusBadge>
            </li>
          )}
          {tags.map((tag) => (
            <li key={tag} className="min-w-0">
              <Badge variant="outline" className="max-w-full">
                <span dir="auto" className="truncate">
                  {tag}
                </span>
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
