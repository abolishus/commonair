// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, Skeleton, SkeletonGroup, SkeletonText } from "@commonair/ui";
import { ChannelHeader } from "@commonair/ui/blocks/media";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { Tv01Icon } from "@hugeicons/core-free-icons";
import { createFileRoute, notFound } from "@tanstack/react-router";
import * as React from "react";
import { ChatPanel } from "../../chat/chat-panel.tsx";
import { ChannelBanner, ChannelBannerSkeleton } from "../../components/channel/banner.tsx";
import { bannerVisible, type ChannelExtras } from "../../components/channel/panels-data.ts";
import { getChannelPage } from "../../components/channel/panels-loader.ts";
import { ChannelPanels } from "../../components/channel/panels.tsx";
import { FollowButton, FollowerCount, useFollow } from "../../components/channel-follow.tsx";
import { FollowGrantToggle } from "../../components/portability/grants.tsx";
import { MovedNotice } from "../../components/portability/moved-notice.tsx";
import { SupportButton } from "../../components/support/support-dialog.tsx";
import { isMatureGate, maturityClient } from "../../components/safety/client.ts";
import { MatureGate, RestrictedStream, useViewerMaturity } from "../../components/safety/mature-gate.tsx";
import { playerStage } from "../../components/safety/stage.ts";
import { ReportButton } from "../../components/safety/report-dialog.tsx";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import type { ChannelSummary } from "../../lib/channel-summary.ts";
import { titleHead } from "../../lib/page-title.ts";
import { useChannel } from "../../lib/use-channel.ts";
import { Player } from "../../player/player.tsx";

export const Route = createFileRoute("/_app/$channel")({
  loader: async ({ params }) => {
    // One `channels.get`: the summary the page polls, plus the banner, panels and suspension.
    const page = await getChannelPage({ data: { channel: params.channel } });
    if (!page) throw notFound();
    return page;
  },
  head: ({ loaderData, params }) =>
    titleHead(t("channelPage.title", { name: loaderData?.summary.displayName ?? params.channel })),
  component: ChannelPage,
  pendingComponent: ChannelPending,
  notFoundComponent: ChannelNotFound,
});

function ChannelPage(): React.JSX.Element {
  const { summary, extras } = Route.useLoaderData();
  // Keyed by channel so per-channel state (follow, chat) never leaks across navigations.
  return <ChannelView key={summary.slug} initial={summary} extras={extras} />;
}

function ChannelView({ initial, extras }: { initial: ChannelSummary; extras: ChannelExtras }): React.JSX.Element {
  const { me } = useBootstrap();
  const channel = useChannel(initial.slug, initial);
  const live = channel.live !== null;
  const own = me !== null && (me.channelSlug ?? me.username) === channel.slug;
  const follow = useFollow(channel.slug, channel.following, channel.followerCount, channel.requestedAt ?? 0);
  const signedIn = me !== null;
  const mature = channel.mature || channel.live?.mature === true;
  const restricted = channel.live?.restricted === "under_review";
  const [client] = React.useState(maturityClient);
  const hasBanner = extras.bannerUrl !== null && !extras.suspended;
  // The banner of a mature channel waits for the 18+ check even while it is offline.
  const maturity = useViewerMaturity(signedIn, (live && (mature || restricted)) || (mature && hasBanner), client);
  // `playback.start` refused with the 18+ gate (e.g. a mature category the page did not know about).
  const [gateHit, setGateHit] = React.useState(false);
  const stage = playerStage({ live, mature, restricted, confirmed: maturity.confirmed, gateHit });
  const showBanner = bannerVisible({
    bannerUrl: extras.bannerUrl,
    suspended: extras.suspended,
    mature,
    confirmed: maturity.confirmed,
    locked: stage === "restricted-locked",
  });
  // Signed in on a mature channel: its frame is held while the 18+ check loads, so nothing shifts.
  const bannerPending = hasBanner && mature && !maturity.loaded;
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
            <MovedNotice channelName={channel.displayName} movedTo={channel.movedTo} />
            {stage === "mature-gate" ? (
              <MatureGate
                signedIn={signedIn}
                checking={signedIn && !maturity.loaded}
                onConfirmed={onConfirmed}
                client={client}
              />
            ) : stage === "restricted-locked" || stage === "restricted-player" ? (
              <RestrictedStream
                signedIn={signedIn}
                confirmed={maturity.confirmed}
                onConfirmed={onConfirmed}
                client={client}
              >
                {stage === "restricted-player" ? player : <div className="aspect-video w-full bg-muted" />}
              </RestrictedStream>
            ) : (
              player
            )}
            {showBanner && extras.bannerUrl !== null ? (
              <ChannelBanner url={extras.bannerUrl} />
            ) : bannerPending ? (
              <ChannelBannerSkeleton />
            ) : null}
            <ChannelHeader
              name={channel.displayName}
              avatarUrl={channel.avatarUrl}
              accent={channel.accent}
              live={live}
              title={channel.live?.title || channel.title}
              viewerCount={channel.live?.viewerCount}
              catchingUp={
                channel.live?.catchingUpCount ? (
                  <span data-testid="channel-catching-up" data-count={channel.live.catchingUpCount}>
                    {t("channel.catchingUp", { count: channel.live.catchingUpCount })}
                  </span>
                ) : undefined
              }
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
            {!own && follow.state.following === true && typeof channel.portabilityGrant === "boolean" ? (
              // Remounted when the polled grant changes, so the switch never shows a stale value.
              <FollowGrantToggle
                key={`${channel.slug}:${String(channel.portabilityGrant)}`}
                channel={channel.slug}
                displayName={channel.displayName}
                initial={channel.portabilityGrant}
              />
            ) : null}
          </div>
        }
        aside={
          <ChatPanel
            channel={channel.slug}
            stream={{ id: channel.id, live: channel.live !== null, slug: channel.slug }}
            signedIn={me !== null}
            selfUsername={me?.username ?? null}
            // Bounded so the log scrolls inside the panel: under the player on phones, beside it on desktop.
            className="h-112 lg:h-160"
          />
        }
      />
      {extras.suspended || extras.panels.length === 0 ? null : (
        <div className="pt-6">
          <ChannelPanels panels={extras.panels} />
        </div>
      )}
    </PageContainer>
  );
}

/** While the channel loads (a client-side navigation): the player, header and chat frames. */
function ChannelPending(): React.JSX.Element {
  return (
    <PageContainer width="wide" className="py-4">
      <SkeletonGroup label={t("channelPage.loading")}>
        <SplitLayout
          asideWidth="lg"
          main={
            <div className="flex min-w-0 flex-col gap-4">
              <Skeleton className="aspect-video w-full" />
              <SkeletonText lines={2} />
            </div>
          }
          aside={<Skeleton className="h-112 w-full lg:h-160" />}
        />
      </SkeletonGroup>
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
