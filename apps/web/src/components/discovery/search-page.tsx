// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `/search?q=` (F1): a debounced search box, then Channels and Categories. The count is announced
 * once per answered query, politely; an empty query asks nothing and announces nothing.
 */
import { ChannelAvatar, EmptyState, LiveBadge, ViewerCount, formatCompactNumber, useLocale } from "@commonair/ui";
import { Section } from "@commonair/ui/blocks/headers";
import { CategoryTile } from "@commonair/ui/blocks/media";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@commonair/ui/components/input-group";
import { PageContainer } from "@commonair/ui/layouts";
import { AlertCircleIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { categoryHref, categoryLink } from "../../lib/category-route.ts";
import { collidingNames, displayLabel } from "../../lib/directory-sections.ts";
import { liveLabel, tileData, viewerLabel } from "./category-tiles.tsx";
import type { SearchChannel, SearchData } from "./loaders.ts";
import { QUERY_MAX } from "./search-params.ts";
import { rememberSearch } from "./tab-storage.ts";

/** Typing pauses this long before the page searches. */
export const SEARCH_DEBOUNCE_MS = 300;

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
    <search aria-label={t("discovery.search.placeholder")}>
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
            placeholder={t("discovery.search.placeholder")}
            value={value}
            maxLength={QUERY_MAX}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
        </InputGroup>
      </form>
    </search>
  );
}

export function SearchPage({ q, results }: { q: string; results: SearchData | null }): React.JSX.Element {
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
      <SearchResults q={q} results={results} />
    </PageContainer>
  );
}

/** The two result groups and the polite count announcement. */
export function SearchResults({ q, results }: { q: string; results: SearchData | null }): React.JSX.Element {
  const total = results ? results.channels.length + results.categories.length : 0;
  const announcement = q && results ? t("discovery.search.count", { count: total, q }) : "";
  return (
    <>
      {/* Always mounted, so a screen reader hears each new count once. */}
      <p aria-live="polite" aria-atomic="true" data-testid="search-announcement" className="sr-only">
        {announcement}
      </p>
      {!q ? (
        <EmptyState icon={Search01Icon} title={t("discovery.search.prompt")} />
      ) : results === null ? (
        <EmptyState icon={AlertCircleIcon} title={t("discovery.search.failed")} />
      ) : total === 0 ? (
        <EmptyState
          data-testid="search-empty"
          icon={Search01Icon}
          title={t("discovery.search.none", { q })}
          description={t("discovery.search.noneHint")}
        />
      ) : (
        <div className="flex flex-col gap-8">
          {results.channels.length > 0 && <ChannelResults channels={results.channels} />}
          {results.categories.length > 0 && (
            <Section data-testid="search-results-categories" heading={t("discovery.search.categories")}>
              <ul className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {results.categories.map((category) => (
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
          )}
        </div>
      )}
    </>
  );
}

function ChannelResults({ channels }: { channels: SearchChannel[] }): React.JSX.Element {
  const { locale } = useLocale();
  const collisions = collidingNames(channels.map((c) => ({ id: c.slug, displayName: c.displayName })));
  return (
    <Section data-testid="search-results-channels" heading={t("discovery.search.channels")}>
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
