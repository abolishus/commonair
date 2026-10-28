// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * hls.js with the P2P loader (`p2p-media-loader-hlsjs` 4.0.0), for sessions where
 * `PlaybackStart.p2p.enabled`. Loaded by dynamic `import()` only then, so the loader stays out of
 * the main chunk (as hls.js does).
 *
 * How the pinned loader works, as this wrapper relies on it:
 * - Peers identify a segment by its stream swarm (info hash of `streamSwarmIdBuilder`'s id) and
 *   its media sequence number (`externalId`, `segment-manager.ts`); never by URL, so tokenized
 *   URLs do not split the swarm.
 * - Segments the loader fetches over HTTP itself go through `httpRequestSetup`, not hls.js's
 *   `xhrSetup`; segments it has not registered (LL-HLS parts, init segments) and playlists go
 *   through hls.js's own loader.
 * - `validateP2PSegment` returning false drops the bytes, destroys that peer connection
 *   (`peer.ts`, `validation-failed`) and leaves the segment to HTTP or another peer.
 * - A peer that stops partway (timeout, absent answer, abort) leaves its bytes on the request;
 *   HTTP then finishes them and only `validateHTTPSegment` sees the result (`PeerTouchedSegments`).
 * - A tracker socket that cannot connect (403 without a grant) is reported only on the core's
 *   private socket pool, which `watchTrackerSockets` reaches into defensively.
 */
import type Hls from "hls.js";
import type { HlsConfig, Loader, LoaderCallbacks, LoaderConfiguration, LoaderContext } from "hls.js";
import { HlsJsP2PEngine } from "p2p-media-loader-hlsjs";
import type { CoreEventMap, DynamicCoreConfig } from "p2p-media-loader-core";
import { withToken } from "../heartbeat.ts";
import { buildCoreConfig, tokenedSegmentRequest, type P2PSessionInfo } from "./config.ts";
import type { P2PStats } from "./stats.ts";

/** The part of `HlsJsP2PEngine` this wrapper uses (tests pass a fake). */
export interface EngineLike {
  getConfigForHlsJs(): { fLoader: unknown; pLoader: unknown };
  bindHls(hls: unknown): void;
  addEventListener<K extends keyof CoreEventMap>(name: K, listener: CoreEventMap[K]): void;
  applyDynamicConfig(config: { core?: DynamicCoreConfig }): void;
  destroy(): void;
}

export type EngineCtor = new (config: { core: ReturnType<typeof buildCoreConfig> }) => EngineLike;

export interface P2PHlsOptions {
  Hls: typeof Hls;
  /** The session's hls.js config (already including `P2P_HLS_CONFIG`). */
  hlsConfig: Partial<HlsConfig>;
  p2p: P2PSessionInfo;
  iceServers: RTCIceServer[];
  /** `DigestValidator.validate`. */
  validateP2PSegment: (url: string, byteRange: unknown, data: ArrayBuffer) => Promise<boolean>;
  /** The current playback token. */
  token: () => string | undefined;
  stats: P2PStats;
  /** Bytes of hls.js's own HTTP requests (playlists, parts, segments the loader did not take). */
  onHlsHttpBytes: (bytes: number) => void;
  /** Peers or the running state changed. */
  onChange: () => void;
  Engine?: EngineCtor;
}

export interface P2PHls {
  hls: Hls;
  readonly running: boolean;
  /** Stop P2P now (no reload): the loader drops its peers and tracker socket, HTTP continues. */
  disable(): void;
  /** Fresh ICE servers (TURN credentials) for new peer connections. */
  applyIceServers(iceServers: RTCIceServer[]): void;
  /** Destroy the loader (peers, tracker socket) and hls.js. */
  destroy(): void;
}

/**
 * Consecutive socket failures before P2P gives up for the session (the tracker refuses, or is
 * unreachable). The socket retries with backoff from 1 s, so a refusal fails 3 times in seconds.
 */
export const MAX_TRACKER_SOCKET_ERRORS = 3;
/** Socket errors further apart than this start a new streak (a Wi-Fi drop hours later is not a refusal). */
export const TRACKER_SOCKET_ERROR_GAP_MS = 60_000;
/** Peer-touched segments remembered at once, oldest dropped (a few seconds of segments are in flight). */
export const MAX_PEER_TOUCHED_SEGMENTS = 256;

/**
 * Segments a peer started sending that have not loaded yet. The pinned core keeps a peer's
 * partial bytes when the peer stalls (`bytes-receiving-timeout`), answers absent mid-transfer or
 * is aborted; only a validation failure or protocol error clears them (`peer.ts`
 * `#destroyOnPeerError`). Its HTTP loader then resumes with `Range: bytes=<loaded>-`, or completes
 * from the loaded bytes alone, and checks the joined buffer only with `validateHTTPSegment`. So
 * those completions go through the digest like any peer-delivered segment (decision 7); pure HTTP
 * segments skip it (one origin request each for nothing).
 */
export class PeerTouchedSegments {
  /** url → bytes the peer had delivered when HTTP first resumed, then the peer's share once valid. */
  readonly #segments = new Map<string, { resumedAt?: number; share?: number }>();

  /** A peer attempt on this segment started (`onSegmentStart`, source p2p). */
  peerStarted(url: string): void {
    this.#segments.delete(url);
    this.#segments.set(url, {});
    if (this.#segments.size > MAX_PEER_TOUCHED_SEGMENTS) {
      const oldest = this.#segments.keys().next().value;
      if (oldest !== undefined) this.#segments.delete(oldest);
    }
  }

  has(url: string): boolean {
    return this.#segments.has(url);
  }

  /**
   * The loader's HTTP request for a peer-touched segment starts at `offset`: what came before it
   * came from the peer (the first resume only; a later one after a truncated HTTP response
   * includes HTTP bytes).
   */
  httpResumed(url: string, offset: number): void {
    const entry = this.#segments.get(url);
    if (entry && entry.resumedAt === undefined) entry.resumedAt = offset;
  }

  /**
   * The digest check came back. On false the core drops every loaded byte and fetches again from
   * byte 0 over HTTP, so the segment is no longer peer-touched (and is not checked forever).
   */
  checked(url: string, valid: boolean, length: number): void {
    const entry = this.#segments.get(url);
    if (!entry) return;
    if (!valid) this.#segments.delete(url);
    else entry.share = Math.min(length, entry.resumedAt ?? length);
  }

  /** The segment loaded: the bytes of it that came from a peer, when HTTP finished it. */
  loaded(url: string, source: "http" | "p2p"): number {
    const share = this.#segments.get(url)?.share ?? 0;
    this.#segments.delete(url);
    return source === "http" ? share : 0;
  }
}

type DefaultLoader = new (config: HlsConfig) => Loader<LoaderContext>;

/** hls.js's own loader, counting the bytes of every request it completes. */
export function countingLoader(Base: DefaultLoader, onBytes: (bytes: number) => void): DefaultLoader {
  return class CountingLoader extends Base {
    override load(context: LoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) {
      super.load(context, config, {
        ...callbacks,
        onSuccess: (response, stats, ctx, networkDetails) => {
          onBytes(stats.loaded);
          callbacks.onSuccess(response, stats, ctx, networkDetails);
        },
      });
    }
  };
}

interface SocketPoolLike {
  addEventListener(name: "error", listener: () => void): void;
  removeEventListener(name: "error", listener: () => void): void;
}

/** The core's tracker socket pool, if this loader version still has it where 4.0.0 does. */
function socketPool(engine: EngineLike): SocketPoolLike | null {
  const core = (engine as unknown as { core?: { webTorrentSocketPool?: unknown } }).core;
  const pool = core?.webTorrentSocketPool as Partial<SocketPoolLike> | undefined;
  return typeof pool?.addEventListener === "function" && typeof pool.removeEventListener === "function"
    ? (pool as SocketPoolLike)
    : null;
}

export function createP2PHls(opts: P2PHlsOptions): P2PHls {
  const { Hls: HlsCtor, stats } = opts;
  const Engine: EngineCtor = opts.Engine ?? (HlsJsP2PEngine as unknown as EngineCtor);
  const touched = new PeerTouchedSegments();
  const engine = new Engine({
    core: buildCoreConfig(opts.p2p, {
      iceServers: opts.iceServers,
      validateP2PSegment: opts.validateP2PSegment,
      validateHTTPSegment: async (url, byteRange, data) => {
        if (!touched.has(url)) return true;
        let valid = false;
        try {
          valid = await opts.validateP2PSegment(url, byteRange, data);
        } finally {
          touched.checked(url, valid, data.byteLength);
        }
        return valid;
      },
      httpRequestSetup: async (segmentUrl, segmentRange, signal, range) => {
        if (!segmentRange) touched.httpResumed(segmentUrl, range?.start ?? 0);
        return tokenedSegmentRequest(segmentUrl, opts.token(), signal, range, withToken);
      },
    }),
  });

  let running = true;
  let destroyed = false;
  let socketErrors = 0;
  let lastSocketError = Number.NEGATIVE_INFINITY;
  /** Proof the tracker socket works (a peer signalled through it, a tracker message): a new streak. */
  const socketWorks = () => {
    socketErrors = 0;
  };

  const disable = () => {
    if (!running) return;
    running = false;
    engine.applyDynamicConfig({ core: { isP2PDisabled: true, isP2PUploadDisabled: true } });
    stats.clearPeers();
    opts.onChange();
  };

  const onSocketError = () => {
    const now = Date.now();
    if (now - lastSocketError > TRACKER_SOCKET_ERROR_GAP_MS) socketErrors = 0;
    lastSocketError = now;
    socketErrors += 1;
    if (socketErrors >= MAX_TRACKER_SOCKET_ERRORS) disable();
  };
  const watchTrackerSockets = () => {
    const pool = socketPool(engine);
    pool?.removeEventListener("error", onSocketError);
    pool?.addEventListener("error", onSocketError);
  };

  engine.addEventListener("onChunkDownloaded", (bytes, source) => {
    if (source === "http") stats.httpSegmentBytes += bytes;
  });
  engine.addEventListener("onSegmentStart", (d) => {
    if (d.downloadSource === "p2p") touched.peerStarted(d.segment.url);
  });
  engine.addEventListener("onSegmentLoaded", (d) => {
    // A segment HTTP finished after a peer stopped: the peer's prefix counts as P2P (the HTTP
    // remainder is already counted chunk by chunk).
    const peerShare = touched.loaded(d.segment.url, d.downloadSource);
    if (d.downloadSource === "p2p") stats.p2pBytes += d.bytesLength;
    else stats.p2pBytes += peerShare;
  });
  engine.addEventListener("onChunkUploaded", (bytes) => {
    stats.uploadedBytes += bytes;
  });
  engine.addEventListener("onPeerConnect", (d) => {
    socketWorks();
    if (!running) return;
    stats.peerConnected(`${d.infoHash}/${d.peerId}`);
    opts.onChange();
  });
  engine.addEventListener("onPeerClose", (d) => {
    stats.peerClosed(`${d.infoHash}/${d.peerId}`);
    opts.onChange();
  });
  engine.addEventListener("onTrackerError", (d) => {
    // "failure reason" from our tracker: no grant, an info hash outside the set, an old token.
    if (d.error.type === "tracker-response") disable();
  });
  engine.addEventListener("onTrackerWarning", socketWorks);

  const BaseLoader = (opts.hlsConfig.loader ?? HlsCtor.DefaultConfig.loader) as DefaultLoader;
  const hls = new HlsCtor({
    ...opts.hlsConfig,
    loader: countingLoader(BaseLoader, opts.onHlsHttpBytes),
    ...(engine.getConfigForHlsJs() as Pick<HlsConfig, "fLoader" | "pLoader">),
  });
  engine.bindHls(hls);
  // A new manifest (first load, or a relay → origin switch) rebuilds the core: same swarm ids,
  // new socket, so peers start from zero and the socket watch is attached again.
  hls.on(HlsCtor.Events.MANIFEST_LOADING, () => {
    socketWorks();
    stats.clearPeers();
    opts.onChange();
  });
  hls.on(HlsCtor.Events.MANIFEST_LOADED, watchTrackerSockets);

  return {
    hls,
    get running() {
      return running && !destroyed;
    },
    disable,
    applyIceServers(iceServers) {
      if (destroyed) return;
      engine.applyDynamicConfig({ core: { rtcConfig: { iceServers: iceServers.map((s) => ({ ...s })) } } });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      running = false;
      engine.destroy();
      hls.destroy();
      stats.clearPeers();
    },
  };
}
