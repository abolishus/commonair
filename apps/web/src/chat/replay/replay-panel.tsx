// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The chat replay panel beside a VOD or clip (W2-vod-watch; docs/testing/w2-selectors.md "VOD and
 * clip watch pages, replay panel"): the lines placed at or before the playhead, in `(at, id)`
 * order, as `ReplayModel` keeps them. The log has no live announcements (`aria-live="off"`): replay
 * would flood a screen reader, and the lines are there to read at the reader's own pace. A line's
 * time seeks the player. Keyed by the video by its parent, so one model serves one video.
 */
import { EmptyState, formatDuration, NO_VALUE, StatusBadge } from "@commonair/ui";
import { ChatMessage, ChatPanel, ChatReplayFooter } from "@commonair/ui/blocks/media";
import { Button } from "@commonair/ui/components/button";
import { BubbleChatIcon, Clock01Icon } from "@hugeicons/core-free-icons";
import * as React from "react";
import { t } from "../../i18n/index.ts";
import { useBlocks, type BlocksClient } from "../blocks.ts";
import { nameColorIndex, visibleBadges } from "../view.ts";
import { ReplayModel, type ReplayFetch, type ReplayLine, type ReplaySnapshot } from "./model.ts";
import { microsToDate, MICROS_PER_SECOND } from "./time.ts";

export interface ReplayPanelProps {
  /** `vods.chat` or `clips.chat` for this video. */
  fetch: ReplayFetch;
  /** The signed-in viewer's username (their blocks), null signed out. */
  viewer: string | null;
  /** The playhead's wall clock in epoch microseconds; null before the first frame. */
  playheadMicros: number | null;
  /** The wall clock at media time 0 (microseconds), for each line's position in the video. */
  originMicros: number | null;
  onSeek: (at: Date) => void;
  className?: string;
  blocksClient?: BlocksClient;
}

/** A line's position in the video as a clock (`1:05`), or a dash while the origin is unknown. */
export function lineTime(atMicros: number, originMicros: number | null): string {
  return originMicros === null ? NO_VALUE : formatDuration((atMicros - originMicros) / MICROS_PER_SECOND);
}

export function ReplayPanel({
  fetch,
  viewer,
  playheadMicros,
  originMicros,
  onSeek,
  className,
  blocksClient,
}: ReplayPanelProps): React.JSX.Element {
  // One model per mount: the parent keys the panel by its video, whose `fetch` stays the same.
  const [model] = React.useState(() => new ReplayModel({ fetch }));
  React.useEffect(() => {
    model.start();
    return () => model.stop();
  }, [model]);

  // Another account sees another replay (its blocks are filtered by the server).
  const seenViewer = React.useRef(viewer);
  React.useEffect(() => {
    if (seenViewer.current === viewer) return;
    seenViewer.current = viewer;
    model.reset();
  }, [model, viewer]);

  const blocks = useBlocks(viewer, blocksClient);
  React.useEffect(() => model.setBlocked(blocks), [model, blocks]);
  React.useEffect(() => model.setPlayhead(playheadMicros), [model, playheadMicros]);

  const snap: ReplaySnapshot = React.useSyncExternalStore(
    React.useCallback((fn) => model.subscribe(fn), [model]),
    () => model.snapshot(),
    () => model.snapshot(),
  );

  return (
    <ChatPanel
      data-testid="replay-panel"
      data-status={snap.status}
      variant="replay"
      logLive="off"
      title={t("replay.panel.title")}
      logLabel={t("replay.panel.log")}
      newMessagesLabel={t("replay.panel.jumpToLatest")}
      footer={<ChatReplayFooter>{t("replay.panel.footer")}</ChatReplayFooter>}
      className={className}
    >
      <ReplayBody snap={snap} originMicros={originMicros} onSeek={onSeek} onRetry={() => model.retry()} />
    </ChatPanel>
  );
}

function ReplayBody({
  snap,
  originMicros,
  onSeek,
  onRetry,
}: {
  snap: ReplaySnapshot;
  originMicros: number | null;
  onSeek: (at: Date) => void;
  onRetry: () => void;
}): React.JSX.Element {
  if (snap.status === "not-retained")
    return (
      <EmptyState
        data-testid="replay-not-retained"
        icon={Clock01Icon}
        title={t("replay.notRetained.title")}
        description={t("replay.notRetained.description")}
      />
    );
  if (snap.status === "empty")
    return <EmptyState data-testid="replay-empty" icon={BubbleChatIcon} title={t("replay.empty.title")} />;
  return (
    <>
      {snap.status === "ready" && snap.lines.length === 0 && !snap.loading && (
        <ChatMessage notice author="" colorIndex={1} body={t("replay.waiting")} />
      )}
      {snap.lines.map((line) => (
        <ReplayRow key={line.item.id} line={line} originMicros={originMicros} onSeek={onSeek} />
      ))}
      {snap.loading && (
        <ChatMessage notice data-testid="replay-loading" author="" colorIndex={1} body={t("replay.loading")} />
      )}
      {snap.error && (
        <ChatMessage
          notice
          author=""
          colorIndex={1}
          body={
            <span className="flex flex-wrap items-center gap-2">
              {t("replay.error")}
              <Button size="xs" variant="outline" onClick={onRetry}>
                {t("replay.retry")}
              </Button>
            </span>
          }
        />
      )}
    </>
  );
}

function ReplayRow({
  line,
  originMicros,
  onSeek,
}: {
  line: ReplayLine;
  originMicros: number | null;
  onSeek: (at: Date) => void;
}): React.JSX.Element {
  const { item } = line;
  const time = lineTime(line.atMicros, originMicros);
  const reply = item.replyTo && !line.quoteHidden ? item.replyTo : null;
  return (
    <ChatMessage
      data-testid="replay-row"
      data-at={item.at}
      data-message-id={item.id}
      data-catching-up={item.catchingUp ? "true" : undefined}
      author={item.user.displayName}
      colorIndex={nameColorIndex(item.user.username)}
      badges={visibleBadges(item.user.badges)}
      action={item.isAction}
      timestamp={
        <Button
          data-testid="replay-row-time"
          size="xs"
          variant="ghost"
          aria-label={t("replay.row.seek", { time })}
          onClick={() => onSeek(microsToDate(line.atMicros))}
        >
          {time}
        </Button>
      }
      body={
        <>
          {reply && (
            <span className="block text-muted-foreground">{t("replay.row.replyTo", { name: reply.username })}</span>
          )}
          {item.catchingUp && (
            <StatusBadge data-testid="replay-catching-up" tone="info" className="me-1 align-middle">
              {t("replay.row.catchingUp")}
            </StatusBadge>
          )}
          {item.body}
        </>
      }
    />
  );
}
