// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The stream recap's rules (overhaul wave 3, D5.3; creator-studio P3), pure: when it shows, which
 * broadcast and video it is about, and the numbers it may state. Viewer numbers come only from the
 * settled analytics (`analytics.range` lists a broadcast 24 h after it ends), never estimated.
 * Dismissing the recap and seeing the member-owner notice are remembered in this browser only
 * (`localStorage`, a per-viewer convenience: losing it shows the card once more, nothing worse).
 */
import type { AnalyticsRange } from "@commonair/contracts/dto";

export type RangeBroadcast = AnalyticsRange["broadcasts"][number];

/** The recap is for a stream that ended within this long. */
export const RECAP_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
/** A settled broadcast matches `lastLiveAt` when it ended within this of it. */
export const END_MATCH_MS = 5 * 60 * 1000;
/** The analytics range looked at: from this long before the end. */
export const RANGE_BEFORE_MS = 3 * 24 * 3600 * 1000;
/** No stream is longer than this; bounds the video search before the numbers settle. */
export const MAX_STREAM_MS = 24 * 3600 * 1000;

export const RECAP_DISMISSED_KEY = "commonair.studio.recapDismissed.v1";
export const MEMBER_NOTICE_KEY = "commonair.studio.memberNoticeSeen.v1";

/** Whether the recap card shows: offline, ended recently, and not dismissed for that stream. */
export function recapVisible(
  input: { live: boolean; lastLiveAt: string | null; dismissedFor: string | null },
  now: number,
): boolean {
  if (input.live || !input.lastLiveAt) return false;
  const ended = Date.parse(input.lastLiveAt);
  if (!Number.isFinite(ended) || now - ended > RECAP_MAX_AGE_MS) return false;
  return input.dismissedFor !== input.lastLiveAt;
}

/** The settled broadcast that ended at `lastLiveAt`, or null while its numbers settle. */
export function settledBroadcast(broadcasts: readonly RangeBroadcast[], lastLiveAt: string): RangeBroadcast | null {
  const ended = Date.parse(lastLiveAt);
  let best: RangeBroadcast | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const b of broadcasts) {
    const end = Date.parse(b.startedAt) + b.durationSeconds * 1000;
    const gap = Math.abs(end - ended);
    if (gap <= END_MATCH_MS && gap < bestGap) {
      best = b;
      bestGap = gap;
    }
  }
  return best;
}

/** Average verified viewers over the stream, whole: verified viewer-seconds over its length. */
export function averageViewers(b: Pick<RangeBroadcast, "durationSeconds" | "totals">): number {
  if (b.durationSeconds <= 0) return 0;
  return Math.round(b.totals.verifiedViewerSeconds / b.durationSeconds);
}

export interface RecapWindow {
  start: number;
  end: number;
}

/** The stream's span: exact once settled, else the longest a stream can be up to its end. */
export function recapWindow(lastLiveAt: string, settled: RangeBroadcast | null): RecapWindow {
  const end = Date.parse(lastLiveAt);
  if (settled) return { start: Date.parse(settled.startedAt), end };
  return { start: end - MAX_STREAM_MS, end };
}

const inWindow = (at: string, w: RecapWindow, slackMs = 0) => {
  const x = Date.parse(at);
  return x >= w.start - slackMs && x <= w.end + slackMs;
};

/** The stream's video: the newest one created inside its window (recording starts with the stream). */
export function recapVideo<V extends { createdAt: string }>(vods: readonly V[], w: RecapWindow): V | null {
  let best: V | null = null;
  for (const v of vods)
    if (inWindow(v.createdAt, w, 60_000) && (!best || Date.parse(v.createdAt) > Date.parse(best.createdAt))) best = v;
  return best;
}

/** Follows during the stream, not counting excluded ones (they never count anywhere). */
export function followsDuring(follows: readonly { followedAt: string; excluded: boolean }[], w: RecapWindow): number {
  return follows.filter((f) => !f.excluded && inWindow(f.followedAt, w)).length;
}

/** Clips made during the stream. */
export function clipsDuring(clips: readonly { createdAt: string }[], w: RecapWindow): number {
  return clips.filter((c) => inWindow(c.createdAt, w)).length;
}

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function storage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Storage can be missing or throw (private windows): every access is guarded. */
export function readFlag(key: string, store: StorageLike | null = storage()): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeFlag(key: string, value: string, store: StorageLike | null = storage()): void {
  try {
    store?.setItem(key, value);
  } catch {
    // Not remembered: the card shows again next time, which is harmless.
  }
}

/** The member-owner notice is once per account: the key carries the channel it was seen for. */
export const memberNoticeKey = (channel: string) => `${MEMBER_NOTICE_KEY}:${channel}`;
