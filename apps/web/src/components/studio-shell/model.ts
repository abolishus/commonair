// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The studio LiveStatusBar's rules (overhaul wave 3, D5.2), pure so every edge is unit tested:
 * the state from the channel and its health, the health summary, and the poll's pace with its
 * backoff on busy (429) or unreachable answers.
 */
import type { LiveStatusHealth, LiveStatusState } from "@commonair/ui/blocks/studio";
import { isTransientFailure, retryAfterSeconds } from "../../lib/load-failure.ts";
import { healthState, type StreamHealthDto } from "../../lib/stream-health.ts";

/** What the bar reads of `channels.get`. */
export interface StatusChannel {
  slug: string;
  live: { startedAt: string; viewerCount: number; title: string } | null;
  lastLiveAt: string | null;
}

export type StatusHealth = Pick<StreamHealthDto, "live" | "samples" | "viewers">;

/**
 * `live` once the channel is live and the encoder has sent its first stats; `starting` while
 * either says live but the first health sample has not landed (the encoder just connected);
 * `offline` otherwise. Before the first answer the bar says offline rather than guessing.
 */
export function liveStatusState(channel: StatusChannel | null, health: StatusHealth | null): LiveStatusState {
  const channelLive = (channel?.live ?? null) !== null;
  const healthLive = health?.live === true;
  if (!channelLive && !healthLive) return "offline";
  if (health && healthLive && health.samples.length === 0) return "starting";
  // The health poll says live before the channel answer catches up: starting, not live yet.
  if (!channelLive) return "starting";
  return "live";
}

/** The health word: unknown without a live answer or a sample, else healthy or needs attention. */
export function healthSummary(health: StatusHealth | null): LiveStatusHealth {
  if (!health || !health.live || health.samples.length === 0) return "unknown";
  return healthState(health) === "warning" ? "warning" : "healthy";
}

/** Verified viewers: the health answer's (owner view) when there is one, else the public count. */
export function verifiedViewers(channel: StatusChannel | null, health: StatusHealth | null): number | null {
  if (health?.live) return health.viewers.verified;
  return channel?.live?.viewerCount ?? null;
}

/** The bar polls gently: the dashboard's own cards poll faster where they need it. */
export const STATUS_POLL_MS = 30_000;
/** After failures the pace backs off to at most this. */
export const STATUS_POLL_MAX_MS = 300_000;

/**
 * The wait before the next poll after `failures` failed ones in a row: 30 s, then doubling up to
 * 5 minutes, or the server's `retryAfterSeconds` on a busy answer when that is longer. A failure
 * that is not transient (403, 404) still backs off, so a broken page does not keep asking.
 */
export function statusPollDelay(failures: number, error?: unknown): number {
  const n = Math.max(0, Math.floor(failures));
  const backoff = Math.min(STATUS_POLL_MAX_MS, STATUS_POLL_MS * 2 ** n);
  if (n === 0 || error === undefined || !isTransientFailure(error)) return backoff;
  const hinted = retryAfterSeconds(error);
  return hinted === null ? backoff : Math.min(STATUS_POLL_MAX_MS, Math.max(backoff, Math.ceil(hinted * 1000)));
}
