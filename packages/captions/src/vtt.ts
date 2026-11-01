// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * WebVTT for captions (ADR 0011): the live subtitle playlist and its segments (served by the
 * origin from the cues in Valkey) and the VOD track (stitched by media at the end, rewritten by
 * the API when a creator corrects it). Pure string functions.
 */
import type { Cue } from "./cues.ts";

/** Live subtitle segments are as long as the worker's chunks, so a chunk lands in one segment. */
export const SEGMENT_MS = 3_000;
/**
 * How far behind live a captions-on player holds its playhead (seconds): the web player's
 * `setTargetLatency` (`apps/web/src/player/captions-state.ts` keeps the same value). A segment
 * must be listed before then to be on time; the harness gates on it.
 */
export const CAPTIONS_LATENCY_SECONDS = 9;
/** Segments a live subtitle playlist lists (two minutes): what a player at 8–10 s latency needs, and then some. */
export const LIVE_WINDOW_SEGMENTS = 40;
/**
 * MediaMTX's LL-HLS muxer writes `tfdt` as the source's SRT timeline plus 10 s
 * (`services/media/src/clock/README.md`, "Variant A2"); the source rendition's media timestamps
 * are on that clock, so `X-TIMESTAMP-MAP` maps cue time 0 (W0) to 10 s of MPEG-TS time.
 */
export const MEDIAMTX_TIMELINE_OFFSET_S = 10;
const MPEGTS_HZ = 90_000;
const MPEGTS_WRAP = 2 ** 33;

/** `HH:MM:SS.mmm` (hours at least two digits; a long broadcast's LOCAL times pass 99 h only after 4 days). */
export function vttTimestamp(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3_600_000);
  const m = Math.floor((t % 3_600_000) / 60_000);
  const s = Math.floor((t % 60_000) / 1000);
  const frac = t % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(frac, 3)}`;
}

/** Parse `HH:MM:SS.mmm` or `MM:SS.mmm`; null when malformed. */
export function parseVttTimestamp(s: string): number | null {
  const m = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 3_600_000 + Number(m[2]) * 60_000 + Number(m[3]) * 1000 + Number(m[4]);
}

/** Cue text safe for a WebVTT payload: one line, markup escaped (so `-->` cannot appear either). */
export function escapeCueText(text: string): string {
  return text.replace(/\s+/gu, " ").trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function unescapeCueText(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------------------------------
// Live

/** The live track the origin serves: what the worker publishes in Valkey (`CAPTIONS_KEYS.live`). */
export interface LiveTrack {
  language: string;
  /** W0: the wall clock of the source timeline's PTS 0 (ADR 0012), epoch ms. */
  w0Ms: number;
  /** PDT where segment 0 starts: the first chunk's start. */
  anchorMs: number;
  /** Transcribed up to here (the end of the newest finished chunk), epoch ms. */
  throughMs: number;
}

/** Index of the segment holding `pdtMs`. */
export const segmentIndexAt = (track: Pick<LiveTrack, "anchorMs">, pdtMs: number): number =>
  Math.floor((pdtMs - track.anchorMs) / SEGMENT_MS);

/** `[start, end)` of segment `n`, epoch ms. */
export const segmentBounds = (track: Pick<LiveTrack, "anchorMs">, n: number): [number, number] => [
  track.anchorMs + n * SEGMENT_MS,
  track.anchorMs + (n + 1) * SEGMENT_MS,
];

/** Segments that are complete (transcribed to their end): `[first, last]`, or null when none is. */
export function completeSegments(track: LiveTrack, window = LIVE_WINDOW_SEGMENTS): [number, number] | null {
  const last = Math.floor((track.throughMs - track.anchorMs) / SEGMENT_MS) - 1;
  if (last < 0) return null;
  return [Math.max(0, last - window + 1), last];
}

/**
 * The file name of live segment `n`: unique per track (the anchor is the track's first chunk
 * start, epoch ms), because relays cache `.vtt` files as immutable media, and segment numbers
 * restart at 0 on a channel's next broadcast under the same path.
 */
export const liveSegmentName = (track: Pick<LiveTrack, "anchorMs">, n: number): string => `${track.anchorMs}-${n}.vtt`;

/** The segment number a live segment file name names for this track; null for another track's or a malformed name. */
export function parseLiveSegmentName(track: Pick<LiveTrack, "anchorMs">, file: string): number | null {
  const m = /^(\d{1,16})-(\d{1,9})\.vtt$/.exec(file);
  if (!m || Number(m[1]) !== track.anchorMs) return null;
  return Number(m[2]);
}

/**
 * The live subtitle playlist: every complete segment in the window, each with its
 * `EXT-X-PROGRAM-DATE-TIME`, so players can place it against the video's PDT. `uri(n)` names
 * segment `n` (the origin adds the viewer's token).
 */
export function liveSubtitlePlaylist(track: LiveTrack, uri: (n: number) => string): string {
  // A plain live playlist (no PLAYLIST-TYPE): old segments leave the window.
  const out = ["#EXTM3U", "#EXT-X-VERSION:6", `#EXT-X-TARGETDURATION:${Math.ceil(SEGMENT_MS / 1000)}`];
  const range = completeSegments(track);
  out.push(`#EXT-X-MEDIA-SEQUENCE:${range ? range[0] : 0}`);
  if (range)
    for (let n = range[0]; n <= range[1]; n++) {
      const [start] = segmentBounds(track, n);
      out.push(`#EXT-X-PROGRAM-DATE-TIME:${new Date(start).toISOString()}`);
      out.push(`#EXTINF:${(SEGMENT_MS / 1000).toFixed(3)},`);
      out.push(uri(n));
    }
  return `${out.join("\n")}\n`;
}

/** `X-TIMESTAMP-MAP` value: LOCAL 0 is W0, on MediaMTX's source timeline (MPEG-TS 90 kHz, wrapped). */
export const timestampMap = (): string =>
  `X-TIMESTAMP-MAP=MPEGTS:${(MEDIAMTX_TIMELINE_OFFSET_S * MPEGTS_HZ) % MPEGTS_WRAP},LOCAL:00:00:00.000`;

/**
 * Live segment `n`: the cues that overlap it, timed from W0 (`X-TIMESTAMP-MAP`). A cue that
 * crosses a segment edge is listed in both; players de-duplicate identical cues.
 */
export function liveVttSegment(track: LiveTrack, n: number, cues: readonly Cue[]): string {
  const [start, end] = segmentBounds(track, n);
  const lines = ["WEBVTT", timestampMap(), ""];
  for (const c of cues) {
    if (c.endMs <= start || c.startMs >= end) continue;
    lines.push(`${vttTimestamp(c.startMs - track.w0Ms)} --> ${vttTimestamp(c.endMs - track.w0Ms)}`);
    lines.push(escapeCueText(c.text), "");
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------
// VOD

/** A VOD track cue: milliseconds from the VOD's first frame. */
export interface VodCue {
  startMs: number;
  endMs: number;
  text: string;
}

/** The `NOTE` line that records the broadcast-clock instant of the VOD's time 0 (round-tripped on edit). */
const ORIGIN_NOTE = "NOTE commonair-origin ";

export interface VodTrack {
  /** Epoch ms of the VOD's time 0 on the broadcast clock, when known. */
  originMs: number | null;
  cues: VodCue[];
}

/** Live cues moved onto the VOD's own clock (0 = `originMs`); cues before it are clipped or dropped. */
export function toVodCues(cues: readonly Cue[], originMs: number): VodCue[] {
  const out: VodCue[] = [];
  for (const c of cues) {
    const startMs = Math.max(0, c.startMs - originMs);
    const endMs = c.endMs - originMs;
    if (endMs <= startMs || c.text === "") continue;
    out.push({ startMs, endMs, text: c.text });
  }
  return out;
}

export function vodVttDocument(track: VodTrack): string {
  const lines = ["WEBVTT", ""];
  if (track.originMs !== null) lines.push(`${ORIGIN_NOTE}${new Date(track.originMs).toISOString()}`, "");
  for (const c of track.cues) {
    lines.push(`${vttTimestamp(c.startMs)} --> ${vttTimestamp(c.endMs)}`, escapeCueText(c.text), "");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Parse a WebVTT document (ours, or any simple one): cue identifiers, settings and `NOTE`/`STYLE`
 * blocks are skipped, multi-line payloads are joined with a space. Null when it is not WebVTT.
 */
export function parseVtt(text: string): VodTrack | null {
  const src = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!/^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(src)) return null;
  const blocks = src.split(/\n{2,}/).slice(1);
  let originMs: number | null = null;
  const cues: VodCue[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").filter((l) => l !== "");
    if (lines.length === 0) continue;
    const head = lines[0] ?? "";
    if (head.startsWith(ORIGIN_NOTE)) {
      const t = Date.parse(head.slice(ORIGIN_NOTE.length).trim());
      originMs = Number.isFinite(t) ? t : null;
      continue;
    }
    if (head.startsWith("NOTE") || head.startsWith("STYLE") || head.startsWith("REGION")) continue;
    const timingAt = lines.findIndex((l) => l.includes("-->"));
    if (timingAt < 0) continue;
    const [from = "", rest = ""] = (lines[timingAt] ?? "").split("-->");
    const startMs = parseVttTimestamp(from);
    const endMs = parseVttTimestamp(rest.trim().split(/\s+/)[0] ?? "");
    if (startMs === null || endMs === null || endMs < startMs) continue;
    cues.push({ startMs, endMs, text: unescapeCueText(lines.slice(timingAt + 1).join(" ")).trim() });
  }
  return { originMs, cues };
}
