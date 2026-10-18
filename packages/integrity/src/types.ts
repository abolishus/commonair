// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import type { DELIVERY_SOURCES } from "@commonair/contracts/enums";

/**
 * Stable reason codes. They are stored in `playback_sessions.verdict_reasons` and
 * `integrity_flags.signal`, shown to streamers and admins, and referenced by appeals:
 * never rename one; add a new code instead.
 */
export const SESSION_SIGNALS = [
  "datacenter_ip",
  "device_concurrency",
  "account_concurrency",
  "headless",
  "heartbeat_inconsistent",
  "fetch_pattern",
] as const;
export type SessionSignalCode = (typeof SESSION_SIGNALS)[number];

/** Non-signal reason: not enough heartbeats yet to verify. */
export const INSUFFICIENT_HEARTBEATS = "insufficient_heartbeats";

export const CHANNEL_SIGNALS = ["chat_viewer_anomaly", "follow_burst", "raid_overstated"] as const;
export const RELAY_SIGNALS = ["relay_over_report", "relay_suspended"] as const;

export interface Signal<C extends string = SessionSignalCode> {
  code: C;
  /** Probability-like strength in [0, 1]. Signals combine as a noisy-OR. */
  score: number;
  /** Explanation: the measured values and the sub-checks that fired. Ids and numbers only. */
  details: Record<string, unknown>;
}

/** The parts of a `playback_sessions` row scoring needs. */
export interface SessionFacts {
  id: string;
  channelId: string;
  userId: string | null;
  deviceHash: string;
  asn: number | null;
  /** Hosting-provider label recorded at session start, or null. */
  datacenter: string | null;
  userAgent: string | null;
  fingerprint: Record<string, unknown>;
  assignedSource: (typeof DELIVERY_SOURCES)[number];
  startedAt: Date;
  /** Heartbeat counter kept by the API. */
  heartbeats: number;
  watchSeconds: number;
  segmentsFetched: number;
  bytesHttp: number;
  bytesP2p: number;
}

/** One heartbeat as recorded for integrity (server receive time plus the reported stats). */
export const HeartbeatSample = z.object({
  /** Server receive time, epoch ms. */
  at: z.number().int().nonnegative(),
  playedSeconds: z.number().min(0),
  bufferSeconds: z.number().min(0),
  visible: z.boolean(),
  muted: z.boolean(),
  stalls: z.number().int().min(0).default(0),
  bytesHttp: z.number().int().min(0).default(0),
  bytesP2p: z.number().int().min(0).default(0),
  fingerprint: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});
export type HeartbeatSample = z.infer<typeof HeartbeatSample>;

/** Origin-observed requests for a session (from `stream:segments`). */
export interface FetchSummary {
  /** Playlist requests, or null when unknown (only the segment counter is available). */
  playlists: number | null;
  segments: number;
  /** LL-HLS partial segments, or null when unknown. */
  parts: number | null;
}

export interface Concurrency {
  /** 1-based position of this session among concurrent sessions of the same device (oldest first). */
  rank: number;
  concurrent: number;
}

export interface ScoringContext {
  sessionExcludeScore: number;
  maxSessionsPerDevice: number;
  device: Concurrency;
  /** Null for anonymous sessions. */
  account: Concurrency | null;
  /** HLS segment duration (MediaMTX default 1 s). */
  segmentDurationSeconds: number;
  /** LL-HLS parts per segment (MediaMTX default 200 ms parts → 5). */
  partsPerSegment: number;
}

export type Verdict = "verified" | "excluded" | "pending";

export interface SessionScore {
  verdict: Verdict;
  score: number;
  /** Reason codes, strongest first. */
  reasons: string[];
  signals: Signal[];
}
