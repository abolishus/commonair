// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The one viewer interface every simulated viewer implements: Playwright browser viewers
 * (harness player page or the real web embed), lightweight HTTP-only viewers, and viewbots.
 * Scenarios and the load test only talk to this interface.
 */
import type { dto } from "@commonair/contracts";
import type { z } from "zod";
import type { ApiClient } from "./api/client.ts";
import { summarize, type Summary } from "./metrics.ts";

export type ViewerKind = "browser" | "http" | "bot";
export type ViewerEngine = "chromium" | "webkit" | "http";
export type PlaybackPath = "mse" | "native" | "http";

/** Where a viewer gets its stream: through the API (real playback session) or a direct playlist. */
export type ViewerTarget = { channel: string } | { playlistUrl: string };

export interface ViewerReport {
  id: string;
  kind: ViewerKind;
  engine: ViewerEngine;
  playbackPath: PlaybackPath | null;
  sessionId: string | null;
  source: string | null;
  /** Epoch ms the viewer started. */
  startedAt: number;
  /** Time from start to the first rendered frame (browser) or first downloaded segment (HTTP). */
  ttffMs: number | null;
  stalls: number;
  stallMs: number;
  playedSeconds: number;
  /** Glass-to-glass latency samples in ms (capture time from the timestamp strip → display). */
  latencyMs: number[];
  /** `strip` = decoded from pixels; `pdt` = from EXT-X-PROGRAM-DATE-TIME (HTTP viewers). */
  latencyMethod: "strip" | "pdt" | null;
  bytesHttp: number;
  bytesP2p: number;
  /** Segments that failed to download and were skipped (HTTP viewers). */
  skippedSegments: number;
  heartbeats: number;
  heartbeatErrors: number;
  errors: string[];
}

export interface Viewer {
  readonly id: string;
  readonly kind: ViewerKind;
  start(): Promise<void>;
  /** Resolves with TTFF in ms once the first frame is shown; rejects on timeout or fatal error. */
  waitForFirstFrame(timeoutMs?: number): Promise<number>;
  report(): Promise<ViewerReport>;
  /** Stop playback, end the session, return the final report. Idempotent. */
  stop(): Promise<ViewerReport>;
}

export function emptyReport(id: string, kind: ViewerKind, engine: ViewerEngine): ViewerReport {
  return {
    id,
    kind,
    engine,
    playbackPath: null,
    sessionId: null,
    source: null,
    startedAt: Date.now(),
    ttffMs: null,
    stalls: 0,
    stallMs: 0,
    playedSeconds: 0,
    latencyMs: [],
    latencyMethod: null,
    bytesHttp: 0,
    bytesP2p: 0,
    skippedSegments: 0,
    heartbeats: 0,
    heartbeatErrors: 0,
    errors: [],
  };
}

/** Aggregate many viewer reports (load test and scenario metrics). */
export interface ViewerAggregate {
  viewers: number;
  started: number;
  ttff: Summary;
  latency: Summary;
  stalls: number;
  stallMs: number;
  playedSeconds: number;
  /** Stalled time / (played + stalled time). */
  stallRatio: number;
  /** Stalls per viewer-minute of playback. */
  stallsPerMinute: number;
  bytesHttp: number;
  bytesP2p: number;
  errors: number;
}

export function aggregateReports(reports: readonly ViewerReport[]): ViewerAggregate {
  const ttffs = reports.flatMap((r) => (r.ttffMs === null ? [] : [r.ttffMs]));
  const latencies = reports.flatMap((r) => r.latencyMs);
  const stalls = reports.reduce((s, r) => s + r.stalls, 0);
  const stallMs = reports.reduce((s, r) => s + r.stallMs, 0);
  const played = reports.reduce((s, r) => s + r.playedSeconds, 0);
  const totalSeconds = played + stallMs / 1000;
  return {
    viewers: reports.length,
    started: ttffs.length,
    ttff: summarize(ttffs),
    latency: summarize(latencies),
    stalls,
    stallMs,
    playedSeconds: played,
    stallRatio: totalSeconds > 0 ? stallMs / 1000 / totalSeconds : 0,
    stallsPerMinute: played > 0 ? stalls / (played / 60) : 0,
    bytesHttp: reports.reduce((s, r) => s + r.bytesHttp, 0),
    bytesP2p: reports.reduce((s, r) => s + r.bytesP2p, 0),
    errors: reports.reduce((s, r) => s + r.errors.length, 0),
  };
}

export type PlaybackStart = z.infer<typeof dto.PlaybackStart>;
export type HeartbeatInput = z.infer<typeof dto.Heartbeat>;

/**
 * Heartbeat counters (`stalls`, `bytesHttp`, `bytesP2p`) are sent as deltas since the previous
 * heartbeat, like `playedSeconds`.
 * CONTRACT-REQUEST: state delta-vs-cumulative for these fields in `dto.Heartbeat` docs.
 */
export const HEARTBEAT_COUNTERS_ARE_DELTAS = true;

export interface SessionStats {
  playedSeconds: number;
  bufferSeconds: number;
  stalls: number;
  bytesHttp: number;
  bytesP2p: number;
  latencySeconds: number | null;
  ttffMs: number | null;
  visible: boolean;
  muted: boolean;
}

/** A playback session against the API: start → heartbeat… → end, tracking token refreshes. */
export class PlaybackSession {
  started: PlaybackStart | null = null;
  token: string | null = null;
  playlistUrl: string | null = null;
  ended = false;
  private sent = { played: 0, stalls: 0, bytesHttp: 0, bytesP2p: 0 };

  constructor(
    private readonly api: ApiClient,
    private readonly opts: {
      channel: string;
      deviceId: string;
      nativeHls?: boolean;
      p2pCapable?: boolean;
      embed?: boolean;
      fingerprint?: Record<string, string | number | boolean | null>;
    },
  ) {}

  async start(): Promise<PlaybackStart> {
    const res = await this.api.playback.start({
      channel: this.opts.channel,
      deviceId: this.opts.deviceId,
      nativeHls: this.opts.nativeHls ?? false,
      p2pCapable: this.opts.p2pCapable ?? false,
      embed: this.opts.embed ?? false,
    });
    this.started = res;
    this.token = res.token;
    this.playlistUrl = res.playlistUrl;
    return res;
  }

  /** Send cumulative stats; the session converts them to per-heartbeat deltas. Returns a new playlist URL on switch. */
  async heartbeat(
    cumulative: SessionStats & { rendition?: HeartbeatInput["rendition"] },
  ): Promise<{ switchTo?: string }> {
    if (!this.started || !this.token || this.ended) throw new Error("playback session not started");
    const input: HeartbeatInput = {
      sessionId: this.started.sessionId,
      token: this.token,
      playedSeconds: Math.min(120, Math.max(0, cumulative.playedSeconds - this.sent.played)),
      bufferSeconds: Math.max(0, cumulative.bufferSeconds),
      stalls: Math.max(0, cumulative.stalls - this.sent.stalls),
      bytesHttp: Math.max(0, Math.round(cumulative.bytesHttp - this.sent.bytesHttp)),
      bytesP2p: Math.max(0, Math.round(cumulative.bytesP2p - this.sent.bytesP2p)),
      rendition: cumulative.rendition ?? "source",
      latencySeconds: cumulative.latencySeconds,
      ttffMs: cumulative.ttffMs,
      visible: cumulative.visible,
      muted: cumulative.muted,
      fingerprint: this.opts.fingerprint,
    };
    const res = await this.api.playback.heartbeat(input);
    this.sent = {
      played: cumulative.playedSeconds,
      stalls: cumulative.stalls,
      bytesHttp: cumulative.bytesHttp,
      bytesP2p: cumulative.bytesP2p,
    };
    if (res.token) this.token = res.token;
    if (res.switchTo) this.playlistUrl = res.switchTo;
    return res.switchTo ? { switchTo: res.switchTo } : {};
  }

  async end(): Promise<void> {
    if (!this.started || !this.token || this.ended) return;
    this.ended = true;
    await this.api.playback.end({ sessionId: this.started.sessionId, token: this.token });
  }
}
