// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { createFileRoute } from "@tanstack/react-router";
import type * as React from "react";
import { ClipWatchPage } from "../../components/vod-watch/watch-page.tsx";
import { useBootstrap } from "../../lib/bootstrap.ts";

/**
 * `/$channel/clips/$clipId`: the public clip watch page with the clip window's chat (decision
 * (e)). Public; what the caller may not watch answers not-found. `$channel_` keeps it out of the
 * channel page's route (which renders no outlet) while the URL stays `/$channel/clips/$clipId`.
 * The clip loads in the browser (`components/vod-watch/watch-page.tsx`).
 */
export const Route = createFileRoute("/_app/$channel_/clips/$clipId")({
  component: ClipRoute,
});

function ClipRoute(): React.JSX.Element {
  const { channel, clipId } = Route.useParams();
  const { me } = useBootstrap();
  return (
    <ClipWatchPage key={clipId} channel={channel} clipId={clipId} viewer={me ? { username: me.username } : null} />
  );
}
