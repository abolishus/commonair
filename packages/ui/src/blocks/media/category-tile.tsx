// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { useRender } from "@base-ui/react/use-render";
import { HugeiconsIcon } from "@hugeicons/react";
import { GameController03Icon } from "@hugeicons/core-free-icons";
import { AspectRatio } from "@commonair/ui/components/aspect-ratio";
import { Card } from "@commonair/ui/components/card";
import { OverlayBadge, formatCompactNumber } from "@commonair/ui";
import type { Accent } from "@commonair/ui";
import { cn } from "@commonair/ui/lib/utils";
import { useResolvedLocale } from "@commonair/ui/lib/locale";

export interface CategoryTileData {
  id: string;
  name: string;
  liveCount: number;
  viewers?: number;
  imageUrl?: string | null;
  accent?: Accent;
  tags?: string[];
}

export interface CategoryTileProps extends Omit<React.ComponentProps<"article">, "children"> {
  category: CategoryTileData;
  href?: string;
  render?: useRender.RenderProp;
  size?: "default" | "sm";
  layout?: "tile" | "chip";
  locale?: string;
  liveLabel: (formatted: string, count: number) => string;
  viewerLabel: (formatted: string, count: number) => string;
}

export function CategoryTile({
  category,
  href,
  render,
  size = "default",
  layout = "tile",
  locale,
  liveLabel,
  viewerLabel,
  className,
  ...props
}: CategoryTileProps): React.JSX.Element {
  const resolvedLocale = useResolvedLocale(locale);
  const chip = layout === "chip";
  const link = useRender({
    defaultTagName: href ? "a" : "div",
    render,
    props: {
      href,
      "data-slot": "category-tile-link",
      className: cn(
        "group block min-w-0 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring",
        chip && "flex items-center gap-2",
      ),
      children: (
        <>
          <AspectRatio
            ratio={chip ? 1 : 3 / 4}
            className={cn("overflow-hidden bg-muted", chip ? "size-10 shrink-0" : "relative w-full")}
          >
            {category.imageUrl ? (
              <img src={category.imageUrl} alt="" loading="lazy" decoding="async" className="size-full object-cover" />
            ) : (
              <span
                data-accent={category.accent ?? "zinc"}
                className="grid size-full place-items-center bg-channel-accent/15 text-channel-accent-foreground"
              >
                <HugeiconsIcon icon={GameController03Icon} aria-hidden className="size-6" />
              </span>
            )}
            {!chip && (
              <OverlayBadge size="sm" className="absolute end-2 bottom-2">
                {liveLabel(formatCompactNumber(category.liveCount, resolvedLocale), category.liveCount)}
              </OverlayBadge>
            )}
          </AspectRatio>
          <span className={cn("flex min-w-0 flex-col", chip && "flex-1")}>
            <span className={cn("truncate font-medium", size === "sm" ? "text-xs" : "text-sm")}>{category.name}</span>
            {category.viewers !== undefined && (
              <span className="text-xs text-muted-foreground">
                {viewerLabel(formatCompactNumber(category.viewers, resolvedLocale), category.viewers)}
              </span>
            )}
            {chip && (
              <span className="text-2xs text-muted-foreground">
                {liveLabel(formatCompactNumber(category.liveCount, resolvedLocale), category.liveCount)}
              </span>
            )}
            {!chip && category.tags?.length ? (
              <span className="mt-1 truncate text-xs text-muted-foreground">{category.tags.join(" · ")}</span>
            ) : null}
          </span>
        </>
      ),
    },
  });
  return (
    <article className={cn("min-w-0", className)} {...props}>
      {chip ? (
        link
      ) : (
        <Card size={size === "sm" ? "sm" : "default"} className="min-w-0 p-2">
          {link}
        </Card>
      )}
    </article>
  );
}

export interface CategoryGridProps extends React.ComponentProps<"div"> {
  categories: CategoryTileData[];
  hrefFor?: (category: CategoryTileData) => string;
  columns?: 2 | 3 | 4;
  liveLabel: CategoryTileProps["liveLabel"];
  viewerLabel: CategoryTileProps["viewerLabel"];
}

export function CategoryGrid({
  categories,
  hrefFor,
  columns = 4,
  liveLabel,
  viewerLabel,
  className,
  ...props
}: CategoryGridProps): React.JSX.Element {
  return (
    <div
      className={cn(
        "grid min-w-0 grid-cols-2 gap-3",
        columns >= 3 && "md:grid-cols-3",
        columns === 4 && "lg:grid-cols-4",
        className,
      )}
      {...props}
    >
      {categories.map((category) => (
        <CategoryTile
          key={category.id}
          category={category}
          href={hrefFor?.(category)}
          liveLabel={liveLabel}
          viewerLabel={viewerLabel}
        />
      ))}
    </div>
  );
}
