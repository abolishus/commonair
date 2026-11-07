// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import { useRender } from "@base-ui/react/use-render";
import { CategoryArt, CategoryTileSkeleton, LiveBadge, formatCompactNumber } from "@commonair/ui";
import type { Accent, CategoryArtShape } from "@commonair/ui";
import { cn } from "@commonair/ui/lib/utils";
import { useResolvedLocale } from "@commonair/ui/lib/locale";

// The art moved to the art system (`src/art/category-art.tsx`); these names stay importable from here.
export {
  CategoryArt,
  categoryFallback,
  categoryKind,
  type CategoryArtProps,
  type CategoryKind,
} from "../../art/category-art.tsx";

export interface CategoryTileData {
  id: string;
  /** The URL slug; the fallback art is derived from it (else from `id`), so it never changes between renders. */
  slug?: string;
  name: string;
  liveCount: number;
  /** Verified viewers across the category's live channels; leave out when the total is not known exactly. */
  viewers?: number;
  imageUrl?: string | null;
  /** A channel accent for the fallback; without one the fallback picks a chart token from the slug. */
  accent?: Accent;
  tags?: string[];
}

export interface CategoryTileProps extends Omit<React.ComponentProps<"article">, "children"> {
  category: CategoryTileData;
  href?: string;
  render?: useRender.RenderProp;
  size?: "default" | "sm";
  layout?: "tile" | "chip";
  /** Tile only: `portrait` (3:4, the directory) or `landscape` (16:9, the compact home shelf). */
  shape?: CategoryArtShape;
  /** Draw the 0-live state; defaults to `liveCount === 0`. Muted tiles never show a "0 live" badge. */
  muted?: boolean;
  locale?: string;
  liveLabel: (formatted: string, count: number) => string;
  viewerLabel: (formatted: string, count: number) => string;
  /** Tags shown as chips under the name (the tile is one link, so the chips are not links). At most 3. */
  maxTags?: number;
  /** Make the name a heading at this level (it is plain text by default). */
  headingLevel?: 2 | 3 | 4;
}

const STRETCHED =
  "outline-none after:absolute after:inset-0 after:z-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-offset-2 focus-visible:after:ring-offset-background";

/**
 * A category as a tile (the art, then the name, viewers and tags) or as a compact chip. One
 * stretched link per tile. Live counts show only when something is live: at 0 the art goes muted
 * and no "0 live" badge appears.
 */
export function CategoryTile({
  category,
  href,
  render,
  size = "default",
  layout = "tile",
  shape = "portrait",
  muted,
  locale,
  liveLabel,
  viewerLabel,
  maxTags = 2,
  headingLevel,
  className,
  ...props
}: CategoryTileProps): React.JSX.Element {
  const resolvedLocale = useResolvedLocale(locale);
  const chip = layout === "chip";
  const isMuted = muted ?? category.liveCount <= 0;
  const live =
    category.liveCount > 0
      ? liveLabel(formatCompactNumber(category.liveCount, resolvedLocale), category.liveCount)
      : null;
  const tags = (category.tags ?? []).slice(0, Math.min(3, Math.max(0, maxTags)));
  const Name = headingLevel ? (`h${headingLevel}` as const) : "p";
  const link = useRender({
    defaultTagName: href ? "a" : "span",
    render: href ? render : undefined,
    props: {
      href,
      "data-slot": "category-tile-link",
      className: cn(href && STRETCHED),
      children: category.name,
    },
  });
  const viewers =
    category.viewers !== undefined && !isMuted ? (
      <span className="text-xs text-muted-foreground tabular-nums">
        {viewerLabel(formatCompactNumber(category.viewers, resolvedLocale), category.viewers)}
      </span>
    ) : null;

  if (chip)
    return (
      <article
        data-slot="category-tile"
        data-layout="chip"
        data-muted={isMuted || undefined}
        className={cn(
          "group/category-tile relative flex min-h-11 min-w-0 items-center gap-2.5 transition-colors duration-120 ease-out",
          className,
        )}
        {...props}
      >
        <CategoryArt
          slug={category.slug ?? category.id}
          imageUrl={category.imageUrl}
          accent={category.accent}
          muted={isMuted}
          iconSize="sm"
          className="size-10 shrink-0"
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <Name
            dir="auto"
            className="truncate text-sm font-medium underline-offset-4 group-hover/category-tile:underline"
          >
            {link}
          </Name>
          {viewers}
          {live && <span className="text-xs text-muted-foreground tabular-nums">{live}</span>}
        </span>
      </article>
    );

  return (
    <article
      data-slot="category-tile"
      data-layout="tile"
      data-muted={isMuted || undefined}
      className={cn("group/category-tile relative flex min-w-0 flex-col", className)}
      {...props}
    >
      <div
        data-slot="category-tile-media"
        className="relative overflow-hidden ring-channel-accent transition-shadow duration-120 ease-out group-hover/category-tile:ring-2"
      >
        <CategoryArt
          slug={category.slug ?? category.id}
          imageUrl={category.imageUrl}
          accent={category.accent}
          shape={shape}
          muted={isMuted}
          iconSize={shape === "landscape" || size === "sm" ? "md" : "lg"}
          className="transition-transform duration-120 ease-out motion-safe:group-hover/category-tile:scale-102"
        />
        {live && (
          <LiveBadge data-slot="category-tile-live" label={live} className="absolute start-2 top-2 tabular-nums" />
        )}
      </div>
      <div className="flex min-w-0 flex-col items-start gap-0.5 pt-2">
        <Name dir="auto" className="line-clamp-2 self-stretch text-sm leading-snug font-medium break-words">
          {link}
        </Name>
        {viewers}
        {tags.length > 0 && (
          <ul className="flex min-w-0 max-w-full flex-wrap gap-1 pt-1">
            {tags.map((tag) => (
              <li key={tag} className="min-w-0 max-w-full">
                <span className="inline-flex min-h-6 max-w-full items-center bg-muted px-1.5 text-xs text-muted-foreground">
                  <span dir="auto" className="truncate">
                    {tag}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </article>
  );
}

export interface CategoryGridProps extends React.ComponentProps<"div"> {
  categories: CategoryTileData[];
  hrefFor?: (category: CategoryTileData) => string;
  /** A router link per tile (Base UI `render`); `hrefFor` stays the plain-anchor fallback. */
  renderLink?: (category: CategoryTileData) => React.ReactElement;
  /** Extra props per tile (`data-*` test ids). */
  tileProps?: (category: CategoryTileData) => { [key: `data-${string}`]: string | undefined };
  columns?: 2 | 3 | 4 | 6;
  /** The art's shape for every tile. */
  shape?: CategoryArtShape;
  liveLabel: CategoryTileProps["liveLabel"];
  viewerLabel: CategoryTileProps["viewerLabel"];
  /** Placeholder tiles while the list loads. */
  loading?: boolean;
  loadingCount?: number;
  /** Shown instead of the grid when there are no categories. */
  empty?: React.ReactNode;
}

const GRID_COLUMNS = {
  2: "",
  3: "md:grid-cols-3",
  4: "md:grid-cols-3 lg:grid-cols-4",
  6: "sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6",
} as const;

export function CategoryGrid({
  categories,
  hrefFor,
  renderLink,
  tileProps,
  columns = 4,
  shape = "portrait",
  liveLabel,
  viewerLabel,
  loading = false,
  loadingCount = 8,
  empty,
  className,
  ...props
}: CategoryGridProps): React.JSX.Element | null {
  if (!loading && categories.length === 0) return empty ? <>{empty}</> : null;
  return (
    <div className={cn("grid min-w-0 grid-cols-2 gap-x-3 gap-y-5", GRID_COLUMNS[columns], className)} {...props}>
      {loading
        ? Array.from({ length: Math.max(0, loadingCount) }, (_, index) => (
            <CategoryTileSkeleton key={index} shape={shape} />
          ))
        : categories.map((category) => (
            <CategoryTile
              key={category.id}
              {...tileProps?.(category)}
              category={category}
              shape={shape}
              href={hrefFor?.(category)}
              render={renderLink?.(category)}
              liveLabel={liveLabel}
              viewerLabel={viewerLabel}
            />
          ))}
    </div>
  );
}
