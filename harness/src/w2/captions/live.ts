// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What the `captions` scenario reads off the live stream (ADR 0011): the SUBTITLES group in the
 * multivariant playlist, and a follower of the subtitle playlist that records when each segment
 * first appears and which cues it carries. Pure parsing here; `index.ts` does the I/O.
 */
import { parseVtt } from "@commonair/captions";
import { parsePlaylist } from "../../hls.ts";

export interface SubtitleAdvert {
  /** The group's `URI`, relative to the multivariant playlist. */
  uri: string;
  language: string | null;
  groupId: string;
  isDefault: boolean;
  autoselect: boolean;
  /** Every `EXT-X-STREAM-INF` names the group. */
  onEveryVariant: boolean;
  variants: number;
}

const attrOf = (line: string, name: string): string | null => {
  const m = new RegExp(`(?:^|[:,])${name}=("([^"]*)"|[^,]*)`).exec(line);
  if (!m) return null;
  return m[2] ?? m[1] ?? null;
};

/** The first SUBTITLES rendition of a multivariant playlist, or null when it has none. */
export function subtitleAdvert(multivariant: string): SubtitleAdvert | null {
  const lines = multivariant.split(/\r?\n/).map((l) => l.trim());
  const media = lines.find((l) => l.startsWith("#EXT-X-MEDIA:") && attrOf(l, "TYPE") === "SUBTITLES");
  if (!media) return null;
  const groupId = attrOf(media, "GROUP-ID") ?? "";
  const infs = lines.filter((l) => l.startsWith("#EXT-X-STREAM-INF:"));
  return {
    uri: attrOf(media, "URI") ?? "",
    language: attrOf(media, "LANGUAGE"),
    groupId,
    isDefault: attrOf(media, "DEFAULT") === "YES",
    autoselect: attrOf(media, "AUTOSELECT") === "YES",
    onEveryVariant: infs.length > 0 && infs.every((l) => attrOf(l, "SUBTITLES") === groupId),
    variants: infs.length,
  };
}

/** One cue as the follower saw it: its text, and the PDT window of the segment it came in. */
export interface SeenCue {
  text: string;
  /** Cue start in the segment's LOCAL time (ms); identical cues across segments share it. */
  localStartMs: number;
  localEndMs: number;
}

export interface SeenSegment {
  sequence: number;
  /** EXT-X-PROGRAM-DATE-TIME of the segment start, epoch ms. */
  pdtMs: number;
  /** When the follower first saw the segment listed (harness clock, epoch ms). */
  firstSeenAt: number;
  cues: SeenCue[];
}

/** New segments of a subtitle media playlist (by media sequence), with their PDT. */
export function listedSegments(playlist: string): { sequence: number; uri: string; pdtMs: number | null }[] {
  const p = parsePlaylist(playlist);
  if (p.kind !== "media") return [];
  return p.segments.map((s) => ({ sequence: s.sequence, uri: s.uri, pdtMs: s.programDateTime }));
}

/** The cues of one WebVTT segment. */
export function segmentCues(vtt: string): SeenCue[] {
  return (parseVtt(vtt)?.cues ?? []).map((c) => ({ text: c.text, localStartMs: c.startMs, localEndMs: c.endMs }));
}

/** Every distinct cue in time order (a cue that crosses a segment edge is listed in both segments). */
export function distinctCues(segments: readonly SeenSegment[]): SeenCue[] {
  const seen = new Map<string, SeenCue>();
  for (const s of segments) for (const c of s.cues) seen.set(`${c.localStartMs}|${c.localEndMs}|${c.text}`, c);
  return [...seen.values()].sort((a, b) => a.localStartMs - b.localStartMs);
}

/** The transcript the cues add up to. */
export const transcriptOf = (segments: readonly SeenSegment[]) =>
  distinctCues(segments)
    .map((c) => c.text)
    .join(" ");

/**
 * Segments that came too late for a viewer `latencyMs` behind live: listed after the playhead's
 * PDT reached the segment's start. A cue starts no earlier than its segment, so a segment in time
 * means every cue in it is in time. Silent segments (no cues) do not count.
 */
export function lateSegments(segments: readonly SeenSegment[], latencyMs: number): SeenSegment[] {
  return segments.filter((s) => s.cues.length > 0 && s.firstSeenAt > s.pdtMs + latencyMs);
}
