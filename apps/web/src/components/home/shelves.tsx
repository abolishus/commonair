// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Home v2's shelves (D3.1). Each one fails on its own with the section-load-error pattern and
 * hides when it has nothing to show (except Live now, which always says what is going on). Every
 * shelf counts its view and its clicks as `home.shelf` with its id as the step.
 */
import type { Category, ChannelCard, ClipCard, StreamCard, VodCard } from "@commonair/contracts/dto";
import {
  ChannelChip,
  ChannelChipRow,
  formatCompactNumber,
  formatDuration,
  IconButton,
  RelativeTime,
  useLocale,
} from "@commonair/ui";
import { CardGrid, MediaCard } from "@commonair/ui/blocks/media";
import { Section } from "@commonair/ui/blocks/headers";
import { Button } from "@commonair/ui/components/button";
import { Progress } from "@commonair/ui/components/progress";
import { toast } from "@commonair/ui/toast";
import { ArrowRight01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import type { MessageKey } from "../../i18n/keys/index.gen.ts";
import { displayLabel } from "../../lib/directory-sections.ts";
import type { ResumePoint } from "../../lib/resume.ts";
import { RouteSectionLoadError } from "../../lib/section-load-error.tsx";
import { trackUi } from "../../lib/ui-metrics.ts";
import { DiscoveryCategoryGrid } from "../discovery/category-tiles.tsx";
import type { LoaderResult } from "../discovery/loaders.ts";
import { DiscoveryStreamCard, DiscoveryStreamGrid } from "../discovery/stream-cards.tsx";
import { videoMedia } from "./hero.tsx";
import { continueWatching, MEDIA_SHELF, watchedShare, type HomeShelfId } from "./model.ts";
import { useTrackView } from "./track.ts";
import { useResumePoints } from "./use-resume.ts";

const SHELF_TITLES: Record<HomeShelfId, MessageKey> = {
  live: "d3Home.live.title",
  continue: "d3Home.continue.title",
  videos: "d3Home.catchUp.title",
  clips: "d3Home.clips.title",
  categories: "d3Home.categories.title",
  recent: "d3Home.recent.title",
};

/** A link click inside a shelf, counted once per click (the link itself navigates as usual). */
function countLinkClick(id: HomeShelfId) {
  return (event: React.MouseEvent) => {
    if (event.target instanceof Element && event.target.closest("a")) trackUi("home.shelf", "click", id);
  };
}

interface ShelfProps extends Omit<React.ComponentProps<"section">, "children"> {
  id: HomeShelfId;
  heading?: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  [key: `data-${string}`]: string | undefined;
}

/** A shelf: a `Section` with its view and clicks counted. */
export function Shelf({ id, heading, description, action, children, ...props }: ShelfProps): React.JSX.Element {
  useTrackView("home.shelf", id);
  return (
    <Section
      data-testid="home-shelf"
      data-shelf={id}
      {...props}
      heading={heading ?? t(SHELF_TITLES[id])}
      {...(description ? { description } : {})}
      action={action}
      onClickCapture={countLinkClick(id)}
    >
      {children}
    </Section>
  );
}

function SeeAll({ to, label }: { to: "/directory"; label: string }): React.JSX.Element {
  return (
    <Button variant="ghost" size="sm" nativeButton={false} render={<Link to={to} />} aria-label={label}>
      {t("d3Home.live.seeAll")}
      <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} aria-hidden className="rtl:-scale-x-100" />
    </Button>
  );
}

/** A section that did not load: its own heading in the error, Retry reloads the route. */
export function ShelfError({ id, testId }: { id: HomeShelfId; testId?: string }): React.JSX.Element {
  return (
    <RouteSectionLoadError data-testid={testId ?? "home-shelf-error"} section={t(SHELF_TITLES[id])} headingLevel={2} />
  );
}

function VideoTile({ video, kind, lazy = true }: { video: VodCard; kind?: string; lazy?: boolean }): React.JSX.Element {
  return (
    <MediaCard
      data-testid="home-video"
      data-vod={video.id}
      kind="vod"
      headingLevel={3}
      lazy={lazy}
      media={videoMedia(video, kind)}
      href={`/${video.channel.slug}/vods/${video.id}`}
      render={<Link to="/$channel/vods/$vodId" params={{ channel: video.channel.slug, vodId: video.id }} />}
    />
  );
}

export interface LiveNowShelfProps {
  cards: StreamCard[];
  /** Videos filling the row when fewer than four channels are live (each labelled "Video"). */
  fill: VodCard[];
  /** Channels live on the page in all, for the backfill note. */
  liveTotal: number;
  collisions: ReadonlySet<string>;
}

/**
 * Live now (`directory-section` / `live`, as the harness finds live cards): everyone live the
 * featured stream and Following did not show, then the backfill. With nobody live at all and only
 * videos, it is "Latest videos".
 */
export function LiveNowShelf({ cards, fill, liveTotal, collisions }: LiveNowShelfProps): React.JSX.Element | null {
  if (cards.length === 0 && fill.length === 0) return null;
  const nobody = liveTotal === 0;
  const note =
    fill.length === 0
      ? undefined
      : nobody
        ? t("d3Home.live.backfillNone")
        : t("d3Home.live.backfill", { count: liveTotal });
  return (
    <Shelf
      id="live"
      data-testid="directory-section"
      data-section="live"
      heading={nobody ? t("d3Home.live.latest") : t("d3Home.live.title")}
      description={note}
      action={nobody ? undefined : <SeeAll to="/directory" label={t("d3Home.live.seeAllLabel")} />}
    >
      <CardGrid max={4}>
        {cards.map((card, index) => (
          <DiscoveryStreamCard key={card.channel.id} card={card} collisions={collisions} lazy={index >= 4} />
        ))}
        {fill.map((video) => (
          <VideoTile key={video.id} video={video} kind={t("d3Home.video.kind")} />
        ))}
      </CardGrid>
    </Shelf>
  );
}

/** Followed channels live now (`directory-section` / `following`), signed in only. */
export function FollowingShelf({
  cards,
  collisions,
}: {
  cards: StreamCard[];
  collisions: ReadonlySet<string>;
}): React.JSX.Element | null {
  if (cards.length === 0) return null;
  return (
    <Section data-testid="directory-section" data-section="following" heading={t("d3Home.following.title")}>
      <DiscoveryStreamGrid cards={cards} collisions={collisions} showReason={false} dense />
    </Section>
  );
}

/** Continue watching (D3.6): this browser's resume points, videos only, each with Remove. */
export function ContinueWatchingShelf(): React.JSX.Element | null {
  const { points, remove } = useResumePoints();
  // Hidden at once, even when storage is blocked and the point cannot be dropped there.
  const [removed, setRemoved] = React.useState<ReadonlySet<string>>(new Set());
  const shown = continueWatching(points.filter((p) => !removed.has(p.vodId)));
  if (shown.length === 0) return null;
  return (
    <ContinueWatchingRow
      points={shown}
      onRemove={(id) => {
        setRemoved((prev) => new Set([...prev, id]));
        remove(id);
        toast.success(t("d3Home.continue.removed"));
      }}
    />
  );
}

function ContinueWatchingRow({
  points,
  onRemove,
}: {
  points: ResumePoint[];
  onRemove: (vodId: string) => void;
}): React.JSX.Element {
  return (
    <Shelf id="continue">
      <CardGrid max={4}>
        {points.map((point) => (
          <div key={point.vodId} data-testid="home-continue" data-vod={point.vodId} className="relative min-w-0">
            <MediaCard
              kind="vod"
              headingLevel={3}
              media={{
                id: point.vodId,
                title: point.title,
                thumbnailUrl: point.thumbnailUrl,
                duration: formatDuration(point.durationSeconds),
                kind: t("d3Home.video.kind"),
                views: t("d3Home.continue.left", {
                  position: formatDuration(point.positionSeconds),
                  duration: formatDuration(point.durationSeconds),
                }),
              }}
              href={`/${point.channelSlug}/vods/${point.vodId}`}
              render={<Link to="/$channel/vods/$vodId" params={{ channel: point.channelSlug, vodId: point.vodId }} />}
            />
            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-0 block aspect-video">
              <Progress
                value={Math.round(watchedShare(point) * 100)}
                data-testid="home-continue-progress"
                data-percent={Math.round(watchedShare(point) * 100)}
                className="absolute inset-x-0 bottom-0"
              />
            </span>
            <IconButton
              data-testid="home-continue-remove"
              variant="secondary"
              size="icon-sm"
              icon={Cancel01Icon}
              label={t("d3Home.continue.remove", { title: point.title })}
              onClick={() => onRemove(point.vodId)}
              className="absolute end-2 top-2 z-10"
            />
          </div>
        ))}
      </CardGrid>
    </Shelf>
  );
}

/** Catch up: the newest videos across channels (after the ones Live now borrowed). */
export function CatchUpShelf({
  result,
  videos,
}: {
  result: LoaderResult<VodCard[]>;
  videos: VodCard[];
}): React.JSX.Element | null {
  if (result.status === "failed") return <ShelfError id="videos" testId="home-videos-load-error" />;
  if (videos.length === 0) return null;
  return (
    <Shelf id="videos">
      <CardGrid max={4}>
        {videos.slice(0, MEDIA_SHELF).map((video) => (
          <VideoTile key={video.id} video={video} />
        ))}
      </CardGrid>
    </Shelf>
  );
}

/** Fresh clips across channels. */
export function FreshClipsShelf({ result }: { result: LoaderResult<ClipCard[]> }): React.JSX.Element | null {
  const { locale } = useLocale();
  if (result.status === "failed") return <ShelfError id="clips" testId="home-clips-load-error" />;
  if (result.data.length === 0) return null;
  return (
    <Shelf id="clips">
      <CardGrid max={4}>
        {result.data.slice(0, MEDIA_SHELF).map((clip) => (
          <MediaCard
            key={clip.id}
            data-testid="home-clip"
            data-clip={clip.id}
            kind="clip"
            headingLevel={3}
            media={{
              id: clip.id,
              title: clip.title,
              thumbnailUrl: clip.thumbnailUrl,
              accent: clip.channel.accent,
              channelName: clip.channel.displayName,
              duration: formatDuration(clip.durationSeconds),
              kind: t("d3Home.clips.kind"),
              views: t("d3Home.clips.views", {
                count: clip.views,
                formatted: formatCompactNumber(clip.views, locale),
              }),
              ...(clip.creator ? { clippedBy: t("d3Home.clips.by", { name: clip.creator.displayName }) } : {}),
            }}
            href={`/${clip.channel.slug}/clips/${clip.id}`}
            render={<Link to="/$channel/clips/$clipId" params={{ channel: clip.channel.slug, clipId: clip.id }} />}
          />
        ))}
      </CardGrid>
    </Shelf>
  );
}

/** Every category (live first); the quiet ones draw muted, never with "0 live". */
export function CategoriesShelf({ result }: { result: LoaderResult<Category[]> }): React.JSX.Element | null {
  if (result.status === "failed") return <ShelfError id="categories" testId="home-categories-load-error" />;
  if (result.data.length === 0) return null;
  return (
    <Shelf
      id="categories"
      data-testid="home-categories-shelf"
      action={<SeeAll to="/directory" label={t("d3Home.categories.seeAll")} />}
    >
      <DiscoveryCategoryGrid categories={result.data} columns={6} />
    </Shelf>
  );
}

/** Recently live, as compact `ChannelChip` rows (D3.1). */
export function RecentShelf({
  cards,
  collisions,
}: {
  cards: ChannelCard[];
  collisions: ReadonlySet<string>;
}): React.JSX.Element | null {
  if (cards.length === 0) return null;
  return (
    <Shelf id="recent" data-testid="directory-section" data-section="recent">
      <ChannelChipRow>
        {cards.map((card) => (
          <ChannelChip
            key={card.channel.id}
            data-testid="home-recent-tile"
            data-channel={card.channel.slug}
            name={displayLabel(collisions, card.channel)}
            href={`/${card.channel.slug}`}
            render={<Link to="/$channel" params={{ channel: card.channel.slug }} />}
            avatarSrc={card.channel.avatarUrl}
            accent={card.channel.accent}
            meta={<RecentMeta card={card} />}
          />
        ))}
      </ChannelChipRow>
    </Shelf>
  );
}

function RecentMeta({ card }: { card: ChannelCard }): React.JSX.Element {
  return (
    <>
      {card.category && <span dir="auto">{card.category.name} · </span>}
      {card.lastLiveAt ? <RelativeTime date={card.lastLiveAt} tooltip={false} /> : t("d3Home.recent.never")}
    </>
  );
}
