// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The offline channel as a content page (F2, overhaul wave 2 D3.8; mockup
 * product/channel-offline.html).
 *
 * - `OfflineHero` (`channel-offline-hero`): the latest VOD in the player's poster state, as one
 *   link to its watch page. Nothing loads or plays here.
 * - `OfflineChannelHome` (`channel-offline-home`): the Follow hero (the latest video beside a
 *   card that says when they were last live, or when the next stream is when it is known
 *   (`Channel.nextStreamAt`, overhaul wave 5: a date block, the weekday and time in the viewer's
 *   zone, "Add to calendar" and "Subscribe in calendar"), with Follow), then recent clips, the
 *   other videos, About with the panels, and the Live now shelf at the end so the visitor always
 *   has somewhere to go.
 */
import {
  formatDuration,
  MediaFallback,
  monthNames,
  OverlayBadge,
  RelativeTime,
  useLocale,
  type Accent,
} from "@commonair/ui";
import { Button } from "@commonair/ui/components/button";
import { cn } from "@commonair/ui/lib/utils";
import { PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { AddToCalendar, SubscribeInCalendar } from "../schedule/calendar-links.tsx";
import { localHhmm, localIsoWeekday, weekdayKey } from "../schedule/model.ts";
import { SHELF_SIZE } from "./channel-data.ts";
import { LiveNowShelf } from "./live-now-shelf.tsx";
import { MediaShelf, tileTitle, VideoThumbnail, type VideoTile } from "./video-grid.tsx";

export function OfflineHero({ tile }: { tile: VideoTile }): React.JSX.Element {
  const title = tileTitle(tile);
  return (
    <section data-testid="channel-offline-hero" data-vod={tile.id} aria-labelledby={`hero-${tile.id}`}>
      <Link
        to="/$channel/vods/$vodId"
        params={{ channel: tile.channelSlug, vodId: tile.id }}
        className="group flex min-w-0 flex-col gap-3 rounded-none outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <VideoThumbnail tile={tile} className="border">
          <PlayMark />
        </VideoThumbnail>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground uppercase">{t("channel.offline.latest")}</span>
          <h2 id={`hero-${tile.id}`} className="line-clamp-2 text-base font-semibold break-words group-hover:underline">
            {title}
          </h2>
          <span className="text-xs text-muted-foreground">
            <RelativeTime date={tile.createdAt} tooltip={false} />
          </span>
        </span>
      </Link>
    </section>
  );
}

function PlayMark(): React.JSX.Element {
  return (
    <span className="absolute inset-0 flex items-center justify-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-overlay text-overlay-foreground transition-transform group-hover:scale-105 motion-reduce:transition-none motion-reduce:group-hover:scale-100">
        <HugeiconsIcon icon={PlayIcon} strokeWidth={2} aria-hidden className="size-6" />
      </span>
    </span>
  );
}

/** The channel's next stream, when a schedule says so. */
export interface NextStream {
  /** ISO 8601 with offset. */
  startsAt: string;
  endsAt?: string | null;
  title?: string | null;
}

/** How the Follow hero introduces the channel. */
export type OfflineHeroState = "next" | "lastLive" | "never";

export function offlineHeroState(lastLiveAt: string | null, next: NextStream | null): OfflineHeroState {
  if (next) return "next";
  return lastLiveAt ? "lastLive" : "never";
}

/** `Channel.nextStreamAt` as the hero's next stream; a time already past is no next stream. */
export function nextStreamOf(nextStreamAt: string | null | undefined, now: number): NextStream | null {
  if (!nextStreamAt) return null;
  const at = Date.parse(nextStreamAt);
  return Number.isNaN(at) || at <= now ? null : { startsAt: nextStreamAt };
}

export interface OfflineChannelHomeProps {
  channel: { slug: string; displayName: string; accent: Accent | null; avatarUrl: string | null };
  /** `Channel.lastLiveAt`; null when it never streamed. */
  lastLiveAt: string | null;
  /** Playable videos, newest first: the first is the hero, the rest the Videos shelf. */
  videos: readonly VideoTile[];
  clips: readonly VideoTile[];
  /** The Follow button (the page's one filled call to action, in the channel's accent). */
  follow: React.ReactNode;
  /** The visitor owns the channel: no Follow; the way to the studio instead. */
  own: boolean;
  /** About and the panels (`ChannelAboutSection`). */
  about: React.ReactNode;
  /** When the next stream is known (`Channel.nextStreamAt`). */
  nextStream?: NextStream | null;
  /** The instance's public URL, for the calendar feed's `webcal:` link. */
  publicUrl?: string;
  /** The shelf at the end; tests pass their own. */
  liveNow?: React.ReactNode;
}

export function OfflineChannelHome(p: OfflineChannelHomeProps): React.JSX.Element {
  const [latest, ...older] = p.videos;
  return (
    <div data-testid="channel-offline-home" className="flex min-w-0 flex-col gap-8">
      <OfflineFollowHero {...p} latest={latest ?? null} />
      <MediaShelf
        kind="clips"
        heading={t("channel.tabs.recentClips")}
        tiles={p.clips.slice(0, SHELF_SIZE)}
        channel={p.channel.slug}
      />
      <MediaShelf
        kind="vods"
        heading={t("channel.tabs.moreVideos")}
        tiles={older.slice(0, SHELF_SIZE)}
        channel={p.channel.slug}
      />
      {p.about}
      {p.liveNow ?? <LiveNowShelf />}
    </div>
  );
}

function OfflineFollowHero({
  channel,
  lastLiveAt,
  follow,
  own,
  nextStream = null,
  publicUrl,
  latest,
}: OfflineChannelHomeProps & { latest: VideoTile | null }): React.JSX.Element {
  const headingId = React.useId();
  const state = offlineHeroState(lastLiveAt, nextStream);
  const name = channel.displayName;
  return (
    <section
      data-testid="channel-offline-follow-hero"
      data-state={state}
      data-accent={channel.accent ?? undefined}
      aria-labelledby={headingId}
      className="grid min-w-0 grid-cols-1 gap-0 bg-card ring-1 ring-foreground/10 md:grid-cols-hero-split"
    >
      {latest ? (
        <Link
          data-testid="channel-offline-hero"
          data-vod={latest.id}
          to="/$channel/vods/$vodId"
          params={{ channel: latest.channelSlug, vodId: latest.id }}
          aria-label={t("d3Watch.offline.latestLabel", { title: tileTitle(latest) })}
          className="group relative block min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <VideoThumbnail tile={latest}>
            <OverlayBadge size="sm" className="absolute start-2 top-2">
              {t("channel.offline.latest")}
            </OverlayBadge>
            <PlayMark />
          </VideoThumbnail>
        </Link>
      ) : (
        <div className="aspect-video min-w-0">
          <MediaFallback accent={channel.accent} name={name} avatarSrc={channel.avatarUrl} kind="offline" />
        </div>
      )}
      <div className="flex min-w-0 flex-col gap-3 p-4 md:p-6">
        <p className="text-xs font-medium text-muted-foreground uppercase">{t("channel.offline", { name })}</p>
        <h2 id={headingId} data-testid="channel-offline-heading" className="text-lg font-semibold break-words">
          {state === "next" && nextStream ? (
            <>
              {t("d3Watch.offline.next")} <RelativeTime date={nextStream.startsAt} />
            </>
          ) : state === "lastLive" && lastLiveAt ? (
            <>
              {t("channel.offline.lastLive")} <RelativeTime date={lastLiveAt} />
            </>
          ) : (
            t("d3Watch.offline.never", { name })
          )}
        </h2>
        {state === "next" && nextStream ? <NextSlot next={nextStream} accented={channel.accent !== null} /> : null}
        {own ? null : (
          <p className="text-sm text-muted-foreground">
            {state === "never" ? t("d3Watch.offline.neverBody") : t("d3Watch.offline.followBody")}
          </p>
        )}
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {own ? (
            <Button variant="outline" nativeButton={false} render={<Link to="/dashboard" />}>
              {t("channel.tabs.streamManager")}
            </Button>
          ) : (
            follow
          )}
          {nextStream ? <AddToCalendar slug={channel.slug} /> : null}
          {nextStream && publicUrl ? <SubscribeInCalendar slug={channel.slug} publicUrl={publicUrl} /> : null}
        </div>
        {latest ? (
          <p data-testid="channel-offline-latest-meta" className="mt-auto text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{tileTitle(latest)}</span>
            {" · "}
            <span className="tabular-nums">{formatDuration(latest.durationSeconds)}</span>
            {" · "}
            <RelativeTime date={latest.createdAt} tooltip={false} />
          </p>
        ) : null}
      </div>
    </section>
  );
}

const noSubscription = () => () => undefined;
const onClient = () => true;
const onServer = () => false;

/**
 * The next stream as a date block (month and day, in the channel's accent) beside its weekday and
 * time in the viewer's zone and its title when known. The time is a 24-hour clock, as schedules
 * are written.
 */
function NextSlot({ next, accented }: { next: NextStream; accented: boolean }): React.JSX.Element | null {
  const { locale } = useLocale();
  // The viewer's zone is the browser's: the server's render would show its own, so this waits.
  const hydrated = React.useSyncExternalStore(noSubscription, onClient, onServer);
  if (!hydrated) return null;
  const start = new Date(next.startsAt);
  return (
    <div data-testid="channel-next-stream" data-starts-at={next.startsAt} className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden
        className={cn(
          "flex size-12 shrink-0 flex-col items-center justify-center",
          accented ? "bg-channel-accent text-channel-accent-foreground" : "bg-muted text-foreground",
        )}
      >
        <span className="text-xs uppercase">{monthNames(locale, "short")[start.getMonth()]}</span>
        <span className="text-base font-semibold tabular-nums">{start.getDate()}</span>
      </span>
      <span className="flex min-w-0 flex-col">
        {next.title ? <span className="text-sm font-medium break-words">{next.title}</span> : null}
        <span className="text-sm text-muted-foreground">
          {t("w5Schedule.card.when", { weekday: t(weekdayKey(localIsoWeekday(start))), time: localHhmm(start) })}
        </span>
      </span>
    </div>
  );
}
