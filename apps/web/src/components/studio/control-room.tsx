// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The `/dashboard` control room's live wiring (F21): the channel's live state, polled while the tab
 * is visible, feeds the preview's `live`, the uptime and chat's `stream`. A streamer usually opens
 * the dashboard before starting OBS, so a one-off read would leave the preview offline and the
 * uptime missing until a reload while the health card beside them already says live.
 */
import { Skeleton, SkeletonGroup } from "@commonair/ui";
import * as React from "react";
import { ChatPanel } from "../../chat/chat-panel.tsx";
import { CHAT_COLUMN_CLASS } from "../../chat/layout.ts";
import { t } from "../../i18n/index.ts";
import { api } from "../../lib/api.ts";
import { HEALTH_POLL_MS, type PollEnv, browserPollEnv, pollWhileVisible } from "../../lib/stream-health.ts";
import { Player } from "../../player/player.tsx";
import { SectionLoadError } from "../../lib/section-load-error.tsx";
import { StreamManager, type StreamManagerProps } from "./stream-manager.tsx";

/** What the control room reads of `channels.get`. */
export interface LiveChannel {
  id: string;
  displayName: string;
  live: { startedAt: string } | null;
  /** The recap's inputs (d5-dashboard); optional so older fakes still type. */
  lastLiveAt?: string | null;
  vodEnabled?: boolean;
  ownerCoop?: { member: boolean; council: boolean };
}

export interface LiveChannelState {
  /** Null until the first answer. */
  data: LiveChannel | null;
  /** The first read failed (a later failure keeps the last answer on screen). */
  failed: boolean;
  /** Read again now (Retry); the poll carries on either way. */
  reload: () => void;
}

export type ChatStream = { id: string; live: boolean; slug: string };

const apiLoad = (slug: string): Promise<LiveChannel> => api().channels.get({ channel: slug });

/**
 * `load(slug)` now and every `HEALTH_POLL_MS` while the page is visible (the health card's pace),
 * one request at a time. Answers for an older slug are dropped.
 */
export function useLiveChannel(
  slug: string,
  load: (slug: string) => Promise<LiveChannel> = apiLoad,
  env?: PollEnv,
): LiveChannelState {
  const [state, setState] = React.useState<Omit<LiveChannelState, "reload"> & { slug: string }>({
    slug,
    data: null,
    failed: false,
  });
  const tickRef = React.useRef<() => void>(() => undefined);
  React.useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const tick = () => {
      // A slow answer must not pile requests up behind it.
      if (inFlight) return;
      inFlight = true;
      load(slug)
        .then((data) => {
          if (!cancelled) setState({ slug, data, failed: false });
        })
        .catch(() => {
          if (!cancelled)
            setState((prev) => (prev.slug === slug && prev.data ? prev : { slug, data: null, failed: true }));
        })
        .finally(() => {
          inFlight = false;
        });
    };
    tickRef.current = tick;
    const stop = pollWhileVisible(tick, HEALTH_POLL_MS, env ?? browserPollEnv());
    return () => {
      cancelled = true;
      tickRef.current = () => undefined;
      stop();
    };
  }, [slug, load, env]);
  const reload = React.useCallback(() => tickRef.current(), []);
  return state.slug === slug
    ? { data: state.data, failed: state.failed, reload }
    : { data: null, failed: false, reload };
}

export interface ControlRoomProps extends Pick<
  StreamManagerProps,
  "infoClient" | "healthLoad" | "activitySource" | "onInfoSaved"
> {
  slug: string;
  username: string;
  /** `channels.get`; tests pass a fake. */
  load?: (slug: string) => Promise<LiveChannel>;
  pollEnv?: PollEnv;
  /** The preview for the current live state; the muted `Player` by default. */
  renderPreview?: (live: boolean) => React.ReactNode;
  /** Chat for the current live state; `ChatPanel` by default. */
  renderChat?: (stream: ChatStream | undefined, channelName: string | undefined) => React.ReactNode;
  /** Above the board, from the same channel poll: the stream recap and the go-live checklist. */
  renderTop?: (channel: LiveChannel | null) => React.ReactNode;
}

export function ControlRoom({
  slug,
  username,
  load,
  pollEnv,
  renderPreview,
  renderChat,
  renderTop,
  ...fakes
}: ControlRoomProps): React.JSX.Element {
  const channel = useLiveChannel(slug, load, pollEnv);
  const isLive = channel.data !== null && channel.data.live !== null;
  const id = channel.data?.id;
  // One object per change, so chat does not get a new `stream` on every poll.
  const stream = React.useMemo<ChatStream | undefined>(
    () => (id ? { id, live: isLive, slug } : undefined),
    [id, isLive, slug],
  );
  const preview = channel.data ? (
    (renderPreview ?? ((live: boolean) => <Preview slug={slug} live={live} />))(isLive)
  ) : channel.failed ? (
    <SectionLoadError
      section={t("d5Dashboard.preview.section")}
      load={{ reload: channel.reload }}
      headingLevel={3}
      data-testid="stream-preview-error"
      retryTestId="stream-preview-retry"
    />
  ) : (
    <SkeletonGroup label={t("studio.preview.loading")}>
      <Skeleton className="aspect-video w-full" />
    </SkeletonGroup>
  );
  const chat = renderChat ? (
    renderChat(stream, channel.data?.displayName)
  ) : (
    <ChatPanel
      channel={slug}
      stream={stream}
      channelName={channel.data?.displayName}
      signedIn
      selfUsername={username}
      className={CHAT_COLUMN_CLASS}
    />
  );
  return (
    <>
      {renderTop?.(channel.data)}
      <StreamManager
        channel={slug}
        startedAt={channel.data?.live?.startedAt ?? null}
        preview={preview}
        chat={chat}
        {...fakes}
      />
    </>
  );
}

function Preview({ slug, live }: { slug: string; live: boolean }): React.JSX.Element {
  return (
    <Player
      channel={slug}
      live={live}
      offline={<p className="text-sm text-muted-foreground">{t("studio.preview.offline")}</p>}
    />
  );
}
