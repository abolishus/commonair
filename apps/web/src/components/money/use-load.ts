// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as React from "react";

export interface Loaded<T> {
  /** null until the first successful load for the current key. */
  data: T | null;
  failed: boolean;
  /** Load again (after an action); the current data stays until the answer arrives. */
  reload: () => void;
}

/**
 * Loads `load()` whenever `key` changes, client-side. An answer for an older key or an older
 * request is dropped, so a slow response cannot overwrite a newer one.
 */
export function useLoad<T>(key: string, load: () => Promise<T>): Loaded<T> {
  const [state, setState] = React.useState<{ key: string; data: T | null; failed: boolean }>({
    key,
    data: null,
    failed: false,
  });
  const seq = React.useRef(0);
  const loadRef = React.useRef(load);
  // Declared before the loading effect, so it runs first and the load sees the latest closure.
  React.useEffect(() => {
    loadRef.current = load;
  });

  const run = React.useCallback(() => {
    const id = ++seq.current;
    loadRef
      .current()
      .then((data) => {
        if (id === seq.current) setState({ key, data, failed: false });
      })
      .catch(() => {
        if (id === seq.current) setState((prev) => ({ key, data: prev.key === key ? prev.data : null, failed: true }));
      });
  }, [key]);

  React.useEffect(() => {
    run();
    // The counter object itself, not a DOM ref: bumping it is how in-flight answers get dropped.
    const counter = seq;
    return () => {
      // Unmount or key change: drop whatever is still in flight.
      counter.current++;
    };
  }, [run]);

  const current = state.key === key ? state : { data: null, failed: false };
  return { data: current.data, failed: current.failed, reload: run };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface Paged<T> {
  /** null until the first page for the current key arrives. */
  items: T[] | null;
  failed: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  /** Appends the next page; a failure is reported through `onMoreError`. */
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
    loadRef
      .current(cursor)
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
    hasMore: extra.cursor !== null,
    loadingMore,
    loadMore,
    reload: first.reload,
  };
}
