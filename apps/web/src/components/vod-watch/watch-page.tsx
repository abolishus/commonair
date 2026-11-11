// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The public VOD and clip watch pages (W2-vod-watch; batch 6 decision (e)): the recording with the
 * chat replay panel beside it from `lg`, below it on narrow screens. What the caller may not watch
 * is one not-found state (`state.ts`); a recording still processing says it is not ready yet; a
 * mature recording shows the 18+ gate (`components/safety`). Loaded in the browser, so the
 * per-viewer answers (subscriber, owner, blocks, 18+) never pass through a shared render.
 */
import { EmptyState, formatDuration, SkeletonGroup, SkeletonText, SkeletonThumbnail } from "@commonair/ui";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { Button } from "@commonair/ui/components/button";
import { Clock01Icon, Film02Icon, PlayIcon, Tv01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { ReplayPanel } from "../../chat/replay/replay-panel.tsx";
import type { ReplayFetch, ReplayFetchInput, ReplayPage } from "../../chat/replay/model.ts";
import { dateToMicros } from "../../chat/replay/time.ts";
import { t } from "../../i18n/index.ts";
import { api, errorCode } from "../../lib/api.ts";
import { summarize } from "../../lib/channel-summary.ts";
import { CHANNEL_MEDIA_PAGE, type ClipItem, type MediaPage, type VodItem } from "../channel/channel-data.ts";
import { maturityClient, type MaturityClient } from "../safety/client.ts";
import { MatureGate } from "../safety/mature-gate.tsx";
import { momentStart, playheadSeconds, seekToStart, type WatchKind } from "../watch/share.ts";
import { resumeOffer, useResumeWriter, type ResumeVideo } from "./resume-writer.ts";
import {
  useWatchChannel,
  WatchChannelCard,
  type ChannelCard,
  type ChannelCardState,
} from "../watch/watch-channel-card.tsx";
import type { Clipboard } from "../channel/channel-meta.tsx";
import { WatchMeta } from "../watch/watch-meta.tsx";
import { WatchMore } from "../watch/watch-more.tsx";
import { WatchNotAvailable } from "../watch/watch-not-available.tsx";
import { clipState, vodState, type ClipDto, type VodDto, type WatchState } from "./state.ts";
import {
  VodPlayer,
  type PlayerProgress,
  type VodPlayerProps,
  type WatchPlayerHandle,
  type WatchSource,
} from "./vod-player.tsx";

export type { ChannelCard } from "../watch/watch-channel-card.tsx";

/** The calls the pages make; tests pass stubs. */
export interface WatchClient {
  vod: (id: string) => Promise<VodDto>;
  clip: (id: string) => Promise<ClipDto>;
  /** The channel card; polled while the page is open (`CHANNEL_POLL_MS`). */
  channel: (slug: string) => Promise<ChannelCard>;
  vodChat: (id: string, input: ReplayFetchInput) => Promise<ReplayPage>;
  clipChat: (id: string, input: ReplayFetchInput) => Promise<ReplayPage>;
  /** "More from": the channel's first page of VODs / clips (defaults to the API). */
  channelVods?: (slug: string) => Promise<MediaPage<VodItem>>;
  channelClips?: (slug: string) => Promise<MediaPage<ClipItem>>;
}

const listVods = async (channel: string) => api().vods.list({ channel, limit: CHANNEL_MEDIA_PAGE });
const listClips = async (channel: string) => api().clips.list({ channel, limit: CHANNEL_MEDIA_PAGE, sort: "recent" });

export const watchClient = (): WatchClient => ({
  vod: (id) => api().vods.get({ id }),
  clip: (id) => api().clips.get({ id }),
  channel: async (slug) => {
    const requestedAt = Date.now();
    const c = summarize(await api().channels.get({ channel: slug }));
    return {
      displayName: c.displayName,
      avatarUrl: c.avatarUrl,
      accent: c.accent,
      followerCount: c.followerCount,
      following: c.following,
      live: c.live ? { viewerCount: c.live.viewerCount } : null,
      requestedAt,
    };
  },
  vodChat: (id, input) => api().vods.chat({ id, ...input }),
  clipChat: (id, input) => api().clips.chat({ id, ...input }),
  channelVods: listVods,
  channelClips: listClips,
});

/** The signed-in viewer as the pages need it. */
export interface WatchViewer {
  username: string;
}

interface CommonProps {
  /** The `$channel` route param. */
  channel: string;
  viewer: WatchViewer | null;
  client?: WatchClient;
  maturity?: MaturityClient;
  /** The instance's public URL, for Share (defaults to this page's origin). */
  publicUrl?: string;
  clipboard?: Clipboard | null;
}

type Loaded<T> = { kind: "loading" } | { kind: "missing" } | { kind: "error" } | { kind: "ok"; value: T };

/** Load `get(id)` again whenever the id, the viewer or `reloads` changes; NOT_FOUND is `missing`. */
function useEntity<T>(id: string, viewer: string | null, get: (id: string) => Promise<T>): [Loaded<T>, () => void] {
  const [reloads, setReloads] = React.useState(0);
  const [state, setState] = React.useState<{ key: string; loaded: Loaded<T> } | null>(null);
  const getRef = React.useRef(get);
  React.useEffect(() => {
    getRef.current = get;
  }, [get]);
  const key = `${id}|${viewer ?? ""}|${reloads}`;
  React.useEffect(() => {
    let live = true;
    getRef.current(id).then(
      (value) => live && setState({ key, loaded: { kind: "ok", value } }),
      (err: unknown) =>
        live && setState({ key, loaded: { kind: errorCode(err) === "NOT_FOUND" ? "missing" : "error" } }),
    );
    return () => {
      live = false;
    };
  }, [id, key]);
  // A finished load of an older key shows until the new one lands, except across ids.
  const loaded: Loaded<T> = state && state.key.split("|")[0] === id ? state.loaded : { kind: "loading" };
  return [loaded, () => setReloads((n) => n + 1)];
}

export function VodWatchPage({
  channel,
  vodId,
  viewer,
  client,
  maturity,
  publicUrl,
  clipboard,
  startAt = null,
}: CommonProps & {
  vodId: string;
  /** `?t=`: where playback starts, in seconds. */ startAt?: number | null;
}): React.JSX.Element {
  const c = useClient(client);
  const [loaded, reload] = useEntity(vodId, viewer?.username ?? null, c.vod);
  const vod = loaded.kind === "ok" ? loaded.value : null;
  const state = loaded.kind === "missing" ? "not-found" : vod ? vodState(vod, channel) : null;
  const card = useWatchChannel(channel, c.channel, { poll: state !== null && state !== "not-found" });
  const playlistUrl = vod?.playlistUrl ?? null;
  const source = React.useMemo<WatchSource | null>(
    () => (playlistUrl ? { kind: "hls", url: playlistUrl } : null),
    [playlistUrl],
  );
  const fetch = React.useCallback<ReplayFetch>((input) => c.vodChat(vodId, input), [c, vodId]);
  const more = React.useCallback(() => (c.channelVods ?? listVods)(channel), [c, channel]);
  // Continue watching (D3.6): only a playable video is written. The offer is read by the layout,
  // which mounts only once the video loaded in the browser (storage is per viewer, never SSR).
  const ready = state === "ready";
  const resumeVideo = React.useMemo<ResumeVideo | null>(
    () =>
      vod && ready
        ? {
            vodId: vod.id,
            channelSlug: vod.channelSlug,
            title: vod.title,
            thumbnailUrl: vod.thumbnailUrl,
            durationSeconds: vod.durationSeconds,
          }
        : null,
    [vod, ready],
  );
  const onProgress = useResumeWriter(resumeVideo);
  if (loaded.kind === "loading") return <WatchSkeleton />;
  if (loaded.kind === "error") return <WatchError onRetry={reload} />;
  if (!vod || state === null || state === "not-found") return <WatchNotAvailable slug={channel} channel={card} />;
  return (
    <WatchLayout
      testId="vod-watch-page"
      idAttr={{ "data-vod-id": vod.id }}
      state={state}
      variant="vod"
      id={vod.id}
      title={vod.title}
      slug={vod.channelSlug}
      createdAt={vod.createdAt}
      durationSeconds={vod.durationSeconds}
      category={vod.category}
      captions={vod.captions}
      source={source}
      fetch={fetch}
      replayKey={`vod:${vod.id}`}
      viewer={viewer}
      maturity={maturity}
      onConfirmed={reload}
      card={card}
      publicUrl={publicUrl}
      clipboard={clipboard}
      startAt={startAt}
      onProgress={onProgress}
      offerResume
      clip={{ channel: vod.channelSlug, vodId: vod.id, signedIn: viewer !== null, publicUrl }}
      more={
        <WatchMore
          kind="vod"
          slug={vod.channelSlug}
          channelName={cardName(card, vod.channelSlug)}
          currentId={vod.id}
          fetchPage={more}
        />
      }
    />
  );
}

export function ClipWatchPage({
  channel,
  clipId,
  viewer,
  client,
  maturity,
  publicUrl,
  clipboard,
}: CommonProps & { clipId: string }): React.JSX.Element {
  const c = useClient(client);
  const [loaded, reload] = useEntity(clipId, viewer?.username ?? null, c.clip);
  const clip = loaded.kind === "ok" ? loaded.value : null;
  const state = loaded.kind === "missing" ? "not-found" : clip ? clipState(clip, channel) : null;
  const card = useWatchChannel(channel, c.channel, { poll: state !== null && state !== "not-found" });
  const clipUrl = clip?.url ?? null;
  const windowStartedAt = clip?.windowStartedAt ?? null;
  const source = React.useMemo<WatchSource | null>(
    () => (clipUrl ? { kind: "mp4", url: clipUrl, windowStartedAt } : null),
    [clipUrl, windowStartedAt],
  );
  const fetch = React.useCallback<ReplayFetch>((input) => c.clipChat(clipId, input), [c, clipId]);
  const more = React.useCallback(() => (c.channelClips ?? listClips)(channel), [c, channel]);
  if (loaded.kind === "loading") return <WatchSkeleton />;
  if (loaded.kind === "error") return <WatchError onRetry={reload} />;
  if (!clip || state === null || state === "not-found") return <WatchNotAvailable slug={channel} channel={card} />;
  return (
    <WatchLayout
      testId="clip-watch-page"
      idAttr={{ "data-clip-id": clip.id }}
      state={state}
      variant="clip"
      id={clip.id}
      title={clip.title}
      slug={clip.channelSlug}
      createdAt={clip.createdAt}
      durationSeconds={clip.durationSeconds}
      category={clip.category}
      captions={[]}
      source={source}
      fetch={fetch}
      replayKey={`clip:${clip.id}`}
      viewer={viewer}
      maturity={maturity}
      onConfirmed={reload}
      card={card}
      publicUrl={publicUrl}
      clipboard={clipboard}
      views={clip.views}
      creator={clip.creator ? { displayName: clip.creator.displayName } : null}
      actions={
        clip.vodId !== null ? (
          <WatchFromMoment slug={clip.channelSlug} vodId={clip.vodId} offsetSeconds={clip.vodOffsetSeconds} />
        ) : null
      }
      more={
        <WatchMore
          kind="clip"
          slug={clip.channelSlug}
          channelName={cardName(card, clip.channelSlug)}
          currentId={clip.id}
          fetchPage={more}
        />
      }
    />
  );
}

const cardName = (card: ChannelCardState, slug: string) => (card.status === "ok" ? card.card.displayName : slug);

function useClient(client: WatchClient | undefined): WatchClient {
  const [fallback] = React.useState(() => client ?? watchClient());
  return client ?? fallback;
}

const pageOrigin = () => (typeof window !== "undefined" ? window.location.origin : "");

interface LayoutProps {
  testId: "vod-watch-page" | "clip-watch-page";
  idAttr: Record<`data-${string}`, string>;
  state: Exclude<WatchState, "not-found">;
  variant: WatchKind;
  id: string;
  title: string;
  slug: string;
  createdAt: string;
  durationSeconds: number;
  category: VodDto["category"];
  captions: VodDto["captions"];
  source: WatchSource | null;
  fetch: ReplayFetch;
  replayKey: string;
  viewer: WatchViewer | null;
  maturity: MaturityClient | undefined;
  onConfirmed: () => void;
  card: ChannelCardState;
  publicUrl: string | undefined;
  clipboard: Clipboard | null | undefined;
  startAt?: number | null;
  views?: number | null;
  creator?: { displayName: string } | null;
  more: React.ReactNode;
  /** Videos: Continue watching's writer. */
  onProgress?: (progress: PlayerProgress) => void;
  /** Videos: offer "Resume from m:ss" from Continue watching's stored point (D3.6). */
  offerResume?: boolean;
  /** Videos: the viewer's Clip button. */
  clip?: VodPlayerProps["clip"];
  /** Next steps under the details. */
  actions?: React.ReactNode;
}

function WatchLayout(p: LayoutProps): React.JSX.Element {
  const handle = React.useRef<WatchPlayerHandle>(null);
  const [clock, setClock] = React.useState<{ playhead: number | null; origin: number | null }>({
    playhead: null,
    origin: null,
  });
  const clockRef = React.useRef(clock);
  React.useEffect(() => {
    clockRef.current = clock;
  }, [clock]);
  const [gateClient] = React.useState(() => p.maturity ?? maturityClient());
  // `?t=`: seek once, as soon as the player knows where media time 0 is; a `t` past the end is dropped.
  const pendingStart = React.useRef(p.startAt ?? null);
  const duration = p.durationSeconds;
  const onPlayhead = React.useCallback(
    (at: Date | null) => {
      const start = pendingStart.current;
      if (start !== null && seekToStart(handle.current, start, duration) !== "pending") pendingStart.current = null;
      const origin = handle.current?.originWallclock() ?? null;
      setClock({ playhead: at ? dateToMicros(at) : null, origin: origin ? dateToMicros(origin) : null });
    },
    [duration],
  );
  const onSeek = React.useCallback((at: Date) => {
    handle.current?.seekToWallclock(at);
  }, []);
  const currentTime = React.useCallback(() => playheadSeconds(clockRef.current.playhead, clockRef.current.origin), []);
  // Read once when the layout mounts (in the browser, after the video loaded): the writer keeps
  // saving while the video plays, and the offer must not follow it.
  const [offer, setOffer] = React.useState<number | null>(() =>
    p.offerResume ? resumeOffer(p.id, p.startAt ?? null, p.durationSeconds) : null,
  );
  const resume = (at: number) => {
    // Before the player knows media time 0, the `?t=` path seeks as soon as it does.
    if (seekToStart(handle.current, at, duration) === "pending") pendingStart.current = at;
    setOffer(null);
  };
  const resumeAt = p.state === "ready" ? offer : null;
  const actions =
    resumeAt !== null || p.actions ? (
      <>
        {resumeAt !== null ? (
          <ResumeOffer at={resumeAt} onResume={() => resume(resumeAt)} onDismiss={() => setOffer(null)} />
        ) : null}
        {p.actions}
      </>
    ) : null;

  const stage =
    p.state === "gated" ? (
      <MatureGate signedIn={p.viewer !== null} onConfirmed={p.onConfirmed} client={gateClient} />
    ) : p.state === "not-ready" ? (
      <EmptyState
        data-testid="watch-not-ready"
        icon={Clock01Icon}
        title={t("replay.watch.notReady.title")}
        description={t("replay.watch.notReady.description")}
      />
    ) : p.source ? (
      <VodPlayer
        source={p.source}
        variant={p.variant}
        title={p.title}
        durationSeconds={p.durationSeconds}
        captions={p.captions}
        onPlayhead={onPlayhead}
        onProgress={p.onProgress}
        clip={p.clip}
        handleRef={handle}
      />
    ) : null;

  return (
    <PageContainer width="wide" className="py-4">
      <div data-testid={p.testId} data-state={p.state} {...p.idAttr} className="flex min-w-0 flex-col gap-8">
        <SplitLayout
          asideWidth="lg"
          main={
            <div className="flex min-w-0 flex-col gap-4">
              {stage}
              <WatchMeta
                kind={p.variant}
                id={p.id}
                slug={p.slug}
                title={p.title}
                createdAt={p.createdAt}
                durationSeconds={p.durationSeconds}
                category={p.category}
                views={p.views ?? null}
                clippedBy={p.creator ?? null}
                publicUrl={p.publicUrl ?? pageOrigin()}
                currentTime={p.variant === "vod" ? currentTime : undefined}
                clipboard={p.clipboard}
                actions={actions}
              />
              <WatchChannelCard
                slug={p.slug}
                card={p.card.status === "ok" ? p.card.card : null}
                signedIn={p.viewer !== null}
              />
            </div>
          }
          aside={
            p.state === "ready" ? (
              <ReplayPanel
                key={`${p.replayKey}`}
                fetch={p.fetch}
                viewer={p.viewer?.username ?? null}
                playheadMicros={clock.playhead}
                originMicros={clock.origin}
                onSeek={onSeek}
                // Bounded so the log scrolls inside the panel: under the player on phones, beside it on desktop.
                className="h-112 lg:h-160"
              />
            ) : null
          }
        />
        {p.more}
      </div>
    </PageContainer>
  );
}

/** "Resume from m:ss" (D3.6), with a way to keep watching from where the page started. */
function ResumeOffer({
  at,
  onResume,
  onDismiss,
}: {
  at: number;
  onResume: () => void;
  onDismiss: () => void;
}): React.JSX.Element {
  return (
    <div data-testid="watch-resume" data-at={at} className="flex min-w-0 flex-wrap items-center gap-2">
      <Button data-testid="watch-resume-action" size="sm" variant="outline" onClick={onResume}>
        <HugeiconsIcon icon={PlayIcon} strokeWidth={2} aria-hidden />
        {t("d3Watch.resume.action", { time: formatDuration(at) })}
      </Button>
      <Button data-testid="watch-resume-dismiss" size="sm" variant="ghost" onClick={onDismiss}>
        {t("d3Watch.resume.dismiss")}
      </Button>
    </div>
  );
}

/** A clip's "Watch from this moment" (D3.9): its video, at the clip's start. */
export function WatchFromMoment({
  slug,
  vodId,
  offsetSeconds,
}: {
  slug: string;
  vodId: string;
  offsetSeconds: number | null;
}): React.JSX.Element {
  const start = momentStart(offsetSeconds);
  return (
    <Button
      data-testid="watch-from-moment"
      data-vod-id={vodId}
      data-t={start ?? 0}
      size="sm"
      variant="outline"
      nativeButton={false}
      render={
        <Link
          to="/$channel/vods/$vodId"
          params={{ channel: slug, vodId }}
          search={start === null ? {} : { t: start }}
        />
      }
    >
      <HugeiconsIcon icon={Film02Icon} strokeWidth={2} aria-hidden />
      {t("d3Watch.moment.action")}
    </Button>
  );
}

function WatchSkeleton(): React.JSX.Element {
  return (
    <PageContainer width="wide" className="py-4">
      <SkeletonGroup label={t("replay.watch.loading")} className="flex flex-col gap-4">
        <SkeletonThumbnail className="aspect-video w-full" />
        <SkeletonText lines={2} />
      </SkeletonGroup>
    </PageContainer>
  );
}

function WatchError({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <PageContainer width="narrow" className="py-16">
      <EmptyState
        icon={Tv01Icon}
        title={t("replay.watch.loadFailed")}
        action={
          <Button size="sm" variant="outline" onClick={onRetry}>
            {t("replay.retry")}
          </Button>
        }
      />
    </PageContainer>
  );
}
