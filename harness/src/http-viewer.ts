// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * HTTP-only viewer: no browser. Starts a real playback session, follows the live playlist,
 * downloads segments on the player's schedule, models a playback buffer (TTFF, stalls), and
 * heartbeats with realistic jitter. Hundreds fit in one process, so load tests use these for the
 * bulk of the audience. Optionally decodes the timestamp strip from downloaded segments with
 * ffmpeg for exact latency; otherwise latency comes from EXT-X-PROGRAM-DATE-TIME.
 */
import type { Logger } from "@commonair/observability";
import type { ApiClient } from "./api/client.ts";
import { CookieJar } from "./api/cookies.ts";
import {
  type Fingerprint,
  HUMAN_TIMING,
  type HeartbeatTiming,
  newDeviceId,
  nextHeartbeatDelay,
  realisticFingerprint,
} from "./fingerprint.ts";
import { type MediaPlaylist, type Segment, lowestVariant, parsePlaylist, resolveUri, withToken } from "./hls.ts";
import { decodeStrip, graySource } from "./timestamp-strip.ts";
import { type Viewer, type ViewerReport, type ViewerTarget, PlaybackSession, emptyReport } from "./viewer.ts";
import { TimeoutError, sleep, waitFor } from "./wait.ts";

export interface HttpViewerOptions {
  id?: string;
  target: ViewerTarget;
  /** Required for `{ channel }` targets. */
  api?: ApiClient;
  deviceId?: string;
  fingerprint?: Fingerprint;
  timing?: HeartbeatTiming;
  /** false = fetch playlists only (a viewbot tell). */
  fetchSegments?: boolean;
  /** Report wall-clock time as played in heartbeats regardless of what was downloaded (viewbots). */
  claimPlayback?: boolean;
  /** Send heartbeats (only meaningful with an API session). */
  heartbeats?: boolean;
  /** Decode the strip from every Nth video segment with ffmpeg (0 = never). */
  decodeStripEvery?: number;
  /** Segments behind the live edge to start from (hls.js uses 3). */
  liveSyncSegments?: number;
  /** Rebuffer threshold: playback resumes once this many seconds are buffered. */
  resumeBufferSeconds?: number;
  log?: Logger;
  /** Extra headers on media requests (e.g. a fixed user agent). */
  headers?: Record<string, string>;
  /** For tests: override fetch. */
  fetch?: typeof fetch;
}

/** Consecutive playlist or segment failures after which the viewer gives up. */
const MAX_CONSECUTIVE_FAILURES = 10;

interface Track {
  url: string;
  lastSequence: number;
  map: string | null;
  mapFetched: boolean;
  isVideo: boolean;
}

/** Playback-buffer model shared by the HTTP viewer and its unit tests. */
export class BufferModel {
  buffered = 0;
  playing = false;
  started = false;
  stalls = 0;
  stallMs = 0;
  playedSeconds = 0;
  private stallStartedAt: number | null = null;
  private lastTick: number;

  constructor(
    private readonly resumeSeconds: number,
    now: number,
  ) {
    this.lastTick = now;
  }

  /** Advance the clock: drain the buffer while playing, detect underruns. */
  tick(now: number): void {
    const elapsed = Math.max(0, (now - this.lastTick) / 1000);
    this.lastTick = now;
    if (!this.playing) return;
    const played = Math.min(elapsed, this.buffered);
    this.buffered -= played;
    this.playedSeconds += played;
    if (this.buffered <= 1e-6 && elapsed > played) {
      this.playing = false;
      this.stalls++;
      this.stallStartedAt = now - (elapsed - played) * 1000;
    }
  }

  /** Media arrived. Returns true when this append starts playback for the first time. */
  append(seconds: number, now: number): boolean {
    this.tick(now);
    this.buffered += seconds;
    if (!this.playing && this.buffered >= this.resumeSeconds) {
      this.playing = true;
      if (this.stallStartedAt !== null) {
        this.stallMs += now - this.stallStartedAt;
        this.stallStartedAt = null;
      }
      if (!this.started) {
        this.started = true;
        return true;
      }
    }
    return false;
  }

  /** Stall time including an ongoing stall. */
  totalStallMs(now: number): number {
    return this.stallMs + (this.stallStartedAt === null ? 0 : now - this.stallStartedAt);
  }
}

export class HttpViewer implements Viewer {
  readonly id: string;
  readonly kind = "http" as const;
  private readonly jar = new CookieJar();
  private readonly f: typeof fetch;
  private session: PlaybackSession | null = null;
  private readonly state: ViewerReport;
  private buffer: BufferModel | null = null;
  private abort = new AbortController();
  private loops: Promise<void>[] = [];
  private firstFrame: { resolve: (ms: number) => void; reject: (e: Error) => void; promise: Promise<number> };
  private videoSegments = 0;
  private stopped = false;
  private latencyMethod: "strip" | "pdt" | null = null;
  private segmentFailures = 0;
  private skippedSegments = 0;

  constructor(private readonly opts: HttpViewerOptions) {
    this.id = opts.id ?? `http-${crypto.randomUUID().slice(0, 8)}`;
    this.state = emptyReport(this.id, "http", "http");
    this.state.playbackPath = "http";
    this.f = opts.fetch ?? fetch;
    let resolve: (ms: number) => void = () => undefined;
    let reject: (e: Error) => void = () => undefined;
    const promise = new Promise<number>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => undefined);
    this.firstFrame = { resolve, reject, promise };
  }

  get sessionId(): string | null {
    return this.state.sessionId;
  }

  async start(): Promise<void> {
    const startedAt = Date.now();
    this.state.startedAt = startedAt;
    let playlistUrl: string;
    if ("channel" in this.opts.target) {
      if (!this.opts.api) throw new Error("HttpViewer needs an API client for channel targets");
      this.session = new PlaybackSession(this.opts.api, {
        channel: this.opts.target.channel,
        deviceId: this.opts.deviceId ?? newDeviceId(),
        nativeHls: false,
        p2pCapable: false,
        fingerprint: this.opts.fingerprint ?? realisticFingerprint(),
      });
      const started = await this.session.start();
      this.state.sessionId = started.sessionId;
      this.state.source = started.source;
      playlistUrl = started.playlistUrl;
    } else {
      playlistUrl = this.opts.target.playlistUrl;
    }
    this.buffer = new BufferModel(this.opts.resumeBufferSeconds ?? 1, startedAt);
    const tracks = await this.resolveTracks(playlistUrl);
    for (const track of tracks) this.loops.push(this.follow(track).catch((err) => this.fail(err)));
    if (this.session && this.opts.heartbeats !== false) {
      this.loops.push(this.heartbeatLoop().catch((err) => this.fail(err)));
    }
  }

  private fail(err: unknown): void {
    if (this.abort.signal.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    this.state.errors.push(message);
    this.opts.log?.warn("http viewer error", { viewer: this.id, error: message });
    this.firstFrame.reject(new Error(message));
  }

  private currentUrl(url: string): string {
    return this.session?.token ? withToken(url, this.session.token) : url;
  }

  /** GET with this viewer's cookie jar, following redirects manually so cookies survive them. */
  private async get(url: string, kind: "playlist" | "media"): Promise<Response> {
    let current = this.currentUrl(url);
    for (let hop = 0; hop < 5; hop++) {
      const headers = new Headers(this.opts.headers);
      const cookie = this.jar.header(new URL(current).pathname);
      if (cookie) headers.set("cookie", cookie);
      const res = await this.f(current, {
        headers,
        redirect: "manual",
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(kind === "playlist" ? 15_000 : 30_000)]),
      });
      this.jar.storeFrom(res.headers);
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current).toString();
        continue;
      }
      return res;
    }
    throw new Error(`too many redirects for ${new URL(url).pathname}`);
  }

  private async fetchPlaylistText(url: string): Promise<string> {
    const res = await this.get(url, "playlist");
    const body = await res.text();
    this.state.bytesHttp += body.length;
    if (!res.ok) throw new Error(`playlist HTTP ${res.status}`);
    return body;
  }

  /** Multivariant → lowest variant (+ its audio rendition); media playlist → itself. */
  private async resolveTracks(url: string): Promise<Track[]> {
    // A fresh live stream 404s until the muxer has enough segments; players retry.
    const body = await waitFor(`playlist for ${this.id}`, () => this.fetchPlaylistText(url), {
      timeoutMs: 45_000,
      intervalMs: 1_000,
      signal: this.abort.signal,
    });
    const playlist = parsePlaylist(body);
    if (playlist.kind === "media") return [{ url, lastSequence: -1, map: null, mapFetched: false, isVideo: true }];
    const variant = lowestVariant(playlist);
    if (!variant) throw new Error("multivariant playlist has no variants");
    const tracks: Track[] = [
      { url: resolveUri(variant.uri, url), lastSequence: -1, map: null, mapFetched: false, isVideo: true },
    ];
    const audio = playlist.renditions.find((r) => r.type === "AUDIO" && r.groupId === variant.audioGroup && r.uri);
    if (audio?.uri) {
      tracks.push({ url: resolveUri(audio.uri, url), lastSequence: -1, map: null, mapFetched: false, isVideo: false });
    }
    return tracks;
  }

  private async follow(track: Track): Promise<void> {
    let failures = 0;
    while (!this.abort.signal.aborted) {
      let playlist: MediaPlaylist;
      try {
        const parsed = parsePlaylist(await this.fetchPlaylistText(track.url));
        if (parsed.kind !== "media") throw new Error("expected a media playlist");
        playlist = parsed;
        failures = 0;
      } catch (err) {
        if (this.abort.signal.aborted) return;
        // Transient playlist errors are retried like a player would; persistent ones are fatal.
        if (++failures >= MAX_CONSECUTIVE_FAILURES) throw err;
        await sleep(1_000, this.abort.signal).catch(() => undefined);
        continue;
      }
      const fresh = this.newSegments(track, playlist);
      for (const segment of fresh) {
        if (this.abort.signal.aborted) return;
        await this.download(track, segment);
      }
      if (playlist.ended) return;
      const waitSeconds = fresh.length > 0 ? playlist.targetDuration : playlist.targetDuration / 2;
      await sleep(Math.max(250, waitSeconds * 1000), this.abort.signal).catch(() => undefined);
    }
  }

  private newSegments(track: Track, playlist: MediaPlaylist): Segment[] {
    if (track.lastSequence < 0) {
      // Join near the live edge like hls.js (liveSyncDurationCount).
      const sync = this.opts.liveSyncSegments ?? 3;
      const start = playlist.segments.slice(-sync);
      const first = start[0];
      track.lastSequence = first ? first.sequence - 1 : -1;
      return start;
    }
    return playlist.segments.filter((s) => s.sequence > track.lastSequence);
  }

  private async download(track: Track, segment: Segment): Promise<void> {
    track.lastSequence = segment.sequence;
    const buffer = this.buffer;
    if (!buffer) return;
    if (this.opts.fetchSegments === false) return;
    let fetched: { init: Uint8Array | null; bytes: Uint8Array };
    try {
      fetched = await this.fetchSegment(track, segment);
      this.segmentFailures = 0;
    } catch (err) {
      if (this.abort.signal.aborted) return;
      // Players skip a missing segment and carry on; only a run of failures is fatal.
      this.skippedSegments++;
      if (++this.segmentFailures >= MAX_CONSECUTIVE_FAILURES) throw err;
      this.opts.log?.debug("segment skipped", { viewer: this.id, error: (err as Error).message });
      return;
    }
    const { init, bytes } = fetched;
    if (!track.isVideo) return;
    const now = Date.now();
    if (buffer.append(segment.duration, now)) {
      this.state.ttffMs = now - this.state.startedAt;
      this.firstFrame.resolve(this.state.ttffMs);
    }
    this.videoSegments++;
    if (segment.programDateTime !== null && this.latencyMethod !== "strip") {
      this.latencyMethod = "pdt";
      this.pushLatency(now - (segment.programDateTime + segment.duration * 1000));
    }
    const every = this.opts.decodeStripEvery ?? 0;
    if (every > 0 && this.videoSegments % every === 1 % every) {
      void this.decodeLatency(init, bytes, segment, now).catch((err) =>
        this.opts.log?.debug("strip decode failed", { viewer: this.id, error: (err as Error).message }),
      );
    }
  }

  private async fetchSegment(track: Track, segment: Segment): Promise<{ init: Uint8Array | null; bytes: Uint8Array }> {
    let init: Uint8Array | null = null;
    if (segment.map && (!track.mapFetched || track.map !== segment.map)) {
      const res = await this.get(resolveUri(segment.map, track.url), "media");
      if (!res.ok) throw new Error(`init segment HTTP ${res.status}`);
      init = new Uint8Array(await res.arrayBuffer());
      this.state.bytesHttp += init.byteLength;
      track.map = segment.map;
      track.mapFetched = true;
    }
    const res = await this.get(resolveUri(segment.uri, track.url), "media");
    if (!res.ok) throw new Error(`segment HTTP ${res.status}: ${new URL(res.url || segment.uri, track.url).pathname}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    this.state.bytesHttp += bytes.byteLength;
    return { init, bytes };
  }

  private pushLatency(ms: number): void {
    this.state.latencyMs.push(Math.max(0, Math.round(ms)));
    if (this.state.latencyMs.length > 1_000) this.state.latencyMs.shift();
  }

  private initCache: Uint8Array | null = null;

  /** Extract the first frame of the segment with ffmpeg and read its capture time from the strip. */
  private async decodeLatency(init: Uint8Array | null, bytes: Uint8Array, segment: Segment, arrivedAt: number) {
    if (init) this.initCache = init;
    const head = segment.map ? this.initCache : null;
    if (segment.map && !head) return;
    const input = head ? Buffer.concat([head, bytes]) : Buffer.from(bytes);
    const width = 320;
    const height = 180;
    const proc = Bun.spawn(
      [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-frames:v",
        "1",
        "-vf",
        `scale=${width}:${height}`,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "pipe:1",
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "ignore" },
    );
    void proc.stdin.write(input);
    await proc.stdin.end();
    const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
    await proc.exited;
    if (out.byteLength < width * height) return;
    const captured = decodeStrip(graySource(out, width, height));
    if (captured === null) return;
    this.latencyMethod = "strip";
    // The segment became playable when it arrived; its first frame was captured at `captured`.
    this.pushLatency(arrivedAt - captured - segment.duration * 1000);
  }

  private async heartbeatLoop(): Promise<void> {
    const session = this.session;
    if (!session?.started) return;
    const interval = session.started.heartbeatIntervalMs;
    const timing = this.opts.timing ?? HUMAN_TIMING;
    while (!this.abort.signal.aborted) {
      await sleep(nextHeartbeatDelay(interval, timing), this.abort.signal).catch(() => undefined);
      if (this.abort.signal.aborted) return;
      await this.sendHeartbeat();
    }
  }

  private async sendHeartbeat(): Promise<void> {
    const session = this.session;
    const buffer = this.buffer;
    if (!session || !buffer) return;
    const now = Date.now();
    buffer.tick(now);
    const latest = this.state.latencyMs.at(-1);
    try {
      const res = await session.heartbeat({
        playedSeconds: this.opts.claimPlayback ? (now - this.state.startedAt) / 1000 : buffer.playedSeconds,
        bufferSeconds: buffer.buffered,
        stalls: buffer.stalls,
        bytesHttp: this.state.bytesHttp,
        bytesP2p: 0,
        latencySeconds: latest === undefined ? null : latest / 1000,
        ttffMs: this.state.ttffMs,
        visible: true,
        muted: false,
      });
      this.state.heartbeats++;
      if (res.switchTo) this.opts.log?.info("http viewer switched source", { viewer: this.id });
    } catch (err) {
      this.state.heartbeatErrors++;
      this.opts.log?.warn("heartbeat failed", { viewer: this.id, error: (err as Error).message });
    }
  }

  async waitForFirstFrame(timeoutMs = 45_000): Promise<number> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.firstFrame.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new TimeoutError(`first segment for ${this.id}`, timeoutMs)), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async report(): Promise<ViewerReport> {
    const now = Date.now();
    this.buffer?.tick(now);
    return {
      ...this.state,
      stalls: this.buffer?.stalls ?? 0,
      stallMs: this.buffer?.totalStallMs(now) ?? 0,
      playedSeconds: this.buffer?.playedSeconds ?? 0,
      latencyMs: [...this.state.latencyMs],
      latencyMethod: this.latencyMethod,
      skippedSegments: this.skippedSegments,
      errors: [...this.state.errors],
    };
  }

  async stop(): Promise<ViewerReport> {
    if (!this.stopped) {
      this.stopped = true;
      const final = await this.report();
      this.abort.abort(new Error("viewer stopped"));
      await Promise.allSettled(this.loops);
      try {
        await this.session?.end();
      } catch (err) {
        this.state.errors.push(`end: ${(err as Error).message}`);
      }
      Object.assign(this.state, { ...final, errors: this.state.errors });
    }
    return { ...this.state, latencyMs: [...this.state.latencyMs], errors: [...this.state.errors] };
  }
}
