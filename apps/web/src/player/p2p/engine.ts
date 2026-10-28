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

/** Socket failures before P2P gives up for the session (the tracker refuses, or is unreachable). */
export const MAX_TRACKER_SOCKET_ERRORS = 3;

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
  const engine = new Engine({
    core: buildCoreConfig(opts.p2p, {
      iceServers: opts.iceServers,
      validateP2PSegment: opts.validateP2PSegment,
      httpRequestSetup: async (segmentUrl, _segmentRange, signal, range) =>
        tokenedSegmentRequest(segmentUrl, opts.token(), signal, range, withToken),
    }),
  });

  let running = true;
  let destroyed = false;
  let socketErrors = 0;

  const disable = () => {
    if (!running) return;
    running = false;
    engine.applyDynamicConfig({ core: { isP2PDisabled: true, isP2PUploadDisabled: true } });
    stats.clearPeers();
    opts.onChange();
  };

  const onSocketError = () => {
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
  engine.addEventListener("onSegmentLoaded", (d) => {
    if (d.downloadSource === "p2p") stats.p2pBytes += d.bytesLength;
  });
  engine.addEventListener("onChunkUploaded", (bytes) => {
    stats.uploadedBytes += bytes;
  });
  engine.addEventListener("onPeerConnect", (d) => {
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
