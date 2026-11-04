// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Live DVR controls (ADR 0016; docs/testing/w2-selectors.md "Live DVR"): the scrubber in the player
 * chrome's scrubber slot, and "back to live", the behind-live readout and the source-quality note
 * in the control row. Both render nothing without a DVR grant (window 0) or in data mode, which is
 * source-only DVR's opposite (decision 7). Keyboard: arrows ±10 s, Page Up / Page Down ±60 s,
 * Home the oldest second of the window, End live (the slider's own keys), and `L` anywhere on the
 * page but a text field. Nothing animates, so reduced motion needs no special case. The player's
 * shortcut map (`shortcuts.ts`, the `?` dialog) lists `L` and leaves it to this listener; the
 * player's ±5 s arrows apply only while the scrubber is not focused.
 */
import { formatDuration } from "@commonair/ui";
import { PlayerScrubber } from "@commonair/ui/blocks/media";
import { Button } from "@commonair/ui/components/button";
import { OverlayBadge } from "@commonair/ui";
import * as React from "react";
import { t } from "../i18n/index.ts";
import type { DvrGrant, PlayerController } from "./controller.ts";
import {
  behindLiveSeconds,
  behindOf,
  DVR_LARGE_STEP_SECONDS,
  DVR_STEP_SECONDS,
  isBackToLiveKey,
  positionOf,
  seekerFor,
} from "./dvr.ts";
import type { PlaybackMode } from "./media-clock.ts";

export interface DvrSlotProps {
  /** The playing session (seam: `enterDvr`, `exitDvr`, `seekToWallclock`, `playheadWallclock`). */
  controller: PlayerController;
  /** The session's DVR grant; null without DVR (window 0), when nothing shows. */
  grant: DvrGrant | null;
  /** Data mode is on: DVR is source-only, so the controls hide (ADR 0016 decision 7). */
  dataMode: boolean;
  playbackMode: PlaybackMode;
}

/** How often the behind-live readout and the scrubber follow the playhead. */
export const DVR_TICK_MS = 1_000;

/** Whole seconds behind live, re-read every tick while in DVR (0 at live). */
function useBehindLive(controller: PlayerController, mode: PlaybackMode, enabled: boolean): number {
  const active = enabled && mode === "dvr";
  const read = React.useCallback(() => Math.round(behindLiveSeconds(controller, Date.now())), [controller]);
  // Re-read on a timer (the playhead is outside React); at live it is 0 without reading.
  const [sample, setSample] = React.useState<{ controller: PlayerController; behind: number } | null>(null);
  React.useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setSample({ controller, behind: read() }), DVR_TICK_MS);
    return () => {
      clearInterval(timer);
      // A later return to DVR reads afresh, not the last sample of this one.
      setSample(null);
    };
  }, [active, controller, read]);
  if (!active) return 0;
  return sample?.controller === controller ? sample.behind : read();
}

const shown = (p: DvrSlotProps): p is DvrSlotProps & { grant: DvrGrant } =>
  p.grant !== null && p.grant.windowSeconds > 0 && !p.dataMode;

const firstValue = (v: number | readonly number[]): number => (typeof v === "number" ? v : (v[0] ?? 0));

/** The DVR scrubber: a slider over the window, live at its end. */
export function DvrScrubber(props: DvrSlotProps): React.JSX.Element | null {
  const { controller, playbackMode } = props;
  const visible = shown(props);
  const behind = useBehindLive(controller, playbackMode, visible);
  // While dragging, the thumb follows the pointer; the seek happens on release.
  const [dragging, setDragging] = React.useState<number | null>(null);
  if (!shown(props)) return null;
  const window = props.grant.windowSeconds;
  const position = dragging ?? positionOf(behind, window);
  const behindShown = behindOf(position, window);
  const commit = (v: number | readonly number[]) => {
    setDragging(null);
    void seekerFor(controller).seek(behindOf(firstValue(v), window));
  };
  return (
    <PlayerScrubber
      data-testid="player-dvr-scrubber"
      data-behind-seconds={String(Math.round(behindShown))}
      data-window-seconds={String(window)}
      value={position}
      max={window}
      step={DVR_STEP_SECONDS}
      largeStep={DVR_LARGE_STEP_SECONDS}
      label={t("dvr.scrubber.label")}
      valueText={behindShown < 1 ? t("dvr.atLive") : t("dvr.behind", { time: formatDuration(behindShown) })}
      onValueChange={(v) => setDragging(firstValue(v))}
      onValueCommitted={commit}
    />
  );
}

/** "Back to live", the behind-live readout and the source-quality note, in the control row. */
export function DvrControls(props: DvrSlotProps): React.JSX.Element | null {
  const { controller, playbackMode } = props;
  const visible = shown(props);
  const behind = useBehindLive(controller, playbackMode, visible);
  const inDvr = visible && playbackMode === "dvr";

  React.useEffect(() => {
    if (!inDvr) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isBackToLiveKey(e)) return;
      e.preventDefault();
      seekerFor(controller).live();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [inDvr, controller]);

  if (!inDvr) return null;
  return (
    <>
      <Button
        data-testid="player-dvr-live"
        variant="secondary"
        size="sm"
        aria-keyshortcuts="L"
        onClick={() => seekerFor(controller).live()}
      >
        {t("dvr.backToLive")}
      </Button>
      <OverlayBadge data-testid="player-dvr-behind" data-seconds={String(behind)}>
        {t("dvr.behind", { time: formatDuration(behind) })}
      </OverlayBadge>
      <OverlayBadge data-testid="player-dvr-source-note" className="hidden sm:inline-flex">
        {t("dvr.sourceOnly")}
      </OverlayBadge>
    </>
  );
}
