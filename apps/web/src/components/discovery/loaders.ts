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
import { errorCode, serverApi } from "../../lib/api.ts";
import { loadWebEnv } from "../../server/env.ts";

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Categories per directory page; the seed has 15+, so the first page holds every live one. */
export const CATEGORY_PAGE = 48;
/**
 * Live channels loaded with the directory: enough that the per-category totals and the tag list
 * are usually complete (they are shown only when they are, see `categoryStats`).
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

/** `/directory`: the category grid and the live channels (optionally one tag), or null when the API is down. */
export const getDirectoryPage = createServerFn({ method: "GET" })
  .validator((input: { tag?: string }) => ({ tag: TEXT(input.tag) }))
  .handler(async ({ data }): Promise<DirectoryPageData | null> => {
    try {
      const api = serverApi(loadWebEnv().API_INTERNAL_URL, cookieHeaders(getRequestHeader("cookie")));
      // The tag list comes from the unfiltered page, so a picked tag does not narrow the choices.
      const [categories, live, tagged] = await Promise.all([
        api.categories.list({ limit: CATEGORY_PAGE }),
        api.directory.live({ limit: DIRECTORY_LIVE_PAGE, sort: "viewers_desc" }),
        data.tag ? api.directory.live({ limit: LIVE_PAGE, sort: "viewers_desc", tag: data.tag }) : undefined,
      ]);
      return tagged ? { categories, live, tagged } : { categories, live };
    } catch {
      return null;
    }
  });

/** The home page's Categories shelf: the busiest few. Empty when the API is down (the shelf hides). */
export const getHomeCategories = createServerFn({ method: "GET" }).handler(async (): Promise<Category[]> => {
  try {
    return (
      await serverApi(loadWebEnv().API_INTERNAL_URL, cookieHeaders(getRequestHeader("cookie"))).categories.list({
        limit: 8,
      })
    ).items;
  } catch {
    return [];
  }
});

/** `/directory/$category`: the category and its live channels; `undefined` when it does not exist. */
export const getCategoryPage = createServerFn({ method: "GET" })
  .validator((input: { slug: string }) => ({ slug: String(input.slug).slice(0, 80) }))
  .handler(async ({ data }): Promise<CategoryPageData | undefined> => {
    const api = serverApi(loadWebEnv().API_INTERNAL_URL, cookieHeaders(getRequestHeader("cookie")));
    try {
      const [category, live] = await Promise.all([
        api.categories.get({ slug: data.slug }),
        api.directory.live({ category: data.slug, limit: LIVE_PAGE, sort: "viewers_desc" }),
      ]);
      return { category, live };
    } catch (err) {
      if (errorCode(err) === "NOT_FOUND") return undefined;
      throw err;
    }
  });

/** `/search?q=`: channels and categories. An empty query asks nothing. Null when the API is down. */
export const getSearch = createServerFn({ method: "GET" })
  .validator((input: { q?: string }) => ({ q: TEXT(input.q) }))
  .handler(async ({ data }): Promise<SearchData | null> => {
    if (!data.q) return { channels: [], categories: [] };
    try {
      return await serverApi(loadWebEnv().API_INTERNAL_URL, cookieHeaders(getRequestHeader("cookie"))).directory.search(
        { q: data.q, limit: 20 },
      );
    } catch {
      return null;
    }
  });
