// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { useRender } from "@base-ui/react/use-render";
import { HugeiconsIcon } from "@hugeicons/react";
import { Scissor01Icon, Video01Icon } from "@hugeicons/core-free-icons";
import { Badge } from "@commonair/ui/components/badge";
import { ChannelAvatar, MediaFallback, OverlayBadge, MediaCardSkeleton } from "@commonair/ui";
import type { Accent } from "@commonair/ui";
import { cn } from "@commonair/ui/lib/utils";
import { ACCENTS } from "@commonair/contracts/shapes";
import { CardGrid } from "./stream-grid.tsx";

export interface MediaCardData {
  id: string;
  title: string;
  thumbnailUrl?: string | null;
  accent?: string;
  channelName?: string;
  channelAvatarUrl?: string | null;
  /** Pre-formatted length ("2:14:08"), bottom-end over the thumbnail. */
  duration?: string;
  /** Pre-formatted age ("2 days ago"), on the meta line. */
  ago?: string;
  /** Pre-formatted views ("312 views"), on the meta line. */
  views?: string;
  /** Pre-formatted "Clipped by …" line for clips; shown instead of `views` when both are set. */
  clippedBy?: string;
  mature?: boolean;
  /** The visible kind label over the thumbnail's top start ("Video", "Clip", "Past broadcast"). */
  kind?: string;
  matureLabel?: string;
  highlightLabel?: string;
}

export type MediaKind = "vod" | "clip";

export interface MediaCardProps extends Omit<React.ComponentProps<"article">, "children"> {
  media: MediaCardData;
  /** The card's one link (the title, stretched over the card). Without it the card is not a link. */
  href?: string;
  render?: useRender.RenderProp;
  /** `vod` (a past broadcast or upload, with the channel avatar) or `clip` (no avatar, the clipper). */
  kind?: MediaKind;
  /** Legacy name for `kind`: `highlight` and `upload` are VODs; `highlight` shows its badge. */
  variant?: "vod" | "clip" | "highlight" | "upload";
  layout?: "card" | "compact";
  headingLevel?: 2 | 3 | 4;
  /** Lazy-load the thumbnail (default); set false for the first row above the fold. */
  lazy?: boolean;
  locale?: string;
}

const STRETCHED =
  "outline-none after:absolute after:inset-0 after:z-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-offset-2 focus-visible:after:ring-offset-background";

const ACCENT_NAMES: ReadonlySet<string> = new Set(ACCENTS);
const asAccent = (accent: string | undefined): Accent =>
  accent && ACCENT_NAMES.has(accent) ? (accent as Accent) : "zinc";

/**
 * A video or a clip, with the StreamCard footprint: the 16:9 frame (or the accent fallback with
 * the arcs), then the title, one meta line and the channel. One stretched link; the kind label and
 * the duration sit over the frame in 12 px tabular figures.
 */
export function MediaCard({
  media,
  href,
  render,
  kind,
  variant = "vod",
  layout = "card",
  headingLevel,
  lazy = true,
  locale,
  className,
  ...props
}: MediaCardProps): React.JSX.Element {
  const resolvedKind: MediaKind = kind ?? (variant === "clip" ? "clip" : "vod");
  const compact = layout === "compact";
  const accent = asAccent(media.accent);
  const [failedSrc, setFailedSrc] = React.useState<string | null>(null);
  const showImage = Boolean(media.thumbnailUrl) && failedSrc !== media.thumbnailUrl;
  const Heading = headingLevel ? (`h${headingLevel}` as const) : "p";

  const title = useRender({
    defaultTagName: href ? "a" : "span",
    render: href ? render : undefined,
    props: {
      href,
      "data-slot": "media-card-link",
      className: cn(href && STRETCHED),
      children: media.title,
    },
  });

  const meta = [
    media.channelName,
    resolvedKind === "clip" ? (media.clippedBy ?? media.views) : media.ago,
    resolvedKind === "clip" ? media.ago : media.views,
  ].filter((part): part is string => Boolean(part));
  const avatar = resolvedKind === "vod" && !compact && media.channelName;

  return (
    <article
      data-slot="media-card"
      data-kind={resolvedKind}
      data-accent={accent}
      className={cn("group/media-card relative flex min-w-0", compact ? "items-start gap-3" : "flex-col", className)}
      {...props}
    >
      <div
        data-slot="media-card-media"
        className={cn(
          "relative aspect-video overflow-hidden bg-muted ring-channel-accent transition-shadow duration-120 ease-out group-hover/media-card:ring-2",
          compact ? "w-32 shrink-0 sm:w-40" : "w-full",
        )}
      >
        {showImage ? (
          <img
            src={media.thumbnailUrl ?? undefined}
            alt=""
            loading={lazy ? "lazy" : "eager"}
            decoding="async"
            onError={() => setFailedSrc(media.thumbnailUrl ?? null)}
            className="size-full object-cover transition-transform duration-120 ease-out motion-safe:group-hover/media-card:scale-102"
          />
        ) : (
          <MediaFallback kind="vod" accent={accent} />
        )}
        {media.kind && (
          <OverlayBadge data-slot="media-card-kind" className="absolute start-2 top-2">
            <HugeiconsIcon
              icon={resolvedKind === "clip" ? Scissor01Icon : Video01Icon}
              strokeWidth={2}
              aria-hidden
              data-icon="inline-start"
            />
            {media.kind}
          </OverlayBadge>
        )}
        {media.mature && media.matureLabel && (
          <OverlayBadge className="absolute end-2 top-2">{media.matureLabel}</OverlayBadge>
        )}
        {media.duration && (
          <OverlayBadge data-slot="media-card-duration" className="absolute end-2 bottom-2">
            {media.duration}
          </OverlayBadge>
        )}
      </div>
      <div className={cn("flex min-w-0 flex-1 gap-2.5", !compact && "pt-2.5")}>
        {avatar && (
          <ChannelAvatar
            name={avatar}
            src={media.channelAvatarUrl}
            accent={accent}
            size="sm"
            locale={locale}
            decorative
          />
        )}
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
          <Heading dir="auto" className="line-clamp-2 self-stretch text-sm leading-snug font-medium break-words">
            {title}
          </Heading>
          {meta.length > 0 && (
            <p data-slot="media-card-meta" className="max-w-full truncate text-xs text-muted-foreground tabular-nums">
              {meta.map((part, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <span aria-hidden> · </span>}
                  <span dir="auto">{part}</span>
                </React.Fragment>
              ))}
            </p>
          )}
          {variant === "highlight" && media.highlightLabel && <Badge variant="outline">{media.highlightLabel}</Badge>}
        </div>
      </div>
    </article>
  );
}

export interface MediaGridProps extends React.ComponentProps<"div"> {
  media: MediaCardData[];
  hrefFor?: (item: MediaCardData) => string;
  /** A router link per card (Base UI `render`); `hrefFor` stays the plain-anchor fallback. */
  renderLink?: (item: MediaCardData) => React.ReactElement;
  kind?: MediaKind;
  /** Legacy: the grid now auto-fills at a 248 px minimum; `2` still caps it at two columns. */
  columns?: 2 | 3 | 4;
  loading?: boolean;
  loadingCount?: number;
  /** Cards before this index load eagerly (the first row). */
  eager?: number;
}

/** Videos or clips in the auto-fill media grid (min 248 px, gap-x-4 gap-y-6). */
export function MediaGrid({
  media,
  hrefFor,
  renderLink,
  kind,
  columns,
  loading = false,
  loadingCount = 4,
  eager = 0,
  className,
  ...props
}: MediaGridProps): React.JSX.Element {
  return (
    <CardGrid max={columns === 2 ? 2 : undefined} className={className} {...props}>
      {loading
        ? Array.from({ length: Math.max(0, loadingCount) }, (_, index) => <MediaCardSkeleton key={index} kind={kind} />)
        : media.map((item, index) => (
            <MediaCard
              key={item.id}
              media={item}
              kind={kind}
              href={hrefFor?.(item)}
              render={renderLink?.(item)}
              lazy={index >= eager}
            />
          ))}
    </CardGrid>
  );
}
