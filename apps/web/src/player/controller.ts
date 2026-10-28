// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One playback session on one `<video>`: `playback.start`, play the signed playlist (hls.js over
 * MSE, native HLS where MSE is missing or on WebKit), heartbeat per the contract (honouring token
 * refresh and `switchTo`), `playback.end` on stop. Framework-free so it can move to
 * `packages/player` unchanged.
 *
 * P2P (ADR 0005 amendment 1): only when the caller's policy allows it on the hls.js path does the
 * session ask for it (`p2pCapable`), and only when the server granted it (`p2p.enabled`) and gave
 * ICE servers does the P2P loader (`./p2p/engine.ts`, its own chunk) load. Anything else is plain
 * hls.js exactly as without P2P.
 */
import type Hls from "hls.js";
import type { HlsConfig } from "hls.js";
import type { Api } from "../lib/api.ts";
import {
  HeartbeatAccountant,
  MAX_P2P_PEERS,
  RENDITION_SOURCE,
  nextHeartbeatDelay,
  withToken,
  type CumulativeStats,
} from "./heartbeat.ts";
import { P2P_WATCHING_WINDOW_MS, p2pHlsConfig } from "./p2p/config.ts";
import { DigestValidator } from "./p2p/digest.ts";
import type { P2PHls } from "./p2p/engine.ts";
import { fetchIceServers, iceRefreshDelay } from "./p2p/ice.ts";
import { P2PStats, p2pState, type P2PState } from "./p2p/stats.ts";
import { heartbeatSwitch, playerSource, type PlayerSource } from "./source.ts";
import { VideoStats, collectFingerprint, sessionDeviceId } from "./stats.ts";

export type PlayerState = "offline" | "loading" | "playing" | "error";

/** What the player shows about P2P for the current session. */
export interface P2PStatus {
  /** The server would allow P2P for this session (`PlaybackStart.p2p.available`): offer the switch. */
  available: boolean;
  state: P2PState;
  peers: number;
  /** Bytes sent to peers this session. */
  uploadedBytes: number;
  /** Segment bytes received from peers this session. */
  receivedBytes: number;
}

export const P2P_STATUS_OFF: P2PStatus = Object.freeze({
  available: false,
  state: "off",
  peers: 0,
  uploadedBytes: 0,
  receivedBytes: 0,
});

type EngineModule = typeof import("./p2p/engine.ts");

export interface PlayerControllerOptions {
  channel: string;
  video: HTMLVideoElement;
  api: Api;
  /** Client used for `playback.end` while the page unloads. */
  endApi?: Api;
  embed?: boolean;
  onState: (state: PlayerState) => void;
  /** The delivery source of the playlist being played: on start and after every `switchTo`. */
  onSource?: (source: PlayerSource) => void;
  /** A failed start (e.g. `playback.start` refused with the 18+ gate); the state still goes to `error`. */
  onStartError?: (err: unknown) => void;
  /**
   * Whether this session asks for P2P, decided at start once the path is known (`native`). The
   * player's policy (`p2p/policy.ts`) plus the disclosure rule; absent means never.
   */
  p2pWanted?: (native: boolean) => boolean;
  /** P2P status changes (start, peers, turned off) and a refresh with every heartbeat. */
  onP2P?: (status: P2PStatus) => void;
  /** Tests: load the P2P engine module (default: the lazy chunk). */
  loadP2PEngine?: () => Promise<EngineModule>;
}

const PLAYLIST_WAIT_MS = 45_000;

/** Every hls.js session. */
const BASE_HLS_CONFIG = {
  manifestLoadingMaxRetry: 45,
  manifestLoadingRetryDelay: 1_000,
  // Every second, not hls.js's doubling: the origin answers 503 while a rendition (a WHIP
  // source's AAC copy) starts, and a 1-2-4-8 s backoff adds up to 7 s to its first frame.
  manifestLoadingMaxRetryTimeout: 1_000,
  levelLoadingMaxRetry: 10,
  fragLoadingMaxRetry: 10,
} as const satisfies Partial<HlsConfig>;

/** Sessions without P2P: low-latency HLS as before P1. */
const LL_HLS_CONFIG = { lowLatencyMode: true, liveSyncDurationCount: 3 } as const satisfies Partial<HlsConfig>;

function isChromium(): boolean {
  return "userAgentData" in navigator || /Chrome\//.test(navigator.userAgent);
}

/** Native HLS on WebKit (Safari, iOS); hls.js wherever MSE works. */
export function prefersNativeHls(video: HTMLVideoElement, mseSupported: boolean): boolean {
  const canNative = video.canPlayType("application/vnd.apple.mpegurl") !== "";
  if (canNative && !isChromium()) return true;
  return !mseSupported && canNative;
}

interface P2PPlan {
  engine: EngineModule;
  iceServers: RTCIceServer[];
  expiresAt: number | null;
  info: { trackerUrls: string[]; swarmId: string; digestUrl: string };
}

export class PlayerController {
  private hls: Hls | null = null;
  private stats: VideoStats | null = null;
  private accountant = new HeartbeatAccountant();
  private session: { id: string; token: string; intervalMs: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private iceTimer: ReturnType<typeof setTimeout> | null = null;
  private abort = new AbortController();
  private bytesHttp = 0;
  private native = false;
  private stopped = false;
  private state: PlayerState = "loading";
  private p2p: P2PHls | null = null;
  private p2pStats: P2PStats | null = null;
  private p2pAvailable = false;
  /** The viewer turned P2P off during this session. */
  private p2pOff = false;
  /** When the server last acknowledged a heartbeat (it then lists the session as watching). */
  private lastAckAt: number | null = null;

  constructor(private readonly opts: PlayerControllerOptions) {}

  private setState(s: PlayerState): void {
    if (this.stopped || this.state === s) return;
    this.state = s;
    this.opts.onState(s);
  }

  /** The current P2P status (also sent through `onP2P`). */
  p2pStatus(): P2PStatus {
    const stats = this.p2pStats;
    const running = this.p2p !== null && !this.p2pOff && !this.stopped;
    const peers = running ? (stats?.peerCount ?? 0) : 0;
    return {
      available: this.p2pAvailable,
      state: p2pState(running, peers),
      peers,
      uploadedBytes: stats?.uploadedBytes ?? 0,
      receivedBytes: stats?.p2pBytes ?? 0,
    };
  }

  private emitP2P = (): void => {
    if (!this.stopped) this.opts.onP2P?.(this.p2pStatus());
  };

  /**
   * The viewer turned P2P off: stop the loader at once (peers and tracker socket go, playback
   * continues over HTTP, no reload). Turning it on again needs a new playback start.
   */
  disableP2P(): void {
    if (this.p2pOff) return;
    this.p2pOff = true;
    if (this.iceTimer) clearTimeout(this.iceTimer);
    this.iceTimer = null;
    this.p2p?.disable();
    this.emitP2P();
  }

  async start(): Promise<void> {
    const { video, api, channel } = this.opts;
    // Always reported, even though a new controller already is `loading`: the player may still
    // show the previous session's `error`.
    if (!this.stopped) this.opts.onState("loading");
    try {
      const { default: HlsCtor } = await import("hls.js");
      if (this.stopped) return;
      this.native = prefersNativeHls(video, HlsCtor.isSupported());
      // Native HLS has no loader to plug into, so it never asks.
      const wantP2P = !this.native && (this.opts.p2pWanted?.(this.native) ?? false);
      const started = await api.playback.start({
        channel,
        deviceId: sessionDeviceId(),
        embed: this.opts.embed ?? false,
        p2pCapable: wantP2P,
        nativeHls: this.native,
      });
      if (this.stopped) {
        await this.endSession(started.sessionId, started.token);
        return;
      }
      this.session = { id: started.sessionId, token: started.token, intervalMs: started.heartbeatIntervalMs };
      this.p2pAvailable = started.p2p.available;
      this.emitP2P();
      this.opts.onSource?.(playerSource(started.source));
      this.stats = new VideoStats(video, () => this.setState("playing"));
      video.addEventListener("playing", this.onPlaying);
      video.addEventListener("error", this.onVideoError);
      this.scheduleHeartbeat();
      if (this.native) {
        await this.waitForPlaylist(started.playlistUrl);
        if (this.stopped) return;
        video.src = started.playlistUrl;
      } else {
        const plan =
          wantP2P && started.p2p.enabled && started.p2p.trackerUrls.length > 0 ? await this.planP2P(started.p2p) : null;
        if (this.stopped) return;
        this.attachHls(HlsCtor, started.playlistUrl, plan);
      }
      void video.play().catch(() => undefined);
    } catch (err) {
      if (!this.stopped) this.opts.onStartError?.(err);
      this.setState("error");
    }
  }

  /** ICE servers and the loader chunk; null (plain hls.js) on any failure or an opt-out meanwhile. */
  private async planP2P(info: P2PPlan["info"]): Promise<P2PPlan | null> {
    const session = this.session;
    if (!session) return null;
    const ice = await fetchIceServers(this.opts.api, { sessionId: session.id, token: session.token });
    if (!ice || this.stopped || this.p2pOff) return null;
    try {
      const engine = await (this.opts.loadP2PEngine ?? (() => import("./p2p/engine.ts")))();
      if (this.stopped || this.p2pOff) return null;
      return { engine, iceServers: ice.iceServers, expiresAt: ice.expiresAt, info };
    } catch {
      return null;
    }
  }

  private onPlaying = () => {
    if (this.stats && this.stats.ttffMs !== null) this.setState("playing");
  };

  private onVideoError = () => {
    // hls.js recovers its own errors; a native element error is terminal for this session.
    if (this.native) this.setState("error");
  };

  private attachHls(HlsCtor: typeof Hls, url: string, plan: P2PPlan | null): void {
    const xhrSetup: HlsConfig["xhrSetup"] = (xhr, requestUrl) => {
      // Heartbeats refresh the playback token; every request uses the current one.
      const token = this.session?.token;
      if (token) xhr.open("GET", withToken(requestUrl, token), true);
    };
    let hls: Hls;
    if (plan) {
      const stats = new P2PStats();
      const digests = new DigestValidator({
        digestBase: plan.info.digestUrl,
        token: () => this.session?.token,
        onRejected: () => {
          stats.rejected += 1;
        },
        onHttpBytes: (bytes) => {
          stats.digestBytes += bytes;
        },
      });
      this.p2pStats = stats;
      this.p2p = plan.engine.createP2PHls({
        Hls: HlsCtor,
        hlsConfig: { ...BASE_HLS_CONFIG, ...p2pHlsConfig(), xhrSetup },
        p2p: plan.info,
        iceServers: plan.iceServers,
        validateP2PSegment: digests.validate,
        token: () => this.session?.token,
        stats,
        // hls.js still fires FRAG_LOADED for segments the loader handed it (from peers too), so
        // P2P sessions count hls.js's own requests at its loader instead.
        onHlsHttpBytes: (bytes) => {
          this.bytesHttp += bytes;
        },
        watching: () => this.lastAckAt !== null && Date.now() - this.lastAckAt < P2P_WATCHING_WINDOW_MS,
        onChange: this.emitP2P,
      });
      // The heartbeat timer runs while ICE servers and the chunk load: one may be acknowledged already.
      if (this.lastAckAt !== null) this.p2p.enable();
      hls = this.p2p.hls;
      this.scheduleIceRefresh(plan.expiresAt);
      this.emitP2P();
    } else {
      hls = new HlsCtor({ ...BASE_HLS_CONFIG, ...LL_HLS_CONFIG, xhrSetup });
      hls.on(HlsCtor.Events.FRAG_LOADED, (_e, data) => {
        this.bytesHttp += data.frag.stats.loaded;
      });
      hls.on(HlsCtor.Events.LEVEL_LOADED, (_e, data) => {
        this.bytesHttp += data.stats.loaded;
      });
    }
    hls.on(HlsCtor.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.type === HlsCtor.ErrorTypes.NETWORK_ERROR) hls.startLoad();
      else if (data.type === HlsCtor.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
      else this.setState("error");
    });
    hls.loadSource(url);
    hls.attachMedia(this.opts.video);
    this.hls = hls;
  }

  /** TURN credentials expire: fetch fresh ones at ~80 % of their lifetime and apply them at runtime. */
  private scheduleIceRefresh(expiresAt: number | null): void {
    const delay = iceRefreshDelay(expiresAt);
    // The engine may have stopped itself (tracker refusal): no TURN credentials for nothing.
    if (delay === null || this.stopped || this.p2pOff || !this.p2p?.running) return;
    this.iceTimer = setTimeout(() => {
      this.iceTimer = null;
      void this.refreshIce();
    }, delay);
  }

  private async refreshIce(): Promise<void> {
    const session = this.session;
    if (!session || !this.p2p?.running || this.stopped || this.p2pOff) return;
    const ice = await fetchIceServers(this.opts.api, { sessionId: session.id, token: session.token });
    // A refusal means the grant is gone; the tracker drops the socket and HTTP carries on.
    if (!ice || !this.p2p?.running || this.stopped || this.p2pOff) return;
    this.p2p.applyIceServers(ice.iceServers);
    this.scheduleIceRefresh(ice.expiresAt);
  }

  /** Native players do not retry a missing live playlist; wait until it exists. */
  private async waitForPlaylist(url: string): Promise<void> {
    const deadline = Date.now() + PLAYLIST_WAIT_MS;
    while (Date.now() < deadline && !this.abort.signal.aborted) {
      const res = await fetch(url, { signal: this.abort.signal }).catch(() => null);
      if (res?.ok) return;
      await new Promise((r) => setTimeout(r, 1_000));
    }
    if (!this.abort.signal.aborted) throw new Error("playlist did not become available");
  }

  private latencySeconds(): number | null {
    const now = Date.now();
    if (this.hls) {
      const at = this.hls.playingDate;
      return at ? (now - at.getTime()) / 1000 : null;
    }
    const v = this.opts.video as HTMLVideoElement & { getStartDate?: () => Date };
    const start = v.getStartDate?.().getTime();
    if (start === undefined || !Number.isFinite(start)) return null;
    return (now - (start + v.currentTime * 1000)) / 1000;
  }

  private cumulative(): CumulativeStats {
    const v = this.opts.video;
    const p2p = this.p2pStats;
    const totals: CumulativeStats = {
      playedSeconds: this.stats?.playedSeconds ?? 0,
      bufferSeconds: this.stats?.bufferSeconds() ?? 0,
      stalls: this.stats?.stalls ?? 0,
      bytesHttp: this.bytesHttp + (p2p?.httpBytes ?? 0),
      bytesP2p: p2p?.p2pBytes ?? 0,
      latencySeconds: this.latencySeconds(),
      ttffMs: this.stats?.ttffMs ?? null,
      visible: document.visibilityState === "visible",
      muted: v.muted,
    };
    if (p2p) {
      totals.bytesP2pUp = p2p.uploadedBytes;
      totals.p2pRejected = p2p.rejected;
      totals.p2pPeers = Math.min(MAX_P2P_PEERS, this.p2pStatus().peers);
    }
    return totals;
  }

  private scheduleHeartbeat(): void {
    if (!this.session || this.stopped) return;
    this.timer = setTimeout(() => {
      void this.heartbeat().finally(() => this.scheduleHeartbeat());
    }, nextHeartbeatDelay(this.session.intervalMs));
  }

  private async heartbeat(): Promise<void> {
    const session = this.session;
    if (!session || this.stopped) return;
    const totals = this.cumulative();
    try {
      const res = await this.opts.api.playback.heartbeat({
        sessionId: session.id,
        token: session.token,
        rendition: RENDITION_SOURCE,
        fingerprint: collectFingerprint(this.native),
        ...this.accountant.delta(totals),
      });
      // Throttled: the server recorded nothing, so the deltas ride along with the next beat.
      if (!this.accountant.settle(totals, res)) return;
      this.lastAckAt = Date.now();
      // The tracker accepts this session's socket from now on: start sharing (once).
      if (!this.p2pOff) this.p2p?.enable();
      if (res.token) session.token = res.token;
      const move = heartbeatSwitch(res);
      if (move && !this.stopped) this.switchTo(move.url, move.source);
    } catch {
      // Not committed: this heartbeat's share is reported with the next one.
    } finally {
      // Bytes shared move between peer events; the indicator follows the heartbeat.
      if (this.p2p) this.emitP2P();
    }
  }

  /**
   * Move to another playlist of the same stream without leaving `playing`: the state only changes
   * on a fatal error, as for the first playlist. A new source reloads the media element, which
   * pauses it, and `autoplay` no longer applies once `play()` was called, so play again. A P2P
   * session keeps its swarm: the swarm ids come from the broadcast, not from the HTTP source.
   */
  private switchTo(url: string, source: PlayerSource): void {
    const { video } = this.opts;
    if (this.hls) this.hls.loadSource(url);
    else video.src = url;
    void video.play().catch(() => undefined);
    this.opts.onSource?.(source);
  }

  private async endSession(id: string, token: string): Promise<void> {
    await (this.opts.endApi ?? this.opts.api).playback.end({ sessionId: id, token }).catch(() => undefined);
  }

  /** Stop playback and end the session. Safe to call more than once. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    if (this.iceTimer) clearTimeout(this.iceTimer);
    const { video } = this.opts;
    video.removeEventListener("playing", this.onPlaying);
    video.removeEventListener("error", this.onVideoError);
    this.stats?.dispose();
    // The P2P loader (peer connections, tracker socket) goes before the session ends.
    if (this.p2p) this.p2p.destroy();
    else this.hls?.destroy();
    this.p2p = null;
    this.hls = null;
    video.removeAttribute("src");
    video.load();
    const session = this.session;
    this.session = null;
    if (session) await this.endSession(session.id, session.token);
  }
}
