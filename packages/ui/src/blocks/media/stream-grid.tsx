// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import type { StreamCard as StreamCardData } from "@commonair/contracts/dto";
import { StreamCard, StreamCardSkeleton } from "@commonair/ui";
import { cn } from "@commonair/ui/lib/utils";

export interface StreamGridProps extends React.ComponentProps<"section"> {
  streams: StreamCardData[];
  hrefFor: (stream: StreamCardData) => string;
  renderLink?: (stream: StreamCardData) => React.ReactElement;
  columns?: "default" | "dense";
  loading?: boolean;
  loadingCount?: number;
  empty?: React.ReactNode;
  footer?: React.ReactNode;
}

export function StreamGrid({
  streams,
  hrefFor,
  renderLink,
  columns = "default",
  loading = false,
  loadingCount = 4,
  empty,
  footer,
  className,
  ...props
}: StreamGridProps): React.JSX.Element {
  return (
    <section className={cn("flex min-w-0 flex-col gap-4", className)} {...props}>
      {loading ? (
        <div className={cn("grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2", columns === "default" && "lg:grid-cols-3")}>
          {Array.from({ length: Math.max(0, loadingCount) }, (_, index) => (
            <StreamCardSkeleton key={index} />
          ))}
        </div>
      ) : streams.length ? (
        <div className={cn("grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2", columns === "default" && "lg:grid-cols-3")}>
          {streams.map((stream, index) => (
            <StreamCard
              key={stream.channel.id}
              stream={stream}
              href={hrefFor(stream)}
              render={renderLink?.(stream)}
              lazy={index > 2}
            />
          ))}
        </div>
      ) : (
        (empty ?? null)
      )}
      {footer}
    </section>
  );
}
