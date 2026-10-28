// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The loader's configuration for one P2P session, built from `PlaybackStart.p2p` and the ICE
 * servers. Pure and library-free (type imports only), so the main chunk can hold it while the
 * loader itself stays in the lazily loaded engine chunk.
 */
import { P2P_STREAM_RENDITIONS, p2pStreamSwarmId, type P2PStreamType } from "@commonair/contracts/p2p";
import type { HlsConfig } from "hls.js";
import type { CoreConfig, StreamSwarmIdBuilderContext } from "p2p-media-loader-core";

export interface P2PSessionInfo {
  trackerUrls: string[];
  swarmId: string;
}

/**
 * The rendition a variant or audio playlist belongs to: its directory under `live/<slug>/`
 * (`services/origin/src/paths.ts`), `source` when there is none. The URL carries this viewer's
 * token, so it never goes into a swarm id itself.
 */
export function renditionOf(playlistUrl: string): string {
  let path: string;
  try {
    path = new URL(playlistUrl).pathname;
  } catch {
    return "source";
  }
  const m = /\/live\/[^/]+\/([^/]+)\/[^/]+$/.exec(path);
  const dir = m?.[1];
  return dir !== undefined && P2P_STREAM_RENDITIONS.includes(dir) ? dir : "source";
}

/**
 * `ca1:<swarmId>:<main|secondary>:<rendition>` (`@commonair/contracts/p2p`), which the tracker
 * reproduces. The library's default hashes bitrate, codecs and frame rate, which it cannot.
 *
 * Audio tracks take their playlist's directory too, not one shared `audio` name: the origin
 * namespaces one audio group per rendition (`synthesizeMultivariant`), and those are different
 * streams with the same properties, so a shared name would put different segments under one
 * sequence number in one swarm (every exchange failing validation). The tracker allows every
 * name for both types.
 */
export function streamSwarmIdBuilder(ctx: Pick<StreamSwarmIdBuilderContext, "swarmId" | "runtimeId" | "streamType">) {
  const type: P2PStreamType = ctx.streamType;
  return p2pStreamSwarmId(ctx.swarmId, type, renditionOf(ctx.runtimeId));
}

/**
 * Latency vs sharing (P1 Build 5), P2P sessions only; plain sessions keep low-latency HLS.
 *
 * MediaMTX cuts segments on keyframes (2 s with the ladder's GOP) and keeps 7 in the playlist
 * (about 14 s); parts never come from peers (the origin publishes digests of whole segments only).
 * A segment that just appeared is `target - 2` s ahead of a session's playhead. While it is further
 * ahead than `httpDownloadTimeWindow` only peers may deliver it; between that and
 * `highDemandTimeWindow` the loader may seed it over HTTP at random; inside the high-demand window
 * HTTP takes over. Sessions at the same distance from the edge all reach the high-demand window
 * together and all fetch over HTTP, so each session draws its target once from
 * [liveSyncDuration, liveSyncDuration + liveSyncSpread): the session nearest the edge fetches a
 * segment over HTTP and the ones further back take it from a peer before they need it.
 *
 * Measured on the harness stack (10 opted-in Chromium viewers, 60 s, P1-player 2026-10-28): a fixed
 * 4 s target shared 2 % of bytes; 4–6 s, 27 %; 4–8 s, 37 % (the first ~10 s of each session are
 * HTTP only, until its first heartbeat). Median latency 5.8 s against 2.0 s for low-latency
 * sessions (glass to glass), so about +4 s. The farthest target plus the slack (10 s) leaves one
 * segment of the 14 s playlist as margin.
 */
export interface P2PTuning {
  /** The smallest distance from the live edge a P2P session plays at (seconds). */
  liveSyncDuration: number;
  /** Each session adds a uniform draw from [0, spread) to it (seconds). */
  liveSyncSpread: number;
  /** hls.js jumps forward to the target once latency exceeds target + this (seconds). */
  maxLatencySlack: number;
  highDemandTimeWindow: number;
  httpDownloadTimeWindow: number;
  /** Covers every segment ahead of the farthest playhead (`liveSyncDuration + liveSyncSpread - 2`). */
  p2pDownloadTimeWindow: number;
  simultaneousHttpDownloads: number;
  simultaneousP2PDownloads: number;
}

export const P2P_TUNING: P2PTuning = Object.freeze({
  liveSyncDuration: 4,
  liveSyncSpread: 4,
  maxLatencySlack: 2,
  highDemandTimeWindow: 1.5,
  httpDownloadTimeWindow: 3,
  p2pDownloadTimeWindow: 8,
  simultaneousHttpDownloads: 2,
  simultaneousP2PDownloads: 3,
});

/** hls.js settings of one P2P session: whole segments, a distance from the live edge drawn once. */
export function p2pHlsConfig(tuning: P2PTuning = P2P_TUNING, random: () => number = Math.random) {
  const r = random();
  const draw = Number.isFinite(r) ? Math.min(Math.max(r, 0), 1) : 0;
  const sync = tuning.liveSyncDuration + draw * tuning.liveSyncSpread;
  return {
    lowLatencyMode: false,
    liveSyncDuration: sync,
    liveMaxLatencyDuration: sync + tuning.maxLatencySlack,
  } satisfies Partial<HlsConfig>;
}

/** The loader's windows and concurrency for P2P sessions (seconds of media ahead of the playhead). */
export function p2pCoreTuning(tuning: P2PTuning = P2P_TUNING) {
  return {
    highDemandTimeWindow: tuning.highDemandTimeWindow,
    httpDownloadTimeWindow: tuning.httpDownloadTimeWindow,
    p2pDownloadTimeWindow: tuning.p2pDownloadTimeWindow,
    simultaneousHttpDownloads: tuning.simultaneousHttpDownloads,
    simultaneousP2PDownloads: tuning.simultaneousP2PDownloads,
  } satisfies Partial<CoreConfig>;
}

/**
 * How long after an acknowledged heartbeat the session counts as watching for the tracker. The
 * tracker accepts a socket while the last heartbeat is under 30 s old (`HEARTBEAT_STALE_MS`,
 * services/tracker/src/auth.ts); this stays below it so clock skew and request time cannot make a
 * refused socket look like an accepted session.
 */
export const P2P_WATCHING_WINDOW_MS = 25_000;

export interface CoreConfigHooks {
  iceServers: RTCIceServer[];
  validateP2PSegment: NonNullable<CoreConfig["validateP2PSegment"]>;
  /** Checks HTTP completions of segments a peer started (see `PeerTouchedSegments`). */
  validateHTTPSegment: NonNullable<CoreConfig["validateHTTPSegment"]>;
  httpRequestSetup: NonNullable<CoreConfig["httpRequestSetup"]>;
}

/**
 * The core config. `announceTrackers` and `rtcConfig` are always set: the library's defaults are
 * three public trackers and Google/Twilio STUN, and none of them may survive. An empty ICE list
 * means host candidates only.
 */
export function buildCoreConfig(
  p2p: P2PSessionInfo,
  hooks: CoreConfigHooks,
  tuning: P2PTuning = P2P_TUNING,
): CoreConfig {
  return {
    swarmId: p2p.swarmId,
    streamSwarmIdBuilder: streamSwarmIdBuilder,
    announceTrackers: [...p2p.trackerUrls],
    rtcConfig: { iceServers: hooks.iceServers.map((s) => ({ ...s })) },
    validateP2PSegment: hooks.validateP2PSegment,
    validateHTTPSegment: hooks.validateHTTPSegment,
    httpRequestSetup: hooks.httpRequestSetup,
    // Off until the session's first heartbeat is acknowledged (`P2PHls.enable`): no tracker
    // socket before the tracker sees the session watching.
    isP2PDisabled: true,
    isP2PUploadDisabled: true,
    ...p2pCoreTuning(tuning),
  };
}

/**
 * The loader's HTTP request for a segment with the current token in `t` (heartbeats refresh it;
 * the playlist URL carries the token it was issued with).
 */
export function tokenedSegmentRequest(
  segmentUrl: string,
  token: string | undefined,
  signal: AbortSignal | undefined,
  range: { start: number; end?: number } | undefined,
  withToken: (url: string, token: string) => string,
): Request {
  const headers = new Headers();
  if (range) headers.set("Range", `bytes=${range.start}-${range.end ?? ""}`);
  const init: RequestInit = { headers };
  if (signal) init.signal = signal;
  return new Request(token ? withToken(segmentUrl, token) : segmentUrl, init);
}
