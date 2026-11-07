// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Layout-shaped loading placeholders: each mirrors the card it stands in for (16:9 frame, avatar,
 * two title lines, the meta line, tag chips), never a full-width grey slab. Each is `aria-hidden`;
 * wrap a loading region in `<SkeletonGroup>` so assistive tech hears one "Loading" instead. They
 * pulse only when the viewer allows motion.
 */
import type * as React from "react";
import { Skeleton as SkeletonBase } from "../components/skeleton.tsx";
import { useUiMessages } from "../lib/locale.tsx";
import { cn } from "../lib/utils.ts";

/** The shadcn skeleton block, static under `prefers-reduced-motion`. */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  return <SkeletonBase className={cn("animate-none motion-safe:animate-pulse", className)} {...props} />;
}

export interface SkeletonGroupProps extends React.ComponentProps<"output"> {
  /** Accessible status text; defaults to `messages.loading`. */
  label?: string;
}

/** A busy region with a single screen-reader status for the skeletons inside it. */
export function SkeletonGroup({ label, children, className, ...props }: SkeletonGroupProps): React.JSX.Element {
  const messages = useUiMessages();
  return (
    <output aria-busy="true" data-slot="skeleton-group" className={cn("block", className)} {...props}>
      <span className="sr-only">{label ?? messages.loading}</span>
      {children}
    </output>
  );
}

export interface SkeletonTextProps extends React.ComponentProps<"div"> {
  lines?: number;
}

/** Paragraph placeholder; the last line is shorter, like real text. */
export function SkeletonText({ lines = 3, className, ...props }: SkeletonTextProps): React.JSX.Element {
  const count = Math.max(1, Math.floor(lines));
  return (
    <div aria-hidden data-slot="skeleton-text" className={cn("flex w-full flex-col gap-1.5", className)} {...props}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className={cn("h-3", i === count - 1 && count > 1 ? "w-3/5" : "w-full")} />
      ))}
    </div>
  );
}

const avatarSizes = { xs: "size-6", sm: "size-8", md: "size-10", lg: "size-14", xl: "size-20" } as const;
export type AvatarSize = keyof typeof avatarSizes;

export function SkeletonAvatar({
  size = "md",
  className,
  ...props
}: React.ComponentProps<"div"> & { size?: AvatarSize }): React.JSX.Element {
  return (
    <Skeleton
      aria-hidden
      data-slot="skeleton-avatar"
      className={cn("shrink-0 rounded-full", avatarSizes[size], className)}
      {...props}
    />
  );
}

/** 16:9 video thumbnail placeholder. */
export function SkeletonThumbnail({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <Skeleton aria-hidden data-slot="skeleton-thumbnail" className={cn("aspect-video w-full", className)} {...props} />
  );
}

export function SkeletonButton({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  return <Skeleton aria-hidden data-slot="skeleton-button" className={cn("h-8 w-24", className)} {...props} />;
}

/** Two tag chips (`min-h-6`), as the cards show them. */
function SkeletonTags(): React.JSX.Element {
  return (
    <div className="flex gap-1 pt-0.5">
      <Skeleton className="h-6 w-14" />
      <Skeleton className="h-6 w-10" />
    </div>
  );
}

export interface StreamCardSkeletonProps extends React.ComponentProps<"div"> {
  /** Match `StreamCard size`. */
  size?: "default" | "feature";
}

/** Placeholder with the exact footprint of `<StreamCard>`, so the grid does not jump when data arrives. */
export function StreamCardSkeleton({
  size = "default",
  className,
  ...props
}: StreamCardSkeletonProps): React.JSX.Element {
  if (size === "feature")
    return (
      <div
        aria-hidden
        data-slot="stream-card-skeleton"
        data-size="feature"
        className={cn("flex min-w-0 flex-col bg-card ring-1 ring-foreground/10 md:flex-row", className)}
        {...props}
      >
        <SkeletonThumbnail className="md:w-31/50 md:shrink-0 md:self-start" />
        <div className="flex min-w-0 flex-1 flex-col gap-3 p-4 md:p-6">
          <div className="flex items-center gap-2.5">
            <SkeletonAvatar size="md" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-1/2" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          </div>
          <Skeleton className="h-5 w-11/12" />
          <Skeleton className="h-5 w-2/3" />
          <SkeletonTags />
        </div>
      </div>
    );
  return (
    <div
      aria-hidden
      data-slot="stream-card-skeleton"
      data-size="default"
      className={cn("flex min-w-0 flex-col", className)}
      {...props}
    >
      <SkeletonThumbnail />
      <div className="flex gap-2.5 pt-2.5">
        <SkeletonAvatar size="sm" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-3/5" />
          <Skeleton className="h-3 w-1/2" />
          <SkeletonTags />
        </div>
      </div>
    </div>
  );
}

export interface MediaCardSkeletonProps extends React.ComponentProps<"div"> {
  /** Clips carry no avatar, as `MediaCard kind="clip"`. */
  kind?: "vod" | "clip";
  layout?: "card" | "compact";
}

/** Placeholder with the footprint of `<MediaCard>` (the StreamCard footprint, no tags). */
export function MediaCardSkeleton({
  kind = "vod",
  layout = "card",
  className,
  ...props
}: MediaCardSkeletonProps): React.JSX.Element {
  const compact = layout === "compact";
  return (
    <div
      aria-hidden
      data-slot="media-card-skeleton"
      data-kind={kind}
      className={cn("flex min-w-0", compact ? "items-start gap-3" : "flex-col", className)}
      {...props}
    >
      <SkeletonThumbnail className={cn(compact && "w-32 shrink-0 sm:w-40")} />
      <div className={cn("flex min-w-0 flex-1 gap-2.5", !compact && "pt-2.5")}>
        {kind === "vod" && !compact && <SkeletonAvatar size="sm" />}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-3/5" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
    </div>
  );
}

/** Placeholder with the footprint of `<ChannelChip>` (44 px row). */
export function ChannelChipSkeleton({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      aria-hidden
      data-slot="channel-chip-skeleton"
      className={cn(
        "flex min-h-11 w-48 items-center gap-2.5 py-1.5 ps-1.5 pe-3 ring-1 ring-border ring-inset",
        className,
      )}
      {...props}
    >
      <SkeletonAvatar size="sm" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Skeleton className="h-3.5 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}

export interface CategoryTileSkeletonProps extends React.ComponentProps<"div"> {
  /** Match `CategoryArt shape`: 3:4 for the directory, 16:9 for the compact shelf. */
  shape?: "portrait" | "landscape";
}

/** Placeholder with the footprint of a category tile: the art, then the name and the meta line. */
export function CategoryTileSkeleton({
  shape = "portrait",
  className,
  ...props
}: CategoryTileSkeletonProps): React.JSX.Element {
  return (
    <div
      aria-hidden
      data-slot="category-tile-skeleton"
      data-shape={shape}
      className={cn("flex min-w-0 flex-col gap-2", className)}
      {...props}
    >
      <Skeleton className={cn("w-full", shape === "portrait" ? "aspect-3/4" : "aspect-video")} />
      <Skeleton className="h-3.5 w-3/4" />
      <Skeleton className="h-3 w-1/3" />
    </div>
  );
}

export { avatarSizes };
