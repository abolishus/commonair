// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { EmptyState, RelativeTime, Skeleton, SkeletonGroup, SkeletonText } from "@commonair/ui";
import { ChannelHeader } from "@commonair/ui/blocks/media";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { cn } from "@commonair/ui/lib/utils";
import { Tv01Icon } from "@hugeicons/core-free-icons";
import { createFileRoute, notFound } from "@tanstack/react-router";
import * as React from "react";
import { ChatPanel } from "../../chat/chat-panel.tsx";
import { chatColumnClass } from "../../chat/layout.ts";
import { ChannelAboutSection } from "../../components/channel/about.tsx";
import { ChannelBanner, ChannelBannerSkeleton } from "../../components/channel/banner.tsx";
import {
  channelUrl,
  lastLiveFrom,
  parseChannelSearch,
  SHELF_SIZE,
  showsJustStarted,
  tabSearch,
  type ChannelTab,
} from "../../components/channel/channel-data.ts";
import {
  CategoryLink,
  ChannelOverflowMenu,
  JustStartedBadge,
  ShareButton,
  tagLink,
  Uptime,
} from "../../components/channel/channel-meta.tsx";
import { ChannelTabs } from "../../components/channel/channel-tabs.tsx";
import { ChannelNotFoundPage } from "../../components/channel/live-now-shelf.tsx";
import { OfflineHero } from "../../components/channel/offline-hero.tsx";
import { bannerVisible } from "../../components/channel/panels-data.ts";
import { getChannelPage, type ChannelPage as ChannelPageData } from "../../components/channel/panels-loader.ts";
import { useChannelClips, useChannelVods } from "../../components/channel/use-media-list.ts";
import { clipTiles, MediaEmptyState, MediaShelf, VideoGrid, vodTiles } from "../../components/channel/video-grid.tsx";
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
import { titleHead } from "../../lib/page-title.ts";
import { useChannel } from "../../lib/use-channel.ts";
import { Player } from "../../player/player.tsx";
import { useTheatre } from "../../player/theatre.ts";

export const Route = createFileRoute("/_app/$channel")({
  // `?tab=videos|clips|about` (F2): each tab is a link and Back steps through them.
  validateSearch: parseChannelSearch,
  loader: async ({ params }) => {
    // One `channels.get` (the summary the page polls, plus the banner, panels, suspension, bio and
    // live metadata) beside the first page of VODs and clips.
    const page = await getChannelPage({ data: { channel: params.channel } });
    if (!page) throw notFound();
    return page;
  },
  // A tab switch stays on the page: the summary is polled, so it does not ask the server again.
  shouldReload: ({ cause }) => cause !== "stay",
  head: ({ loaderData, params }) => {
    const name = loaderData?.summary.displayName ?? params.channel;
    return titleHead(
      loaderData?.summary.live ? t("pageTitle.channelLive", { name }) : t("channelPage.title", { name }),
    );
  },
  component: ChannelPage,
  pendingComponent: ChannelPending,
  notFoundComponent: ChannelNotFound,
});

function ChannelPage(): React.JSX.Element {
  const page = Route.useLoaderData();
  // Parsed again: unvalidated keys from the raw URL reach `useSearch` beside the validated ones.
  const { tab = "home" } = parseChannelSearch(Route.useSearch());
  const navigate = Route.useNavigate();
  const onTabChange = React.useCallback((next: ChannelTab) => void navigate({ search: tabSearch(next) }), [navigate]);
  // Keyed by channel so per-channel state (follow, chat, lists) never leaks across navigations.
  return <ChannelView key={page.summary.slug} page={page} tab={tab} onTabChange={onTabChange} />;
}

function ChannelView({
  page,
  tab,
  onTabChange,
}: {
  page: ChannelPageData;
  tab: ChannelTab;
  onTabChange: (tab: ChannelTab) => void;
}): React.JSX.Element {
  const { extras, about } = page;
  const { me, config, now } = useBootstrap();
  const channel = useChannel(page.summary.slug, page.summary);
  const live = channel.live !== null;
  const own = me !== null && (me.channelSlug ?? me.username) === channel.slug;
  const follow = useFollow(channel.slug, channel.following, channel.followerCount, channel.requestedAt ?? 0);
  const signedIn = me !== null;
  const mature = channel.mature || channel.live?.mature === true;
  const restricted = channel.live?.restricted === "under_review";
  const [client] = React.useState(maturityClient);
  const { theatre } = useTheatre();
  const vods = useChannelVods(channel.slug, page.vods);
  const clips = useChannelClips(channel.slug, page.clips);
  const videoTiles = vodTiles(vods.items);
  const clipTileList = clipTiles(clips.items);
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
  const banner =
    showBanner && extras.bannerUrl !== null ? (
      <ChannelBanner url={extras.bannerUrl} />
    ) : bannerPending ? (
      <ChannelBannerSkeleton />
    ) : null;
  const onConfirmed = () => {
    maturity.markConfirmed();
    setGateHit(false);
  };
  const panels = extras.suspended ? [] : extras.panels;
  // Offline with a playable VOD: the latest one is the hero instead of the offline card (F2).
  const hero = !live && stage === "player" ? (videoTiles[0] ?? null) : null;
  const lastLive = live ? null : lastLiveFrom(vods.items);

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
  const stageNode =
    stage === "mature-gate" ? (
      <MatureGate
        signedIn={signedIn}
        checking={signedIn && !maturity.loaded}
        onConfirmed={onConfirmed}
        client={client}
      />
    ) : stage === "restricted-locked" || stage === "restricted-player" ? (
      <RestrictedStream signedIn={signedIn} confirmed={maturity.confirmed} onConfirmed={onConfirmed} client={client}>
        {stage === "restricted-player" ? player : <div className="aspect-video w-full bg-muted" />}
      </RestrictedStream>
    ) : hero ? null : (
      player
    );

  const justStarted = live && channel.live !== null && showsJustStarted(channel.live.viewerCount);
  const header = (
    <ChannelHeader
      name={channel.displayName}
      avatarUrl={channel.avatarUrl}
      accent={channel.accent}
      live={live}
      title={channel.live?.title || channel.title}
      offlineLabel={live ? undefined : t("channel.offline.label")}
      badges={justStarted ? <JustStartedBadge /> : undefined}
      // F12: below the threshold the count is replaced by "Just started", never padded.
      viewerCount={live && !justStarted ? channel.live?.viewerCount : undefined}
      category={live && about.category ? <CategoryLink category={about.category} /> : undefined}
      tags={about.tags}
      tagsLabel={t("channel.meta.tags")}
      tagLink={tagLink}
      uptime={channel.live ? <Uptime startedAt={channel.live.startedAt} now={now} /> : undefined}
      catchingUp={
        channel.live?.catchingUpCount ? (
          <span data-testid="channel-catching-up" data-count={channel.live.catchingUpCount}>
            {t("channel.catchingUp", { count: channel.live.catchingUpCount })}
          </span>
        ) : undefined
      }
      followers={<FollowerCount count={follow.state.count} />}
      lastLive={
        lastLive ? (
          <span data-testid="channel-last-live" className="inline-flex min-w-0 flex-wrap items-center gap-1">
            <span>
              {t("channel.offline.lastLive")} <RelativeTime date={lastLive} />
            </span>
            {about.category ? (
              <>
                <span aria-hidden>·</span>
                <CategoryLink category={about.category} />
              </>
            ) : null}
          </span>
        ) : undefined
      }
      actions={
        <>
          {own ? null : (
            <>
              <FollowButton signedIn={signedIn} state={follow.state} onToggle={follow.toggle} />
              <SupportButton
                channel={channel.slug}
                channelName={channel.displayName}
                accent={channel.accent}
                signedIn={signedIn}
              />
            </>
          )}
          <ShareButton url={channelUrl(config.publicUrl, channel.slug)} />
          {own ? null : (
            <>
              {/* F4: on phones Report moves into the "More" menu so Follow and Support keep their room. */}
              <span className="hidden sm:contents">
                <ReportButton
                  signedIn={signedIn}
                  subjectType={channel.live ? "broadcast" : "channel"}
                  subjectId={channel.live ? channel.live.id : channel.id}
                />
              </span>
              <ChannelOverflowMenu
                className="sm:hidden"
                signedIn={signedIn}
                subjectType={channel.live ? "broadcast" : "channel"}
                subjectId={channel.live ? channel.live.id : channel.id}
              />
            </>
          )}
        </>
      }
    />
  );

  const videosShelf = (heading: string, tiles = videoTiles) => (
    <MediaShelf
      kind="vods"
      heading={heading}
      tiles={tiles.slice(0, SHELF_SIZE)}
      onViewAll={() => onTabChange("videos")}
    />
  );
  const aboutSection = (withBanner: boolean) => (
    <ChannelAboutSection
      name={channel.displayName}
      about={about}
      followers={<FollowerCount count={follow.state.count} />}
      panels={panels}
      banner={withBanner ? banner : null}
    />
  );
  // Live, the player and chat stay above the tabs on every tab, so switching never restarts the stream.
  const home = live ? (
    <div className="flex min-w-0 flex-col gap-8">
      {videosShelf(t("channel.tabs.recentVideos"))}
      <MediaShelf
        kind="clips"
        heading={t("channel.tabs.recentClips")}
        tiles={clipTileList.slice(0, SHELF_SIZE)}
        onViewAll={() => onTabChange("clips")}
      />
    </div>
  ) : hero ? (
    <div className="flex min-w-0 flex-col gap-8">
      <OfflineHero tile={hero} />
      {videosShelf(t("channel.tabs.moreVideos"), videoTiles.slice(1))}
    </div>
  ) : (
    // No VODs: today's offline card (above) plus the About content.
    aboutSection(false)
  );
  const tabs = (
    <ChannelTabs
      tab={tab}
      onTabChange={onTabChange}
      panels={{
        home,
        videos: (
          <VideoGrid
            kind="vods"
            tiles={videoTiles}
            list={vods}
            empty={<MediaEmptyState kind="vods" own={own} channelName={channel.displayName} />}
          />
        ),
        clips: (
          <VideoGrid
            kind="clips"
            tiles={clipTileList}
            list={clips}
            empty={<MediaEmptyState kind="clips" own={own} channelName={channel.displayName} />}
          />
        ),
        // Live, the banner moves into About; offline it already heads the page.
        about: aboutSection(live),
      }}
    />
  );
  const grant =
    !own && follow.state.following === true && typeof channel.portabilityGrant === "boolean" ? (
      // Remounted when the polled grant changes, so the switch never shows a stale value.
      <FollowGrantToggle
        key={`${channel.slug}:${String(channel.portabilityGrant)}`}
        channel={channel.slug}
        displayName={channel.displayName}
        initial={channel.portabilityGrant}
      />
    ) : null;
  const chat = (
    <ChatPanel
      channel={channel.slug}
      stream={{ id: channel.id, live: channel.live !== null, slug: channel.slug }}
      signedIn={signedIn}
      selfUsername={me?.username ?? null}
      // D2-chat sizes the column (bounded so the log scrolls inside it; full height in theatre).
      className={chatColumnClass({ theatre: theatre && live })}
    />
  );
  const details = (
    <>
      {header}
      {grant}
      {tabs}
    </>
  );

  if (theatre && live) {
    // Theatre (decision (b)): the player spans the viewport's width with chat docked on the right;
    // the header and tabs follow at page width.
    return (
      <div data-testid="channel-page" data-layout="theatre" className="flex min-w-0 flex-col gap-4 pb-4">
        <div className="flex min-w-0 flex-col lg:flex-row">
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <MovedNotice channelName={channel.displayName} movedTo={channel.movedTo} />
            {stageNode}
          </div>
          <aside className="min-w-0 lg:w-80 lg:shrink-0">{chat}</aside>
        </div>
        <PageContainer width="wide" className="flex flex-col gap-4">
          {details}
        </PageContainer>
      </div>
    );
  }

  return (
    <PageContainer width="wide" className="py-4" data-testid="channel-page" data-layout="default">
      <SplitLayout
        asideWidth="lg"
        main={
          <div className="flex min-w-0 flex-col gap-4">
            <MovedNotice channelName={channel.displayName} movedTo={channel.movedTo} />
            {/* Offline, the banner heads the page; live it sits in About so the player comes first. */}
            {live ? null : banner}
            {stageNode}
            {details}
          </div>
        }
        aside={chat}
      />
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
          aside={<Skeleton className={cn("w-full", chatColumnClass({ theatre: false }))} />}
        />
      </SkeletonGroup>
    </PageContainer>
  );
}

/** An unknown channel (F13): D4's explained state with "Browse live channels", then Live now. */
function ChannelNotFound(): React.JSX.Element {
  return <ChannelNotFoundPage />;
}
