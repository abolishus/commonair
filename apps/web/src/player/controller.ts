// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * One playback session on one `<video>`: `playback.start`, play the signed playlist (hls.js over
 * MSE, native HLS where MSE is missing or on WebKit), heartbeat per the contract (honouring token
 * refresh and `switchTo`), `playback.end` on stop. Framework-free so it can move to
 * `packages/player` unchanged.
 */
import type Hls from "hls.js";
import type { Api } from "../lib/api.ts";
import {
  HeartbeatAccountant,
  RENDITION_SOURCE,
  nextHeartbeatDelay,
  withToken,
  type CumulativeStats,
} from "./heartbeat.ts";
import { VideoStats, collectFingerprint, sessionDeviceId } from "./stats.ts";

export type PlayerState = "offline" | "loading" | "playing" | "error";

export interface PlayerControllerOptions {
  channel: string;
  video: HTMLVideoElement;
  api: Api;
  /** Client used for `playback.end` while the page unloads. */
  endApi?: Api;
  embed?: boolean;
  onState: (state: PlayerState) => void;
}

const PLAYLIST_WAIT_MS = 45_000;

function isChromium(): boolean {
  return "userAgentData" in navigator || /Chrome\//.test(navigator.userAgent);
}

/** Native HLS on WebKit (Safari, iOS); hls.js wherever MSE works. */
export function prefersNativeHls(video: HTMLVideoElement, mseSupported: boolean): boolean {
  const canNative = video.canPlayType("application/vnd.apple.mpegurl") !== "";
  if (canNative && !isChromium()) return true;
  return !mseSupported && canNative;
}

export class PlayerController {
  private hls: Hls | null = null;
  private stats: VideoStats | null = null;
  private accountant = new HeartbeatAccountant();
  private session: { id: string; token: string; intervalMs: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abort = new AbortController();
  private bytesHttp = 0;
  private native = false;
  private stopped = false;
  private state: PlayerState = "loading";

  constructor(private readonly opts: PlayerControllerOptions) {}

  private setState(s: PlayerState): void {
    if (this.stopped || this.state === s) return;
    this.state = s;
    this.opts.onState(s);
  }

  async start(): Promise<void> {
    const { video, api, channel } = this.opts;
    this.setState("loading");
    try {
      const { default: HlsCtor } = await import("hls.js");
      if (this.stopped) return;
      this.native = prefersNativeHls(video, HlsCtor.isSupported());
      const started = await api.playback.start({
        channel,
        deviceId: sessionDeviceId(),
        embed: this.opts.embed ?? false,
        // This player has no P2P loader yet.
        p2pCapable: false,
        nativeHls: this.native,
      });
      if (this.stopped) {
        await this.endSession(started.sessionId, started.token);
        return;
      }
      this.session = { id: started.sessionId, token: started.token, intervalMs: started.heartbeatIntervalMs };
      this.stats = new VideoStats(video, () => this.setState("playing"));
      video.addEventListener("playing", this.onPlaying);
      video.addEventListener("error", this.onVideoError);
      this.scheduleHeartbeat();
      if (this.native) {
        await this.waitForPlaylist(started.playlistUrl);
        if (this.stopped) return;
        video.src = started.playlistUrl;
      } else {
        this.attachHls(HlsCtor, started.playlistUrl);
      }
      void video.play().catch(() => undefined);
    } catch {
      this.setState("error");
    }
  }

  private onPlaying = () => {
    if (this.stats && this.stats.ttffMs !== null) this.setState("playing");
  };

  private onVideoError = () => {
    // hls.js recovers its own errors; a native element error is terminal for this session.
    if (this.native) this.setState("error");
  };

  private attachHls(HlsCtor: typeof Hls, url: string): void {
    const hls = new HlsCtor({
      lowLatencyMode: true,
      liveSyncDurationCount: 3,
      manifestLoadingMaxRetry: 45,
      manifestLoadingRetryDelay: 1_000,
      levelLoadingMaxRetry: 10,
      fragLoadingMaxRetry: 10,
      xhrSetup: (xhr, requestUrl) => {
        // Heartbeats refresh the playback token; every request uses the current one.
        const token = this.session?.token;
        if (token) xhr.open("GET", withToken(requestUrl, token), true);
      },
    });
    hls.on(HlsCtor.Events.FRAG_LOADED, (_e, data) => {
      this.bytesHttp += data.frag.stats.loaded;
    });
    hls.on(HlsCtor.Events.LEVEL_LOADED, (_e, data) => {
      this.bytesHttp += data.stats.loaded;
    });
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
    return {
      playedSeconds: this.stats?.playedSeconds ?? 0,
      bufferSeconds: this.stats?.bufferSeconds() ?? 0,
      stalls: this.stats?.stalls ?? 0,
      bytesHttp: this.bytesHttp,
      bytesP2p: 0,
      latencySeconds: this.latencySeconds(),
      ttffMs: this.stats?.ttffMs ?? null,
      visible: document.visibilityState === "visible",
      muted: v.muted,
    };
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
      this.accountant.commit(totals);
      if (res.token) session.token = res.token;
      if (res.switchTo) this.switchTo(res.switchTo);
    } catch {
      // Not committed: this heartbeat's share is reported with the next one.
    }
  }

  private switchTo(url: string): void {
    if (this.hls) this.hls.loadSource(url);
    else this.opts.video.src = url;
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
    const { video } = this.opts;
    video.removeEventListener("playing", this.onPlaying);
    video.removeEventListener("error", this.onVideoError);
    this.stats?.dispose();
    this.hls?.destroy();
    this.hls = null;
    video.removeAttribute("src");
    video.load();
    const session = this.session;
    this.session = null;
    if (session) await this.endSession(session.id, session.token);
  }
}
