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
 *
 * The player seam (docs/testing/w1-selectors.md "Player seam"): `playheadWallclock`,
 * `seekToWallclock`, `setTargetLatency`, `onTextTrack`, `playbackMode`/`onPlaybackMode`, for
 * data mode (ADR 0018) `setDataMode`/`dataUsage`, and for live DVR (ADR 0016; W2 contract step)
 * `dvrGrant`/`enterDvr`/`exitDvr` plus the session's caption tracks (`onFeatures`). Later features
 * (DVR, captions, watch rooms) build on these instead of reaching into hls.js.
 */
import type Hls from "hls.js";
import type { HlsConfig } from "hls.js";
import type { CaptionTrack } from "@commonair/contracts/dto";
import { RENDITIONS, type CAPTIONS_STATES } from "@commonair/contracts/enums";
import type { Api } from "../lib/api.ts";
import { capIndex, nominalLevels, type LevelInfo } from "./budget.ts";
import { swapDvrSource } from "./dvr.ts";
import {
  HeartbeatAccountant,
  MAX_P2P_PEERS,
  RENDITION_SOURCE,
  dataModeField,
  heartbeatDvrSwitch,
  nextHeartbeatDelay,
  playbackFields,
  withToken,
  type CumulativeStats,
  type DvrSwitch,
} from "./heartbeat.ts";
import type { PlaybackMode } from "./media-clock.ts";
import { P2P_TUNING, P2P_WATCHING_WINDOW_MS, p2pHlsConfig, renditionOf } from "./p2p/config.ts";
import { DigestValidator } from "./p2p/digest.ts";
import type { P2PHls } from "./p2p/engine.ts";
import { fetchIceServers, iceRefreshDelay } from "./p2p/ice.ts";
import { P2PStats, p2pState, type P2PState } from "./p2p/stats.ts";
import { heartbeatSwitch, playerSource, tokenDataMode, type PlayerSource } from "./source.ts";
import {
  DataUsageMeter,
  VideoStats,
  collectFingerprint,
  nativeMediaBytes,
  sessionDeviceId,
  type DataUsage,
} from "./stats.ts";

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

/** The session's live DVR grant (`PlaybackStart.dvrWindowSeconds` / `dvrPlaylistUrl`, ADR 0016). */
export interface DvrGrant {
  /** Seconds the viewer may rewind (`min(channel window, DVR_MAX_WINDOW_SECONDS)`), always > 0. */
  windowSeconds: number;
  /** The DVR playlist carrying the newest DVR token (heartbeats refresh it). */
  playlistUrl: string;
}

/** What `playback.start` granted this session beyond the live stream: captions and DVR. */
export interface SessionFeatures {
  captions: { tracks: readonly CaptionTrack[]; state: (typeof CAPTIONS_STATES)[number] };
  /** Null without DVR (no recording, DVR off, data mode, a rehearsal, or the VOD gate refused). */
  dvr: DvrGrant | null;
}

/** Before a session starts and after it ends: nothing granted. */
export const NO_SESSION_FEATURES: SessionFeatures = Object.freeze({
  captions: Object.freeze({ tracks: [], state: "off" as const }),
  dvr: null,
});

/** How long `enterDvr` waits for the DVR playlist before it gives up and returns to live. */
export const DVR_LOAD_TIMEOUT_MS = 10_000;
/** How long a DVR landing on a fresh source (a swap, a rewind) is held: the new source's start-up. */
export const DVR_LANDING_GUARD_MS = 15_000;
/** How far the playhead may drift from the landing (plus played time) before it is put back. */
export const DVR_LANDING_TOLERANCE_MS = 5_000;
/** Corrections per landing; past them the playhead stays wherever it went. */
export const DVR_LANDING_MAX_CORRECTIONS = 3;
/** A `timeupdate` step longer than this is a jump, not playback. */
const PLAYBACK_STEP_MAX_S = 1.5;

/** Where a DVR swap or rewind sent the playhead, held while the new source settles (`DVR_LANDING_GUARD_MS`). */
interface DvrLanding {
  generation: number;
  /** A source swap (`dvrSwitchTo`) or a rewind right after `enterDvr`. */
  via: "swap" | "rewind";
  /** Where the playhead was sent (epoch ms). */
  target: number;
  until: number;
  /** Media seconds played since, counted from `timeupdate` steps (jumps excluded). */
  played: number;
  lastTime: number | null;
  corrections: number;
  seekOk: boolean;
  /** Last measured distance from where the playhead should be (ms; + is toward live). */
  driftMs: number | null;
}

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
  /** Diagnostic (`?targetLatency=`): the hls.js target latency in seconds from the start. */
  targetLatency?: number | undefined;
  /** Diagnostic (`?rendition=`): pin the hls.js level of this rendition (`source`, `720p`, …). */
  rendition?: string | undefined;
  /** Data mode (ADR 0018): the ceiling (bit/s) to start with; null or absent = off. */
  dataMode?: number | null;
  /** The ceiling in effect (the token's `dm`): on start and whenever the server applied a change. */
  onDataMode?: (ceiling: number | null) => void;
  /** Captions and DVR as `playback.start` granted them, once per session (the W2 slots read this). */
  onFeatures?: (features: SessionFeatures) => void;
}

/** One rendition in the settings menu's quality list. */
export interface QualityLevel {
  /** hls.js's level index (`setQuality`). */
  index: number;
  height: number | null;
  frameRate: number | null;
  bitrate: number;
  audioOnly: boolean;
}

/** hls.js levels as the budget controller sees them (audio-only: no video codec, no picture size). */
function levelInfos(hls: Pick<Hls, "levels">): LevelInfo[] {
  return hls.levels.map((l) => ({
    bitrate: Number.isFinite(l.bitrate) ? l.bitrate : 0,
    audioOnly: !l.videoCodec && !((l.width ?? 0) > 0),
  }));
}

/** Bounds of `setTargetLatency` (seconds): below one second hls.js stalls, past a minute it is DVR. */
export const TARGET_LATENCY_RANGE = { min: 1, max: 60 } as const;
/** Bounds of the `targetLatency` query parameter (seconds). */
export const DIAGNOSTIC_LATENCY_RANGE = { min: 1, max: 30 } as const;

/** The player's diagnostic query parameters (`timeline-sync` step 2); invalid values are dropped. */
export interface DiagnosticParams {
  targetLatency?: number;
  rendition?: string;
}

/**
 * Read `targetLatency=<seconds>` (1–30) and `rendition=<name>` (one of `RENDITIONS`) from a
 * `location.search`. The page has no quality picker and no handle on hls.js, so the harness pins
 * viewers through these; anything else is ignored so a hand-edited URL cannot break playback.
 */
export function diagnosticParams(search: string): DiagnosticParams {
  const q = new URLSearchParams(search);
  const out: DiagnosticParams = {};
  const latency = q.get("targetLatency")?.trim();
  if (latency !== undefined && /^\d+(\.\d+)?$/.test(latency)) {
    const n = Number(latency);
    if (n >= DIAGNOSTIC_LATENCY_RANGE.min && n <= DIAGNOSTIC_LATENCY_RANGE.max) out.targetLatency = n;
  }
  const rendition = q.get("rendition");
  if (rendition !== null && (RENDITIONS as readonly string[]).includes(rendition)) out.rendition = rendition;
  return out;
}

/** A fragment's place on both clocks (hls.js `Fragment`: `start`/`duration` in seconds, PDT in epoch ms). */
export interface PdtFragment {
  start: number;
  duration: number;
  programDateTime: number | null;
}

/**
 * The media time whose PDT is `at`, from a playlist's fragments; null when `at` lies outside the
 * playlist window or no fragment carries PDT.
 */
export function mediaTimeOfWallclock(fragments: readonly PdtFragment[], at: number): number | null {
  for (const f of fragments) {
    if (f.programDateTime === null || !Number.isFinite(f.programDateTime)) continue;
    const offset = (at - f.programDateTime) / 1000;
    if (offset >= 0 && offset < f.duration) return f.start + offset;
  }
  return null;
}

function clampLatency(seconds: number): number {
  return Math.min(TARGET_LATENCY_RANGE.max, Math.max(TARGET_LATENCY_RANGE.min, seconds));
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
  /** The target latency asked for (seconds), applied to hls.js now or when it attaches. */
  private targetLatencyS: number | null = null;
  private mode: PlaybackMode = "live";
  private readonly modeListeners = new Set<(mode: PlaybackMode) => void>();
  private readonly textTrackUnsubs = new Set<() => void>();
  /** The data-mode ceiling the viewer wants (bit/s), null = off. */
  private dataModeWanted: number | null;
  /** The ceiling in the current token: what the origin applies. A difference goes out with the next beat. */
  private dataModeApplied: number | null = null;
  private cappingHooked = false;
  private hlsCtor: typeof Hls | null = null;
  /** The playlist being played (its token is replaced on reload). */
  private playlistUrl: string | null = null;
  private renditions: readonly string[] = [];
  /** The viewer's rendition pick (`setQuality`), -1 for Auto. */
  private qualityPick = -1;
  private readonly meter = new DataUsageMeter();
  /** The DVR grant from `playback.start` (its URL as granted), null without one. */
  private dvr: { windowSeconds: number; playlistUrl: string } | null = null;
  /** The newest DVR token (heartbeat `dvrToken`), null until one is known. */
  private dvrToken: string | null = null;
  /** The DVR playlist being played; null at the live edge. */
  private dvrUrl: string | null = null;
  /** Bumped by every `enterDvr`/`exitDvr`, so a superseded DVR load does nothing when it settles. */
  private dvrGeneration = 0;
  private landing: DvrLanding | null = null;

  constructor(private readonly opts: PlayerControllerOptions) {
    const t = opts.targetLatency;
    if (t !== undefined && Number.isFinite(t) && t > 0) this.targetLatencyS = clampLatency(t);
    this.dataModeWanted = opts.dataMode ?? null;
  }

  // ------------------------------------------------------------ the player seam

  /**
   * The PDT under the playhead: what chat sends as `mediaTs` (ADR 0012 amendment 1 decision 1).
   * The same instant has the same PDT on every rendition, so it depends on neither the viewer's
   * clock nor their rung. hls.js: `playingDate`; native HLS: `getStartDate()` + `currentTime`.
   * Null before the first frame, without PDT, or once stopped.
   */
  playheadWallclock(): Date | null {
    if (this.stopped) return null;
    if (this.hls) {
      const at = this.hls.playingDate;
      return at && Number.isFinite(at.getTime()) ? new Date(at.getTime()) : null;
    }
    const v = this.opts.video as HTMLVideoElement & { getStartDate?: () => Date };
    // HAVE_METADATA: before it, `currentTime` is 0 whatever the playlist says.
    if (v.readyState < 1) return null;
    const start = v.getStartDate?.().getTime();
    if (start === undefined || !Number.isFinite(start)) return null;
    return new Date(start + v.currentTime * 1000);
  }

  /**
   * Move the playhead to the media whose PDT is `t` (DVR, alert history, watch rooms). hls.js: the
   * fragment of the playing level whose PDT window holds `t`; native: `currentTime` from
   * `getStartDate()`, within `seekable`. False, and nothing moves, when `t` is out of range.
   */
  seekToWallclock(t: Date): boolean {
    this.landing = null;
    // A rewind right after `enterDvr` meets the same start-up as a swap: nothing buffered yet, and
    // hls.js may still move the playhead to the live sync position once the first fragments are in
    // (relay-dvr CI run 41834516797: the relay loaded segments from 84 s with the playhead at 36 s,
    // so it played 15 s behind live before the swap, which then kept that). So it is held as well.
    const fresh = this.mode === "dvr" && this.hls !== null && !this.hls.hasEnoughToStart;
    const ok = this.seekToWallclockAt(t);
    if (ok && fresh) this.holdFrom("rewind", t.getTime(), true);
    return ok;
  }

  private seekToWallclockAt(t: Date): boolean {
    const at = t.getTime();
    if (this.stopped || !Number.isFinite(at)) return false;
    const { video } = this.opts;
    let target: number | null = null;
    if (this.hls) {
      const levels = this.hls.levels;
      const level = levels[this.hls.currentLevel] ?? levels.find((l) => l.details);
      target = mediaTimeOfWallclock(level?.details?.fragments ?? [], at);
    } else {
      const v = video as HTMLVideoElement & { getStartDate?: () => Date };
      const start = v.getStartDate?.().getTime();
      if (v.readyState >= 1 && start !== undefined && Number.isFinite(start)) {
        const candidate = (at - start) / 1000;
        if (inRanges(v.seekable, candidate)) target = candidate;
      }
    }
    if (target === null) return false;
    // Right after `loadSource` (a rewind, a DVR source swap) the MediaSource is new and nothing is
    // buffered: hls.js has taken the live sync position as its start (the DVR playlist is a live
    // one without EXT-X-START) and moves the playhead there once the first fragment lands, unless
    // the element is seeking just then. Giving hls.js the target as its start position wins that race.
    if (this.hls && !this.hls.hasEnoughToStart) this.hls.startLoad(target);
    video.currentTime = target;
    return true;
  }

  /**
   * Move the playhead `ms` of media time from where it is (watch rooms). PDT is linear in media
   * time, so this lands where `playheadWallclock` says the drift is, without the playing level's
   * fragment list (`seekToWallclock`), which hls.js stops refreshing once ABR loads another level.
   * False, and nothing moves, outside the seekable or buffered range, or while a fresh hls.js
   * source has nothing buffered (`seekToWallclock` handles that start).
   */
  seekBy(ms: number): boolean {
    if (this.stopped || !Number.isFinite(ms)) return false;
    this.landing = null;
    const { video } = this.opts;
    if (video.readyState < 1 || (this.hls && !this.hls.hasEnoughToStart)) return false;
    const next = video.currentTime + ms / 1000;
    if (!inRanges(video.seekable, next) && !inRanges(video.buffered, next)) return false;
    video.currentTime = next;
    return true;
  }

  /**
   * Hold the playhead `seconds` behind the live edge (clamped to `TARGET_LATENCY_RANGE`): hls.js
   * `liveSyncDuration` for this session, replacing `liveSyncDurationCount`, and a step to the new
   * sync position once one is known (not with `seek: false`: watch rooms land the playhead
   * themselves, from the PDT). Returns the value applied. Native HLS exposes no target, so
   * it changes nothing and returns the current latency (NaN while unknown). Before `start()` the
   * path is not decided yet: the value is stored and returned, and applies only if hls.js attaches.
   */
  setTargetLatency(seconds: number, opts: { seek?: boolean } = {}): number {
    if (this.native) return this.latencySeconds() ?? Number.NaN;
    if (!Number.isFinite(seconds)) return this.targetLatencyS ?? Number.NaN;
    const applied = clampLatency(seconds);
    this.targetLatencyS = applied;
    const hls = this.hls;
    if (hls) {
      // hls.js jumps to the sync position whenever latency passes this, so it must stay above the target.
      const max = hls.config.liveMaxLatencyDuration;
      if (max !== undefined && max <= applied) hls.config.liveMaxLatencyDuration = applied + P2P_TUNING.maxLatencySlack;
      hls.targetLatency = applied;
      if (opts.seek === false) return applied;
      const sync = hls.liveSyncPosition;
      const media = this.opts.video;
      if (sync !== null && Number.isFinite(sync) && hls.media && !media.seeking) media.currentTime = sync;
    }
    return applied;
  }

  /**
   * hls.js's own live latency (seconds from the playhead to the live edge, from the playlist, so
   * the viewer's clock plays no part). Null on native HLS, in DVR, or while unknown. Watch rooms
   * steer from it (decision (r)).
   */
  hlsLatencySeconds(): number | null {
    const latency = this.hls?.latency;
    if (this.mode === "dvr" || latency === undefined || !Number.isFinite(latency) || latency <= 0) return null;
    return latency;
  }

  /**
   * Text tracks appearing, disappearing or changing on the video (captions, W2). Fires with the
   * element's `TextTrackList`; W1 adds no tracks, so only what the playlist brings shows up.
   * Returns the unsubscribe function.
   */
  onTextTrack(cb: (tracks: TextTrackList) => void): () => void {
    const tracks = this.opts.video.textTracks as TextTrackList | undefined;
    if (!tracks || typeof tracks.addEventListener !== "function") return () => undefined;
    const fire = () => cb(tracks);
    const events = ["addtrack", "removetrack", "change"] as const;
    for (const e of events) tracks.addEventListener(e, fire);
    const unsub = () => {
      if (!this.textTrackUnsubs.delete(unsub)) return;
      for (const e of events) tracks.removeEventListener(e, fire);
    };
    this.textTrackUnsubs.add(unsub);
    return unsub;
  }

  /** Where the playhead is: `live` at the edge, `dvr` behind it. Always `live` in W1. */
  playbackMode(): PlaybackMode {
    return this.mode;
  }

  /** Subscribe to playback-mode changes; returns the unsubscribe function. */
  onPlaybackMode(cb: (mode: PlaybackMode) => void): () => void {
    const listener = (mode: PlaybackMode) => cb(mode);
    this.modeListeners.add(listener);
    return () => {
      this.modeListeners.delete(listener);
    };
  }

  /**
   * Flip the reported mode without loading anything (heartbeats and chat follow it). `live` while
   * a DVR playlist plays returns to the live playlist (`exitDvr`). To play DVR, use `enterDvr`.
   */
  setPlaybackMode(mode: PlaybackMode): void {
    if (mode === "live" && this.dvrUrl !== null) {
      this.exitDvr();
      return;
    }
    this.notifyMode(mode);
  }

  private notifyMode(mode: PlaybackMode): void {
    if (this.stopped || this.mode === mode) return;
    this.mode = mode;
    // Deleting from a Set while iterating it is safe, so a listener may unsubscribe itself.
    for (const l of this.modeListeners) l(mode);
  }

  /** This session's DVR grant with the newest DVR token, or null (no grant, not started, stopped). */
  dvrGrant(): DvrGrant | null {
    if (this.stopped || !this.dvr) return null;
    const token = this.dvrToken;
    return {
      windowSeconds: this.dvr.windowSeconds,
      playlistUrl: token === null ? this.dvr.playlistUrl : withToken(this.dvr.playlistUrl, token),
    };
  }

  /**
   * Play the DVR playlist (`dvrGrant().playlistUrl`) on the same hls.js instance (native HLS: the
   * same element), so the session, its heartbeats and its played seconds carry on. Resolves true
   * once the playlist loaded and the mode is `dvr` (seek with `seekToWallclock` then); false, back
   * on the live playlist, when it does not load within `DVR_LOAD_TIMEOUT_MS`; false with nothing
   * changed without a grant, in data mode (ADR 0016 decision 7) or once stopped. DVR is
   * origin-only (decision 5), so a P2P session stops sharing for the rest of the session. A later
   * `enterDvr` or `exitDvr` supersedes a pending one, which then resolves false.
   */
  async enterDvr(playlistUrl: string): Promise<boolean> {
    if (this.stopped || !this.session || !this.dvr || this.dataModeWanted !== null) return false;
    const generation = ++this.dvrGeneration;
    const url = this.dvrToken === null ? playlistUrl : withToken(playlistUrl, this.dvrToken);
    if (this.p2p) this.disableP2P();
    this.dvrUrl = url;
    const ok = await (this.hls ? this.loadDvrHls(this.hls, url) : this.loadDvrNative(url));
    if (generation !== this.dvrGeneration || this.stopped) return false;
    if (!ok) {
      this.leaveDvrPlaylist();
      return false;
    }
    this.notifyMode("dvr");
    return true;
  }

  /** Back to the live playlist at the live edge, same session; at the edge already, a no-op. */
  exitDvr(): void {
    if (this.stopped) return;
    this.dvrGeneration += 1;
    this.leaveDvrPlaylist();
    this.notifyMode("live");
  }

  private leaveDvrPlaylist(): void {
    if (this.dvrUrl === null) return;
    this.dvrUrl = null;
    const session = this.session;
    if (this.playlistUrl && session) this.reload(withToken(this.playlistUrl, session.token));
  }

  /** hls.js: load the DVR playlist and wait for its level, so `seekToWallclock` has fragments. */
  private loadDvrHls(hls: Hls, url: string, autoplay = true): Promise<boolean> {
    const ctor = this.hlsCtor;
    return new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (ctor) hls.off(ctor.Events.LEVEL_LOADED, onLevel);
        resolve(ok);
      };
      const onLevel = () => finish(true);
      const timer = setTimeout(() => finish(false), DVR_LOAD_TIMEOUT_MS);
      if (ctor) hls.on(ctor.Events.LEVEL_LOADED, onLevel);
      this.resetQuality();
      hls.loadSource(url);
      if (autoplay) void this.opts.video.play().catch(() => undefined);
    });
  }

  /** Native HLS: point the element at the DVR playlist and wait for its metadata. */
  private loadDvrNative(url: string, autoplay = true): Promise<boolean> {
    const { video } = this.opts;
    return new Promise<boolean>((resolve) => {
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        video.removeEventListener("loadedmetadata", onMeta);
        video.removeEventListener("error", onError);
        resolve(ok);
      };
      const onMeta = () => finish(true);
      const onError = () => finish(false);
      const timer = setTimeout(() => finish(false), DVR_LOAD_TIMEOUT_MS);
      video.addEventListener("loadedmetadata", onMeta);
      video.addEventListener("error", onError);
      video.src = url;
      if (autoplay) void video.play().catch(() => undefined);
    });
  }

  /** The token a request needs: the DVR token under the DVR playlist's directory, else the live one. */
  private tokenFor(requestUrl: string): string | undefined {
    const dir = this.dvrUrl === null ? null : urlDirectory(this.dvrUrl);
    if (dir !== null && this.dvrToken !== null && requestUrl.startsWith(dir)) return this.dvrToken;
    return this.session?.token;
  }

  /** Seconds behind the live edge while in DVR (ADR 0016 decision 6), else null. */
  private behindLiveSeconds(): number | null {
    return this.mode === "dvr" ? this.secondsBehindNow() : null;
  }

  /**
   * Data mode (ADR 0018): the bitrate ceiling in bit/s, or null to turn it off. hls.js is capped
   * at once and P2P stops; the next heartbeat sends `dataMode`, and when the server answers with a
   * token carrying the new ceiling the player reloads the multivariant playlist the origin now
   * filters (hls.js `loadSource`; native HLS a source reload and a short rebuffer). Before
   * `start()` the value is what the session starts with.
   */
  setDataMode(ceiling: number | null): void {
    if (this.stopped) return;
    this.dataModeWanted = ceiling !== null && Number.isFinite(ceiling) ? Math.round(ceiling) : null;
    // DVR is source-only, so data mode never rewinds (ADR 0016 decision 7).
    // A DVR load still pending (`dvrUrl` set, mode still `live`) is cancelled the same way.
    if (this.dataModeWanted !== null && (this.mode === "dvr" || this.dvrUrl !== null)) this.exitDvr();
    // Uploading to peers spends the budget; the server drops the grant with the beat (decision 6).
    if (this.dataModeWanted !== null && this.p2p) this.disableP2P();
    this.applyCapping();
  }

  /** HTTP bytes this session (P2P is off in data mode) and the recent rate in MB an hour. */
  dataUsage(): DataUsage {
    return this.meter.sample(this.httpBytes());
  }

  /**
   * The levels the budget is judged against: hls.js's own, or on native HLS (which exposes none)
   * the nominal rungs of the renditions `playback.start` listed.
   */
  playableLevels(): LevelInfo[] {
    const levels = this.hls ? levelInfos(this.hls) : [];
    return levels.length > 0 ? levels : nominalLevels(this.renditions);
  }

  /**
   * The renditions the viewer may pick in the settings menu (D2-player), in hls.js's order. None on
   * native HLS, where the browser picks and exposes no levels.
   */
  qualityLevels(): QualityLevel[] {
    const hls = this.hls;
    if (!hls) return [];
    return hls.levels.map((l, index) => ({
      index,
      height: l.height > 0 ? l.height : null,
      frameRate: Number.isFinite(l.frameRate) && l.frameRate > 0 ? l.frameRate : null,
      bitrate: Number.isFinite(l.bitrate) ? l.bitrate : 0,
      audioOnly: !l.videoCodec && !((l.width ?? 0) > 0),
    }));
  }

  /** The picked rendition's index, or -1 for Auto (hls.js's ABR, capped in data mode). */
  quality(): number {
    return this.qualityPick;
  }

  /** Pick a rendition (from the next fragment on), or -1 for Auto. */
  setQuality(index: number): void {
    const hls = this.hls;
    const valid = hls !== null && Number.isInteger(index) && index >= 0 && index < hls.levels.length;
    this.qualityPick = valid ? index : -1;
    if (hls) hls.nextLevel = this.qualityPick;
  }

  /** Back to Auto: hls.js drops a manual level on `loadSource`, and the new renditions may differ. */
  private resetQuality(): void {
    this.qualityPick = -1;
  }

  /** hls.js: cap ABR at the wanted ceiling (the origin's filter does it for native HLS). */
  private applyCapping(): void {
    const hls = this.hls;
    const ctor = this.hlsCtor;
    if (!hls || !ctor) return;
    // Hooked only once data mode is wanted: sessions without it keep hls.js's ABR untouched.
    if (!this.cappingHooked && this.dataModeWanted !== null) {
      this.cappingHooked = true;
      hls.on(ctor.Events.MANIFEST_PARSED, () => this.applyCapping());
    }
    if (this.cappingHooked) hls.autoLevelCapping = capIndex(levelInfos(hls), this.dataModeWanted);
  }

  private httpBytes(): number {
    if (this.native) return nativeMediaBytes(this.opts.video) ?? 0;
    return this.bytesHttp + (this.p2pStats?.httpBytes ?? 0);
  }

  /** A token arrived: if its ceiling differs from the one being played, reload under it. */
  private applyDataModeToken(token: string, moved: boolean): void {
    const dm = tokenDataMode(token);
    if (dm === undefined || dm === this.dataModeApplied) return;
    this.dataModeApplied = dm;
    this.meter.restart();
    this.opts.onDataMode?.(dm);
    if (dm !== null && this.p2p) this.disableP2P();
    // A `switchTo` reloads anyway.
    if (moved || !this.playlistUrl) return;
    this.reload(withToken(this.playlistUrl, token));
  }

  // ------------------------------------------------------------ session

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
      // Native HLS has no loader to plug into, so it never asks; data mode never shares (ADR 0018).
      const wantP2P = !this.native && this.dataModeWanted === null && (this.opts.p2pWanted?.(this.native) ?? false);
      const started = await api.playback.start({
        channel,
        deviceId: sessionDeviceId(),
        embed: this.opts.embed ?? false,
        p2pCapable: wantP2P,
        nativeHls: this.native,
        dataMode: this.dataModeWanted,
      });
      if (this.stopped) {
        await this.endSession(started.sessionId, started.token);
        return;
      }
      this.session = { id: started.sessionId, token: started.token, intervalMs: started.heartbeatIntervalMs };
      this.playlistUrl = started.playlistUrl;
      this.renditions = started.renditions;
      // A change made while `start` was in flight goes out with the first beat.
      this.dataModeApplied = started.dataMode;
      this.opts.onDataMode?.(started.dataMode);
      this.p2pAvailable = started.p2p.available;
      this.emitP2P();
      this.dvr =
        started.dvrWindowSeconds > 0 && started.dvrPlaylistUrl !== null
          ? { windowSeconds: started.dvrWindowSeconds, playlistUrl: started.dvrPlaylistUrl }
          : null;
      this.dvrToken = this.dvr ? new URL(this.dvr.playlistUrl).searchParams.get("t") : null;
      this.opts.onFeatures?.({
        captions: { tracks: started.captions, state: started.captionsState },
        dvr: this.dvrGrant(),
      });
      this.opts.onSource?.(playerSource(started.source));
      this.stats = new VideoStats(video, () => this.setState("playing"));
      video.addEventListener("playing", this.onPlaying);
      video.addEventListener("error", this.onVideoError);
      video.addEventListener("timeupdate", this.holdLanding);
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
    // A new hls.js starts on Auto, and its levels may differ: a remembered pick would mislabel the menu.
    this.resetQuality();
    const xhrSetup: HlsConfig["xhrSetup"] = (xhr, requestUrl) => {
      // Heartbeats refresh the playback token and the DVR token; every request uses the current one.
      const token = this.tokenFor(requestUrl);
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
        hlsConfig: { ...BASE_HLS_CONFIG, ...this.p2pLatencyConfig(), xhrSetup },
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
      hls = new HlsCtor({ ...BASE_HLS_CONFIG, ...this.llLatencyConfig(), xhrSetup });
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
    const rendition = this.opts.rendition;
    if (rendition !== undefined) {
      // Pinned before the first fragment loads; `currentLevel` also turns ABR off for the session.
      hls.on(HlsCtor.Events.MANIFEST_PARSED, () => {
        const i = hls.levels.findIndex((l) => renditionOf(l.uri) === rendition);
        if (i >= 0) hls.currentLevel = i;
      });
    }
    hls.loadSource(url);
    hls.attachMedia(this.opts.video);
    this.hls = hls;
    this.hlsCtor = HlsCtor;
    this.applyCapping();
  }

  /** Low-latency hls.js, with `liveSyncDuration` in place of the segment count once a target is set. */
  private llLatencyConfig(): Partial<HlsConfig> {
    const t = this.targetLatencyS;
    // hls.js refuses a config that sets both.
    return t === null ? LL_HLS_CONFIG : { lowLatencyMode: true, liveSyncDuration: t };
  }

  /** The P2P latency window, moved to the target when one is set (the slack above it kept). */
  private p2pLatencyConfig(): Partial<HlsConfig> {
    const base = p2pHlsConfig();
    const t = this.targetLatencyS;
    return t === null ? base : { ...base, liveSyncDuration: t, liveMaxLatencyDuration: t + P2P_TUNING.maxLatencySlack };
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

  private secondsBehindNow(): number | null {
    const at = this.playheadWallclock();
    return at ? (Date.now() - at.getTime()) / 1000 : null;
  }

  /** Distance to the live edge as a live viewer has it; null in DVR (that is `behindLiveSeconds`). */
  private latencySeconds(): number | null {
    return this.mode === "dvr" ? null : this.secondsBehindNow();
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
    // A data-mode change the current token does not carry yet; resent until the server applies it.
    const wanted = this.dataModeWanted;
    const change = wanted !== this.dataModeApplied ? wanted : undefined;
    // Beats go one after another, so a request that never answers would stop them all and drop the
    // viewer from the count (once on CI: 35 s without a beat). Give up after one interval; the
    // deltas ride along with the next beat, and the server caps watch time to wall-clock time.
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new Error("heartbeat timed out")), session.intervalMs);
    try {
      const res = await Promise.race([
        this.opts.api.playback.heartbeat(
          {
            sessionId: session.id,
            token: session.token,
            rendition: RENDITION_SOURCE,
            fingerprint: collectFingerprint(this.native),
            ...this.accountant.delta(totals),
            ...playbackFields(this.playbackMode(), this.behindLiveSeconds()),
            ...dataModeField(change),
          },
          { signal: abort.signal },
        ),
        new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(abort.signal.reason))),
      ]);
      // Throttled: the server recorded nothing, so the deltas ride along with the next beat.
      if (!this.accountant.settle(totals, res)) return;
      this.lastAckAt = Date.now();
      this.meter.sample(this.httpBytes());
      // The tracker accepts this session's socket from now on: start sharing (once).
      if (!this.p2pOff) this.p2p?.enable();
      if (res.token) session.token = res.token;
      if (res.dvrToken && this.dvr) this.dvrToken = res.dvrToken;
      const move = heartbeatSwitch(res);
      if (move && !this.stopped) this.switchTo(move.url, move.source);
      // The mode, not `dvrUrl`: a rewind still loading on the relay only gets the grant move.
      const dvrMove = heartbeatDvrSwitch(res, { hasGrant: this.dvr !== null, playingDvr: this.mode === "dvr" });
      if (dvrMove && !this.stopped) this.switchDvrTo(dvrMove);
      // Only a token says what the origin applies: a beat answered without one (a concurrent beat
      // lost the race) leaves the change pending, and it is sent again.
      if (res.token && !this.stopped) this.applyDataModeToken(res.token, move !== null);
    } catch {
      // Not committed: this heartbeat's share is reported with the next one.
    } finally {
      clearTimeout(timeout);
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
    this.reload(url);
    this.opts.onSource?.(source);
  }

  /**
   * Batch 8 (`dvrSwitchTo`): the session's relay left, so its DVR grant moves to the origin
   * playlist for the rest of the session. Unless DVR is playing (mode `dvr`), only the grant
   * changes: the next `enterDvr` rewinds on the origin, and a rewind still loading on the relay
   * fails there and returns to live as any failed `enterDvr` does. While DVR plays, the source
   * swaps at the current position (`swapDvrSource`: no seek to live; a paused viewer is not told to
   * play and stays paused). A failed swap returns to live; a later `enterDvr`/`exitDvr` supersedes it.
   */
  private switchDvrTo(move: DvrSwitch): void {
    if (!this.dvr) return;
    this.dvr = { windowSeconds: this.dvr.windowSeconds, playlistUrl: move.url };
    if (move.token !== null) this.dvrToken = move.token;
    if (!move.swap || this.mode !== "dvr" || this.dvrUrl === null) return;
    const generation = ++this.dvrGeneration;
    const { video } = this.opts;
    void swapDvrSource(
      {
        playheadWallclock: () => this.playheadWallclock(),
        seekToWallclock: (t) => this.seekToWallclockAt(t),
        paused: () => video.paused,
        pause: () => video.pause(),
        landed: (target, seekOk) => {
          if (generation !== this.dvrGeneration || this.stopped) return;
          this.holdFrom("swap", target.getTime(), seekOk);
        },
        loadDvr: async (url, { autoplay }) => {
          // Set first, so `tokenFor` hands the new directory its DVR token.
          this.dvrUrl = url;
          const ok = await (this.hls ? this.loadDvrHls(this.hls, url, autoplay) : this.loadDvrNative(url, autoplay));
          if (generation !== this.dvrGeneration || this.stopped) return false;
          if (!ok) {
            this.exitDvr();
            return false;
          }
          // Still DVR (it was when the swap began); a guard should anything have reset the mode.
          this.notifyMode("dvr");
          return true;
        },
      },
      this.dvrToken === null ? move.url : withToken(move.url, this.dvrToken),
    );
  }

  /** Start holding a landing (`holdLanding`) for the current DVR generation. */
  private holdFrom(via: DvrLanding["via"], target: number, seekOk: boolean): void {
    this.landing = {
      generation: this.dvrGeneration,
      via,
      target,
      until: Date.now() + DVR_LANDING_GUARD_MS,
      played: 0,
      lastTime: null,
      corrections: 0,
      seekOk,
      driftMs: null,
    };
    this.traceLanding();
  }

  /**
   * Hold a DVR landing while the new source settles: the playhead should be where the swap or
   * rewind sent it plus what has played since. hls.js can still move it on a new live playlist (to the
   * live sync position once the first fragments are in, CI run 41764916744: 60 s behind became 15);
   * a jump like that is put back, at most `DVR_LANDING_MAX_CORRECTIONS` times. A seek of the
   * viewer's (any public seek but a rewind onto a fresh source, which starts its own), a new
   * `enterDvr`/`exitDvr`/swap or the end of the window ends it.
   */
  private holdLanding = (): void => {
    const l = this.landing;
    if (!l) return;
    const { video } = this.opts;
    if (l.generation !== this.dvrGeneration || this.mode !== "dvr" || this.stopped || Date.now() > l.until) {
      this.landing = null;
      return;
    }
    const t = video.currentTime;
    if (l.lastTime !== null) {
      const step = t - l.lastTime;
      if (step > 0 && step <= PLAYBACK_STEP_MAX_S) l.played += step;
    }
    l.lastTime = t;
    // Not while a seek is under way or before the new source has media.
    if (video.seeking || (this.hls && !this.hls.hasEnoughToStart)) return;
    const at = this.playheadWallclock();
    if (!at) return;
    const expected = l.target + l.played * 1000;
    l.driftMs = Math.round(at.getTime() - expected);
    if (Math.abs(l.driftMs) > DVR_LANDING_TOLERANCE_MS && l.corrections < DVR_LANDING_MAX_CORRECTIONS) {
      l.corrections += 1;
      if (this.seekToWallclockAt(new Date(expected))) l.lastTime = video.currentTime;
    }
    this.traceLanding();
  };

  /** The last landing on the element (`data-dvr-swap`), for the harness's relay-dvr diagnostics. */
  private traceLanding(): void {
    const l = this.landing;
    if (!l) return;
    this.opts.video.dataset.dvrSwap = JSON.stringify({
      via: l.via,
      target: l.target,
      seekOk: l.seekOk,
      played: Math.round(l.played * 10) / 10,
      driftMs: l.driftMs,
      corrections: l.corrections,
    });
  }

  /**
   * Load a new multivariant playlist of the same stream (a move, or a new data-mode ceiling).
   * While DVR plays it is only remembered: `exitDvr` returns to it.
   */
  private reload(url: string): void {
    const { video } = this.opts;
    this.playlistUrl = url;
    if (this.dvrUrl !== null) return;
    // The new playlist's level list may differ, so the pick goes back to Auto.
    this.resetQuality();
    if (this.hls) this.hls.loadSource(url);
    else video.src = url;
    void video.play().catch(() => undefined);
  }

  private async endSession(id: string, token: string): Promise<void> {
    await (this.opts.endApi ?? this.opts.api).playback.end({ sessionId: id, token }).catch(() => undefined);
  }

  /** Stop playback and end the session. Safe to call more than once. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.dvrGeneration += 1;
    this.dvrUrl = null;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    if (this.iceTimer) clearTimeout(this.iceTimer);
    this.modeListeners.clear();
    for (const unsub of this.textTrackUnsubs) unsub();
    const { video } = this.opts;
    video.removeEventListener("playing", this.onPlaying);
    video.removeEventListener("error", this.onVideoError);
    video.removeEventListener("timeupdate", this.holdLanding);
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

/** A URL's directory with its trailing slash and no query (`…/dvr/<vodId>/`). */
export function urlDirectory(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1)}`;
}

/** Whether `t` lies in one of the ranges (`video.seekable`). */
function inRanges(ranges: TimeRanges | undefined, t: number): boolean {
  if (!ranges || !Number.isFinite(t)) return false;
  for (let i = 0; i < ranges.length; i++) if (t >= ranges.start(i) && t <= ranges.end(i)) return true;
  return false;
}
