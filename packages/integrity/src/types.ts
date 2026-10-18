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
  "privacy_relay",
] as const;
export type SessionSignalCode = (typeof SESSION_SIGNALS)[number];

/** Non-signal reason: not enough heartbeats yet to verify. */
export const INSUFFICIENT_HEARTBEATS = "insufficient_heartbeats";
/**
 * Non-signal reason: the session claims playback but the delivery accounting does not show
 * the media it would have needed. Such a session stays pending; it never verifies.
 */
export const MEDIA_UNCONFIRMED = "media_unconfirmed";
/** Non-signal reason: signals an appeal or an admin decision allowed were ignored for this session. */
export const ALLOWED_ON_APPEAL = "allowed_on_appeal";

export const CHANNEL_SIGNALS = ["chat_viewer_anomaly", "follow_burst", "raid_overstated"] as const;
export const RELAY_SIGNALS = ["relay_over_report", "relay_suspended", "relay_issuance_unknown"] as const;

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
  /** Network-list label recorded at session start, or null (see `network.ts` for the privacy-relay prefix). */
  datacenter: string | null;
  userAgent: string | null;
  fingerprint: Record<string, unknown>;
  assignedSource: (typeof DELIVERY_SOURCES)[number];
  startedAt: Date;
  /** Last heartbeat the API accepted (spreads watch time over a receipt window). */
  lastHeartbeatAt?: Date | null;
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
  /**
   * LL-HLS partial segments, or null when unknown. The database counter
   * (`playback_sessions.segments_fetched`) counts full segments only, so with it alone a
   * low-latency player that fetches parts would look starved: ratio checks are skipped then.
   */
  parts: number | null;
}

/** Relay-observed delivery for a session: the per-session entries of its relay's receipts. */
export interface RelayFetchSummary {
  /** Fully delivered media objects (segments, parts, init sections) the receipts list for the session. */
  relayObjects: number;
  /** Seconds of playback the session claimed inside the window those receipts cover. */
  claimedSeconds: number;
}

/**
 * What the delivery path says a session fetched. Null when no per-session accounting
 * exists: CDN delivery (CDN pulls are tokenless) or a relay with no receipts for the window.
 */
export type FetchEvidence = FetchSummary | RelayFetchSummary | null;

export const isRelayFetch = (f: FetchEvidence): f is RelayFetchSummary => f !== null && "relayObjects" in f;

/**
 * What an overturned appeal or an admin `allowed` decision covers (see `allowance.ts`).
 * Covered codes are ignored; heartbeat checks look only at beats received after `since`.
 */
export interface Allowance {
  /** Epoch ms of the latest covering decision. */
  since: number;
  codes: readonly string[];
}

export interface Concurrency {
  /**
   * 1-based position among the concurrent sessions of the same device (or account), newest
   * first: after a reload the new session is the real one.
   */
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
  /** Appeal / admin allowance covering this session, if any. */
  allowance?: Allowance | null;
}

export type Verdict = "verified" | "excluded" | "pending";

export interface SessionScore {
  verdict: Verdict;
  score: number;
  /** Reason codes, strongest first. */
  reasons: string[];
  signals: Signal[];
}
