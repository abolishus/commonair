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
import { HttpViewer } from "./http-viewer.ts";
import { type Viewer, type ViewerReport, PlaybackSession } from "./viewer.ts";
import { sleep } from "./wait.ts";

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

export interface Placement {
  id: string;
  /** The source the API assigned (null when the viewer cannot tell, e.g. before a browser reports). */
  source: string | null;
}

/**
 * Sessions the API sent to the CDN. The origin cases (household, hidden tab, bots judged on their
 * fetches) mean nothing there: the CDN is never judged on fetches, and a bogus `CDN_BASE_URL`
 * serves no media. The scenario fails when any of them lands there.
 */
export function onCdn(placements: readonly Placement[]): Placement[] {
  return placements.filter((p) => p.source === "cdn");
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

/**
 * An honest HTTP viewer whose tab can be hidden (`hide()` / `show()`). It is an `HttpViewer`
 * (playlist, segments, buffer, token refresh, source switches) with steady visible timing, seen
 * through an API client whose heartbeat call is wrapped: while hidden, a beat says
 * `visible: false` and is held until the background cadence (`hiddenHeartbeatDelay` after the
 * previous beat) is due. Media keeps flowing while hidden, as audio would keep playing.
 */
export class HiddenTabViewer implements Viewer {
  readonly id: string;
  readonly kind = "http" as const;
  private readonly inner: HttpViewer;
  private hidden = false;
  private hiddenBeats = 0;
  private lastBeatAt: number | null = null;
  /** The session's visible heartbeat interval (from `playback.start`). */
  private intervalMs = 10_000;
  /** Wakes a held beat early: on `show()` and on `stop()`. */
  private wake = new AbortController();
  private readonly stopping = new AbortController();

  constructor(private readonly opts: HiddenTabOptions) {
    this.id = opts.id ?? `hidden-tab-${crypto.randomUUID().slice(0, 8)}`;
    this.inner = new HttpViewer({
      id: this.id,
      target: { channel: opts.channel },
      api: this.wrapApi(opts.api),
      deviceId: opts.deviceId ?? newDeviceId(),
      fingerprint: opts.fingerprint ?? realisticFingerprint(opts.random),
      timing: STEADY_TIMING,
      log: opts.log,
      fetch: opts.fetch,
    });
  }

  get sessionId(): string | null {
    return this.inner.sessionId;
  }

  /** Where the API sent the session (from the playback token). */
  get assignment(): PlaybackAssignment | null {
    return this.inner.assignment;
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
    this.wake.abort();
    this.wake = new AbortController();
  }

  /** The caller's client with `playback.heartbeat` replaced; everything else passes through. */
  private wrapApi(api: ApiClient): ApiClient {
    const heartbeat: ApiClient["playback"]["heartbeat"] = async (input, ...rest) => {
      if (this.hidden) {
        const due = (this.lastBeatAt ?? Date.now()) + hiddenHeartbeatDelay(this.intervalMs, this.opts.random);
        const wait = due - Date.now();
        if (wait > 0)
          await sleep(wait, AbortSignal.any([this.wake.signal, this.stopping.signal])).catch(() => undefined);
      }
      // Visibility as of when the beat is actually sent (the tab may have come back meanwhile).
      const visible = !this.hidden && input.visible;
      const res = await api.playback.heartbeat({ ...input, visible }, ...rest);
      this.lastBeatAt = Date.now();
      if (!visible) this.hiddenBeats++;
      return res;
    };
    const start: ApiClient["playback"]["start"] = async (...args) => {
      const res = await api.playback.start(...args);
      this.intervalMs = res.heartbeatIntervalMs;
      return res;
    };
    const wrapped: Partial<Record<PropertyKey, unknown>> = { heartbeat, start };
    const playback = new Proxy(api.playback, {
      get: (target, key, receiver) => (Object.hasOwn(wrapped, key) ? wrapped[key] : Reflect.get(target, key, receiver)),
    });
    return new Proxy(api, {
      get: (target, key, receiver) => (key === "playback" ? playback : Reflect.get(target, key, receiver)),
    });
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  waitForFirstFrame(timeoutMs?: number): Promise<number> {
    return this.inner.waitForFirstFrame(timeoutMs);
  }

  report(): Promise<ViewerReport> {
    return this.inner.report();
  }

  stop(): Promise<ViewerReport> {
    this.stopping.abort();
    return this.inner.stop();
  }
}
