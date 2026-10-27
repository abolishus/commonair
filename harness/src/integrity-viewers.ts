// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Viewers for the `integrity-basic` cases beyond the viewbot swarm (`viewbot.ts`):
 *
 * - `HeartbeatOnlyViewer`: a bot that looks human (plausible fingerprint, jittered beats, a
 *   residential address the caller picks) and heartbeats claimed playback without ever requesting
 *   a playlist or a segment. On origin it must never verify; on the CDN nobody can judge its
 *   fetches, so it carries `fetch_unjudged` and is not gate-eligible.
 * - `HiddenTabViewer`: an honest viewer whose tab goes to the background for a while. It keeps
 *   fetching media (audio keeps playing) while its beats report `visible: false` at the cadence a
 *   throttled background timer gives. It must stay verified.
 *
 * The pure helpers below are what the scenario judges rows with; tests cover them without a stack.
 */
import type { Logger } from "@commonair/observability";
import type { ApiClient } from "./api/client.ts";
import { type PlaybackAssignment, assignmentOf } from "./assignment.ts";
import {
  type Fingerprint,
  type HeartbeatTiming,
  newDeviceId,
  nextHeartbeatDelay,
  realisticFingerprint,
} from "./fingerprint.ts";
import { type MediaPlaylist, lowestVariant, parsePlaylist, resolveUri, withToken } from "./hls.ts";
import { BufferModel } from "./http-viewer.ts";
import { type Viewer, type ViewerReport, PlaybackSession, emptyReport } from "./viewer.ts";
import { TimeoutError, sleep } from "./wait.ts";

// Reason codes as stored in `playback_sessions.verdict_reasons` (packages/integrity/src/types.ts;
// the harness does not depend on @commonair/integrity, so the strings are mirrored here).
export const FETCH_UNJUDGED = "fetch_unjudged";
export const MEDIA_UNCONFIRMED = "media_unconfirmed";
export const FETCH_PATTERN = "fetch_pattern";

export interface VerdictRow {
  verdict: string;
  reasons: readonly string[] | null;
}

/**
 * Mirror of `gateEligible` in packages/integrity/src/score.ts: verified, and its fetches were
 * judged. Takes the verdict and reasons as stored.
 */
export function gateEligible(row: VerdictRow): boolean {
  return row.verdict === "verified" && !(row.reasons ?? []).includes(FETCH_UNJUDGED);
}

/**
 * A fetch-less session was handled correctly: held pending because delivery never confirmed its
 * media, or excluded on its fetch pattern. Never verified.
 */
export function fetchlessHeld(row: VerdictRow): boolean {
  const reasons = row.reasons ?? [];
  if (row.verdict === "pending") return reasons.includes(MEDIA_UNCONFIRMED);
  if (row.verdict === "excluded") return reasons.includes(FETCH_PATTERN);
  return false;
}

/**
 * The CDN bot's row as the scenario expects it once scored with enough beats: not held for too
 * few heartbeats any more, marked `fetch_unjudged`, and therefore not gate-eligible.
 */
export function cdnBotSettled(row: VerdictRow): boolean {
  const reasons = row.reasons ?? [];
  return reasons.includes(FETCH_UNJUDGED) && !reasons.includes("insufficient_heartbeats");
}

/** Honest viewers the public count must show: the plain ones, a household, and the hidden tab. */
export function honestAudience(o: { plain: number; household: number; hidden: number }): number {
  return Math.max(0, o.plain) + Math.max(0, o.household) + Math.max(0, o.hidden);
}

/** Visible-tab timing for these viewers: human jitter, never a late beat (keeps the count steady). */
export const STEADY_TIMING: HeartbeatTiming = { jitter: 0.15, lateProbability: 0 };

/** The API counts a viewer whose last beat is at most this old (services/api/src/lib/viewers.ts). */
export const VIEWER_WINDOW_MS = 30_000;

/**
 * Delay before the next beat of a hidden tab. Browsers run background timers on whole-second
 * wake-ups and stretch them under a CPU budget, so the cadence slows and loses its sub-second
 * jitter. Capped below the public count's window so the viewer is still counted (intensive
 * one-a-minute throttling only starts after five minutes hidden).
 */
export function hiddenHeartbeatDelay(
  intervalMs: number,
  random: () => number = Math.random,
  stretch = 1.8,
  capMs: number = VIEWER_WINDOW_MS - 5_000,
): number {
  const base = nextHeartbeatDelay(intervalMs, STEADY_TIMING, random) * Math.max(1, stretch);
  return Math.min(Math.max(1_000, Math.ceil(base / 1_000) * 1_000), Math.max(1_000, Math.floor(capMs / 1_000) * 1_000));
}

/** Bytes a bot claims to have downloaded after `elapsedMs` at `kbps` (client bytes are never trusted). */
export function claimedBytes(elapsedMs: number, kbps: number): number {
  return Math.max(0, Math.round((Math.max(0, elapsedMs) / 1000) * Math.max(0, kbps) * 125));
}

export interface HeartbeatOnlyOptions {
  id: string;
  api: ApiClient;
  channel: string;
  deviceId?: string;
  fingerprint?: Fingerprint;
  /** Claimed bitrate for the bytes the bot reports (default 1500 kb/s). */
  claimKbps?: number;
  timing?: HeartbeatTiming;
  log?: Logger;
  random?: () => number;
}

/** Heartbeats claiming continuous playback; never a playlist or media request. */
export class HeartbeatOnlyViewer {
  readonly id: string;
  private session: PlaybackSession | null = null;
  private abort = new AbortController();
  private loop: Promise<void> | null = null;
  private startedAt = 0;
  private beats = 0;
  private beatErrors = 0;
  private assigned: PlaybackAssignment | null = null;

  constructor(private readonly opts: HeartbeatOnlyOptions) {
    this.id = opts.id;
  }

  get sessionId(): string | null {
    return this.session?.started?.sessionId ?? null;
  }

  /** Where the API sent the session (from the playback token). */
  get assignment(): PlaybackAssignment | null {
    return this.assigned;
  }

  get heartbeats(): number {
    return this.beats;
  }

  get heartbeatErrors(): number {
    return this.beatErrors;
  }

  async start(): Promise<void> {
    this.session = new PlaybackSession(this.opts.api, {
      channel: this.opts.channel,
      deviceId: this.opts.deviceId ?? newDeviceId(),
      nativeHls: false,
      p2pCapable: false,
      fingerprint: this.opts.fingerprint ?? realisticFingerprint(this.opts.random),
    });
    const started = await this.session.start();
    this.startedAt = Date.now();
    this.assigned = assignmentOf(started.token) ?? { source: started.source, relayId: null };
    this.loop = this.heartbeatLoop(started.heartbeatIntervalMs);
  }

  private async heartbeatLoop(intervalMs: number): Promise<void> {
    const timing = this.opts.timing ?? STEADY_TIMING;
    const signal = this.abort.signal;
    while (!signal.aborted) {
      await sleep(nextHeartbeatDelay(intervalMs, timing, this.opts.random), signal).catch(() => undefined);
      if (signal.aborted) return;
      const session = this.session;
      if (!session) return;
      const elapsed = Date.now() - this.startedAt;
      try {
        await session.heartbeat({
          playedSeconds: elapsed / 1000,
          bufferSeconds: 2 + ((this.beats * 7) % 3),
          stalls: 0,
          bytesHttp: claimedBytes(elapsed, this.opts.claimKbps ?? 1500),
          bytesP2p: 0,
          latencySeconds: 3,
          ttffMs: 900,
          visible: true,
          muted: false,
        });
        this.beats++;
      } catch (err) {
        this.beatErrors++;
        this.opts.log?.warn("heartbeat-only viewer: heartbeat failed", {
          viewer: this.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async stop(): Promise<void> {
    this.abort.abort(new Error("viewer stopped"));
    await this.loop?.catch(() => undefined);
    await this.session?.end().catch(() => undefined);
  }
}

export interface HiddenTabOptions {
  id?: string;
  api: ApiClient;
  channel: string;
  deviceId?: string;
  fingerprint?: Fingerprint;
  log?: Logger;
  /** For tests: override fetch. */
  fetch?: typeof fetch;
  random?: () => number;
}

interface Track {
  url: string;
  lastSequence: number;
  mapFetched: string | null;
  isVideo: boolean;
}

/**
 * An honest HTTP viewer whose tab can be hidden (`hide()` / `show()`). Media keeps flowing while
 * hidden; the beats say `visible: false` and come at the background cadence. Tokens are refreshed
 * from heartbeats, so it can watch for longer than one token's lifetime.
 */
export class HiddenTabViewer implements Viewer {
  readonly id: string;
  readonly kind = "http" as const;
  private readonly f: typeof fetch;
  private session: PlaybackSession | null = null;
  private readonly state: ViewerReport;
  private buffer: BufferModel | null = null;
  private abort = new AbortController();
  private loops: Promise<void>[] = [];
  private hidden = false;
  private hiddenBeats = 0;
  private firstFrame: { resolve: (ms: number) => void; reject: (e: Error) => void; promise: Promise<number> };

  constructor(private readonly opts: HiddenTabOptions) {
    this.id = opts.id ?? `hidden-tab-${crypto.randomUUID().slice(0, 8)}`;
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

  /** Beats sent while hidden. */
  get beatsWhileHidden(): number {
    return this.hiddenBeats;
  }

  hide(): void {
    this.hidden = true;
  }

  show(): void {
    this.hidden = false;
  }

  async start(): Promise<void> {
    this.state.startedAt = Date.now();
    this.session = new PlaybackSession(this.opts.api, {
      channel: this.opts.channel,
      deviceId: this.opts.deviceId ?? newDeviceId(),
      nativeHls: false,
      p2pCapable: false,
      fingerprint: this.opts.fingerprint ?? realisticFingerprint(this.opts.random),
    });
    const started = await this.session.start();
    this.state.sessionId = started.sessionId;
    this.state.source = started.source;
    this.buffer = new BufferModel(1, this.state.startedAt);
    const tracks = await this.resolveTracks(started.playlistUrl);
    for (const t of tracks) this.loops.push(this.follow(t).catch((err) => this.fail(err)));
    this.loops.push(this.heartbeatLoop(started.heartbeatIntervalMs));
  }

  private fail(err: unknown): void {
    if (this.abort.signal.aborted) return;
    const message = err instanceof Error ? err.message : String(err);
    this.state.errors.push(message);
    this.opts.log?.warn("hidden-tab viewer error", { viewer: this.id, error: message });
    this.firstFrame.reject(new Error(message));
  }

  /** The URL with the session's current token (heartbeats refresh it). */
  private current(url: string): string {
    return this.session?.token ? withToken(url, this.session.token) : url;
  }

  private async get(url: string): Promise<Response> {
    return this.f(this.current(url), {
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)]),
    });
  }

  private async playlistText(url: string): Promise<string> {
    const res = await this.get(url);
    const body = await res.text();
    this.state.bytesHttp += body.length;
    if (!res.ok) throw new Error(`playlist HTTP ${res.status}`);
    return body;
  }

  private async resolveTracks(url: string): Promise<Track[]> {
    // A fresh live stream 404s until the muxer has segments; players retry.
    let body: string | null = null;
    for (let i = 0; i < 45 && body === null; i++) {
      try {
        body = await this.playlistText(url);
      } catch (err) {
        if (this.abort.signal.aborted || i === 44) throw err;
        await sleep(1_000, this.abort.signal);
      }
    }
    const playlist = parsePlaylist(body ?? "");
    if (playlist.kind === "media") return [{ url, lastSequence: -1, mapFetched: null, isVideo: true }];
    const variant = lowestVariant(playlist);
    if (!variant) throw new Error("multivariant playlist has no variants");
    const tracks: Track[] = [{ url: resolveUri(variant.uri, url), lastSequence: -1, mapFetched: null, isVideo: true }];
    const audio = playlist.renditions.find((r) => r.type === "AUDIO" && r.groupId === variant.audioGroup && r.uri);
    if (audio?.uri)
      tracks.push({ url: resolveUri(audio.uri, url), lastSequence: -1, mapFetched: null, isVideo: false });
    return tracks;
  }

  private async follow(track: Track): Promise<void> {
    let failures = 0;
    while (!this.abort.signal.aborted) {
      let playlist: MediaPlaylist;
      try {
        const parsed = parsePlaylist(await this.playlistText(track.url));
        if (parsed.kind !== "media") throw new Error("expected a media playlist");
        playlist = parsed;
        failures = 0;
      } catch (err) {
        if (this.abort.signal.aborted) return;
        if (++failures >= 10) throw err;
        await sleep(1_000, this.abort.signal).catch(() => undefined);
        continue;
      }
      // Join three segments behind the live edge, like hls.js.
      const fresh =
        track.lastSequence < 0
          ? playlist.segments.slice(-3)
          : playlist.segments.filter((s) => s.sequence > track.lastSequence);
      for (const segment of fresh) {
        if (this.abort.signal.aborted) return;
        track.lastSequence = segment.sequence;
        try {
          if (segment.map && track.mapFetched !== segment.map) {
            const init = await this.get(resolveUri(segment.map, track.url));
            this.state.bytesHttp += (await init.arrayBuffer()).byteLength;
            track.mapFetched = segment.map;
          }
          const res = await this.get(resolveUri(segment.uri, track.url));
          this.state.bytesHttp += (await res.arrayBuffer()).byteLength;
          if (!res.ok) throw new Error(`segment HTTP ${res.status}`);
        } catch (err) {
          if (this.abort.signal.aborted) return;
          this.state.skippedSegments++;
          this.opts.log?.debug("hidden-tab viewer: segment skipped", {
            viewer: this.id,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        if (track.isVideo && this.buffer?.append(segment.duration, Date.now())) {
          this.state.ttffMs = Date.now() - this.state.startedAt;
          this.firstFrame.resolve(this.state.ttffMs);
        }
      }
      if (playlist.ended) return;
      const wait = fresh.length > 0 ? playlist.targetDuration : playlist.targetDuration / 2;
      await sleep(Math.max(250, wait * 1000), this.abort.signal).catch(() => undefined);
    }
  }

  private async heartbeatLoop(intervalMs: number): Promise<void> {
    const signal = this.abort.signal;
    while (!signal.aborted) {
      const delay = this.hidden
        ? hiddenHeartbeatDelay(intervalMs, this.opts.random)
        : nextHeartbeatDelay(intervalMs, STEADY_TIMING, this.opts.random);
      await sleep(delay, signal).catch(() => undefined);
      if (signal.aborted) return;
      const session = this.session;
      const buffer = this.buffer;
      if (!session || !buffer) return;
      buffer.tick(Date.now());
      const visible = !this.hidden;
      try {
        await session.heartbeat({
          playedSeconds: buffer.playedSeconds,
          bufferSeconds: buffer.buffered,
          stalls: buffer.stalls,
          bytesHttp: this.state.bytesHttp,
          bytesP2p: 0,
          latencySeconds: null,
          ttffMs: this.state.ttffMs,
          visible,
          muted: false,
        });
        this.state.heartbeats++;
        if (!visible) this.hiddenBeats++;
      } catch (err) {
        this.state.heartbeatErrors++;
        this.opts.log?.warn("hidden-tab viewer: heartbeat failed", {
          viewer: this.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
      latencyMs: [],
      errors: [...this.state.errors],
    };
  }

  async stop(): Promise<ViewerReport> {
    const final = await this.report();
    if (!this.abort.signal.aborted) {
      this.abort.abort(new Error("viewer stopped"));
      await Promise.allSettled(this.loops);
      await this.session?.end().catch((err: unknown) => {
        this.state.errors.push(`end: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return final;
  }
}
