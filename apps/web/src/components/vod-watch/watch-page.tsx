// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The public VOD and clip watch pages (W2-vod-watch; batch 6 decision (e)): the recording with the
 * chat replay panel beside it from `lg`, below it on narrow screens. What the caller may not watch
 * is one not-found state (`state.ts`); a recording still processing says it is not ready yet; a
 * mature recording shows the 18+ gate (`components/safety`). Loaded in the browser, so the
 * per-viewer answers (subscriber, owner, blocks, 18+) never pass through a shared render.
 */
import {
  ChannelAvatar,
  EmptyState,
  formatDuration,
  RelativeTime,
  SkeletonGroup,
  SkeletonText,
  SkeletonThumbnail,
} from "@commonair/ui";
import { PageContainer, SplitLayout } from "@commonair/ui/layouts";
import { Button } from "@commonair/ui/components/button";
import { Clock01Icon, Tv01Icon } from "@hugeicons/core-free-icons";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import type { Accent } from "@commonair/ui";
import { ReplayPanel } from "../../chat/replay/replay-panel.tsx";
import type { ReplayFetch, ReplayFetchInput, ReplayPage } from "../../chat/replay/model.ts";
import { dateToMicros } from "../../chat/replay/time.ts";
import { t } from "../../i18n/index.ts";
import { api, errorCode } from "../../lib/api.ts";
import { maturityClient, type MaturityClient } from "../safety/client.ts";
import { MatureGate } from "../safety/mature-gate.tsx";
import { clipState, vodState, type ClipDto, type VodDto, type WatchState } from "./state.ts";
import { VodPlayer, type WatchPlayerHandle, type WatchSource } from "./vod-player.tsx";

export interface ChannelCard {
  displayName: string;
  avatarUrl: string | null;
  accent: Accent | null;
}

/** The calls the pages make; tests pass stubs. */
export interface WatchClient {
  vod: (id: string) => Promise<VodDto>;
  clip: (id: string) => Promise<ClipDto>;
  channel: (slug: string) => Promise<ChannelCard>;
  vodChat: (id: string, input: ReplayFetchInput) => Promise<ReplayPage>;
  clipChat: (id: string, input: ReplayFetchInput) => Promise<ReplayPage>;
}

export const watchClient = (): WatchClient => ({
  vod: (id) => api().vods.get({ id }),
  clip: (id) => api().clips.get({ id }),
  channel: async (slug) => {
    const c = await api().channels.get({ channel: slug });
    return { displayName: c.displayName, avatarUrl: c.avatarUrl, accent: c.theme.accent ?? null };
  },
  vodChat: (id, input) => api().vods.chat({ id, ...input }),
  clipChat: (id, input) => api().clips.chat({ id, ...input }),
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

function useChannelCard(slug: string | null, client: WatchClient): ChannelCard | null {
  const [card, setCard] = React.useState<{ slug: string; card: ChannelCard } | null>(null);
  React.useEffect(() => {
    if (!slug) return;
    let live = true;
    client.channel(slug).then(
      (c) => live && setCard({ slug, card: c }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [slug, client]);
  return card && card.slug === slug ? card.card : null;
}

export function VodWatchPage({
  channel,
  vodId,
  viewer,
  client,
  maturity,
}: CommonProps & { vodId: string }): React.JSX.Element {
  const c = useClient(client);
  const [loaded, reload] = useEntity(vodId, viewer?.username ?? null, c.vod);
  const vod = loaded.kind === "ok" ? loaded.value : null;
  const state = loaded.kind === "missing" ? "not-found" : vod ? vodState(vod, channel) : null;
  const playlistUrl = vod?.playlistUrl ?? null;
  const source = React.useMemo<WatchSource | null>(
    () => (playlistUrl ? { kind: "hls", url: playlistUrl } : null),
    [playlistUrl],
  );
  const fetch = React.useCallback<ReplayFetch>((input) => c.vodChat(vodId, input), [c, vodId]);
  if (loaded.kind === "loading") return <WatchSkeleton />;
  if (loaded.kind === "error") return <WatchError onRetry={reload} />;
  if (!vod || state === null || state === "not-found") return <WatchNotFound />;
  return (
    <WatchLayout
      testId="vod-watch-page"
      idAttr={{ "data-vod-id": vod.id }}
      state={state}
      variant="vod"
      title={vod.title}
      slug={vod.channelSlug}
      createdAt={vod.createdAt}
      durationSeconds={vod.durationSeconds}
      captions={vod.captions}
      source={source}
      fetch={fetch}
      replayKey={`vod:${vod.id}`}
      viewer={viewer}
      client={c}
      maturity={maturity}
      onConfirmed={reload}
    />
  );
}

export function ClipWatchPage({
  channel,
  clipId,
  viewer,
  client,
  maturity,
}: CommonProps & { clipId: string }): React.JSX.Element {
  const c = useClient(client);
  const [loaded, reload] = useEntity(clipId, viewer?.username ?? null, c.clip);
  const clip = loaded.kind === "ok" ? loaded.value : null;
  const state = loaded.kind === "missing" ? "not-found" : clip ? clipState(clip, channel) : null;
  const clipUrl = clip?.url ?? null;
  const windowStartedAt = clip?.windowStartedAt ?? null;
  const source = React.useMemo<WatchSource | null>(
    () => (clipUrl ? { kind: "mp4", url: clipUrl, windowStartedAt } : null),
    [clipUrl, windowStartedAt],
  );
  const fetch = React.useCallback<ReplayFetch>((input) => c.clipChat(clipId, input), [c, clipId]);
  if (loaded.kind === "loading") return <WatchSkeleton />;
  if (loaded.kind === "error") return <WatchError onRetry={reload} />;
  if (!clip || state === null || state === "not-found") return <WatchNotFound />;
  return (
    <WatchLayout
      testId="clip-watch-page"
      idAttr={{ "data-clip-id": clip.id }}
      state={state}
      variant="clip"
      title={clip.title}
      slug={clip.channelSlug}
      createdAt={clip.createdAt}
      durationSeconds={clip.durationSeconds}
      captions={[]}
      source={source}
      fetch={fetch}
      replayKey={`clip:${clip.id}`}
      viewer={viewer}
      client={c}
      maturity={maturity}
      onConfirmed={reload}
      creator={clip.creator?.displayName ?? null}
    />
  );
}

function useClient(client: WatchClient | undefined): WatchClient {
  const [fallback] = React.useState(() => client ?? watchClient());
  return client ?? fallback;
}

interface LayoutProps {
  testId: "vod-watch-page" | "clip-watch-page";
  idAttr: Record<`data-${string}`, string>;
  state: Exclude<WatchState, "not-found">;
  variant: "vod" | "clip";
  title: string;
  slug: string;
  createdAt: string;
  durationSeconds: number;
  captions: VodDto["captions"];
  source: WatchSource | null;
  fetch: ReplayFetch;
  replayKey: string;
  viewer: WatchViewer | null;
  client: WatchClient;
  maturity: MaturityClient | undefined;
  onConfirmed: () => void;
  creator?: string | null;
}

function WatchLayout(p: LayoutProps): React.JSX.Element {
  const card = useChannelCard(p.slug, p.client);
  const handle = React.useRef<WatchPlayerHandle>(null);
  const [clock, setClock] = React.useState<{ playhead: number | null; origin: number | null }>({
    playhead: null,
    origin: null,
  });
  const [gateClient] = React.useState(() => p.maturity ?? maturityClient());
  const onPlayhead = React.useCallback((at: Date | null) => {
    const origin = handle.current?.originWallclock() ?? null;
    setClock({ playhead: at ? dateToMicros(at) : null, origin: origin ? dateToMicros(origin) : null });
  }, []);
  const onSeek = React.useCallback((at: Date) => {
    handle.current?.seekToWallclock(at);
  }, []);

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
        handleRef={handle}
      />
    ) : null;

  const header = (
    <header className="flex min-w-0 flex-col gap-2">
      <h1 data-testid="watch-title" className="text-lg font-semibold break-words">
        {p.title}
      </h1>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
        <Link
          data-testid="watch-channel-link"
          to="/$channel"
          params={{ channel: p.slug }}
          className="flex min-w-0 items-center gap-2 font-medium text-foreground hover:underline focus-visible:underline"
        >
          <ChannelAvatar
            name={card?.displayName ?? p.slug}
            src={card?.avatarUrl}
            accent={card?.accent}
            size="sm"
            decorative
          />
          <span className="truncate">{card?.displayName ?? p.slug}</span>
        </Link>
        <RelativeTime date={p.createdAt} />
        <span>{t("replay.watch.duration", { duration: formatDuration(p.durationSeconds) })}</span>
        {p.creator && <span>{t("replay.watch.clippedBy", { name: p.creator })}</span>}
      </div>
    </header>
  );

  return (
    <PageContainer width="wide" className="py-4">
      <div data-testid={p.testId} data-state={p.state} {...p.idAttr}>
        <SplitLayout
          asideWidth="lg"
          main={
            <div className="flex min-w-0 flex-col gap-4">
              {stage}
              {header}
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
      </div>
    </PageContainer>
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

/** Anything the caller may not watch; never says why. */
export function WatchNotFound(): React.JSX.Element {
  return (
    <PageContainer width="narrow" className="py-16">
      <EmptyState data-testid="watch-not-found" icon={Tv01Icon} title={t("replay.watch.notFound")} />
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
