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
