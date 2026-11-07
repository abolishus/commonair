// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";
import { withBackoff } from "../../lib/retry.ts";
import { type RetryStatus, useRetryingLoad } from "../../lib/retrying-load.ts";

/**
 * A load and how it is retrying: `reload` loads again (after an action, or Retry), the current
 * data staying until the answer arrives; `retryInMs` and `gaveUp` are what a `SectionLoadError`
 * says next to its Retry.
 */
export interface Loaded<T> extends RetryStatus {
  /** null until the first successful load for the current key. */
  data: T | null;
}

/**
 * Loads `load()` whenever `key` changes, client-side, through `useRetryingLoad`: a busy or
 * unreachable API retries by itself with backoff (F2). An answer for an older key or an older
 * request is dropped, so a slow response cannot overwrite a newer one.
 */
export function useLoad<T>(key: string, load: () => Promise<T>): Loaded<T> {
  return useRetryingLoad(key, load);
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Paged<T> {
  /** null until the first page for the current key arrives. */
  items: T[] | null;
  failed: boolean;
  /** How the first page is retrying, for the section's `SectionLoadError`. */
  first: RetryStatus;
  hasMore: boolean;
  loadingMore: boolean;
  /** Appends the next page (retrying a busy API by itself); a failure is reported through `onMoreError`. */
  loadMore: () => void;
  /** Loads the first page again (after an action); the current rows stay until it arrives. */
  reload: () => void;
}

/**
 * A cursor-paged list for `key`: the first page through `useLoad`, then "load more" appends pages.
 * A page for an older key (or from before a reload) is dropped.
 */
export function usePaged<T>(
  key: string,
  load: (cursor: string | undefined) => Promise<Page<T>>,
  onMoreError: (err: unknown) => void,
): Paged<T> {
  const first = useLoad(key, () => load(undefined));
  const [more, setMore] = React.useState<{ base: Page<T> | null; items: T[]; cursor: string | null }>({
    base: null,
    items: [],
    cursor: null,
  });
  const [loadingMore, setLoadingMore] = React.useState(false);
  // Extra pages belong to the first page they were loaded after; a new first page drops them.
  const extra =
    more.base === first.data ? more : { base: first.data, items: [], cursor: first.data?.nextCursor ?? null };
  const loadRef = React.useRef(load);
  React.useEffect(() => {
    loadRef.current = load;
  });

  const loadMore = () => {
    const cursor = extra.cursor;
    const base = first.data;
    if (!cursor || !base || loadingMore) return;
    setLoadingMore(true);
    // A busy or unreachable API gets the same automatic retries as the first page.
    withBackoff(() => loadRef.current(cursor))
      .then((page) =>
        setMore((prev) => {
          const current = prev.base === base ? prev : { base, items: [], cursor };
          return { base, items: [...current.items, ...page.items], cursor: page.nextCursor };
        }),
      )
      .catch(onMoreError)
      .finally(() => setLoadingMore(false));
  };

  return {
    items: first.data ? [...first.data.items, ...extra.items] : null,
    failed: first.failed,
    first,
    hasMore: extra.cursor !== null,
    loadingMore,
    loadMore,
    reload: first.reload,
  };
}
