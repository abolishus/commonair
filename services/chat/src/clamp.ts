// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Media-time clamp for chat (ADR 0012 amendment 1 decisions 2 and 4). Stub until W1-spine implements it. */

export interface ClampInput {
  receivedAt: Date;
  /** The client's `mediaTs`, parsed; null when absent or unparsable. */
  hint: Date | null;
  playbackMode: "live" | "dvr";
  /** `ChannelState.liveStartedAt`; null = channel not live. */
  liveStartedAt: Date | null;
  /** `KEYS.chatLatency` in seconds, read only when `hint` is null; null = no key. */
  channelLatencySeconds: number | null;
}

/** ADR 0012 amendment 1 decisions 2 and 4. Pure. */
export function clampMediaTs(_i: ClampInput): Date | null {
  return null; // W1-spine
}
