// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { getWatchHead, TITLE_STALE_MS, watchPageTitle } from "../../components/vod-watch/watch-head.ts";
import { VodWatchPage } from "../../components/vod-watch/watch-page.tsx";
import { parseWatchSearch } from "../../components/watch/share.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * `/$channel/vods/$vodId`: the public VOD watch page with the chat replay panel (decision (e)).
 * Public; what the caller may not watch answers not-found. `$channel_` keeps it out of the
 * channel page's route (which renders no outlet) while the URL stays `/$channel/vods/$vodId`.
 * The VOD loads in the browser (`components/vod-watch/watch-page.tsx`): its URLs and its replay
 * are per viewer. The loader fetches only the title, for "<VOD> · <channel> · <site>" (F11).
 * `?t=<seconds>` (Share's "Start at") starts playback there.
 */
export const Route = createFileRoute("/_app/$channel_/vods/$vodId")({
  validateSearch: parseWatchSearch,
  loader: ({ params }) => getWatchHead({ data: { kind: "vod", id: params.vodId, channel: params.channel } }),
  // Only a title: reuse it for a minute, so hovering tiles (preload "intent") and going back do not refetch.
  staleTime: TITLE_STALE_MS,
  preloadStaleTime: TITLE_STALE_MS,
  head: ({ loaderData, params }) => titleHead(watchPageTitle(loaderData, "vod", params.channel)),
  component: VodRoute,
});

function VodRoute(): React.JSX.Element {
  const { channel, vodId } = Route.useParams();
  const { t: startAt } = Route.useSearch();
  const { me, config } = useBootstrap();
  return (
    <VodWatchPage
      key={vodId}
      channel={channel}
      vodId={vodId}
      viewer={me ? { username: me.username } : null}
      publicUrl={config.publicUrl}
      startAt={startAt ?? null}
    />
  );
}
