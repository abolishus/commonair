// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Server-rendered first loads of the browse pages: the home directory, the category page with its
 * Overview (D3.2) and search v2 with its empty-query page (D3.4). Each handler forwards the
 * visitor's cookie; the bodies stay inside the handlers so the compiler drops `server/env.ts` from
 * the client bundle.
 */
import type { Category, ChannelCard, ClipCard, StreamCard, VodCard } from "@commonair/contracts/dto";
import type { VodItem, ClipItem } from "../components/channel/channel-data.ts";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import {
  LIVE_PAGE,
  loaderFailed,
  loaderOk,
  type LoaderResult,
  type Page,
  type SearchChannel,
} from "../components/discovery/loaders.ts";
import { loadDirectory } from "../server/directory.ts";
import { loadWebEnv } from "../server/env.ts";
import { serverApi } from "./api.ts";
import { loadFailureKind } from "./load-failure.ts";

/** Front-page directory, server-rendered and refetched on every navigation to `/`. */
export const getDirectory = createServerFn({ method: "GET" }).handler(() => loadDirectory(getRequestHeader("cookie")));

/** How many items each Overview shelf shows. */
export const OVERVIEW_SHELF = 6;
/** Channels on the Overview's "Recently live" row. */
export const OVERVIEW_RECENT = 12;
/** Live channels the empty search page and "Live now elsewhere" load. */
export const START_LIVE = 8;
/** Categories the empty search page shows. */
export const START_CATEGORIES = 12;
/** Results per group on the search page. */
export const SEARCH_LIMIT = 20;

/**
 * The Overview's shelves beyond the live channels. Each is null when it did not load, so the page
 * names the shelf that failed (with Retry) and keeps the rest.
 */
export interface CategoryOverview {
  recentlyLive: ChannelCard[] | null;
  videos: VodItem[] | null;
  clips: ClipItem[] | null;
  /** Live channels anywhere, for "Live now elsewhere" (this category's are dropped on the page). */
  elsewhere: StreamCard[] | null;
}

export interface CategoryPageV2Data {
  category: Category;
  live: Page<StreamCard>;
  overview: CategoryOverview;
}

const cookieHeaders = (cookie: string | undefined): Record<string, string> => (cookie ? { cookie } : {});

/** A settled shelf's value, or null when it failed. */
export function settledOrNull<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === "fulfilled" ? result.value : null;
}

/** `/directory/$category`: the category, its live channels and the Overview; `undefined` when it does not exist. */
export const getCategoryOverviewPage = createServerFn({ method: "GET" })
  .validator((input: { slug: string }) => ({ slug: String(input.slug).slice(0, 80) }))
  .handler(async ({ data }): Promise<LoaderResult<CategoryPageV2Data> | undefined> => {
    const api = serverApi(loadWebEnv().API_INTERNAL_URL, cookieHeaders(getRequestHeader("cookie")));
    const slug = data.slug;
    const shelves = Promise.allSettled([
      api.categories.recentlyLive({ slug, limit: OVERVIEW_RECENT }),
      api.vods.listByCategory({ slug, limit: OVERVIEW_SHELF }),
      api.clips.listByCategory({ slug, limit: OVERVIEW_SHELF, sort: "top", range: "all" }),
      api.directory.live({ limit: START_LIVE + OVERVIEW_SHELF, sort: "viewers_desc" }),
    ]);
    try {
      const [category, live] = await Promise.all([
        api.categories.get({ slug }),
        api.directory.live({ category: slug, limit: LIVE_PAGE, sort: "viewers_desc" }),
      ]);
      const [recentlyLive, videos, clips, elsewhere] = await shelves;
      return loaderOk({
        category,
        live,
        overview: {
          recentlyLive: settledOrNull(recentlyLive),
          videos: settledOrNull(videos)?.items ?? null,
          clips: settledOrNull(clips)?.items ?? null,
          elsewhere: settledOrNull(elsewhere)?.items ?? null,
        },
      });
    } catch (err) {
      // Let the shelves settle so none rejects unhandled.
      await shelves;
      if (loadFailureKind(err) === "notFound") return undefined;
      return loaderFailed(err);
    }
  });

/** `directory.search`'s answer. */
export interface SearchResultsData {
  channels: SearchChannel[];
  categories: Category[];
  videos: VodCard[];
  clips: ClipCard[];
}

/** What `/search` shows before anything is typed: popular categories and who is live. */
export interface SearchStartData {
  categories: Category[];
  live: StreamCard[];
}

export type SearchPageData =
  | { kind: "results"; results: SearchResultsData }
  | { kind: "start"; start: SearchStartData };

const queryText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text.slice(0, 80);
};

/** `/search?q=`: the results; with no query, the start page's categories and live channels. */
export const getSearchPage = createServerFn({ method: "GET" })
  .validator((input: { q?: string }) => ({ q: queryText(input.q) }))
  .handler(async ({ data }): Promise<LoaderResult<SearchPageData>> => {
    try {
      const api = serverApi(loadWebEnv().API_INTERNAL_URL, cookieHeaders(getRequestHeader("cookie")));
      if (data.q)
        return loaderOk({ kind: "results", results: await api.directory.search({ q: data.q, limit: SEARCH_LIMIT }) });
      const [categories, live] = await Promise.all([
        api.categories.list({ limit: START_CATEGORIES }),
        api.directory.live({ limit: START_LIVE, sort: "viewers_desc" }),
      ]);
      return loaderOk({ kind: "start", start: { categories: categories.items, live: live.items } });
    } catch (err) {
      return loaderFailed(err);
    }
  });
