// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Layout-shaped loading placeholders. Each is `aria-hidden`; wrap a loading
 * region in `<SkeletonGroup>` so assistive tech hears one "Loading" instead.
 */
import type * as React from "react";
import { Skeleton } from "../components/skeleton.tsx";
import { useUiMessages } from "../lib/locale.tsx";
import { cn } from "../lib/utils.ts";

export { Skeleton };

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

/** Placeholder with the exact footprint of `<StreamCard>`, so the grid does not jump when data arrives. */
export function StreamCardSkeleton({ className, ...props }: React.ComponentProps<"div">): React.JSX.Element {
  return (
    <div
      aria-hidden
      data-slot="stream-card-skeleton"
      className={cn("flex min-w-0 flex-col gap-2", className)}
      {...props}
    >
      <SkeletonThumbnail />
      <div className="flex gap-2">
        <SkeletonAvatar size="sm" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </div>
    </div>
  );
}

export { avatarSizes };
