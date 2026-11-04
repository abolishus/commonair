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

export interface ChannelMediaClient {
  vods(channel: string, cursor?: string): Promise<MediaPage<VodItem>>;
  clips(channel: string, cursor?: string): Promise<MediaPage<ClipItem>>;
}

export const channelMediaClient = (): ChannelMediaClient => ({
  vods: (channel, cursor) => api().vods.list({ channel, limit: CHANNEL_MEDIA_PAGE, ...(cursor ? { cursor } : {}) }),
  clips: (channel, cursor) =>
    api().clips.list({ channel, limit: CHANNEL_MEDIA_PAGE, sort: "recent", ...(cursor ? { cursor } : {}) }),
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

export function useChannelClips(channel: string, initial: MediaPage<ClipItem> | null): MediaList<ClipItem> {
  const client = useMediaClient();
  const fetchPage = React.useCallback((cursor?: string) => client.clips(channel, cursor), [client, channel]);
  return useMediaList(fetchPage, initial);
}

export function useMediaList<T extends { id: string }>(
  fetchPage: (cursor?: string) => Promise<MediaPage<T>>,
  initial: MediaPage<T> | null,
): MediaList<T> {
  const [page, setPage] = React.useState<MediaPage<T> | null>(initial);
  const [status, setStatus] = React.useState<MediaListStatus>(initial ? "ready" : "loading");
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [moreFailed, setMoreFailed] = React.useState(false);
  // A double click in one frame must not ask for the same page twice.
  const inFlight = React.useRef(false);
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
    fetchPage(cursor)
      .then(
        (next) => setPage((cur) => ({ items: appendPage(cur?.items ?? [], next.items), nextCursor: next.nextCursor })),
        () => setMoreFailed(true),
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
