// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { useRender } from "@base-ui/react/use-render";
import { HugeiconsIcon } from "@hugeicons/react";
import { PlayIcon } from "@hugeicons/core-free-icons";
import type { StreamCard as StreamCardData } from "@commonair/contracts/dto";
import { MediaFallback } from "../art/media-fallback.tsx";
import { buttonVariants } from "../components/button.tsx";
import { useUiMessages } from "../lib/locale.tsx";
import { cn } from "../lib/utils.ts";
import { ChannelAvatar, type Accent } from "./channel-avatar.tsx";
import { LiveBadge } from "./live-badge.tsx";
import { OverlayBadge } from "./overlay-badge.tsx";
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
  /** Hide the "why is this shown" line (e.g. on the following page where it is redundant). */
  showReason?: boolean;
  /** At most 3 tags show, whatever this says. */
  maxTags?: number;
  headingLevel?: 2 | 3 | 4;
  /** Lazy-load the thumbnail (default for grid cards); set false for the first row above the fold. */
  lazy?: boolean;
  /** Pre-formatted time live ("3:41:09"), shown over the thumbnail's bottom-end corner (Following). */
  uptimeLabel?: string;
  /**
   * `default`: the grid tile. `feature`: the home hero card, poster at 62 % beside a 38 % side
   * panel (stacked below 768 px), with a Play affordance over the poster. It never autoplays.
   */
  size?: "default" | "feature";
  /** Feature only: the visible label of the button-styled call to action ("Watch now"). */
  ctaLabel?: string;
}

/** The tile's tag chips: never more than three, whatever the caller asks for. */
export const MAX_CARD_TAGS = 3;

const SLOT_TEXT =
  "relative z-10 max-w-full truncate underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background";

const TAG_CHIP =
  "inline-flex min-h-6 max-w-full items-center bg-muted px-1.5 text-xs text-muted-foreground tabular-nums";

/** The stretched primary link: its ::after covers the card (the nearest positioned ancestor) and carries the focus ring. */
export const STRETCHED_LINK =
  "outline-none after:absolute after:inset-0 after:z-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-offset-2 focus-visible:after:ring-offset-background";

/**
 * The chip's stretched link draws its ring inset with no offset: the chip row scrolls below
 * 768 px, and a scroller clips anything drawn outside the chip's box.
 */
const CHIP_LINK =
  "outline-none after:absolute after:inset-0 after:z-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset";

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

/** A thumbnail that falls back to the accent field when it is missing or fails to load. */
function useThumbnail(src: string | null | undefined): {
  ref: React.RefObject<HTMLImageElement | null>;
  failed: boolean;
  onError: () => void;
} {
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const ref = React.useRef<HTMLImageElement>(null);
  // A server-rendered <img> can fail before React hydrates and attaches onError; catch that case too.
  React.useLayoutEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0 && src) setFailedSrc(src);
  }, [src]);
  return { ref, failed: !src || failedSrc === src, onError: () => setFailedSrc(src ?? null) };
}

/**
 * The live stream tile used by every directory, search and recommendation grid. The title is the
 * primary link and its hit area covers the whole card; the optional slot links (channel,
 * category, tags) stack above it, so no anchor is nested in another and tab order follows reading
 * order. `size="feature"` is the same card at hero size.
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
  maxTags = MAX_CARD_TAGS,
  headingLevel = 3,
  lazy,
  uptimeLabel,
  size = "default",
  ctaLabel,
  className,
  ...props
}: StreamCardProps): React.JSX.Element {
  const messages = useUiMessages();
  const { channel, broadcast } = stream;
  const { ref: imgRef, failed: thumbFailed, onError: onThumbError } = useThumbnail(broadcast.thumbnailUrl);
  const feature = size === "feature";
  const accent: Accent = channel.accent ?? "zinc";
  const Heading = `h${headingLevel}` as const;
  const tags = stream.tags.slice(0, Math.min(MAX_CARD_TAGS, Math.max(0, maxTags)));

  const link = useRender({
    defaultTagName: "a",
    render,
    props: {
      href,
      "data-slot": "stream-card-link",
      className: STRETCHED_LINK,
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
  const channelSlot = channelLink ? (
    <SlotLink link={channelLink} slot="stream-card-channel-link" className={SLOT_TEXT}>
      {channelName}
    </SlotLink>
  ) : (
    <span className="min-w-0 max-w-full">{channelName}</span>
  );
  const categorySlot =
    categoryName &&
    (categoryLink ? (
      <SlotLink link={categoryLink} slot="stream-card-category-link" className={SLOT_TEXT}>
        {categoryName}
      </SlotLink>
    ) : (
      <span className="min-w-0 max-w-full">{categoryName}</span>
    ));

  const media = (
    <div
      data-slot="stream-card-media"
      className={cn(
        "relative aspect-video w-full overflow-hidden bg-muted ring-channel-accent transition-shadow duration-120 ease-out group-hover/stream-card:ring-2",
        feature && "md:w-31/50 md:shrink-0 md:self-start",
      )}
    >
      {thumbFailed ? (
        <MediaFallback kind="nothumb" accent={accent} name={channel.displayName} locale={locale} />
      ) : (
        <img
          ref={imgRef}
          src={broadcast.thumbnailUrl ?? undefined}
          alt=""
          loading={(lazy ?? !feature) ? "lazy" : "eager"}
          decoding="async"
          onError={onThumbError}
          className="size-full object-cover transition-transform duration-120 ease-out motion-safe:group-hover/stream-card:scale-102"
        />
      )}
      {feature && (
        // A poster, never a player: the affordance says "this plays"; the stretched link does the work.
        <span aria-hidden data-slot="stream-card-play" className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-16 items-center justify-center rounded-full bg-overlay text-overlay-foreground">
            <HugeiconsIcon icon={PlayIcon} strokeWidth={1.5} className="size-7" />
          </span>
        </span>
      )}
      <LiveBadge className="absolute start-2 top-2" />
      {broadcast.mature && <OverlayBadge className="absolute end-2 top-2">{messages.mature}</OverlayBadge>}
      <ViewerCount
        count={broadcast.viewerCount}
        locale={locale}
        variant="overlay"
        size="md"
        className="absolute start-2 bottom-2"
      />
      {uptimeLabel && (
        <OverlayBadge data-slot="stream-card-uptime" className="absolute end-2 bottom-2">
          {uptimeLabel}
        </OverlayBadge>
      )}
    </div>
  );

  const tagList = tags.length > 0 && (
    <ul data-slot="stream-card-tags" className="flex min-w-0 max-w-full flex-wrap gap-1">
      {tags.map((tag) => (
        <li key={tag} className="min-w-0 max-w-full">
          {tagLink ? (
            <SlotLink
              link={tagLink(tag)}
              slot="stream-card-tag-link"
              className={cn(
                TAG_CHIP,
                "relative z-10 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              )}
            >
              <span dir="auto" className="truncate">
                {tag}
              </span>
            </SlotLink>
          ) : (
            <span data-slot="stream-card-tag" className={TAG_CHIP}>
              <span dir="auto" className="truncate">
                {tag}
              </span>
            </span>
          )}
        </li>
      ))}
    </ul>
  );

  // The reason is a quiet line of meta text, not a chip competing with the tags.
  const reason = showReason && (
    <p
      data-slot="stream-card-reason"
      data-reason={stream.reason}
      className="max-w-full truncate text-xs text-muted-foreground"
    >
      {reasonLabel ?? messages.discoveryReason[stream.reason]}
    </p>
  );

  const heading = (
    <Heading
      dir="auto"
      lang={stream.language || undefined}
      className={cn(
        "line-clamp-2 self-stretch break-words text-foreground",
        feature ? "text-base font-semibold md:text-xl" : "text-sm leading-snug font-medium",
      )}
    >
      {link}
    </Heading>
  );

  if (feature)
    return (
      <article
        data-slot="stream-card"
        data-size="feature"
        data-accent={accent}
        className={cn(
          "group/stream-card relative flex min-w-0 flex-col bg-card text-card-foreground ring-1 ring-foreground/10 md:flex-row",
          className,
        )}
        {...props}
      >
        {media}
        <div className="flex min-w-0 flex-1 flex-col items-start gap-2.5 p-4 md:p-6">
          <div className="flex min-w-0 max-w-full items-center gap-2.5">
            <ChannelAvatar
              name={channel.displayName}
              src={channel.avatarUrl}
              accent={accent}
              size="md"
              live
              locale={locale}
              decorative
            />
            <div className="flex min-w-0 flex-col items-start">
              <span className="max-w-full text-sm font-medium">{channelSlot}</span>
              {categorySlot && <span className="max-w-full text-xs text-muted-foreground">{categorySlot}</span>}
            </div>
          </div>
          {heading}
          {tagList}
          {ctaLabel && (
            <>
              <span aria-hidden className="flex-1" />
              {/* The stretched title link is the one target; this only looks like a button. */}
              <span
                aria-hidden
                data-slot="stream-card-cta"
                className={cn(buttonVariants({ variant: "outline", size: "lg" }), "text-sm")}
              >
                {ctaLabel}
              </span>
            </>
          )}
          {reason}
        </div>
      </article>
    );

  return (
    <article
      data-slot="stream-card"
      data-size="default"
      data-accent={accent}
      className={cn("group/stream-card relative flex min-w-0 flex-col", className)}
      {...props}
    >
      {media}
      <div className="flex min-w-0 gap-2.5 pt-2.5">
        <ChannelAvatar
          name={channel.displayName}
          src={channel.avatarUrl}
          accent={accent}
          size="sm"
          locale={locale}
          decorative
        />
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
          {heading}
          <p className="flex min-w-0 max-w-full items-center gap-1 text-xs text-muted-foreground">
            {channelSlot}
            {categorySlot && (
              <>
                <span aria-hidden className="shrink-0">
                  ·
                </span>
                {categorySlot}
              </>
            )}
          </p>
          {tagList && <div className="max-w-full pt-0.5">{tagList}</div>}
          {reason}
        </div>
      </div>
    </article>
  );
}

export interface ChannelChipProps extends Omit<React.ComponentProps<"article">, "children"> {
  /** The channel's display name: the chip's one link. */
  name: string;
  href: string;
  /** Custom link element (e.g. the router's `<Link>`). */
  render?: useRender.RenderProp;
  avatarSrc?: string | null;
  accent?: Accent | null;
  /** One quiet line under the name: "Art · 3 hours ago", "First stream this week". */
  meta?: React.ReactNode;
  locale?: string;
}

/**
 * An offline channel as a compact row ("Recently live", "Say hi to new streamers"): avatar, name
 * and one meta line, 44 px tall, one stretched link. Live channels get a `StreamCard` instead.
 */
export function ChannelChip({
  name,
  href,
  render,
  avatarSrc,
  accent,
  meta,
  locale,
  className,
  ...props
}: ChannelChipProps): React.JSX.Element {
  const link = useRender({
    defaultTagName: "a",
    render,
    props: {
      href,
      "data-slot": "channel-chip-link",
      className: cn(CHIP_LINK, "block truncate"),
      children: (
        <span dir="auto" className="truncate">
          {name}
        </span>
      ),
    },
  });
  return (
    <article
      data-slot="channel-chip"
      data-accent={accent ?? "zinc"}
      className={cn(
        "group/channel-chip relative flex min-h-11 min-w-0 max-w-full items-center gap-2.5 py-1.5 ps-1.5 pe-3 ring-1 ring-border ring-inset transition-colors duration-120 ease-out hover:bg-accent",
        className,
      )}
      {...props}
    >
      <ChannelAvatar name={name} src={avatarSrc} accent={accent} size="sm" locale={locale} decorative />
      <span className="flex min-w-0 flex-col">
        <span className="min-w-0 text-sm leading-tight font-medium">{link}</span>
        {meta && <span className="truncate text-xs text-muted-foreground tabular-nums">{meta}</span>}
      </span>
    </article>
  );
}

export interface ChannelChipRowProps extends React.ComponentProps<"ul"> {
  children: React.ReactNode;
}

/** A row of `ChannelChip`s: a horizontal scroller below 768 px, wrapping lines above. */
export function ChannelChipRow({ children, className, ...props }: ChannelChipRowProps): React.JSX.Element {
  return (
    <ul
      data-slot="channel-chip-row"
      className={cn("flex min-w-0 gap-2 overflow-x-auto pb-1 md:flex-wrap md:overflow-visible", className)}
      {...props}
    >
      {React.Children.toArray(children).map((child, index) => (
        <li key={(React.isValidElement(child) ? child.key : null) ?? index} className="shrink-0 md:shrink">
          {child}
        </li>
      ))}
    </ul>
  );
}
