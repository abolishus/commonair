// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Category } from "@commonair/contracts/dto";
import { CategoryGrid, type CategoryGridProps, type CategoryTileData } from "@commonair/ui/blocks/media";
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
