// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * An HTTP-only DVR viewer (ADR 0016): starts a real playback session, rewinds by playing the
 * origin's `/dvr/` playlist from a distance behind live, downloads its 4 s segments as playback
 * reaches them, and heartbeats in `dvr` mode with `behindLiveSeconds`, refreshing both the live
 * and the DVR token from the heartbeat. Its fetches are what integrity judges its DVR seconds on.
 * Nothing here logs a token.
 */
import type { Logger } from "@commonair/observability";
import type { ApiClient } from "../../api/client.ts";
import { HUMAN_TIMING, newDeviceId, nextHeartbeatDelay, realisticFingerprint } from "../../fingerprint.ts";
import { type MediaPlaylist, type Segment, parsePlaylist, resolveUri, withToken } from "../../hls.ts";
import { sleep } from "../../wait.ts";
import type { PlaybackStart } from "../../viewer.ts";

export const HEARTBEAT_INTERVAL_MS = 10_000;
/** Keep this much media downloaded ahead of the playhead (a player's forward buffer). */
export const BUFFER_AHEAD_SECONDS = 12;

/** Where playback starts: the segment about `behindSeconds` before the playlist's newest end. */
export function startIndex(segments: readonly Pick<Segment, "duration">[], behindSeconds: number): number {
  let covered = 0;
  for (let i = segments.length - 1; i >= 0; i--) {
    covered += segments[i]?.duration ?? 0;
    if (covered >= behindSeconds) return i;
  }
  return 0;
}

/**
 * The name of the segment after the newest one a DVR playlist lists (the recorder names them
 * `<run>_<6 digits>.m4s`): the one being recorded, which `/dvr/` must refuse. Null when the
 * newest name does not follow that pattern.
 */
export function nextSegmentName(uri: string): string | null {
  const file = uri.split("?")[0]?.split("/").at(-1) ?? "";
  const m = /^(.*_)(\d+)\.m4s$/.exec(file);
  if (!m?.[1] || !m[2]) return null;
  const next = String(Number(m[2]) + 1).padStart(m[2].length, "0");
  return `${m[1]}${next}.m4s`;
}

export interface DvrViewerReport {
  sessionId: string | null;
  dvrWindowSeconds: number;
  playlists: number;
  segments: number;
  bytes: number;
  playedSeconds: number;
  heartbeats: number;
  dvrTokenRefreshes: number;
  errors: string[];
}

export interface DvrViewerOptions {
  api: ApiClient;
  channel: string;
  /** How far behind live to start (seconds). */
  behindSeconds: number;
  log?: Logger;
  fetch?: typeof fetch;
}

export class DvrHttpViewer {
  readonly report: DvrViewerReport = {
    sessionId: null,
    dvrWindowSeconds: 0,
    playlists: 0,
    segments: 0,
    bytes: 0,
    playedSeconds: 0,
    heartbeats: 0,
    dvrTokenRefreshes: 0,
    errors: [],
  };
  private started: PlaybackStart | null = null;
  private liveToken = "";
  private dvrUrl = "";
  private readonly abort = new AbortController();
  private loops: Promise<void>[] = [];
  private readonly fingerprint = realisticFingerprint();
  private readonly fetchFn: typeof fetch;
  /** Media downloaded and played, seconds; the wall-clock time playback started. */
  private downloaded = 0;
  private playStartMs: number | null = null;
  private firstPdtMs: number | null = null;
  private sentPlayed = 0;
  private sentBytes = 0;
  /** When each counted segment (or init map) finished downloading, epoch ms. */
  private readonly segmentDoneAt: number[] = [];

  constructor(private readonly opts: DvrViewerOptions) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  get sessionId(): string | null {
    return this.started?.sessionId ?? null;
  }

  /** Start the session; throws when the session has no DVR grant. */
  async start(): Promise<PlaybackStart> {
    const res = await this.opts.api.playback.start({
      channel: this.opts.channel,
      deviceId: newDeviceId(),
      nativeHls: false,
      p2pCapable: false,
      embed: false,
    });
    this.started = res;
    this.report.sessionId = res.sessionId;
    this.report.dvrWindowSeconds = res.dvrWindowSeconds;
    this.liveToken = res.token;
    if (!res.dvrPlaylistUrl) throw new Error("the session has no DVR grant");
    this.dvrUrl = res.dvrPlaylistUrl;
    this.loops = [this.playLoop(), this.heartbeatLoop()];
    return res;
  }

  /** Seconds played so far (never more than downloaded). */
  private played(now = Date.now()): number {
    if (this.playStartMs === null) return 0;
    return Math.min(this.downloaded, (now - this.playStartMs) / 1000);
  }

  private behindLive(now = Date.now()): number | null {
    if (this.firstPdtMs === null) return null;
    return Math.max(0, (now - (this.firstPdtMs + this.played(now) * 1000)) / 1000);
  }

  private async get(url: string): Promise<Response> {
    return this.fetchFn(url, { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]) });
  }

  private async playlist(): Promise<MediaPlaylist | null> {
    const res = await this.get(this.dvrUrl);
    if (!res.ok) {
      await res.body?.cancel();
      this.report.errors.push(`playlist ${res.status}`);
      return null;
    }
    this.report.playlists++;
    const p = parsePlaylist(await res.text());
    return p.kind === "media" ? p : null;
  }

  private async segment(uri: string): Promise<boolean> {
    const res = await this.get(resolveUri(uri, this.dvrUrl));
    if (!res.ok) {
      await res.body?.cancel();
      this.report.errors.push(`segment ${res.status}`);
      return false;
    }
    this.report.bytes += (await res.arrayBuffer()).byteLength;
    this.report.segments++;
    this.segmentDoneAt.push(Date.now());
    return true;
  }

  private async playLoop(): Promise<void> {
    let next: number | null = null;
    let mapFetched: string | null = null;
    while (!this.abort.signal.aborted) {
      try {
        const p = await this.playlist();
        if (p && p.segments.length > 0) {
          if (next === null) {
            const i = startIndex(p.segments, this.opts.behindSeconds);
            next = p.segments[i]?.sequence ?? p.mediaSequence;
            this.firstPdtMs = p.segments[i]?.programDateTime ?? null;
          }
          // Download while the forward buffer is short, in sequence order.
          for (const s of p.segments) {
            if (s.sequence < next) continue;
            if (this.downloaded - this.played() >= BUFFER_AHEAD_SECONDS) break;
            if (s.map && s.map !== mapFetched && (await this.segment(s.map))) mapFetched = s.map;
            if (!(await this.segment(s.uri))) break;
            this.downloaded += s.duration;
            this.playStartMs ??= Date.now();
            next = s.sequence + 1;
          }
        }
      } catch (err) {
        if (this.abort.signal.aborted) return;
        this.report.errors.push(String(err).slice(0, 120));
      }
      await sleep(4_000, this.abort.signal).catch(() => undefined);
    }
  }

  private async heartbeatLoop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      await sleep(nextHeartbeatDelay(HEARTBEAT_INTERVAL_MS, HUMAN_TIMING), this.abort.signal).catch(() => undefined);
      if (this.abort.signal.aborted || !this.started) return;
      const now = Date.now();
      const played = this.played(now);
      try {
        const res = await this.opts.api.playback.heartbeat({
          sessionId: this.started.sessionId,
          token: this.liveToken,
          playedSeconds: Math.min(120, Math.max(0, played - this.sentPlayed)),
          bufferSeconds: Math.max(0, this.downloaded - played),
          stalls: 0,
          bytesHttp: Math.max(0, this.report.bytes - this.sentBytes),
          bytesP2p: 0,
          rendition: "source",
          latencySeconds: null,
          ttffMs: 900,
          visible: true,
          muted: false,
          fingerprint: this.fingerprint,
          playbackMode: "dvr",
          behindLiveSeconds: this.behindLive(now),
        });
        if (res.throttled) continue;
        this.sentPlayed = played;
        this.sentBytes = this.report.bytes;
        this.report.heartbeats++;
        this.report.playedSeconds = played;
        if (res.token) this.liveToken = res.token;
        if (res.dvrToken) {
          this.dvrUrl = withToken(this.dvrUrl, res.dvrToken);
          this.report.dvrTokenRefreshes++;
        }
      } catch (err) {
        this.report.errors.push(`heartbeat ${String(err).slice(0, 120)}`);
      }
    }
  }

  /** When each counted segment finished downloading (epoch ms, in order). */
  segmentTimes(): readonly number[] {
    return this.segmentDoneAt;
  }

  /** The current DVR playlist URL (with the newest DVR token). */
  playlistUrl(): string {
    return this.dvrUrl;
  }

  /** Stop playback and end the session. Idempotent. */
  async stop(): Promise<DvrViewerReport> {
    if (!this.abort.signal.aborted) {
      this.abort.abort();
      await Promise.allSettled(this.loops);
      if (this.started)
        await this.opts.api.playback
          .end({ sessionId: this.started.sessionId, token: this.liveToken })
          .catch((err: unknown) => this.opts.log?.warn("dvr viewer: end failed", { err: String(err) }));
    }
    return this.report;
  }
}
