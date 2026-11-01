// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Where the VOD or clip playhead is on the wall clock, the clock chat replay places lines on (ADR
 * 0012 amendment 1). VOD playlists carry `EXT-X-PROGRAM-DATE-TIME` on every segment (W1-spine), so
 * hls.js knows the PDT under the playhead (`playingDate`) and native HLS exposes the playlist's
 * start (`getStartDate()`). A clip is an MP4 with no clock of its own: its media time 0 is the
 * start of the window it was cut from (`Clip.windowStartedAt`, as `clips.chat` places it).
 *
 * Every function is pure over small structural views of hls.js and the video element, so the
 * mapping is tested without either.
 */

/** The part of a `<video>` the mapping reads. */
export interface VideoClock {
  readyState: number;
  currentTime: number;
  duration: number;
  getStartDate?: () => Date;
}

/** The part of an hls.js instance the mapping reads. */
export interface HlsClock {
  playingDate: Date | null;
  currentLevel: number;
  levels: readonly { details?: { fragments: readonly { programDateTime: number | null; start: number }[] } }[];
}

const finite = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

/** HAVE_METADATA: before it `currentTime` is 0 whatever the media says. */
const HAVE_METADATA = 1;

/**
 * The wall clock (epoch ms) at media time 0, or null while unknown. hls.js: the first fragment
 * with a PDT of the playing level (else any loaded level), less its media start; native HLS:
 * `getStartDate()`; a clip: its window start.
 */
export function hlsOrigin(hls: HlsClock): number | null {
  const levels = hls.levels;
  const level = levels[hls.currentLevel]?.details ? levels[hls.currentLevel] : levels.find((l) => l.details);
  for (const f of level?.details?.fragments ?? []) {
    if (finite(f.programDateTime) && finite(f.start)) return f.programDateTime - f.start * 1000;
  }
  return null;
}

export function nativeOrigin(video: VideoClock): number | null {
  if (video.readyState < HAVE_METADATA) return null;
  const start = video.getStartDate?.().getTime();
  return finite(start) ? start : null;
}

export function clipOrigin(windowStartedAt: string | null): number | null {
  if (windowStartedAt === null) return null;
  const ms = Date.parse(windowStartedAt);
  return Number.isFinite(ms) ? ms : null;
}

/** The PDT under the playhead with hls.js; null before the first frame. */
export function hlsWallclock(hls: HlsClock): Date | null {
  const at = hls.playingDate?.getTime();
  return finite(at) ? new Date(at) : null;
}

/** Native HLS, or a clip: the origin plus `currentTime`; null before the metadata. */
export function originWallclock(video: VideoClock, origin: number | null): Date | null {
  if (origin === null || video.readyState < HAVE_METADATA || !finite(video.currentTime)) return null;
  return new Date(origin + video.currentTime * 1000);
}

/**
 * The media time (seconds) at wall clock `t`, or null when the origin is unknown or `t` is outside
 * the media (`[0, duration]`; an unknown duration accepts anything from 0 on).
 */
export function mediaTimeAt(origin: number | null, duration: number, t: Date): number | null {
  const at = t.getTime();
  if (origin === null || !Number.isFinite(at)) return null;
  const s = (at - origin) / 1000;
  if (s < 0) return null;
  if (Number.isFinite(duration) && duration > 0 && s > duration) return null;
  return s;
}
