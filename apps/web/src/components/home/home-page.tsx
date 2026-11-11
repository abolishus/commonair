// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Home v2 (overhaul wave 2, D2.3 and D3.1), full at two channels live and at two hundred:
 *
 * - signed out, the hero with one real live stream at feature size; signed in, the featured
 *   stream alone; a streamer who is live gets the compact live-status bar instead (F7);
 * - Following live (signed in), then Live now, backfilled with labelled videos below four cards;
 * - Continue watching (this browser's resume points), Catch up and Fresh clips;
 * - every category (never "0 live"), the co-op band, Recently live as chips, the stream band.
 *
 * Every shelf fails on its own. The wrapper keeps `data-testid="directory"` and the live shelves
 * keep their `directory-section` ids, which the harness reads.
 */
import type { Category } from "@commonair/contracts/dto";
import { EmptyState } from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { PageContainer } from "@commonair/ui/layouts";
import { LiveStreaming02Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import type { SessionUser } from "../../lib/bootstrap-types.ts";
import { collidingNames, type DirectoryHome } from "../../lib/directory-sections.ts";
import { primeHomeFeed } from "../discovery/feed.ts";
import type { HomeShelves, LoaderResult } from "../discovery/loaders.ts";
import { ownChannelSlug, withoutOwnChannel } from "../discovery/own-channel.ts";
import { OwnLiveStatus } from "../discovery/own-live-status.tsx";
import { CoopBand, StreamBand } from "./bands.tsx";
import { CREATORS_HREF, FeaturedStream, SignedOutHero } from "./hero.tsx";
import { backfill, homeCategories, homeLive } from "./model.ts";
import {
  CatchUpShelf,
  CategoriesShelf,
  ContinueWatchingShelf,
  FollowingShelf,
  FreshClipsShelf,
  LiveNowShelf,
  RecentShelf,
  ShelfError,
} from "./shelves.tsx";
import { useTrackView } from "./track.ts";

export interface HomePageProps {
  /** `directory.home`; null when it did not load. */
  home: DirectoryHome | null;
  categories: LoaderResult<Category[]>;
  shelves: HomeShelves;
  me: SessionUser | null;
  /** The instance's name, for "Live now on {site}" and "Stream on {site}". */
  site: string;
  /** The feed's viewer key (`feedViewer(me)`). */
  viewer: string;
}

export function HomePage({ home, categories, shelves, me, site, viewer }: HomePageProps): React.JSX.Element {
  const signedIn = me !== null;
  // The rail and the sheet read the same `directory.home`: hand them this copy. A layout effect,
  // so it lands before the rail's subscribe effect and it does not ask again.
  React.useLayoutEffect(() => {
    if (home) primeHomeFeed(home, viewer);
  }, [home, viewer]);
  const slug = ownChannelSlug(me);
  const own = React.useMemo(() => (home ? withoutOwnChannel(home, slug) : null), [home, slug]);
  const live = React.useMemo(() => (own ? homeLive(own.home, signedIn) : null), [own, signedIn]);
  const videos = shelves.videos.status === "ok" ? shelves.videos.data : [];
  const coop = shelves.coop.status === "ok" ? shelves.coop.data : null;
  const ownLive = own?.ownLive ?? null;

  // A live streamer's own bar takes the feature's place; the featured stream then leads Live now.
  const featured = live && !ownLive ? live.featured : null;
  const liveCards = live ? [...(ownLive && live.featured ? [live.featured] : []), ...live.live] : [];
  // Signed out with nobody live, the newest video is the feature, so the shelves start after it.
  const recordedFeature = !signedIn && live !== null && live.liveTotal === 0 ? (videos[0] ?? null) : null;
  const rest = recordedFeature ? videos.slice(1) : videos;
  const { fill, catchUp } = backfill(liveCards.length, rest);
  const nothing = live !== null && live.liveTotal === 0 && videos.length === 0;
  const collisions = React.useMemo(
    () =>
      collidingNames(
        [
          ...(live?.featured ? [live.featured] : []),
          ...(live?.following ?? []),
          ...(live?.live ?? []),
          ...(live?.recent ?? []),
        ].map((c) => c.channel),
      ),
    [live],
  );
  const cats: LoaderResult<Category[]> =
    categories.status === "ok" ? { status: "ok", data: homeCategories(categories.data) } : categories;

  return (
    <PageContainer width="wide" className="flex flex-col gap-10 py-6">
      {signedIn && <h1 className="sr-only">{t("pageTitle.home")}</h1>}
      <div data-testid="directory" className="flex min-w-0 flex-col gap-10">
        {ownLive ? (
          <OwnLiveStatus card={ownLive} />
        ) : !signedIn ? (
          <SignedOutHero
            site={site}
            featured={featured}
            latestVideo={recordedFeature}
            coop={coop}
            collisions={collisions}
          />
        ) : featured ? (
          <FeaturedStream card={featured} collisions={collisions} />
        ) : null}
        {live === null ? (
          <ShelfError id="live" testId="home-live-load-error" />
        ) : nothing ? (
          <NothingYet signedIn={signedIn} />
        ) : (
          <>
            <FollowingShelf cards={live.following} collisions={collisions} />
            <LiveNowShelf cards={liveCards} fill={fill} liveTotal={live.liveTotal} collisions={collisions} />
          </>
        )}
        <ContinueWatchingShelf />
        <CatchUpShelf result={shelves.videos} videos={catchUp} />
        <FreshClipsShelf result={shelves.clips} />
        <CategoriesShelf result={cats} />
        <CoopBand coop={coop} />
        {live && <RecentShelf cards={live.recent} collisions={collisions} />}
        {!ownLive && <StreamBand site={site} creatorShare={coop?.creatorShare ?? null} />}
      </div>
    </PageContainer>
  );
}

/** Nobody live and no video yet: say so, and offer the way to change it. */
function NothingYet({ signedIn }: { signedIn: boolean }): React.JSX.Element {
  useTrackView("home.empty");
  return (
    <EmptyState
      data-testid="directory-empty"
      icon={LiveStreaming02Icon}
      title={t("d3Home.empty.title")}
      description={t("d3Home.empty.body")}
      headingLevel={2}
      action={
        signedIn ? (
          <Button variant="outline" nativeButton={false} render={<Link to="/dashboard" />}>
            {t("home.toDashboard")}
          </Button>
        ) : (
          <Button
            variant="outline"
            nativeButton={false}
            render={<a href={CREATORS_HREF} aria-label={t("d3Home.empty.action")} />}
          >
            {t("d3Home.empty.action")}
          </Button>
        )
      }
    />
  );
}
