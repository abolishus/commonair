// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/directory/$category` (F1, overhaul D3.2): the category's art, name, live channels, verified
 * viewers, videos and the tags its live channels carry, then four tabs. Overview (the bare URL)
 * leads with who is live, then who streamed it recently, the latest videos and the top clips, and
 * ends with who is live elsewhere, so no category is a dead end. Live, Videos
 * (`vods.listByCategory`) and Clips (`clips.listByCategory`, with the sort and range control) are
 * the full lists. The tab is the URL's `?tab=`, as on the channel page, so each is a link and Back
 * steps through them; only the active panel mounts, so Videos and Clips ask for their first page
 * when opened.
 */
import type { Category, ChannelCard, StreamCard } from "@commonair/contracts/dto";
import {
  ChannelChip,
  ChannelChipRow,
  EmptyState,
  formatCompactNumber,
  RelativeTime,
  useLocale,
  ViewerCount,
} from "@commonair/ui";
import { PageTabs, Section } from "@commonair/ui/blocks/headers";
import { CategoryArt } from "@commonair/ui/blocks/media";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import { GridViewIcon, LiveStreaming02Icon, Scissor01Icon, Video01Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { RouteSectionLoadError } from "../../lib/section-load-error.tsx";
import { tagLink } from "../../lib/category-route.ts";
import { collidingNames } from "../../lib/directory-sections.ts";
import { OVERVIEW_SHELF, START_LIVE, type CategoryOverview } from "../../lib/directory.ts";
import {
  ClipFilters,
  clipFilterSearch,
  parseClipFilter,
  type ClipFilter,
  type ClipFilterSearch,
} from "../channel/clip-filters.tsx";
import { useCategoryClips, useCategoryVods } from "../channel/use-media-list.ts";
import { ClipsFilteredEmpty, clipTiles, VideoGrid, VideoTileList, vodTiles } from "../channel/video-grid.tsx";
import { NotFoundState } from "../not-found.tsx";
import { liveLabel, viewerLabel } from "./category-tiles.tsx";
import { LiveView } from "./directory-page.tsx";
import type { Page } from "./loaders.ts";
import { DiscoveryStreamGrid } from "./stream-cards.tsx";

export const CATEGORY_TABS = ["overview", "live", "videos", "clips"] as const;
export type CategoryTab = (typeof CATEGORY_TABS)[number];

/** `/directory/$category`'s search params: Overview is the bare URL; Clips adds its sort and range. */
export interface CategorySearch extends ClipFilterSearch {
  tab?: Exclude<CategoryTab, "overview">;
}

/** The route's `validateSearch`: anything unknown is the Overview, so a bad link never errors. */
export function parseCategorySearch(search: Record<string, unknown>): CategorySearch {
  if (search.tab === "clips") return { tab: "clips", ...parseClipFilter(search) };
  if (search.tab === "live" || search.tab === "videos") return { tab: search.tab };
  return {};
}

export function isCategoryTab(value: unknown): value is CategoryTab {
  return (CATEGORY_TABS as readonly unknown[]).includes(value);
}

export function categoryTabSearch(tab: CategoryTab, filter?: ClipFilter): CategorySearch {
  if (tab === "overview") return {};
  if (tab === "clips") return { tab, ...(filter ? clipFilterSearch(filter) : {}) };
  return { tab };
}

function tabLabel(tab: CategoryTab): string {
  switch (tab) {
    case "overview":
      return t("d3Browse.category.tabOverview");
    case "live":
      return t("discovery.category.tabLive");
    case "videos":
      return t("fuChannel.category.tabVideos");
    case "clips":
      return t("fuChannel.category.tabClips");
  }
}

/** "12 videos", compact in the locale. */
export function videoCountLabel(count: number, locale: string): string {
  return t("d3Browse.category.videoCount", { count, formatted: formatCompactNumber(count, locale) });
}

export interface CategoryPageProps {
  category: Category;
  live: Page<StreamCard>;
  /** The Overview's shelves (from the route loader). */
  overview: CategoryOverview;
  tab: CategoryTab;
  clipFilter: ClipFilter;
  onTabChange: (tab: CategoryTab) => void;
  onClipFilterChange: (filter: ClipFilter) => void;
}

export function CategoryPage({
  category,
  live,
  overview,
  tab,
  clipFilter,
  onTabChange,
  onClipFilterChange,
}: CategoryPageProps): React.JSX.Element {
  const { locale } = useLocale();
  const idle = category.liveChannels === 0;
  const panel = (id: CategoryTab): React.ReactNode => {
    if (id !== tab) return null;
    switch (id) {
      case "overview":
        return <OverviewPanel category={category} live={live} overview={overview} />;
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
          <CategoryArt slug={category.slug} imageUrl={category.boxArtUrl} iconSize="lg" muted={idle} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <h1 dir="auto" className="text-2xl font-semibold tracking-tight break-words">
            {category.name}
          </h1>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {/* No "0 live": an idle category leads with its videos instead. */}
            {idle ? null : (
              <>
                <span data-testid="category-live-count" data-count={category.liveChannels}>
                  {liveLabel(formatCompactNumber(category.liveChannels, locale), category.liveChannels)}
                </span>
                <ViewerCount
                  data-testid="category-viewer-count"
                  data-count={category.viewerCount}
                  count={category.viewerCount}
                  label={viewerLabel}
                />
              </>
            )}
            {category.videoCount > 0 ? (
              <span data-testid="category-video-count" data-count={category.videoCount}>
                {videoCountLabel(category.videoCount, locale)}
              </span>
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

/** A shelf's "View all": a link to the tab with the full list. */
function ViewAll({ slug, tab, label }: { slug: string; tab: CategoryTab; label?: string }): React.JSX.Element {
  return (
    <Button
      data-testid={`category-view-all-${tab}`}
      variant="ghost"
      size="sm"
      nativeButton={false}
      render={<Link to="/directory/$category" params={{ category: slug }} search={categoryTabSearch(tab)} />}
    >
      {label ?? t("d3Browse.category.viewAll")}
    </Button>
  );
}

/** "Recently live" as one compact chip per channel: the name, then when it was last live. */
export function RecentChannelChips({ cards }: { cards: readonly ChannelCard[] }): React.JSX.Element {
  return (
    <ChannelChipRow data-testid="category-recent">
      {cards.map((card) => (
        <ChannelChip
          key={card.channel.id}
          data-testid="category-recent-chip"
          data-channel={card.channel.slug}
          name={card.channel.displayName}
          href={`/${card.channel.slug}`}
          render={<Link to="/$channel" params={{ channel: card.channel.slug }} />}
          avatarSrc={card.channel.avatarUrl}
          accent={card.channel.accent}
          meta={
            card.lastLiveAt ? <RelativeTime date={card.lastLiveAt} tooltip={false} /> : t("d3Browse.category.neverLive")
          }
        />
      ))}
    </ChannelChipRow>
  );
}

/**
 * The Overview (D3.2): live, then recently live, videos and clips, then live elsewhere. Nobody live
 * is one line above the rest, not a dead end; a shelf that did not load says so with Retry; only a
 * category with nothing at all gets the full empty state, and "Live now elsewhere" still follows.
 */
export function OverviewPanel({
  category,
  live,
  overview,
}: {
  category: Category;
  live: Page<StreamCard>;
  overview: CategoryOverview;
}): React.JSX.Element {
  const liveCards = React.useMemo(() => live.items.slice(0, OVERVIEW_SHELF), [live.items]);
  const recent = overview.recentlyLive ?? [];
  const videos = overview.videos ? vodTiles(overview.videos).slice(0, OVERVIEW_SHELF) : null;
  const clips = overview.clips ? clipTiles(overview.clips).slice(0, OVERVIEW_SHELF) : null;
  const elsewhere = React.useMemo(
    () =>
      (overview.elsewhere ?? []).filter((card) => card.broadcast.category?.slug !== category.slug).slice(0, START_LIVE),
    [overview.elsewhere, category.slug],
  );
  const collisions = React.useMemo(
    () => collidingNames([...liveCards, ...elsewhere].map((c) => c.channel)),
    [liveCards, elsewhere],
  );
  const nothing =
    liveCards.length === 0 && overview.recentlyLive?.length === 0 && videos?.length === 0 && clips?.length === 0;
  const recentHeading = t("d3Browse.category.recentlyLive", { category: category.name });
  return (
    <div data-testid="category-overview" className="flex min-w-0 flex-col gap-8">
      {nothing ? (
        <EmptyState
          data-testid="category-overview-empty"
          icon={GridViewIcon}
          title={t("d3Browse.category.empty", { category: category.name })}
          description={t("d3Browse.category.emptyHint")}
          action={
            <Button variant="outline" nativeButton={false} render={<Link to="/directory" />}>
              {t("discovery.category.browseOthers")}
            </Button>
          }
        />
      ) : (
        <>
          <Section
            data-testid="category-overview-live"
            heading={t("d3Browse.category.liveNow", { category: category.name })}
            action={
              live.items.length > liveCards.length || live.nextCursor ? (
                <ViewAll slug={category.slug} tab="live" label={t("d3Browse.category.viewAllLive")} />
              ) : undefined
            }
          >
            {liveCards.length > 0 ? (
              <DiscoveryStreamGrid cards={liveCards} collisions={collisions} showReason={false} dense />
            ) : (
              <p data-testid="category-none-live" className="text-sm text-muted-foreground">
                {recent.length > 0
                  ? t("d3Browse.category.noneLiveRecent", { category: category.name })
                  : t("d3Browse.category.noneLive", { category: category.name })}
              </p>
            )}
          </Section>
          {overview.recentlyLive === null ? (
            <RouteSectionLoadError data-testid="category-recent-error" section={recentHeading} />
          ) : recent.length > 0 ? (
            <Section data-testid="category-overview-recent" heading={recentHeading}>
              <RecentChannelChips cards={recent} />
            </Section>
          ) : null}
          {videos === null ? (
            <RouteSectionLoadError data-testid="category-videos-error" section={t("d3Browse.category.videos")} />
          ) : videos.length > 0 ? (
            <Section
              data-testid="category-overview-videos"
              heading={t("d3Browse.category.videos")}
              action={<ViewAll slug={category.slug} tab="videos" />}
            >
              <VideoTileList tiles={videos} showChannel />
            </Section>
          ) : null}
          {clips === null ? (
            <RouteSectionLoadError data-testid="category-clips-error" section={t("d3Browse.category.clips")} />
          ) : clips.length > 0 ? (
            <Section
              data-testid="category-overview-clips"
              heading={t("d3Browse.category.clips")}
              action={<ViewAll slug={category.slug} tab="clips" />}
            >
              <VideoTileList tiles={clips} showChannel />
            </Section>
          ) : null}
        </>
      )}
      {elsewhere.length > 0 ? (
        <Section data-testid="category-overview-elsewhere" heading={t("d3Browse.category.elsewhere")}>
          <DiscoveryStreamGrid cards={elsewhere} collisions={collisions} showReason={false} dense />
        </Section>
      ) : null}
    </div>
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
