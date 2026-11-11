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
  clipsSearch,
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
import {
  ClipFilters,
  clipFilterFrom,
  isDefaultClipFilter,
  type ClipFilter,
} from "../../components/channel/clip-filters.tsx";
import { ChannelNotFoundPage } from "../../components/channel/live-now-shelf.tsx";
import { nextStreamOf, OfflineChannelHome } from "../../components/channel/offline-hero.tsx";
import { bannerVisible } from "../../components/channel/panels-data.ts";
import { getChannelPage, type ChannelPage } from "../../components/channel/panels-loader.ts";
import { useChannelClips, useChannelVods } from "../../components/channel/use-media-list.ts";
import {
  ClipsFilteredEmpty,
  clipTiles,
  MediaEmptyState,
  MediaShelf,
  VideoGrid,
  vodTiles,
} from "../../components/channel/video-grid.tsx";
import { FollowButton, FollowerCount, useFollow } from "../../components/channel-follow.tsx";
import { CheckoutReturn } from "../../components/money/checkout-return.tsx";
import { MovedNotice } from "../../components/portability/moved-notice.tsx";
import { SupportButton } from "../../components/support/support-dialog.tsx";
import { isMatureGate, maturityClient } from "../../components/safety/client.ts";
import { MatureGate, RestrictedStream, useViewerMaturity } from "../../components/safety/mature-gate.tsx";
import { playerStage } from "../../components/safety/stage.ts";
import { ReportButton } from "../../components/safety/report-dialog.tsx";
import {
  ModViewButton,
  OwnerShortcuts,
  TrustBadge,
  useModerates,
  useWatchPanel,
  VerifiedViewers,
  WatchPanelSwitch,
} from "../../components/watch-layout/watch-layout.tsx";
import { t } from "../../i18n/index.ts";
import { useBootstrap } from "../../lib/bootstrap.ts";
import { titleHead } from "../../lib/page-title.ts";
import { seoHead, siteFromMatches, withSeo } from "../../lib/seo.ts";
import { useChannel } from "../../lib/use-channel.ts";
import { Player } from "../../player/player.tsx";
import { TheatreProvider, useTheatre, useTheatreAvailable, useTheatreChat } from "../../player/theatre.ts";

export const Route = createFileRoute("/_app/$channel")({
  // `?tab=videos|clips|about` (F2): each tab is a link and Back steps through them. Clips adds
  // `&sort=top&range=7d|30d`.
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
  head: ({ loaderData, params, matches }) => {
    const name = loaderData?.summary.displayName ?? params.channel;
    const title = loaderData?.summary.live ? t("pageTitle.channelLive", { name }) : t("channelPage.title", { name });
    if (!loaderData || loaderData.extras.suspended) return titleHead(title);
    // F13: link previews from what the loader has. A mature channel's preview carries no image.
    const { summary, about, extras } = loaderData;
    const mature = summary.mature || summary.live?.mature === true;
    return withSeo(
      titleHead(title),
      seoHead(siteFromMatches(matches), {
        title,
        description: summary.live?.title || about.bio || summary.title,
        path: `/${summary.slug}`,
        image: mature ? null : (extras.bannerUrl ?? summary.avatarUrl),
        type: summary.live ? "video.other" : "website",
      }),
    );
  },
  component: ChannelPage,
  pendingComponent: ChannelPending,
  notFoundComponent: ChannelNotFound,
});

function ChannelPage(): React.JSX.Element {
  const page = Route.useLoaderData();
  // Parsed again: unvalidated keys from the raw URL reach `useSearch` beside the validated ones.
  const search = parseChannelSearch(Route.useSearch());
  const { tab = "home" } = search;
  const { sort, range } = clipFilterFrom(search);
  const clipFilter = React.useMemo<ClipFilter>(() => ({ sort, range }), [sort, range]);
  const navigate = Route.useNavigate();
  const onTabChange = React.useCallback((next: ChannelTab) => void navigate({ search: tabSearch(next) }), [navigate]);
  const onClipFilterChange = React.useCallback(
    (next: ClipFilter) => void navigate({ search: clipsSearch(next) }),
    [navigate],
  );
  // Keyed by channel so per-channel state (follow, chat, lists) never leaks across navigations.
  // D2-player's theatre state (per tab): the player's toggle and this layout read the same provider.
  return (
    <TheatreProvider>
      <ChannelView
        key={page.summary.slug}
        page={page}
        tab={tab}
        onTabChange={onTabChange}
        clipFilter={clipFilter}
        onClipFilterChange={onClipFilterChange}
      />
    </TheatreProvider>
  );
}

function ChannelView({
  page,
  tab,
  onTabChange,
  clipFilter,
  onClipFilterChange,
}: {
  page: ChannelPage;
  tab: ChannelTab;
  onTabChange: (tab: ChannelTab) => void;
  clipFilter: ClipFilter;
  onClipFilterChange: (filter: ClipFilter) => void;
}): React.JSX.Element {
  const { extras, about } = page;
  const { me, config, now } = useBootstrap();
  const channel = useChannel(page.summary.slug, page.summary);
  const live = channel.live !== null;
  const own = me !== null && (me.channelSlug ?? me.username) === channel.slug;
  const follow = useFollow(channel.slug, channel.following, channel.followerCount, channel.requestedAt ?? 0);
  const signedIn = me !== null;
  // Both mounts (the actions row, the offline hero) carry the channel for the sign-up prompt and
  // the confirm, the known alerts and the "Email me once if they move" grant (D4.3).
  const followButton = (
    <FollowButton
      signedIn={signedIn}
      state={follow.state}
      onToggle={follow.toggle}
      channel={{
        slug: channel.slug,
        name: channel.displayName,
        accent: channel.accent ?? null,
        avatarUrl: channel.avatarUrl ?? null,
      }}
      notify={channel.notify}
      portabilityGrant={typeof channel.portabilityGrant === "boolean" ? channel.portabilityGrant : undefined}
    />
  );
  const mature = channel.mature || channel.live?.mature === true;
  const restricted = channel.live?.restricted === "under_review";
  const [client] = React.useState(maturityClient);
  const { theatre } = useTheatre();
  const theatreAvailable = useTheatreAvailable();
  const { chatHidden } = useTheatreChat();
  const vods = useChannelVods(channel.slug, page.vods);
  // Live -> offline: the loaded list predates the broadcast that just ended (it was still recording,
  // so it was left out); ask again so the hero is that broadcast.
  const wasLive = React.useRef(live);
  const refreshVods = vods.retry;
  React.useEffect(() => {
    if (wasLive.current && !live) refreshVods();
    wasLive.current = live;
  }, [live, refreshVods]);
  // The loader's first page is the default filter's; another sort or range asks for its own.
  const clips = useChannelClips(channel.slug, isDefaultClipFilter(clipFilter) ? page.clips : null, clipFilter);
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
  // Offline (D3.8): Home is the content page (the Follow hero with the latest video, clips, videos,
  // About) instead of the player's offline card. A suspended channel keeps the card.
  const offlineHome = !live && stage === "player" && !extras.suspended;
  const lastLive = live ? null : channel.lastLiveAt;

  const player = (
    <Player
      channel={channel.slug}
      live={live}
      clip={{ signedIn, publicUrl: config.publicUrl }}
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
    ) : offlineHome ? null : (
      player
    );

  const justStarted = live && channel.live !== null && showsJustStarted(channel.live.viewerCount);
  const theatreLayout = theatre && live && theatreAvailable;
  // D4.1: below `lg` the page is a sticky player over "Chat | About" (CSS; desktop shows both).
  const [panel, setPanel] = useWatchPanel(live, tab);
  // Exactly one `follow-button` on the page: offline, the Follow hero holds it while Home shows
  // (mockup channel-offline.html); everywhere else the header row does.
  const heroFollow = offlineHome && tab === "home" && panel === "about";
  const moderates = useModerates(channel.slug, signedIn && !own);
  const subjectType = channel.live ? "broadcast" : "channel";
  const subjectId = channel.live ? channel.live.id : channel.id;
  const shareLink = channelUrl(config.publicUrl, channel.slug);
  const header = (
    <ChannelHeader
      name={channel.displayName}
      avatarUrl={channel.avatarUrl}
      accent={channel.accent}
      live={live}
      compactBelowLg
      title={channel.live?.title || channel.title}
      offlineLabel={live ? undefined : t("channel.offline.label")}
      badges={
        justStarted ? (
          <JustStartedBadge />
        ) : live ? undefined : (
          // D4.7: the trust mark sits in the header on the offline page only (About has its own).
          <TrustBadge data-testid="channel-trust-badge" coop={page.ownerCoop} name={channel.displayName} />
        )
      }
      // F12: below the threshold the count is replaced by "Just started", never padded.
      viewerCount={live && !justStarted ? channel.live?.viewerCount : undefined}
      viewerCountNote={
        live && !justStarted ? (
          // Below `lg` the note moves into the About panel, so the compact row stays one line.
          <VerifiedViewers data-testid="channel-verified-viewers" className="max-lg:hidden" />
        ) : undefined
      }
      category={live && channel.category ? <CategoryLink category={channel.category} /> : undefined}
      tags={channel.tags}
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
            {channel.category ? (
              <>
                <span aria-hidden>·</span>
                <CategoryLink category={channel.category} />
              </>
            ) : null}
          </span>
        ) : undefined
      }
      className={theatreLayout ? undefined : "px-4 py-2 lg:p-0"}
      actions={
        own ? (
          <>
            {/* D4.6: the owner's shortcuts; never shown to anyone else. */}
            <OwnerShortcuts />
            <ShareButton url={shareLink} />
          </>
        ) : (
          <>
            {heroFollow ? null : followButton}
            <SupportButton
              channel={channel.slug}
              channelName={channel.displayName}
              accent={channel.accent}
              signedIn={signedIn}
            />
            {moderates ? <ModViewButton channel={channel.slug} /> : null}
            {/* F4, D4.1: below `lg` Share and Report move into the "More" menu so the row keeps its room. */}
            <span className="hidden lg:contents">
              <ShareButton url={shareLink} />
              <ReportButton signedIn={signedIn} subjectType={subjectType} subjectId={subjectId} />
            </span>
            <ChannelOverflowMenu
              className="lg:hidden"
              signedIn={signedIn}
              subjectType={subjectType}
              subjectId={subjectId}
              shareUrl={shareLink}
            />
          </>
        )
      }
    />
  );

  const videosShelf = (heading: string) => (
    <MediaShelf kind="vods" heading={heading} tiles={videoTiles.slice(0, SHELF_SIZE)} channel={channel.slug} />
  );
  const aboutSection = (withBanner: boolean) => (
    <ChannelAboutSection
      name={channel.displayName}
      about={about}
      category={channel.category}
      followers={
        // Its own id: the header's `follower-count` is the one other units read.
        <span data-testid="channel-about-followers" data-count={follow.state.count}>
          {t("follow.count", { count: follow.state.count })}
        </span>
      }
      panels={panels}
      banner={withBanner ? banner : null}
      since={page.since}
      coop={page.ownerCoop}
    />
  );
  // Live, the player and chat stay above the tabs on every tab, so switching never restarts the stream.
  // Live with nothing recorded or clipped yet, both shelves are empty: Home shows About instead of a blank panel.
  const home = live ? (
    videoTiles.length === 0 && clipTileList.length === 0 ? (
      aboutSection(true)
    ) : (
      <div className="flex min-w-0 flex-col gap-8">
        {videosShelf(t("channel.tabs.recentVideos"))}
        <MediaShelf
          kind="clips"
          heading={t("channel.tabs.recentClips")}
          tiles={clipTileList.slice(0, SHELF_SIZE)}
          channel={channel.slug}
        />
      </div>
    )
  ) : offlineHome ? (
    <OfflineChannelHome
      channel={{
        slug: channel.slug,
        displayName: channel.displayName,
        accent: channel.accent ?? null,
        avatarUrl: channel.avatarUrl ?? null,
      }}
      lastLiveAt={channel.lastLiveAt}
      videos={videoTiles}
      clips={clipTileList}
      follow={heroFollow ? followButton : null}
      own={own}
      about={aboutSection(false)}
      publicUrl={config.publicUrl}
      nextStream={nextStreamOf(page.nextStreamAt, now)}
    />
  ) : (
    // Suspended: the offline card (above) plus the About content.
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
          <div className="flex min-w-0 flex-col gap-4">
            <ClipFilters value={clipFilter} onChange={onClipFilterChange} />
            <VideoGrid
              kind="clips"
              tiles={clipTileList}
              list={clips}
              empty={
                // Sort alone never empties the list: only a narrower range gets the filtered empty state.
                clipFilter.range === "all" ? (
                  <MediaEmptyState kind="clips" own={own} channelName={channel.displayName} />
                ) : (
                  <ClipsFilteredEmpty />
                )
              }
            />
          </div>
        ),
        // Live, the banner moves into About; offline it already heads the page.
        about: aboutSection(live),
      }}
    />
  );
  const chat = (
    <ChatPanel
      channel={channel.slug}
      stream={{ id: channel.id, live: channel.live !== null, slug: channel.slug }}
      signedIn={signedIn}
      selfUsername={me?.username ?? null}
      channelName={channel.displayName}
      ageGated={stage === "mature-gate" || stage === "restricted-locked"}
      // J3-d: a followers-only chat says why before the viewer types.
      following={follow.state.following ?? null}
      // Bounded so the log scrolls inside it; below `lg` it fills the viewport under the player
      // (D4.1), in theatre it is the theatre's height.
      className={chatColumnClass({ theatre: theatreLayout, fill: true })}
    />
  );
  // Below `lg`, the About panel: the stream title and the count's note (the compact row leaves
  // them out), then the channel's tabs.
  const details = (
    <div
      data-watch-slot="details"
      className={cn(
        "flex min-w-0 flex-col gap-4",
        theatreLayout ? null : "px-4 pt-2 pb-8 lg:p-0",
        panel === "about" ? null : "max-lg:hidden",
      )}
    >
      {theatreLayout ? null : (
        <div data-testid="watch-about-intro" className="flex min-w-0 flex-col gap-1 lg:hidden">
          {channel.live?.title || channel.title ? (
            <p className="text-base font-semibold break-words">{channel.live?.title || channel.title}</p>
          ) : null}
          {live && !justStarted ? (
            <VerifiedViewers data-testid="channel-verified-viewers-mobile" className="text-xs text-muted-foreground" />
          ) : null}
        </div>
      )}
      {tabs}
    </div>
  );

  // The player and chat keep their place in the tree in every layout (only class names change), so
  // toggling theatre or the panel, or crossing `lg`, never remounts them: no new `playback.start`
  // or lost DVR position, and chat keeps its connection, scroll and draft. Only the header and
  // tabs move. Default: page width, chat beside the stage and details from `lg`; below it the
  // phone layout (`watch-layout.css`). Theatre (`lg` only, decision (b)): the stage spans the
  // viewport with chat docked right, and the details follow at page width.
  return (
    <div
      data-testid="channel-page"
      data-layout={theatreLayout ? "theatre" : "default"}
      data-watch-layout=""
      data-watch-panel={panel}
      className={cn(
        "flex min-w-0 flex-col",
        theatreLayout ? "w-full gap-4 pb-4" : "mx-auto w-full max-w-7xl lg:px-4 lg:py-4",
      )}
    >
      <div
        data-watch-slot="columns"
        className={cn("flex min-w-0 flex-col lg:flex-row", theatreLayout ? null : "lg:gap-6")}
      >
        <div data-watch-slot="main" className="flex min-w-0 flex-col lg:flex-1 lg:gap-4">
          <div className="flex min-w-0 flex-col gap-4 px-4 empty:hidden lg:px-0">
            <MovedNotice channelName={channel.displayName} movedTo={channel.movedTo} />
            {/* After checkout (F12): announced before the player. */}
            <CheckoutReturn channelName={channel.displayName} />
          </div>
          {/* Offline, the banner heads the page; live it sits in About so the player comes first. */}
          {live ? null : banner}
          {stageNode ? <div data-watch-slot="stage">{stageNode}</div> : null}
          {theatreLayout ? null : (
            <>
              {header}
              <WatchPanelSwitch value={panel} onChange={setPanel} />
              {details}
            </>
          )}
        </div>
        {/* Collapsed in theatre, chat stays mounted (connection, scroll and draft kept) but hidden. */}
        <aside
          data-watch-slot="chat"
          className={cn(
            "min-w-0 lg:w-80 lg:shrink-0",
            theatreLayout && chatHidden && "hidden",
            panel === "chat" ? null : "max-lg:hidden",
          )}
        >
          {chat}
        </aside>
      </div>
      {theatreLayout ? (
        <div className="mx-auto flex w-full max-w-7xl min-w-0 flex-col gap-4 px-4">
          {header}
          {details}
        </div>
      ) : null}
    </div>
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
