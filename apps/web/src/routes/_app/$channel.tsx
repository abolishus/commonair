// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ChannelAvatar, EmptyState, LiveBadge, ViewerCount } from "@commonair/ui";
import { Tv01Icon } from "@hugeicons/core-free-icons";
import { createFileRoute, notFound } from "@tanstack/react-router";
import type * as React from "react";
import { ChatPanel } from "../../chat/chat-panel.tsx";
import { FollowButton, FollowerCount, useFollow } from "../../components/channel-follow.tsx";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { getChannel } from "../../lib/channel.ts";
import type { ChannelSummary } from "../../lib/channel-summary.ts";
import { useChannel } from "../../lib/use-channel.ts";
import { Player } from "../../player/player.tsx";

export const Route = createFileRoute("/_app/$channel")({
  loader: async ({ params }) => {
    const channel = await getChannel({ data: { channel: params.channel } });
    if (!channel) throw notFound();
    return channel;
  },
  component: ChannelPage,
  notFoundComponent: ChannelNotFound,
});

function ChannelPage(): React.JSX.Element {
  const initial = Route.useLoaderData();
  // Keyed by channel so per-channel state (follow, chat) never leaks across navigations.
  return <ChannelView key={initial.slug} initial={initial} />;
}

function ChannelView({ initial }: { initial: ChannelSummary }): React.JSX.Element {
  const { me } = useBootstrap();
  const channel = useChannel(initial.slug, initial);
  const live = channel.live !== null;
  const own = me !== null && (me.channelSlug ?? me.username) === channel.slug;
  const follow = useFollow(channel.slug, channel.following, channel.followerCount, channel.requestedAt ?? 0);
  return (
    <div className="mx-auto grid max-w-7xl gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex min-w-0 flex-col gap-3">
        <Player
          channel={channel.slug}
          live={live}
          offline={
            <div data-testid="offline-state">
              <EmptyState icon={Tv01Icon} title={t("channel.offline", { name: channel.displayName })} />
            </div>
          }
        />
        <div className="flex min-w-0 items-center gap-3">
          <ChannelAvatar name={channel.displayName} src={channel.avatarUrl} size="md" live={live} decorative />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h1 className="truncate font-display text-base font-semibold">{channel.displayName}</h1>
            <p className="truncate text-xs text-muted-foreground">{channel.live?.title || channel.title}</p>
            <FollowerCount count={follow.state.count} />
          </div>
          <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
            {channel.live && (
              <>
                <LiveBadge data-testid="live-badge" pulse />
                <ViewerCount count={channel.live.viewerCount} />
              </>
            )}
            {!own && <FollowButton signedIn={me !== null} state={follow.state} onToggle={follow.toggle} />}
          </div>
        </div>
      </div>
      <ChatPanel
        channel={channel.slug}
        signedIn={me !== null}
        selfUsername={me?.username ?? null}
        className="h-[28rem] lg:h-[calc(100dvh-7rem)]"
      />
    </div>
  );
}

function ChannelNotFound(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-md px-4 py-16">
      <EmptyState icon={Tv01Icon} title={t("channel.notFound")} />
    </div>
  );
}
