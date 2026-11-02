// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** What seed-media publishes as `store.extra.media`, built from the recordings' results (pure). */

/** What one recording left behind (the subset of `RecordingResult` the store needs). */
export interface RecordedOutcome {
  handle: string;
  channelId: string;
  broadcastId: string;
  start: Date;
  end: Date;
  vodId: string;
  /** Clips that remain. */
  clipIds: string[];
  private: boolean;
}

/** `store.extra.media`: the keys seed-media's brief names. */
export interface MediaExtra {
  /** Channel id → VOD ids (private ones included). */
  vodsByChannel: Record<string, string[]>;
  /** Channel id → clip ids that remain (the deleted one is not listed). */
  clipsByChannel: Record<string, string[]>;
  recordedWindow: { channelId: string; start: Date; end: Date }[];
  /** Every recorded broadcast, for seed-safety's attestations. */
  recordedBroadcasts: { channelId: string; broadcastId: string }[];
  /** streamer1's ready public VOD and a clip of it (the W2 VOD and clip watch pages). */
  vodId: string;
  clipId: string;
}

export function buildMediaExtra(results: readonly RecordedOutcome[]): MediaExtra {
  const s1 = results.find((r) => r.handle === "streamer1" && !r.private);
  const clipId = s1?.clipIds[0];
  if (!s1 || !clipId)
    throw new Error("seed-media: streamer1's recording left no public VOD and clip for the watch pages");
  const extra: MediaExtra = {
    vodsByChannel: {},
    clipsByChannel: {},
    recordedWindow: results.map((r) => ({ channelId: r.channelId, start: r.start, end: r.end })),
    recordedBroadcasts: results.map((r) => ({ channelId: r.channelId, broadcastId: r.broadcastId })),
    vodId: s1.vodId,
    clipId,
  };
  for (const r of results) {
    (extra.vodsByChannel[r.channelId] ??= []).push(r.vodId);
    (extra.clipsByChannel[r.channelId] ??= []).push(...r.clipIds);
  }
  return extra;
}
