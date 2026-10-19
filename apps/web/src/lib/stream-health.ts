// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Dashboard "Stream health": which state the card is in, the latest sample's warnings, and the
 * message for each warning code services/media emits.
 */
import type { StreamHealth } from "@commonair/contracts/dto";
import { HEALTH_WARNING_CODES, type HealthWarningCode } from "@commonair/contracts/enums";
import type { z } from "zod";
import { t, type MessageKey } from "../i18n/index.ts";

export type StreamHealthDto = z.infer<typeof StreamHealth>;

export { HEALTH_WARNING_CODES, type HealthWarningCode };

interface WarningKeys {
  title: MessageKey;
  hint: MessageKey;
}

export const HEALTH_WARNING_KEYS: Record<HealthWarningCode, WarningKeys> = {
  bitrate_high: { title: "health.bitrateHigh.title", hint: "health.bitrateHigh.hint" },
  bitrate_low: { title: "health.bitrateLow.title", hint: "health.bitrateLow.hint" },
  keyframe_interval: { title: "health.keyframeInterval.title", hint: "health.keyframeInterval.hint" },
  fps_drop: { title: "health.fpsDrop.title", hint: "health.fpsDrop.hint" },
  b_frames_webrtc: { title: "health.bFramesWebrtc.title", hint: "health.bFramesWebrtc.hint" },
  audio_missing: { title: "health.audioMissing.title", hint: "health.audioMissing.hint" },
  video_missing: { title: "health.videoMissing.title", hint: "health.videoMissing.hint" },
  video_codec_unsupported: { title: "health.videoCodec.title", hint: "health.videoCodec.hint" },
  audio_codec_unsupported: { title: "health.audioCodec.title", hint: "health.audioCodec.hint" },
  transcode_capacity: { title: "health.transcodeCapacity.title", hint: "health.transcodeCapacity.hint" },
  recording_disk_budget: { title: "health.recordingDiskBudget.title", hint: "health.recordingDiskBudget.hint" },
};

export interface WarningMessage {
  title: string;
  hint: string;
}

/** Translated title and fix hint; a code this build does not know gets a generic message. */
export function warningMessage(code: string): WarningMessage {
  const keys = Object.hasOwn(HEALTH_WARNING_KEYS, code)
    ? (HEALTH_WARNING_KEYS as Record<string, WarningKeys>)[code]
    : undefined;
  if (!keys) return { title: t("health.unknown.title"), hint: t("health.unknown.hint", { code }) };
  return { title: t(keys.title), hint: t(keys.hint) };
}

export type HealthState = "offline" | "healthy" | "warning";

/** Warnings of the newest sample while live (deduplicated, in emitted order); none otherwise. */
export function latestWarnings(health: Pick<StreamHealthDto, "live" | "samples">): string[] {
  if (!health.live) return [];
  let latest: StreamHealthDto["samples"][number] | undefined;
  // The API sorts oldest first, but do not rely on it.
  for (const s of health.samples) if (!latest || Date.parse(s.at) >= Date.parse(latest.at)) latest = s;
  return [...new Set(latest?.warnings ?? [])];
}

export function healthState(health: Pick<StreamHealthDto, "live" | "samples">): HealthState {
  if (!health.live) return "offline";
  return latestWarnings(health).length > 0 ? "warning" : "healthy";
}

export const HEALTH_POLL_MS = 10_000;

/** What the poller needs from the page; `document` and the global timers in the browser. */
export interface PollEnv {
  isVisible(): boolean;
  onVisibilityChange(listener: () => void): () => void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export function browserPollEnv(): PollEnv {
  return {
    isVisible: () => document.visibilityState === "visible",
    onVisibilityChange: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (handle) => window.clearInterval(handle as number),
  };
}

/**
 * Run `tick` now (if visible) and every `intervalMs` while the page is visible. Hidden tabs stop
 * polling; becoming visible again runs `tick` at once and restarts the interval. Returns a stop
 * function.
 */
export function pollWhileVisible(tick: () => void, intervalMs: number, env: PollEnv): () => void {
  let handle: unknown = null;
  const stopTimer = () => {
    if (handle !== null) env.clearInterval(handle);
    handle = null;
  };
  const sync = () => {
    if (env.isVisible()) {
      if (handle !== null) return;
      tick();
      handle = env.setInterval(tick, intervalMs);
    } else stopTimer();
  };
  const unlisten = env.onVisibilityChange(sync);
  sync();
  return () => {
    unlisten();
    stopTimer();
  };
}
