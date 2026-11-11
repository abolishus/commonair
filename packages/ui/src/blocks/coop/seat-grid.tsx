// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { cn } from "@commonair/ui/lib/utils";
import type { DataAttributes } from "../../lib/data-attributes.ts";
import { TargetLink, type LinkTarget } from "../../lib/link.tsx";
import { ChannelAvatar } from "../../primitives/channel-avatar.tsx";

export interface SeatGridItem {
  userId: string;
  name: string;
  /** The person's channel. */
  link: LinkTarget;
  /** "Rank 1" or the class of the seat. */
  eyebrow?: React.ReactNode;
  /** "3.5% of contribution". */
  meta?: React.ReactNode;
  /** Set on the tile besides `data-user-id` (e.g. `data-rank`, `data-score`). */
  attributes?: DataAttributes;
}

export interface SeatGridProps extends Omit<React.ComponentProps<"ul">, "children"> {
  items: readonly SeatGridItem[];
  /** Accessible name of the list. */
  label: string;
  /** Set on every tile (e.g. `{ "data-testid": "council-member" }`). */
  itemProps?: DataAttributes;
  /** `compact`: a single column of rows (the overview's aside). */
  layout?: "grid" | "rows";
}

/**
 * People on a council or board (overhaul D6.3, coop-trust CT-8): avatar tiles that each link to
 * the person's channel, with their rank or seat and their share. Each tile is one link.
 */
export function SeatGrid({
  items,
  label,
  itemProps,
  layout = "grid",
  className,
  ...props
}: SeatGridProps): React.JSX.Element {
  return (
    <ul
      aria-label={label}
      className={cn(
        "min-w-0",
        layout === "grid" ? "grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4" : "flex flex-col",
        className,
      )}
      {...props}
    >
      {items.map((item) => (
        <li
          {...itemProps}
          {...item.attributes}
          key={item.userId}
          data-user-id={item.userId}
          className={cn("relative min-w-0", layout === "rows" && "border-t first:border-t-0")}
        >
          <div
            className={cn(
              "flex min-w-0 items-center gap-3 transition-colors hover:bg-muted/40 motion-reduce:transition-none",
              layout === "grid" ? "p-3 ring-1 ring-foreground/10" : "py-2",
            )}
          >
            <ChannelAvatar name={item.name} size={layout === "grid" ? "md" : "sm"} decorative />
            <div className="flex min-w-0 flex-col">
              {item.eyebrow ? <span className="text-xs text-muted-foreground">{item.eyebrow}</span> : null}
              <TargetLink
                target={item.link}
                className="truncate text-sm font-medium after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-ring"
              >
                {item.name}
              </TargetLink>
              {item.meta ? <span className="text-xs text-muted-foreground tabular-nums">{item.meta}</span> : null}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
