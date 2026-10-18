// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Measurement probe injected into every page a browser viewer opens (Playwright `addInitScript`),
 * so the same numbers come from the harness player page and from the real web app's embed route.
 * It watches every <video>: time to first frame, stalls, played time, and glass-to-glass latency
 * decoded from the timestamp strip once a second via canvas `drawImage`.
 *
 * Players may annotate a video with `data-harness-id` and `data-harness-start` (performance.now()
 * when playback was requested) and publish byte counters in `window.__harnessBytes[id]`.
 */
import { decodeStrip, rgbaSource, stripHeight } from "../src/timestamp-strip.ts";

export interface ProbeVideoStats {
  id: string;
  /** performance.now() when playback was requested (or the element started loading). */
  startedAt: number | null;
  ttffMs: number | null;
  stalls: number;
  stallMs: number;
  playedSeconds: number;
  latencyMs: number[];
  width: number;
  height: number;
  currentTime: number;
  bytesHttp: number;
  bytesP2p: number;
  errors: string[];
}

interface Tracked {
  video: HTMLVideoElement;
  stats: ProbeVideoStats;
  firstFrameAt: number | null;
  stallStartedAt: number | null;
  lastTime: number;
}

declare global {
  interface Window {
    __harnessProbe?: { snapshot(): ProbeVideoStats[] };
    __harnessBytes?: Record<string, { http: number; p2p: number }>;
  }
}

const SAMPLE_INTERVAL_MS = 1_000;
const MAX_SAMPLES = 600;
const CANVAS_MAX_WIDTH = 480;

function install(): void {
  if (window.__harnessProbe) return;
  const tracked = new Map<HTMLVideoElement, Tracked>();
  let counter = 0;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const startOf = (t: Tracked): number | null => {
    const fromPlayer = Number(t.video.dataset.harnessStart);
    return Number.isFinite(fromPlayer) && fromPlayer > 0 ? fromPlayer : t.stats.startedAt;
  };

  const markFirstFrame = (t: Tracked) => {
    if (t.firstFrameAt !== null) return;
    t.firstFrameAt = performance.now();
    const start = startOf(t);
    t.stats.ttffMs = start === null ? null : Math.round(t.firstFrameAt - start);
  };

  const track = (video: HTMLVideoElement) => {
    if (tracked.has(video)) return;
    const t: Tracked = {
      video,
      stats: {
        id: video.dataset.harnessId ?? `v${counter++}`,
        startedAt: null,
        ttffMs: null,
        stalls: 0,
        stallMs: 0,
        playedSeconds: 0,
        latencyMs: [],
        width: 0,
        height: 0,
        currentTime: 0,
        bytesHttp: 0,
        bytesP2p: 0,
        errors: [],
      },
      firstFrameAt: null,
      stallStartedAt: null,
      lastTime: 0,
    };
    tracked.set(video, t);
    video.addEventListener("loadstart", () => {
      t.stats.startedAt ??= performance.now();
    });
    if ("requestVideoFrameCallback" in video) {
      video.requestVideoFrameCallback(() => markFirstFrame(t));
    }
    video.addEventListener("playing", () => {
      markFirstFrame(t);
      if (t.stallStartedAt !== null) {
        t.stats.stallMs += performance.now() - t.stallStartedAt;
        t.stallStartedAt = null;
      }
    });
    video.addEventListener("waiting", () => {
      // Waiting before the first frame is startup, not a stall.
      if (t.firstFrameAt === null || t.stallStartedAt !== null) return;
      t.stats.stalls++;
      t.stallStartedAt = performance.now();
    });
    video.addEventListener("timeupdate", () => {
      const delta = video.currentTime - t.lastTime;
      // Ignore seeks and live-edge jumps; only count continuous playback.
      if (delta > 0 && delta < 5) t.stats.playedSeconds += delta;
      t.lastTime = video.currentTime;
    });
    video.addEventListener("error", () => {
      t.stats.errors.push(`media error ${video.error?.code ?? "?"}: ${video.error?.message ?? ""}`.trim());
    });
  };

  const scan = (root: ParentNode) => {
    for (const v of root.querySelectorAll("video")) track(v);
  };

  const sampleLatency = () => {
    if (!ctx) return;
    for (const t of tracked.values()) {
      const v = t.video;
      t.stats.width = v.videoWidth;
      t.stats.height = v.videoHeight;
      t.stats.currentTime = v.currentTime;
      if (v.readyState < 2 || v.videoWidth === 0 || v.paused) continue;
      const w = Math.min(v.videoWidth, CANVAS_MAX_WIDTH);
      const h = Math.round((v.videoHeight * w) / v.videoWidth);
      const rows = Math.min(h, stripHeight(h) + 2);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== rows) canvas.height = rows;
      try {
        // Draw the full frame scaled to w×h; only the strip rows land on the canvas.
        ctx.drawImage(v, 0, 0, w, h);
        const pixels = ctx.getImageData(0, 0, w, rows).data;
        const captured = decodeStrip(rgbaSource(pixels, w, h));
        if (captured !== null) {
          t.stats.latencyMs.push(Math.max(0, Date.now() - captured));
          if (t.stats.latencyMs.length > MAX_SAMPLES) t.stats.latencyMs.shift();
        }
      } catch (err) {
        const msg = `latency sampling failed: ${(err as Error).name}`;
        if (!t.stats.errors.includes(msg)) t.stats.errors.push(msg);
      }
    }
  };

  window.__harnessProbe = {
    snapshot() {
      const now = performance.now();
      return [...tracked.values()].map((t) => {
        const bytes = window.__harnessBytes?.[t.stats.id];
        return {
          ...t.stats,
          startedAt: startOf(t),
          stallMs: Math.round(t.stats.stallMs + (t.stallStartedAt === null ? 0 : now - t.stallStartedAt)),
          latencyMs: [...t.stats.latencyMs],
          bytesHttp: bytes?.http ?? 0,
          bytesP2p: bytes?.p2p ?? 0,
          errors: [...t.stats.errors],
        };
      });
    },
  };

  const start = () => {
    scan(document);
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node instanceof HTMLVideoElement) track(node);
          else if (node instanceof Element) scan(node);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(sampleLatency, SAMPLE_INTERVAL_MS);
  };
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
}

install();
