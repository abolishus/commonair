// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Minimal HLS media-playlist model for fMP4 recordings: enough to read what ffmpeg writes and
 * to write the VOD playlist we publish (several recorder runs joined with discontinuities, each
 * segment stamped with its wall-clock start so clips can be located by broadcast time).
 */
export interface PlaylistSegment {
  uri: string;
  durationSeconds: number;
  /** Wall-clock start of the segment, from EXT-X-PROGRAM-DATE-TIME. */
  startedAt: Date | null;
  /** EXT-X-MAP initialization segment in effect for this segment. */
  map: string | null;
}

export interface MediaPlaylist {
  segments: PlaylistSegment[];
  ended: boolean;
}

export function parsePlaylist(text: string): MediaPlaylist {
  const segments: PlaylistSegment[] = [];
  let map: string | null = null;
  let duration: number | null = null;
  let pdt: Date | null = null;
  let ended = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-MAP:")) {
      map = /URI="([^"]+)"/.exec(line)?.[1] ?? null;
    } else if (line.startsWith("#EXTINF:")) {
      const d = Number.parseFloat(line.slice(8));
      duration = Number.isFinite(d) ? d : null;
    } else if (line.startsWith("#EXT-X-PROGRAM-DATE-TIME:")) {
      const t = new Date(line.slice(25));
      pdt = Number.isNaN(t.getTime()) ? null : t;
    } else if (line === "#EXT-X-ENDLIST") {
      ended = true;
    } else if (!line.startsWith("#")) {
      if (duration !== null) segments.push({ uri: line, durationSeconds: duration, startedAt: pdt, map });
      duration = null;
      pdt = null;
    }
  }
  return { segments, ended };
}

const fmtDuration = (d: number) => d.toFixed(6);

export function renderPlaylist(segments: readonly PlaylistSegment[], opts: { ended: boolean }): string {
  const target = Math.max(1, Math.ceil(Math.max(0, ...segments.map((s) => s.durationSeconds))));
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    `#EXT-X-TARGETDURATION:${target}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    `#EXT-X-PLAYLIST-TYPE:${opts.ended ? "VOD" : "EVENT"}`,
    "#EXT-X-INDEPENDENT-SEGMENTS",
  ];
  let map: string | null | undefined;
  for (const s of segments) {
    if (s.map !== map) {
      // A new recorder run has its own init segment and timestamps: players must reset.
      if (map !== undefined) lines.push("#EXT-X-DISCONTINUITY");
      if (s.map) lines.push(`#EXT-X-MAP:URI="${s.map}"`);
      map = s.map;
    }
    if (s.startedAt) lines.push(`#EXT-X-PROGRAM-DATE-TIME:${s.startedAt.toISOString()}`);
    lines.push(`#EXTINF:${fmtDuration(s.durationSeconds)},`, s.uri);
  }
  if (opts.ended) lines.push("#EXT-X-ENDLIST");
  return `${lines.join("\n")}\n`;
}

export const totalDuration = (segments: readonly PlaylistSegment[]) =>
  Math.round(segments.reduce((sum, s) => sum + s.durationSeconds, 0) * 1000) / 1000;

export interface SegmentWindow {
  /** Segments that overlap the window, all sharing one init segment. */
  segments: PlaylistSegment[];
  /** Offset of the window start from the start of the first returned segment. */
  offsetSeconds: number;
  /** Window length available in those segments (may be shorter than asked at the live edge). */
  durationSeconds: number;
}

/**
 * Segments covering [start, start+duration) by wall-clock time. If the window spans recorder
 * runs (different init segments) only the run containing the start is used, so the result can
 * be concatenated into one MP4.
 */
export function findWindow(
  segments: readonly PlaylistSegment[],
  start: Date,
  durationSeconds: number,
): SegmentWindow | null {
  const startMs = start.getTime();
  const endMs = startMs + durationSeconds * 1000;
  const timed = segments.filter((s): s is PlaylistSegment & { startedAt: Date } => s.startedAt !== null);
  const overlapping = timed.filter((s) => {
    const sStart = s.startedAt.getTime();
    return sStart < endMs && sStart + s.durationSeconds * 1000 > startMs;
  });
  const first = overlapping[0];
  if (!first) return null;
  const sameRun = overlapping.filter((s) => s.map === first.map);
  const last = sameRun[sameRun.length - 1] ?? first;
  const firstStart = first.startedAt.getTime();
  const availableEnd = last.startedAt.getTime() + last.durationSeconds * 1000;
  const offsetMs = Math.max(0, startMs - firstStart);
  const lengthMs = Math.min(endMs, availableEnd) - (firstStart + offsetMs);
  if (lengthMs <= 0) return null;
  return { segments: sameRun, offsetSeconds: offsetMs / 1000, durationSeconds: lengthMs / 1000 };
}
