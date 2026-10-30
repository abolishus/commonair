// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Media-time clamp for chat (ADR 0012 amendment 1 decisions 2 and 4). Receive time stays
 * authoritative; `media_ts` is a hint a sender can move at most `MEDIA_TS_WINDOW_MS` back, and
 * never before the broadcast started or after the server received the message.
 */

/** How far before receive time a line may be placed: LL-HLS at its worst plus a slow mobile network. */
export const MEDIA_TS_WINDOW_MS = 60_000;

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
export function clampMediaTs(i: ClampInput): Date | null {
  // DVR viewers are not at the live edge, and offline chat has no media clock: the hint is dropped.
  if (i.playbackMode === "dvr" || !i.liveStartedAt) return null;
  const received = i.receivedAt.getTime();
  // A broadcast that "started" after receipt (clock skew between hosts) still bounds at receive time.
  const lower = Math.min(received, Math.max(received - MEDIA_TS_WINDOW_MS, i.liveStartedAt.getTime()));
  const latencyMs = finiteOr0(i.channelLatencySeconds) * 1000;
  const candidate = i.hint ? i.hint.getTime() : received - latencyMs;
  return new Date(Math.min(received, Math.max(lower, Number.isFinite(candidate) ? candidate : received)));
}

function finiteOr0(n: number | null): number {
  return n !== null && Number.isFinite(n) && n > 0 ? n : 0;
}
