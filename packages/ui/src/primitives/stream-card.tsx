// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { useRender } from "@base-ui/react/use-render";
import type { StreamCard as StreamCardData } from "@commonair/contracts/dto";
import { Badge, badgeVariants } from "../components/badge.tsx";
import { useUiMessages } from "../lib/locale.tsx";
import { cn } from "../lib/utils.ts";
import { ChannelAvatar } from "./channel-avatar.tsx";
import { LiveBadge } from "./live-badge.tsx";
import { OverlayBadge } from "./overlay-badge.tsx";
import { StatusBadge } from "./status-badge.tsx";
import { ViewerCount } from "./viewer-count.tsx";

export type { StreamCardData };

/** A link inside the card (channel name, category, a tag): its URL and, optionally, the element to render it with. */
export interface StreamCardSlotLink {
  href: string;
  /** Custom link element (e.g. the router's `<Link>`, carrying its own test id or aria-label). */
  render?: useRender.RenderProp;
}

export interface StreamCardProps extends Omit<React.ComponentProps<"article">, "children"> {
  stream: StreamCardData;
  /** Channel URL: the card's primary link, stretched over the whole card. */
  href: string;
  /** Custom link element (e.g. the router's `<Link>`); receives `href`, `className` and children. */
  render?: useRender.RenderProp;
  /** Makes the channel name its own link (when the primary `href` goes elsewhere). */
  channelLink?: StreamCardSlotLink;
  /** Makes the category its own link. Ignored when the stream has no category. */
  categoryLink?: StreamCardSlotLink;
  /** Makes each shown tag its own link. */
  tagLink?: (tag: string) => StreamCardSlotLink;
  locale?: string;
  /** Overrides `messages.discoveryReason[stream.reason]`. */
  reasonLabel?: string;
  /** Hide the "why is this shown" chip (e.g. on the following page where it is redundant). */
  showReason?: boolean;
  maxTags?: number;
  headingLevel?: 2 | 3 | 4;
  /** Lazy-load the thumbnail (default); set false for the first row above the fold. */
  lazy?: boolean;
  /** Pre-formatted time live ("3:41:09"), shown over the thumbnail's bottom-end corner (Following). */
  uptimeLabel?: string;
}

const SLOT_TEXT =
  "relative z-10 max-w-full truncate underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring";

/**
 * A link that sits above the card's stretched primary link (z-10), so it is a sibling of that
 * link rather than nested in it, and takes its own clicks.
 */
function SlotLink({
  link,
  slot,
  className,
  children,
}: {
  link: StreamCardSlotLink;
  slot: string;
  className: string;
  children: React.ReactNode;
}): React.ReactElement {
  return useRender({
    defaultTagName: "a",
    render: link.render,
    props: { href: link.href, "data-slot": slot, className, children },
  });
}

/**
 * The live stream tile used by every directory, search and recommendation grid. The title is the
 * primary link and its hit area covers the whole card; the optional slot links (channel,
 * category, tags) stack above it, so no anchor is nested in another and tab order follows reading
 * order: title, channel, category, tags.
 */
export function StreamCard({
  stream,
  href,
  render,
  channelLink,
  categoryLink,
  tagLink,
  locale,
  reasonLabel,
  showReason = true,
  maxTags = 3,
  headingLevel = 3,
  lazy = true,
  uptimeLabel,
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

  // The ::after overlay stretches the link over the article (its containing block) and carries
  // the focus ring, so the whole card stays one click target.
  const link = useRender({
    defaultTagName: "a",
    render,
    props: {
      href,
      "data-slot": "stream-card-link",
      className:
        "outline-none after:absolute after:inset-0 after:z-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-offset-2 focus-visible:after:ring-offset-background",
      // An empty title would leave the primary link with no name and no box to click.
      children: broadcast.title.trim() ? broadcast.title : messages.untitledStream,
    },
  });

  const channelName = (
    <span dir="auto" className="block truncate">
      {channel.displayName}
    </span>
  );
  const categoryName = broadcast.category && (
    <span dir="auto" className="block truncate">
      {broadcast.category.name}
    </span>
  );

  const showChips = tags.length > 0 || showReason;
  return (
    <article
      data-slot="stream-card"
      data-accent={accent}
      className={cn("group/stream-card relative flex min-w-0 flex-col gap-2", className)}
      {...props}
    >
      <div className="relative aspect-video w-full overflow-hidden bg-muted ring-channel-accent transition-shadow group-hover/stream-card:ring-2">
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
        {uptimeLabel && (
          <OverlayBadge size="sm" data-slot="stream-card-uptime" className="absolute end-2 bottom-2">
            {uptimeLabel}
          </OverlayBadge>
        )}
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
        <div className="flex min-w-0 flex-1 flex-col items-start text-xs text-muted-foreground">
          <Heading
            dir="auto"
            lang={stream.language || undefined}
            className="line-clamp-2 self-stretch text-sm font-medium break-words text-foreground"
          >
            {link}
          </Heading>
          {channelLink ? (
            <SlotLink link={channelLink} slot="stream-card-channel-link" className={SLOT_TEXT}>
              {channelName}
            </SlotLink>
          ) : (
            <span className="max-w-full">{channelName}</span>
          )}
          {categoryName &&
            (categoryLink ? (
              <SlotLink link={categoryLink} slot="stream-card-category-link" className={SLOT_TEXT}>
                {categoryName}
              </SlotLink>
            ) : (
              <span className="max-w-full">{categoryName}</span>
            ))}
        </div>
      </div>
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
              {tagLink ? (
                <SlotLink
                  link={tagLink(tag)}
                  slot="stream-card-tag-link"
                  className={cn(badgeVariants({ variant: "outline" }), "relative z-10 max-w-full outline-none")}
                >
                  <span dir="auto" className="truncate">
                    {tag}
                  </span>
                </SlotLink>
              ) : (
                <Badge variant="outline" className="max-w-full">
                  <span dir="auto" className="truncate">
                    {tag}
                  </span>
                </Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
