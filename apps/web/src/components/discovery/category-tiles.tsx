// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Category } from "@commonair/contracts/dto";
import { formatCompactNumber, useLocale } from "@commonair/ui";
import { CategoryGrid, CategoryTile, type CategoryGridProps, type CategoryTileData } from "@commonair/ui/blocks/media";
import { cn } from "@commonair/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { categoryHref, categoryLink } from "../../lib/category-route.ts";

export const liveLabel = (formatted: string, count: number): string =>
  t("discovery.category.live", { count, formatted });
export const viewerLabel = (formatted: string, count: number): string =>
  t("discovery.category.viewers", { count, formatted });

/**
 * A category as a tile: box art (or the generated fallback), live channels, the verified viewers
 * and the most used tags, all as the API counts them (`Category.viewerCount` / `tags`).
 */
export function tileData(category: Category): CategoryTileData {
  const tile: CategoryTileData = {
    id: category.id,
    slug: category.slug,
    name: category.name,
    liveCount: category.liveChannels,
    viewers: category.viewerCount,
    imageUrl: category.boxArtUrl,
  };
  if (category.tags.length > 0) tile.tags = [...category.tags];
  return tile;
}

export interface DiscoveryCategoryGridProps extends Omit<
  CategoryGridProps,
  "categories" | "liveLabel" | "viewerLabel" | "renderLink" | "hrefFor"
> {
  categories: readonly Category[];
}

/** `CategoryGrid` with router links to each category page. */
export function DiscoveryCategoryGrid({ categories, ...props }: DiscoveryCategoryGridProps): React.JSX.Element | null {
  return (
    <CategoryGrid
      {...props}
      categories={categories.map((c) => tileData(c))}
      hrefFor={(tile) => categoryHref(tile.slug ?? tile.id)}
      renderLink={(tile) => <Link {...categoryLink(tile.slug ?? tile.id)} />}
      tileProps={(tile) => ({ "data-testid": "category-tile", "data-category": tile.slug })}
      liveLabel={liveLabel}
      viewerLabel={viewerLabel}
    />
  );
}

/**
 * Categories with nobody live (Directory v2's "All categories"): muted art and no "0 live" badge
 * (the tile's own rule), and the category's videos under the name when it has any, so a quiet
 * category still says what is there to watch.
 */
export function IdleCategoryGrid({
  categories,
  className,
  ...props
}: { categories: readonly Category[] } & Omit<React.ComponentProps<"ul">, "children">): React.JSX.Element | null {
  const { locale } = useLocale();
  if (categories.length === 0) return null;
  return (
    <ul
      className={cn("grid min-w-0 grid-cols-2 gap-x-3 gap-y-5 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6", className)}
      {...props}
    >
      {categories.map((category) => (
        <li key={category.id} className="flex min-w-0 flex-col">
          <CategoryTile
            data-testid="category-tile"
            data-category={category.slug}
            category={tileData(category)}
            href={categoryHref(category.slug)}
            render={<Link {...categoryLink(category.slug)} />}
            liveLabel={liveLabel}
            viewerLabel={viewerLabel}
          />
          {category.videoCount > 0 ? (
            <span
              data-testid="category-tile-videos"
              data-count={category.videoCount}
              className="text-xs text-muted-foreground tabular-nums"
            >
              {t("d3Browse.category.videoCount", {
                count: category.videoCount,
                formatted: formatCompactNumber(category.videoCount, locale),
              })}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
