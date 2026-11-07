// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * First renders of the discovery pages (F1), server-side with the visitor's cookie forwarded. The
 * bodies stay inside the handlers so the compiler drops `server/env.ts` from the client bundle.
 * "Show more" pages load from the browser (`api()`), not through these.
 */
import type { Category, StreamCard } from "@commonair/contracts/dto";
import { createServerFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { serverApi } from "../../lib/api.ts";
import { loadFailureKind, retryAfterSeconds } from "../../lib/load-failure.ts";
import { loadWebEnv } from "../../server/env.ts";

/**
 * A discovery loader's answer (F2): the data, or that the API did not answer it (busy, down, or
 * broken), so the page shows the section that did not load with a Retry instead of hiding it or
 * claiming there is nothing.
 */
export type LoaderResult<T> = { status: "ok"; data: T } | { status: "failed"; retryAfterSeconds: number | null };

export function loaderOk<T>(data: T): LoaderResult<T> {
  return { status: "ok", data };
}

/** A failed load as a result, with the server's retry hint when it gave one. */
export function loaderFailed(err: unknown): { status: "failed"; retryAfterSeconds: number | null } {
  return { status: "failed", retryAfterSeconds: retryAfterSeconds(err) };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Categories per directory page; the seed has 15+, so the first page holds every live one. */
export const CATEGORY_PAGE = 48;
/**
 * Live channels loaded with the directory: enough that the tag filter's options are usually
 * complete (category totals and tags come from the API).
 */
export const DIRECTORY_LIVE_PAGE = 100;
/** Live channels per page on a category page and the Live channels view. */
export const LIVE_PAGE = 24;

export interface DirectoryPageData {
  categories: Page<Category>;
  /** Every live channel, unfiltered: the category totals and the tag filter's options. */
  live: Page<StreamCard>;
  /** With `?tag=`, the live channels carrying it (the Live channels view); otherwise absent. */
  tagged?: Page<StreamCard>;
}

export interface SearchData {
  channels: SearchChannel[];
  categories: Category[];
}

export type SearchChannel = {
  slug: string;
  displayName: string;
  avatarUrl: string | null;
  live: StreamCard["broadcast"] | null;
  followerCount: number;
};

export interface CategoryPageData {
  category: Category;
  live: Page<StreamCard>;
}

const cookieHeaders = (cookie: string | undefined): Record<string, string> => (cookie ? { cookie } : {});

const TEXT = (value: unknown, max = 80): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text.slice(0, max);
};

/** `/directory`: the category grid and the live channels (optionally one tag). */
export const getDirectoryPage = createServerFn({ method: "GET" })
  .validator((input: { tag?: string }) => ({ tag: TEXT(input.tag) }))
  .handler(async ({ data }): Promise<LoaderResult<DirectoryPageData>> => {
    try {
      const api = serverApi(loadWebEnv().API_INTERNAL_URL, cookieHeaders(getRequestHeader("cookie")));
      // The tag list comes from the unfiltered page, so a picked tag does not narrow the choices.
      const [categories, live, tagged] = await Promise.all([
        api.categories.list({ limit: CATEGORY_PAGE }),
        api.directory.live({ limit: DIRECTORY_LIVE_PAGE, sort: "viewers_desc" }),
        data.tag ? api.directory.live({ limit: LIVE_PAGE, sort: "viewers_desc", tag: data.tag }) : undefined,
      ]);
      return loaderOk(tagged ? { categories, live, tagged } : { categories, live });
    } catch (err) {
      return loaderFailed(err);
    }
  });

/** The home page's Categories shelf: the busiest few. */
export const getHomeCategories = createServerFn({ method: "GET" }).handler(
  async (): Promise<LoaderResult<Category[]>> => {
    try {
      const api = serverApi(loadWebEnv().API_INTERNAL_URL, cookieHeaders(getRequestHeader("cookie")));
      return loaderOk((await api.categories.list({ limit: 8 })).items);
    } catch (err) {
      return loaderFailed(err);
    }
  },
);

/** `/directory/$category`: the category and its live channels; `undefined` when it does not exist. */
export const getCategoryPage = createServerFn({ method: "GET" })
  .validator((input: { slug: string }) => ({ slug: String(input.slug).slice(0, 80) }))
  .handler(async ({ data }): Promise<LoaderResult<CategoryPageData> | undefined> => {
    const api = serverApi(loadWebEnv().API_INTERNAL_URL, cookieHeaders(getRequestHeader("cookie")));
    try {
      const [category, live] = await Promise.all([
        api.categories.get({ slug: data.slug }),
        api.directory.live({ category: data.slug, limit: LIVE_PAGE, sort: "viewers_desc" }),
      ]);
      return loaderOk({ category, live });
    } catch (err) {
      if (loadFailureKind(err) === "notFound") return undefined;
      return loaderFailed(err);
    }
  });

/** `/search?q=`: channels and categories. An empty query asks nothing. */
export const getSearch = createServerFn({ method: "GET" })
  .validator((input: { q?: string }) => ({ q: TEXT(input.q) }))
  .handler(async ({ data }): Promise<LoaderResult<SearchData>> => {
    if (!data.q) return loaderOk({ channels: [], categories: [] });
    try {
      const api = serverApi(loadWebEnv().API_INTERNAL_URL, cookieHeaders(getRequestHeader("cookie")));
      return loaderOk(await api.directory.search({ q: data.q, limit: 20 }));
    } catch (err) {
      return loaderFailed(err);
    }
  });
