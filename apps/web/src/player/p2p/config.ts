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
 * Latency vs sharing (P1 Build 5), P2P sessions only. MediaMTX serves 1 s segments with 200 ms
 * LL-HLS parts in a 7-segment playlist. Parts never come from peers (the origin publishes digests
 * of whole segments only), so low-latency mode would leave nothing to share: P2P sessions play
 * whole segments 4 s behind the live edge (about 3 s more latency than LL-HLS). A segment then
 * appears 4 s before it is needed: for the first 2 s peers may only fetch it from each other (or
 * one seeds it over HTTP at random), the last 2 s are the loader's high-demand window, where
 * anything still missing comes over HTTP.
 */
export const P2P_HLS_CONFIG = {
  lowLatencyMode: false,
  liveSyncDuration: 4,
  liveMaxLatencyDuration: 6,
} as const satisfies Partial<HlsConfig>;

/** The loader's time windows for P2P sessions (seconds of media ahead of the playhead). */
export const P2P_TIME_WINDOWS = {
  highDemandTimeWindow: 2,
  httpDownloadTimeWindow: 3,
  p2pDownloadTimeWindow: 4,
} as const;

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
export function buildCoreConfig(p2p: P2PSessionInfo, hooks: CoreConfigHooks): CoreConfig {
  return {
    swarmId: p2p.swarmId,
    streamSwarmIdBuilder: streamSwarmIdBuilder,
    announceTrackers: [...p2p.trackerUrls],
    rtcConfig: { iceServers: hooks.iceServers.map((s) => ({ ...s })) },
    validateP2PSegment: hooks.validateP2PSegment,
    validateHTTPSegment: hooks.validateHTTPSegment,
    httpRequestSetup: hooks.httpRequestSetup,
    ...P2P_TIME_WINDOWS,
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
