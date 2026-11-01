// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type * as React from "react";
import type { PlayerController, SessionFeatures } from "./controller.ts";

export interface CaptionsToggleProps {
  /** The playing session (seam: `onTextTrack`, `setTargetLatency`). */
  controller: PlayerController;
  /** The session's live caption tracks and why there are none (`PlaybackStart.captionsState`). */
  captions: SessionFeatures["captions"];
}

/**
 * The CC control in the player's control row (ADR 0011). Stub from the W2 contract step:
 * W2-captions fills it (`apps/web/src/player/captions*`); `player.tsx` already mounts it.
 */
export function CaptionsToggle(_props: CaptionsToggleProps): React.JSX.Element | null {
  return null;
}
