// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import type { StreamCard as StreamCardData } from "@commonair/contracts/dto";
import { StreamCard, StreamCardSkeleton, type StreamCardProps } from "@commonair/ui";
import { cn } from "@commonair/ui/lib/utils";

export interface CardGridProps extends React.ComponentProps<"div"> {
  /** Cap the columns (a side panel, a two-up shelf). Without it the grid fills its width. */
  max?: 2 | 3 | 4;
}

/**
 * Column steps for a 248 px minimum track with a 16 px gap, by the width of the grid's own box
 * (container queries, so an open rail or a side panel counts): n columns need n·248 + (n−1)·16 px,
 * and each step is the nearest container size at or just under that (2 at 32rem, 3 at 48rem,
 * 4 at 64rem, 5 at 80rem). Full class strings so Tailwind sees them.
 */
const STEPS = ["@lg:grid-cols-2", "@3xl:grid-cols-3", "@5xl:grid-cols-4", "@7xl:grid-cols-5"] as const;

/**
 * The media grid (stream, video and clip cards): auto-fills at a 248 px minimum, `gap-x-4
 * gap-y-6`. The outer box is the query container, the inner one the grid.
 */
export function CardGrid({ max, className, children, ...props }: CardGridProps): React.JSX.Element {
  const steps = max ? STEPS.slice(0, max - 1) : STEPS;
  return (
    <div data-slot="card-grid" data-max={max} className={cn("@container min-w-0", className)} {...props}>
      <div className={cn("grid min-w-0 grid-cols-1 gap-x-4 gap-y-6", ...steps)}>{children}</div>
    </div>
  );
}

/** What a page may set on each card; the grid owns `stream`, `href`, `render`, `lazy`. */
export type StreamGridCardProps = Partial<Omit<StreamCardProps, "stream" | "href" | "render">> & {
  [key: `data-${string}`]: string | undefined;
};

export interface StreamGridProps extends React.ComponentProps<"section"> {
  streams: StreamCardData[];
  hrefFor: (stream: StreamCardData) => string;
  renderLink?: (stream: StreamCardData) => React.ReactElement;
  /** Extra props per card (`data-*` test ids, `showReason`, `headingLevel` …). */
  cardProps?: (stream: StreamCardData) => StreamGridCardProps;
  /** `dense` caps the grid at two columns (narrow regions); `default` fills the width. */
  columns?: "default" | "dense";
  loading?: boolean;
  loadingCount?: number;
  /** Cards before this index load eagerly (the first row). */
  eager?: number;
  empty?: React.ReactNode;
  footer?: React.ReactNode;
}

export function StreamGrid({
  streams,
  hrefFor,
  renderLink,
  cardProps,
  columns = "default",
  loading = false,
  loadingCount = 4,
  eager = 3,
  empty,
  footer,
  className,
  ...props
}: StreamGridProps): React.JSX.Element {
  const max = columns === "dense" ? 2 : undefined;
  return (
    <section className={cn("flex min-w-0 flex-col gap-4", className)} {...props}>
      {loading ? (
        <CardGrid max={max}>
          {Array.from({ length: Math.max(0, loadingCount) }, (_, index) => (
            <StreamCardSkeleton key={index} />
          ))}
        </CardGrid>
      ) : streams.length ? (
        <CardGrid max={max}>
          {streams.map((stream, index) => (
            <StreamCard
              lazy={index >= eager}
              {...cardProps?.(stream)}
              key={stream.channel.id}
              stream={stream}
              href={hrefFor(stream)}
              render={renderLink?.(stream)}
            />
          ))}
        </CardGrid>
      ) : (
        (empty ?? null)
      )}
      {footer}
    </section>
  );
}
