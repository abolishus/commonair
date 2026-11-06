// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * A channel's VODs or clips, paged by cursor ("Show more"). Starts from the loader's first page;
 * when that failed (null) it asks once in the browser. The client is injectable so tests run on
 * fakes; the page uses `api()`.
 */
import * as React from "react";
import { api } from "../../lib/api.ts";
import { appendPage, CHANNEL_MEDIA_PAGE, type ClipItem, type MediaPage, type VodItem } from "./channel-data.ts";
import { DEFAULT_CLIP_FILTER, type ClipFilter } from "./clip-filters.tsx";

export interface ChannelMediaClient {
  vods(channel: string, cursor?: string): Promise<MediaPage<VodItem>>;
  clips(channel: string, cursor?: string, filter?: ClipFilter): Promise<MediaPage<ClipItem>>;
  /** A category's VODs and clips (the category page's tabs). */
  categoryVods(slug: string, cursor?: string): Promise<MediaPage<VodItem>>;
  categoryClips(slug: string, cursor?: string, filter?: ClipFilter): Promise<MediaPage<ClipItem>>;
}

const at = (cursor: string | undefined) => (cursor ? { cursor } : {});

export const channelMediaClient = (): ChannelMediaClient => ({
  vods: (channel, cursor) => api().vods.list({ channel, limit: CHANNEL_MEDIA_PAGE, ...at(cursor) }),
  clips: (channel, cursor, filter = DEFAULT_CLIP_FILTER) =>
    api().clips.list({ channel, limit: CHANNEL_MEDIA_PAGE, ...filter, ...at(cursor) }),
  categoryVods: (slug, cursor) => api().vods.listByCategory({ slug, limit: CHANNEL_MEDIA_PAGE, ...at(cursor) }),
  categoryClips: (slug, cursor, filter = DEFAULT_CLIP_FILTER) =>
    api().clips.listByCategory({ slug, limit: CHANNEL_MEDIA_PAGE, ...filter, ...at(cursor) }),
});

/** Tests provide a fake here; without a provider the page talks to the API. */
export const ChannelMediaClientContext = React.createContext<ChannelMediaClient | null>(null);

export type MediaListStatus = "loading" | "ready" | "error";

export interface MediaList<T> {
  items: T[];
  status: MediaListStatus;
  /** A further page exists. */
  hasMore: boolean;
  loadingMore: boolean;
  /** The last "Show more" failed (the items shown stay). */
  moreFailed: boolean;
  loadMore: () => void;
  /** Asks for the first page again (after a failure, or when the list is known to be stale). Stable. */
  retry: () => void;
}

function useMediaClient(): ChannelMediaClient {
  const injected = React.useContext(ChannelMediaClientContext);
  const [fallback] = React.useState(channelMediaClient);
  return injected ?? fallback;
}

export function useChannelVods(channel: string, initial: MediaPage<VodItem> | null): MediaList<VodItem> {
  const client = useMediaClient();
  const fetchPage = React.useCallback((cursor?: string) => client.vods(channel, cursor), [client, channel]);
  return useMediaList(fetchPage, initial);
}

/** A new sort or range starts the list over (a fresh first page). */
export function useChannelClips(
  channel: string,
  initial: MediaPage<ClipItem> | null,
  filter: ClipFilter = DEFAULT_CLIP_FILTER,
): MediaList<ClipItem> {
  const client = useMediaClient();
  const { sort, range } = filter;
  const fetchPage = React.useCallback(
    (cursor?: string) => client.clips(channel, cursor, { sort, range }),
    [client, channel, sort, range],
  );
  return useMediaList(fetchPage, initial);
}

export function useCategoryVods(slug: string): MediaList<VodItem> {
  const client = useMediaClient();
  const fetchPage = React.useCallback((cursor?: string) => client.categoryVods(slug, cursor), [client, slug]);
  return useMediaList(fetchPage, null);
}

export function useCategoryClips(slug: string, filter: ClipFilter = DEFAULT_CLIP_FILTER): MediaList<ClipItem> {
  const client = useMediaClient();
  const { sort, range } = filter;
  const fetchPage = React.useCallback(
    (cursor?: string) => client.categoryClips(slug, cursor, { sort, range }),
    [client, slug, sort, range],
  );
  return useMediaList(fetchPage, null);
}

/**
 * `initial` seeds the first `fetchPage` only: a different `fetchPage` (a new filter) drops what is
 * shown and asks for its own first page.
 */
export function useMediaList<T extends { id: string }>(
  fetchPage: (cursor?: string) => Promise<MediaPage<T>>,
  initial: MediaPage<T> | null,
): MediaList<T> {
  const [page, setPage] = React.useState<MediaPage<T> | null>(initial);
  const [status, setStatus] = React.useState<MediaListStatus>(initial ? "ready" : "loading");
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [moreFailed, setMoreFailed] = React.useState(false);
  const [source, setSource] = React.useState(() => fetchPage);
  if (source !== fetchPage) {
    // Adjusting state while rendering (not in an effect), so the old list never shows under the new filter.
    setSource(() => fetchPage);
    setPage(null);
    setStatus("loading");
    setMoreFailed(false);
  }
  // A double click in one frame must not ask for the same page twice.
  const inFlight = React.useRef(false);
  // A "Show more" answer for a previous filter is dropped.
  const current = React.useRef(fetchPage);
  React.useEffect(() => {
    current.current = fetchPage;
  }, [fetchPage]);
  const retry = React.useCallback(() => setStatus("loading"), []);

  React.useEffect(() => {
    if (status !== "loading") return;
    let cancelled = false;
    fetchPage().then(
      (first) => {
        if (cancelled) return;
        setPage(first);
        setStatus("ready");
      },
      () => {
        if (!cancelled) setStatus("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [status, fetchPage]);

  const loadMore = () => {
    const cursor = page?.nextCursor;
    if (!cursor || inFlight.current) return;
    inFlight.current = true;
    setLoadingMore(true);
    setMoreFailed(false);
    const asked = fetchPage;
    fetchPage(cursor)
      .then(
        (next) => {
          if (current.current !== asked) return;
          setPage((cur) => ({ items: appendPage(cur?.items ?? [], next.items), nextCursor: next.nextCursor }));
        },
        () => {
          if (current.current === asked) setMoreFailed(true);
        },
      )
      .finally(() => {
        inFlight.current = false;
        setLoadingMore(false);
      });
  };

  return {
    items: page?.items ?? [],
    status,
    hasMore: Boolean(page?.nextCursor),
    loadingMore,
    moreFailed,
    loadMore,
    retry,
  };
}
