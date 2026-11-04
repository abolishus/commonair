// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { getWatchHead, TITLE_STALE_MS, watchPageTitle } from "../../components/vod-watch/watch-head.ts";
import { ClipWatchPage } from "../../components/vod-watch/watch-page.tsx";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { titleHead } from "../../lib/page-title.ts";

/**
 * `/$channel/clips/$clipId`: the public clip watch page with the clip window's chat (decision
 * (e)). Public; what the caller may not watch answers not-found. `$channel_` keeps it out of the
 * channel page's route (which renders no outlet) while the URL stays `/$channel/clips/$clipId`.
 * The clip loads in the browser (`components/vod-watch/watch-page.tsx`); the loader fetches only
 * the title, for "<clip> · <channel> · <site>" (F11).
 */
export const Route = createFileRoute("/_app/$channel_/clips/$clipId")({
  loader: ({ params }) => getWatchHead({ data: { kind: "clip", id: params.clipId, channel: params.channel } }),
  // Only a title: reuse it for a minute, so hovering tiles (preload "intent") and going back do not refetch.
  staleTime: TITLE_STALE_MS,
  preloadStaleTime: TITLE_STALE_MS,
  head: ({ loaderData, params }) => titleHead(watchPageTitle(loaderData, "clip", params.channel)),
  component: ClipRoute,
});

function ClipRoute(): React.JSX.Element {
  const { channel, clipId } = Route.useParams();
  const { me, config } = useBootstrap();
  return (
    <ClipWatchPage
      key={clipId}
      channel={channel}
      clipId={clipId}
      viewer={me ? { username: me.username } : null}
      publicUrl={config.publicUrl}
    />
  );
}
