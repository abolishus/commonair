// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Continue watching, the writer side (overhaul wave 2, D3.6): the video page saves where the viewer
 * is to `lib/resume.ts` (this browser only) at most every `RESUME_SAVE_MS` while playing, and at
 * once on pause, when the tab is hidden, on unload and when the page goes away. On return it offers
 * "Resume from m:ss" unless the link already says where to start (`?t=`).
 */
import * as React from "react";
import {
  RESUME_END_MARGIN_SECONDS,
  RESUME_MIN_SECONDS,
  resumePositionFor,
  saveResumePoint,
  type ResumePoint,
} from "../../lib/resume.ts";
import type { PlayerProgress } from "./vod-player.tsx";

/** How often a playing video's position is saved. */
export const RESUME_SAVE_MS = 10_000;

/** The video as a resume point needs it. */
export interface ResumeVideo {
  vodId: string;
  channelSlug: string;
  title: string;
  thumbnailUrl: string | null;
  durationSeconds: number;
}

type Store = Parameters<typeof saveResumePoint>[1];

export function resumePoint(video: ResumeVideo, progress: PlayerProgress, now: Date): ResumePoint {
  const duration = progress.durationSeconds > 0 ? progress.durationSeconds : video.durationSeconds;
  return {
    vodId: video.vodId,
    channelSlug: video.channelSlug,
    title: video.title,
    thumbnailUrl: video.thumbnailUrl,
    positionSeconds: Math.max(0, Math.floor(progress.positionSeconds)),
    durationSeconds: Math.max(0, Math.floor(duration)),
    updatedAt: now.toISOString(),
  };
}

/** Whether a progress report is saved now: a pause always, playing only once per `RESUME_SAVE_MS`. */
export function saveDue(lastSavedAt: number | null, now: number, paused: boolean): boolean {
  return paused || lastSavedAt === null || now - lastSavedAt >= RESUME_SAVE_MS;
}

/**
 * Where to offer resuming this video: its stored position, unless the link carries `?t=` or the
 * position is too near either end to be worth it. Null for no offer.
 */
export function resumeOffer(
  vodId: string,
  startAt: number | null,
  durationSeconds: number,
  store?: Store,
): number | null {
  if (startAt !== null) return null;
  const at = resumePositionFor(vodId, store);
  if (at === null || at < RESUME_MIN_SECONDS) return null;
  if (durationSeconds > 0 && at > durationSeconds - RESUME_END_MARGIN_SECONDS) return null;
  return Math.floor(at);
}

/**
 * The page's writer: returns the player's `onProgress`. Null `video` (not playable yet) writes
 * nothing. `store` and `now` are for tests.
 */
export function useResumeWriter(
  video: ResumeVideo | null,
  opts: { store?: Store; now?: () => number } = {},
): (progress: PlayerProgress) => void {
  const latest = React.useRef<PlayerProgress | null>(null);
  const lastSaved = React.useRef<number | null>(null);
  const videoRef = React.useRef(video);
  const optsRef = React.useRef(opts);
  React.useEffect(() => {
    videoRef.current = video;
    optsRef.current = opts;
  });

  const flush = React.useCallback(() => {
    const v = videoRef.current;
    const p = latest.current;
    // Near the start says nothing yet: the page loads at 0:00 before "Resume from" is pressed, and
    // writing that would clear the point being offered.
    if (!v || !p || p.positionSeconds < RESUME_MIN_SECONDS) return;
    const now = optsRef.current.now?.() ?? Date.now();
    lastSaved.current = now;
    saveResumePoint(resumePoint(v, p, new Date(now)), optsRef.current.store);
  }, []);

  const vodId = video?.vodId ?? null;
  React.useEffect(() => {
    if (vodId === null) return;
    const onHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
      // Leaving the page inside the app (another video, the channel) saves too.
      flush();
      latest.current = null;
      lastSaved.current = null;
    };
  }, [vodId, flush]);

  return React.useCallback(
    (progress: PlayerProgress) => {
      latest.current = progress;
      const now = optsRef.current.now?.() ?? Date.now();
      if (saveDue(lastSaved.current, now, progress.paused)) flush();
    },
    [flush],
  );
}
