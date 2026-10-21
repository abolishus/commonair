// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState } from "@commonair/ui";
import { ChannelHeader } from "@commonair/ui/blocks/media";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { Tv01Icon } from "@hugeicons/core-free-icons";
import { createFileRoute, notFound } from "@tanstack/react-router";
import * as React from "react";
import { ChatPanel } from "../../chat/chat-panel.tsx";
import { FollowButton, FollowerCount, useFollow } from "../../components/channel-follow.tsx";
import { SupportButton } from "../../components/support/support-dialog.tsx";
import { isMatureGate, maturityClient } from "../../components/safety/client.ts";
import { MatureGate, RestrictedStream, useViewerMaturity } from "../../components/safety/mature-gate.tsx";
import { ReportButton } from "../../components/safety/report-dialog.tsx";
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
  const signedIn = me !== null;
  const mature = channel.mature || channel.live?.mature === true;
  const restricted = channel.live?.restricted === "under_review";
  const [client] = React.useState(maturityClient);
  const maturity = useViewerMaturity(signedIn, live && (mature || restricted), client);
  // `playback.start` refused with the 18+ gate (e.g. a mature category the page did not know about).
  const [gateHit, setGateHit] = React.useState(false);
  const gated = live && (gateHit || (mature && !maturity.confirmed));
  const onConfirmed = () => {
    maturity.markConfirmed();
    setGateHit(false);
  };
  const player = (
    <Player
      channel={channel.slug}
      live={live}
      onStartError={(err) => {
        if (isMatureGate(err)) setGateHit(true);
      }}
      offline={
        <EmptyState
          data-testid="offline-state"
          icon={Tv01Icon}
          title={t("channel.offline", { name: channel.displayName })}
        />
      }
    />
  );
  return (
    <PageContainer width="wide" className="py-4">
      <SplitLayout
        asideWidth="lg"
        main={
          <div className="flex min-w-0 flex-col gap-4">
            {gated ? (
              <MatureGate
                signedIn={signedIn}
                checking={signedIn && !maturity.loaded}
                onConfirmed={onConfirmed}
                client={client}
              />
            ) : restricted ? (
              <RestrictedStream
                signedIn={signedIn}
                confirmed={maturity.confirmed}
                onConfirmed={onConfirmed}
                client={client}
              >
                {player}
              </RestrictedStream>
            ) : (
              player
            )}
            <ChannelHeader
              name={channel.displayName}
              avatarUrl={channel.avatarUrl}
              accent={channel.accent}
              live={live}
              title={channel.live?.title || channel.title}
              viewerCount={channel.live?.viewerCount}
              followers={<FollowerCount count={follow.state.count} />}
              actions={
                own ? undefined : (
                  <>
                    <FollowButton signedIn={me !== null} state={follow.state} onToggle={follow.toggle} />
                    <SupportButton
                      channel={channel.slug}
                      channelName={channel.displayName}
                      accent={channel.accent}
                      signedIn={me !== null}
                    />
                    <ReportButton
                      signedIn={signedIn}
                      subjectType={channel.live ? "broadcast" : "channel"}
                      subjectId={channel.live ? channel.live.id : channel.id}
                    />
                  </>
                )
              }
            />
          </div>
        }
        aside={
          <ChatPanel
            channel={channel.slug}
            signedIn={me !== null}
            selfUsername={me?.username ?? null}
            // Bounded so the log scrolls inside the panel: under the player on phones, beside it on desktop.
            className="h-112 lg:h-160"
          />
        }
      />
    </PageContainer>
  );
}

function ChannelNotFound(): React.JSX.Element {
  return (
    <PageContainer width="narrow" className="py-16">
      <EmptyState icon={Tv01Icon} title={t("channel.notFound")} />
    </PageContainer>
  );
}
