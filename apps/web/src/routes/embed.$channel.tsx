// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState } from "@commonair/ui";
import { Tv01Icon } from "@hugeicons/core-free-icons";
import { createFileRoute, notFound } from "@tanstack/react-router";
import type * as React from "react";
import { t } from "../i18n/index.ts";
import { getChannel } from "../lib/channel.ts";
import { useChannel } from "../lib/use-channel.ts";
import { Player } from "../player/player.tsx";

/** Player only (its `PlayerChrome`), no site chrome: for embedding (and the harness's `--player web`). */
export const Route = createFileRoute("/embed/$channel")({
  loader: async ({ params }) => {
    const channel = await getChannel({ data: { channel: params.channel } });
    if (!channel) throw notFound();
    return channel;
  },
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
  return (
    <div className="grid min-h-dvh place-items-center bg-background">
      <Player
        channel={channel.slug}
        live={channel.live !== null}
        embed
        offline={
          <EmptyState
            data-testid="offline-state"
            icon={Tv01Icon}
            title={t("channel.offline", { name: channel.displayName })}
          />
        }
      />
    </div>
  );
}
