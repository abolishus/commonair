// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Playback statistics measured from a `<video>` element (played time, stalls, first frame). */

/** Gaps larger than this between `timeupdate`s are seeks or resumes, not playback. */
const MAX_TICK_SECONDS = 2;

export class VideoStats {
  playedSeconds = 0;
  stalls = 0;
  ttffMs: number | null = null;
  private lastTime: number | null = null;
  private startedAt: number;
  private readonly cleanup: (() => void)[] = [];

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onFirstFrame: () => void,
    now: () => number = () => performance.now(),
  ) {
    this.startedAt = now();
    const on = (type: string, fn: () => void) => {
      video.addEventListener(type, fn);
      this.cleanup.push(() => video.removeEventListener(type, fn));
    };
    on("timeupdate", () => {
      const t = video.currentTime;
      if (this.lastTime !== null && !video.paused) {
        const d = t - this.lastTime;
        if (d > 0 && d < MAX_TICK_SECONDS) this.playedSeconds += d;
      }
      this.lastTime = t;
      if (this.ttffMs === null && t > 0 && !video.paused) {
        this.ttffMs = now() - this.startedAt;
        this.onFirstFrame();
      }
    });
    on("waiting", () => {
      // Buffering before the first frame is startup, not a stall.
      if (this.ttffMs !== null) this.stalls++;
    });
    on("seeking", () => {
      this.lastTime = null;
    });
  }

  /** Seconds buffered ahead of the playhead. */
  bufferSeconds(): number {
    const v = this.video;
    if (v.buffered.length === 0) return 0;
    return Math.max(0, v.buffered.end(v.buffered.length - 1) - v.currentTime);
  }

  dispose(): void {
    for (const fn of this.cleanup) fn();
    this.cleanup.length = 0;
  }
}

/** The data meter's numbers (ADR 0018): bytes this session and the recent rate. */
export interface DataUsage {
  bytes: number;
  /** MB (10^6 bytes) an hour over the meter's window; 0 until it has a few seconds of data. */
  mbPerHour: number;
}

/** A rate needs at least this much time between its first and last sample. */
const MIN_RATE_SPAN_MS = 5_000;

/**
 * The data-usage meter: samples a cumulative byte count and reports the rate over the last
 * `windowMs`. `restart()` forgets the rate (not the bytes) when the budget changes, so the rate
 * shows the new mode and not the old one.
 */
export class DataUsageMeter {
  private samples: { at: number; bytes: number }[] = [];
  private last = 0;

  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly windowMs = 120_000,
  ) {}

  /** Record the cumulative byte count now. Counts never go down. */
  sample(bytes: number): DataUsage {
    const b = Number.isFinite(bytes) ? Math.max(this.last, Math.round(bytes)) : this.last;
    this.last = b;
    const at = this.now();
    this.samples.push({ at, bytes: b });
    // Keep one sample at or before the window's start so the rate covers the whole window.
    while (this.samples.length > 2 && (this.samples[1]?.at ?? at) <= at - this.windowMs) this.samples.shift();
    return this.usage();
  }

  usage(): DataUsage {
    const first = this.samples[0];
    const last = this.samples.at(-1);
    if (!first || !last || last.at - first.at < MIN_RATE_SPAN_MS) return { bytes: this.last, mbPerHour: 0 };
    const perSecond = (last.bytes - first.bytes) / ((last.at - first.at) / 1000);
    return { bytes: this.last, mbPerHour: (perSecond * 3600) / 1_000_000 };
  }

  restart(): void {
    this.samples = [];
  }
}

/**
 * Media bytes a native-HLS element has decoded (WebKit's `webkit{Audio,Video}DecodedByteCount`),
 * the closest a page gets to what AVFoundation downloaded: its requests are invisible to the page.
 * Null where the browser does not expose them. Playlists are not included.
 */
export function nativeMediaBytes(video: HTMLVideoElement): number | null {
  const v = video as HTMLVideoElement & { webkitAudioDecodedByteCount?: number; webkitVideoDecodedByteCount?: number };
  const audio = v.webkitAudioDecodedByteCount;
  const vid = v.webkitVideoDecodedByteCount;
  if (typeof audio !== "number" && typeof vid !== "number") return null;
  return (Number.isFinite(audio) ? (audio ?? 0) : 0) + (Number.isFinite(vid) ? (vid ?? 0) : 0);
}

/** Coarse capability signals for the integrity checks; no persistent identifiers (see contract). */
export function collectFingerprint(nativeHls: boolean): Record<string, string | number | boolean | null> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    webdriver: nav.webdriver === true,
    headless: /Headless/i.test(nav.userAgent),
    platform: nav.platform.slice(0, 200),
    languages: nav.languages?.length ?? 0,
    plugins: nav.plugins?.length ?? 0,
    hardwareConcurrency: nav.hardwareConcurrency ?? null,
    deviceMemory: nav.deviceMemory ?? null,
    screenWidth: screen.width,
    screenHeight: screen.height,
    colorDepth: screen.colorDepth,
    touchPoints: nav.maxTouchPoints ?? 0,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    nativeHls,
  };
}

/** A random device id for this tab (contract: 16–64 chars), kept for the session only. */
export function sessionDeviceId(): string {
  const key = "commonair-device";
  try {
    const existing = sessionStorage.getItem(key);
    if (existing && existing.length >= 16) return existing;
    const id = crypto.randomUUID().replaceAll("-", "");
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    return crypto.randomUUID().replaceAll("-", "");
  }
}
