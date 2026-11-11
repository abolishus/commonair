// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState } from "@commonair/ui";
import { Tv01Icon } from "@hugeicons/core-free-icons";
import { createFileRoute, notFound } from "@tanstack/react-router";
import type * as React from "react";
import { EmbedIdentity, EmbedOffline, EmbedWatchOn } from "../components/watch/embed-identity.tsx";
import { t } from "../i18n/index.ts";
import { useBootstrap } from "../lib/bootstrap.ts";
import { getChannel } from "../lib/channel.ts";
import { useChannel } from "../lib/use-channel.ts";
import { Player } from "../player/player.tsx";
import { titleHead } from "../lib/page-title.ts";

/**
 * Player only (its `PlayerChrome`), no site chrome: for embedding (and the harness's `--player
 * web`). D3.9: the channel's name over the picture and "Watch on <site>", a plain link that opens
 * the channel in a new tab; offline, the same link under the offline notice.
 */
export const Route = createFileRoute("/embed/$channel")({
  loader: async ({ params }) => {
    const channel = await getChannel({ data: { channel: params.channel } });
    if (!channel) throw notFound();
    return channel;
  },
  head: ({ loaderData, params }) =>
    titleHead(t("pageTitle.embed", { name: loaderData?.displayName ?? params.channel })),
  component: EmbedPage,
  notFoundComponent: () => (
    <div className="grid min-h-dvh place-items-center">
      <EmptyState icon={Tv01Icon} title={t("channel.notFound")} />
    </div>
  ),
});

function EmbedPage(): React.JSX.Element {
  const initial = Route.useLoaderData();
  const channel = useChannel(initial.slug, initial);
  const { instance } = useBootstrap();
  return (
    <div className="grid min-h-dvh place-items-center bg-background">
      <Player
        channel={channel.slug}
        live={channel.live !== null}
        embed
        topStart={<EmbedIdentity channel={channel} />}
        topEnd={<EmbedWatchOn channel={channel} site={instance.name} />}
        offline={<EmbedOffline channel={channel} site={instance.name} />}
      />
    </div>
  );
}
