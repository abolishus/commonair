// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { VodWatchPage } from "../../components/vod-watch/watch-page.tsx";
import { useBootstrap } from "../../lib/bootstrap.ts";

/**
 * `/$channel/vods/$vodId`: the public VOD watch page with the chat replay panel (decision (e)).
 * Public; what the caller may not watch answers not-found. `$channel_` keeps it out of the
 * channel page's route (which renders no outlet) while the URL stays `/$channel/vods/$vodId`.
 * The VOD loads in the browser (`components/vod-watch/watch-page.tsx`): its URLs and its replay
 * are per viewer.
 */
export const Route = createFileRoute("/_app/$channel_/vods/$vodId")({
  component: VodRoute,
});

function VodRoute(): React.JSX.Element {
  const { channel, vodId } = Route.useParams();
  const { me } = useBootstrap();
  return <VodWatchPage key={vodId} channel={channel} vodId={vodId} viewer={me ? { username: me.username } : null} />;
}
