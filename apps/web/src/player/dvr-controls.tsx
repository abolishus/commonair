// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import type { DvrGrant, PlayerController } from "./controller.ts";
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

/**
 * The DVR scrubber, in the player chrome's scrubber slot (ADR 0016). Stub from the W2 contract
 * step: W2-dvr fills it (`apps/web/src/player/dvr*`); `player.tsx` already mounts it.
 */
export function DvrScrubber(_props: DvrSlotProps): React.JSX.Element | null {
  return null;
}

/** "Back to live" and the behind-live readout, in the control row. Stub: W2-dvr fills it. */
export function DvrControls(_props: DvrSlotProps): React.JSX.Element | null {
  return null;
}
