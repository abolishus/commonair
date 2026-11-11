// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/search?q=` (F1, overhaul D3.4): a debounced search box, then the channels (live ones first,
 * as the API ranks them), the live ones again as stream cards, videos, clips and categories. The
 * count is announced once per answered query, politely. An empty query gets a page of its own: this tab's recent searches, who
 * is live now and the popular categories.
 */
import type { Category, StreamCard } from "@commonair/contracts/dto";
import { ChannelAvatar, EmptyState, LiveBadge, ViewerCount, formatCompactNumber, useLocale } from "@commonair/ui";
import { Section } from "@commonair/ui/blocks/headers";
import { CategoryTile } from "@commonair/ui/blocks/media";
import { Button } from "@commonair/ui/components/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@commonair/ui/components/input-group";
import { PageContainer } from "@commonair/ui/layouts";
import { Clock01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { RouteSectionLoadError } from "../../lib/section-load-error.tsx";
import { categoryHref, categoryLink } from "../../lib/category-route.ts";
import { collidingNames, displayLabel, sortCategories } from "../../lib/directory-sections.ts";
import type { SearchPageData, SearchResultsData, SearchStartData } from "../../lib/directory.ts";
import { trackUi } from "../../lib/ui-metrics.ts";
import { clipTiles, VideoTileList, vodTiles } from "../channel/video-grid.tsx";
import { liveLabel, tileData, viewerLabel } from "./category-tiles.tsx";
import type { SearchChannel } from "./loaders.ts";
import { QUERY_MAX } from "./search-params.ts";
import { DiscoveryStreamGrid } from "./stream-cards.tsx";
import { readRecentSearches, rememberSearch } from "./tab-storage.ts";

/** Typing pauses this long before the page searches. */
export const SEARCH_DEBOUNCE_MS = 300;
/** Videos and clips shown per group (the API answers up to 20). */
export const SEARCH_MEDIA = 6;
/** Live channels on the empty-query page. */
export const START_LIVE_SHOWN = 6;

/** `value`, once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export interface SearchBoxProps {
  /** The query the page shows results for (from the URL). */
  q: string;
  /** Called with the trimmed query once typing settles; never with a query equal to `q`. */
  onSearch: (q: string) => void;
}

/** The page's search field: debounced, and an empty query does nothing. */
export function SearchBox({ q, onSearch }: SearchBoxProps): React.JSX.Element {
  const [value, setValue] = React.useState(q);
  const settled = useDebounced(value, SEARCH_DEBOUNCE_MS);
  // The URL changed from elsewhere (the header, back/forward): show it.
  const last = React.useRef(q);
  React.useEffect(() => {
    if (q !== last.current) {
      last.current = q;
      setValue(q);
    }
  }, [q]);
  React.useEffect(() => {
    const next = settled.trim();
    if (next === "" || next === last.current) return;
    last.current = next;
    onSearch(next);
  }, [settled, onSearch]);
  return (
    <search aria-label={t("d3Browse.search.placeholder")}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const next = value.trim();
          if (next === "" || next === last.current) return;
          last.current = next;
          onSearch(next);
        }}
      >
        <InputGroup className="max-w-xl">
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            data-testid="search-input"
            aria-label={t("discovery.search.label")}
            placeholder={t("d3Browse.search.placeholder")}
            value={value}
            maxLength={QUERY_MAX}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
        </InputGroup>
      </form>
    </search>
  );
}

export function SearchPage({ q, data }: { q: string; data: SearchPageData | null }): React.JSX.Element {
  const navigate = useNavigate();
  const onSearch = React.useCallback(
    (next: string) => {
      rememberSearch(next);
      void navigate({ to: "/search", search: { q: next }, replace: true });
    },
    [navigate],
  );
  return (
    <PageContainer width="wide" data-testid="search-page" className="flex flex-col gap-6 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        {q ? t("discovery.search.titleFor", { q }) : t("discovery.search.title")}
      </h1>
      <SearchBox q={q} onSearch={onSearch} />
      {q ? (
        <SearchResults q={q} results={data?.kind === "results" ? data.results : null} />
      ) : (
        <SearchStart start={data?.kind === "start" ? data.start : null} />
      )}
    </PageContainer>
  );
}

/**
 * A live search match as a stream card. The search answer carries no channel id, accent or tags,
 * so the card keys on the slug and uses the neutral accent.
 */
export function liveCardOf(channel: SearchChannel & { live: NonNullable<SearchChannel["live"]> }): StreamCard {
  return {
    channel: {
      id: `search:${channel.slug}`,
      slug: channel.slug,
      displayName: channel.displayName,
      avatarUrl: channel.avatarUrl,
      accent: "zinc",
    },
    broadcast: channel.live,
    tags: [],
    language: "",
    reason: "popular",
  };
}

/** The live matches again as stream cards, so what is on now is one click from the preview. */
function LiveResults({ channels }: { channels: SearchChannel[] }): React.JSX.Element {
  const cards = React.useMemo(
    () => channels.flatMap((c) => (c.live ? [liveCardOf({ ...c, live: c.live })] : [])),
    [channels],
  );
  const collisions = React.useMemo(() => collidingNames(cards.map((c) => c.channel)), [cards]);
  return (
    <Section data-testid="search-results-live" heading={t("d3Browse.search.live")}>
      <DiscoveryStreamGrid cards={cards} collisions={collisions} showReason={false} dense />
    </Section>
  );
}

/** Every result the page shows, for the announcement (a live channel counts once). */
export function resultCount(results: SearchResultsData): number {
  return (
    results.channels.length +
    vodTiles(results.videos).slice(0, SEARCH_MEDIA).length +
    clipTiles(results.clips).slice(0, SEARCH_MEDIA).length +
    results.categories.length
  );
}

/** The result groups (live channels first, as the API ranks them) and the polite count announcement. */
export function SearchResults({ q, results }: { q: string; results: SearchResultsData | null }): React.JSX.Element {
  const total = results ? resultCount(results) : 0;
  const announcement = q && results ? t("discovery.search.count", { count: total, q }) : "";
  const live = results?.channels.filter((c) => c.live !== null) ?? [];
  const videos = results ? vodTiles(results.videos).slice(0, SEARCH_MEDIA) : [];
  const clips = results ? clipTiles(results.clips).slice(0, SEARCH_MEDIA) : [];
  return (
    <>
      {/* Always mounted, so a screen reader hears each new count once. */}
      <p aria-live="polite" aria-atomic="true" data-testid="search-announcement" className="sr-only">
        {announcement}
      </p>
      {!q ? null : results === null ? (
        <RouteSectionLoadError data-testid="search-load-error" section={t("discovery.search.title")} alone />
      ) : total === 0 ? (
        <EmptyState
          data-testid="search-empty"
          icon={Search01Icon}
          title={t("discovery.search.none", { q })}
          description={t("discovery.search.noneHint")}
          action={
            <Button variant="outline" nativeButton={false} render={<Link to="/directory" />}>
              {t("d3Browse.search.browseCategories")}
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-8">
          {results.channels.length > 0 && (
            <ChannelResults
              testId="search-results-channels"
              heading={t("discovery.search.channels")}
              channels={results.channels}
            />
          )}
          {live.length > 0 && <LiveResults channels={live} />}
          {videos.length > 0 && (
            <Section data-testid="search-results-videos" heading={t("d3Browse.search.videos")}>
              <VideoTileList tiles={videos} showChannel />
            </Section>
          )}
          {clips.length > 0 && (
            <Section data-testid="search-results-clips" heading={t("d3Browse.search.clips")}>
              <VideoTileList tiles={clips} showChannel />
            </Section>
          )}
          {results.categories.length > 0 && (
            <CategoryChips
              testId="search-results-categories"
              heading={t("discovery.search.categories")}
              categories={results.categories}
            />
          )}
        </div>
      )}
    </>
  );
}

/** Recent searches from this tab only, read after hydration (the server has none). */
function useRecentSearches(): string[] {
  // A string snapshot, so it compares by value; the server snapshot is empty.
  const joined = React.useSyncExternalStore(
    noSubscription,
    () => JSON.stringify(readRecentSearches()),
    () => "[]",
  );
  return React.useMemo(() => JSON.parse(joined) as string[], [joined]);
}

/** Recent searches change only from this tab's own navigation, which re-renders the page. */
const noSubscription = (): (() => void) => () => {};

/**
 * `/search` with nothing typed: a prompt, this tab's recent searches, who is live now and the
 * popular categories (busiest first), so the page is never blank. Counted once per load.
 */
export function SearchStart({ start }: { start: SearchStartData | null }): React.JSX.Element {
  const recent = useRecentSearches();
  React.useEffect(() => trackUi("search.empty", "view"), []);
  const live = React.useMemo(() => start?.live.slice(0, START_LIVE_SHOWN) ?? [], [start]);
  const categories = React.useMemo(() => (start ? sortCategories(start.categories) : []), [start]);
  return (
    <div data-testid="search-start" className="flex flex-col gap-8">
      <EmptyState
        size="sm"
        icon={Search01Icon}
        title={t("d3Browse.search.emptyTitle")}
        description={t("discovery.search.prompt")}
      />
      {recent.length > 0 && (
        <Section data-testid="search-recent" heading={t("d3Browse.search.recent")}>
          <ul className="flex min-w-0 flex-wrap gap-2">
            {recent.map((query) => (
              <li key={query} className="min-w-0">
                <Link
                  to="/search"
                  search={{ q: query }}
                  data-testid="search-recent-query"
                  className="inline-flex min-h-11 max-w-full items-center gap-2 px-3 text-sm ring-1 ring-border outline-none ring-inset hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <HugeiconsIcon icon={Clock01Icon} aria-hidden="true" className="size-4 shrink-0" />
                  <span dir="auto" className="truncate">
                    {query}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {start === null ? (
        <RouteSectionLoadError data-testid="search-start-error" section={t("d3Browse.search.liveNow")} />
      ) : (
        <>
          {live.length > 0 && <StartLive cards={live} />}
          {categories.length > 0 && (
            <CategoryChips
              testId="search-popular-categories"
              heading={t("d3Browse.search.popularCategories")}
              categories={categories}
            />
          )}
        </>
      )}
    </div>
  );
}

function StartLive({ cards }: { cards: StreamCard[] }): React.JSX.Element {
  const collisions = React.useMemo(() => collidingNames(cards.map((c) => c.channel)), [cards]);
  return (
    <Section data-testid="search-start-live" heading={t("d3Browse.search.liveNow")}>
      <DiscoveryStreamGrid cards={cards} collisions={collisions} showReason={false} dense />
    </Section>
  );
}

function CategoryChips({
  testId,
  heading,
  categories,
}: {
  testId: string;
  heading: string;
  categories: readonly Category[];
}): React.JSX.Element {
  return (
    <Section data-testid={testId} heading={heading}>
      <ul className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map((category) => (
          <li key={category.id} className="min-w-0">
            <CategoryTile
              layout="chip"
              size="sm"
              category={tileData(category)}
              href={categoryHref(category.slug)}
              render={<Link {...categoryLink(category.slug)} />}
              liveLabel={liveLabel}
              viewerLabel={viewerLabel}
              data-testid="search-category"
              data-category={category.slug}
            />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function ChannelResults({
  testId,
  heading,
  channels,
}: {
  testId: string;
  heading: string;
  channels: SearchChannel[];
}): React.JSX.Element {
  const { locale } = useLocale();
  const collisions = collidingNames(channels.map((c) => ({ id: c.slug, displayName: c.displayName })));
  return (
    <Section data-testid={testId} heading={heading}>
      <ul className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {channels.map((channel) => (
          <li key={channel.slug} className="min-w-0">
            <Link
              to="/$channel"
              params={{ channel: channel.slug }}
              data-testid="search-channel"
              data-channel={channel.slug}
              className="flex min-w-0 items-center gap-3 rounded-none p-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChannelAvatar
                name={channel.displayName}
                src={channel.avatarUrl}
                live={channel.live !== null}
                size="md"
                decorative
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span dir="auto" className="truncate text-sm font-medium">
                  {displayLabel(collisions, channel)}
                </span>
                {channel.live?.title ? (
                  <span dir="auto" className="truncate text-xs text-muted-foreground">
                    {channel.live.title}
                  </span>
                ) : null}
                <span className="truncate text-xs text-muted-foreground">
                  {channel.live?.category?.name ??
                    t("discovery.search.followers", {
                      count: channel.followerCount,
                      formatted: formatCompactNumber(channel.followerCount, locale),
                    })}
                </span>
              </span>
              {channel.live && (
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  <LiveBadge size="sm" />
                  <ViewerCount count={channel.live.viewerCount} size="sm" />
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}
