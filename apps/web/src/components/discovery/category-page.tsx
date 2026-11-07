// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/directory/$category` (F1): the category's art, name, live channels, verified viewers and the
 * tags its live channels carry, then three tabs: Live, Videos (`vods.listByCategory`) and Clips
 * (`clips.listByCategory`, with the sort and range control). The tab is the URL's `?tab=`, as on
 * the channel page, so each is a link and Back steps through them; only the active panel mounts,
 * so Videos and Clips ask for their first page when opened.
 */
import type { Category, StreamCard } from "@commonair/contracts/dto";
import { EmptyState, formatCompactNumber, useLocale, ViewerCount } from "@commonair/ui";
import { PageTabs } from "@commonair/ui/blocks/headers";
import { CategoryArt } from "@commonair/ui/blocks/media";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import { GridViewIcon, LiveStreaming02Icon, Scissor01Icon, Video01Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../../i18n/index.ts";
import { RouteSectionLoadError } from "../../lib/section-load-error.tsx";
import { tagLink } from "../../lib/category-route.ts";
import {
  ClipFilters,
  clipFilterSearch,
  parseClipFilter,
  type ClipFilter,
  type ClipFilterSearch,
} from "../channel/clip-filters.tsx";
import { useCategoryClips, useCategoryVods } from "../channel/use-media-list.ts";
import { ClipsFilteredEmpty, clipTiles, VideoGrid, vodTiles } from "../channel/video-grid.tsx";
import { NotFoundState } from "../not-found.tsx";
import { liveLabel, viewerLabel } from "./category-tiles.tsx";
import { LiveView } from "./directory-page.tsx";
import type { Page } from "./loaders.ts";

export const CATEGORY_TABS = ["live", "videos", "clips"] as const;
export type CategoryTab = (typeof CATEGORY_TABS)[number];

/** `/directory/$category`'s search params: Live is the bare URL; Clips adds its sort and range. */
export interface CategorySearch extends ClipFilterSearch {
  tab?: Exclude<CategoryTab, "live">;
}

/** The route's `validateSearch`: anything unknown is the Live tab, so a bad link never errors. */
export function parseCategorySearch(search: Record<string, unknown>): CategorySearch {
  if (search.tab === "clips") return { tab: "clips", ...parseClipFilter(search) };
  return search.tab === "videos" ? { tab: "videos" } : {};
}

export function isCategoryTab(value: unknown): value is CategoryTab {
  return (CATEGORY_TABS as readonly unknown[]).includes(value);
}

export function categoryTabSearch(tab: CategoryTab, filter?: ClipFilter): CategorySearch {
  if (tab === "live") return {};
  if (tab === "clips") return { tab, ...(filter ? clipFilterSearch(filter) : {}) };
  return { tab };
}

function tabLabel(tab: CategoryTab): string {
  switch (tab) {
    case "live":
      return t("discovery.category.tabLive");
    case "videos":
      return t("fuChannel.category.tabVideos");
    case "clips":
      return t("fuChannel.category.tabClips");
  }
}

export interface CategoryPageProps {
  category: Category;
  live: Page<StreamCard>;
  tab: CategoryTab;
  clipFilter: ClipFilter;
  onTabChange: (tab: CategoryTab) => void;
  onClipFilterChange: (filter: ClipFilter) => void;
}

export function CategoryPage({
  category,
  live,
  tab,
  clipFilter,
  onTabChange,
  onClipFilterChange,
}: CategoryPageProps): React.JSX.Element {
  const { locale } = useLocale();
  const panel = (id: CategoryTab): React.ReactNode => {
    if (id !== tab) return null;
    switch (id) {
      case "live":
        return (
          <LiveView
            initial={live}
            category={category.slug}
            empty={
              <EmptyState
                icon={LiveStreaming02Icon}
                title={t("discovery.category.noneLive", { category: category.name })}
                description={t("discovery.category.noneLiveHint")}
                action={
                  <Button variant="outline" nativeButton={false} render={<Link to="/directory" />}>
                    {t("discovery.category.browseOthers")}
                  </Button>
                }
              />
            }
          />
        );
      case "videos":
        return <CategoryVideos category={category} />;
      case "clips":
        return <CategoryClips category={category} filter={clipFilter} onFilterChange={onClipFilterChange} />;
    }
  };
  return (
    <PageContainer
      width="wide"
      data-testid="category-page"
      data-category={category.slug}
      data-tab={tab}
      className="flex flex-col gap-6 py-6"
    >
      <header className="flex min-w-0 gap-4">
        <span className="block aspect-3/4 w-20 shrink-0 overflow-hidden bg-muted sm:w-28">
          <CategoryArt slug={category.slug} imageUrl={category.boxArtUrl} iconSize="lg" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h1 dir="auto" className="text-2xl font-semibold tracking-tight break-words">
            {category.name}
          </h1>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span data-testid="category-live-count" data-count={category.liveChannels}>
              {liveLabel(formatCompactNumber(category.liveChannels, locale), category.liveChannels)}
            </span>
            {category.liveChannels > 0 ? (
              <ViewerCount
                data-testid="category-viewer-count"
                data-count={category.viewerCount}
                count={category.viewerCount}
                label={viewerLabel}
              />
            ) : null}
          </p>
          {category.tags.length > 0 ? (
            <ul
              data-testid="category-tags"
              aria-label={t("fuChannel.category.tags", { category: category.name })}
              className="flex min-w-0 flex-wrap items-center gap-1"
            >
              {category.tags.map((tag) => (
                <li key={tag} className="min-w-0">
                  <Link
                    {...tagLink(tag)}
                    data-testid="category-tag"
                    data-tag={tag}
                    aria-label={t("discovery.card.tag", { tag })}
                    className="block max-w-full truncate border border-border px-1.5 py-0.5 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span dir="auto">{tag}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </header>
      <PageTabs
        aria-label={t("discovery.category.tabs")}
        value={tab}
        onValueChange={(next) => {
          if (isCategoryTab(next) && next !== tab) onTabChange(next);
        }}
        items={CATEGORY_TABS.map((id) => ({
          id,
          label: tabLabel(id),
          "data-testid": `category-tab-${id}`,
          content: <div className="pt-4">{panel(id)}</div>,
        }))}
      />
    </PageContainer>
  );
}

function CategoryVideos({ category }: { category: Category }): React.JSX.Element {
  const list = useCategoryVods(category.slug);
  return (
    <VideoGrid
      kind="vods"
      tiles={vodTiles(list.items)}
      list={list}
      showChannel
      empty={
        <EmptyState
          data-testid="category-media-empty"
          data-kind="vods"
          icon={Video01Icon}
          title={t("fuChannel.category.videosEmpty", { category: category.name })}
          description={t("fuChannel.category.videosEmptyHint")}
        />
      }
    />
  );
}

function CategoryClips({
  category,
  filter,
  onFilterChange,
}: {
  category: Category;
  filter: ClipFilter;
  onFilterChange: (filter: ClipFilter) => void;
}): React.JSX.Element {
  const list = useCategoryClips(category.slug, filter);
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <ClipFilters value={filter} onChange={onFilterChange} />
      <VideoGrid
        kind="clips"
        tiles={clipTiles(list.items)}
        list={list}
        showChannel
        empty={
          filter.range === "all" ? (
            <EmptyState
              data-testid="category-media-empty"
              data-kind="clips"
              icon={Scissor01Icon}
              title={t("fuChannel.category.clipsEmpty", { category: category.name })}
              description={t("fuChannel.category.clipsEmptyHint")}
            />
          ) : (
            <ClipsFilteredEmpty />
          )
        }
      />
    </div>
  );
}

/** The category's channels did not load (busy or unreachable API): say so, with Retry. */
export function CategoryLoadFailed(): React.JSX.Element {
  return (
    <PageContainer width="wide" className="py-6">
      <RouteSectionLoadError data-testid="category-load-error" section={t("discovery.category.tabLive")} alone />
    </PageContainer>
  );
}

/** An unknown category: D4's not-found state, pointing back to the directory. */
export function CategoryNotFound(): React.JSX.Element {
  return (
    <NotFoundState
      data-testid="category-not-found"
      icon={GridViewIcon}
      title={t("discovery.category.notFound")}
      description={t("discovery.category.notFoundHint")}
    />
  );
}
