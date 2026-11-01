// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Cues from whisper's output (ADR 0011). The live worker cuts the source audio into fixed chunks
 * whose start is a PDT on the broadcast clock (the chunk's `-copyts` PTS plus W0, ADR 0012); whisper
 * answers with segments timed in seconds from the chunk start. A cue is that segment on the
 * broadcast clock, kept inside its chunk and never overlapping the cue before it, so the WebVTT
 * segmenter and the VOD stitcher see an ordered, non-overlapping list.
 */

/** One caption cue on the broadcast clock (epoch milliseconds). Text is already masked. */
export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

/** A transcribed span, in seconds from the chunk start (whisper.cpp `verbose_json` segments). */
export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
}

/** A chunk of audio on the broadcast clock. */
export interface Chunk {
  startMs: number;
  endMs: number;
}

/** Live chunk length (decision (j)): long enough for whisper context, short enough for 8–10 s latency. */
export const CHUNK_SECONDS = 3;
/** Cue text cap (the `CaptionCue.text` contract allows 500). */
export const MAX_CUE_CHARS = 500;
/** A cue shorter than this would flash; it is stretched within its chunk. */
export const MIN_CUE_MS = 300;
/** How far into a chunk a repeated edge word may start and still count as the previous chunk's. */
const EDGE_WINDOW_MS = 600;

/** whisper's non-speech markers (`[BLANK_AUDIO]`, `(music)`, `[Music]`, `♪`), which are not captions. */
const NON_SPEECH = /\[[^\]]{0,40}\]|\((?:music|applause|laughter|silence|inaudible|noise)[^)]{0,20}\)|[♪♫]+/giu;

/** Collapse whitespace and drop non-speech markers; empty when nothing was said. */
export function normalizeCueText(text: string): string {
  const cleaned = text.replace(NON_SPEECH, " ").replace(/\s+/gu, " ").trim();
  if (cleaned.length <= MAX_CUE_CHARS) return cleaned;
  const cut = cleaned.slice(0, MAX_CUE_CHARS);
  const space = cut.lastIndexOf(" ");
  return (space > MAX_CUE_CHARS / 2 ? cut.slice(0, space) : cut).trim();
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Segments from a whisper.cpp `/inference` answer. `verbose_json` carries timed `segments`; a plain
 * `json` answer (`{text}`) becomes one segment over the whole chunk. Anything else is no speech.
 */
export function parseWhisperResponse(body: unknown, chunkSeconds = CHUNK_SECONDS): WhisperSegment[] {
  if (typeof body !== "object" || body === null) return [];
  const o = body as { segments?: unknown; text?: unknown };
  if (Array.isArray(o.segments)) {
    const out: WhisperSegment[] = [];
    for (const s of o.segments as unknown[]) {
      if (typeof s !== "object" || s === null) continue;
      const seg = s as { start?: unknown; end?: unknown; text?: unknown };
      const start = num(seg.start);
      const end = num(seg.end);
      if (start === null || end === null || typeof seg.text !== "string") continue;
      out.push({ start, end, text: seg.text });
    }
    return out;
  }
  return typeof o.text === "string" ? [{ start: 0, end: chunkSeconds, text: o.text }] : [];
}

const wordKey = (w: string | undefined) => (w ?? "").toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Cues for one chunk. Each segment is moved onto the broadcast clock, clamped to the chunk and to
 * after `previous` (the last cue already stored), stretched to `MIN_CUE_MS` where the chunk allows,
 * and dropped when it says nothing. A word cut by the chunk edge often comes back twice, at the end
 * of one chunk and the start of the next: a first word equal to `previous`'s last word, starting
 * right at the chunk start, is dropped.
 */
export function buildCues(chunk: Chunk, segments: readonly WhisperSegment[], previous?: Cue | null): Cue[] {
  const out: Cue[] = [];
  let floor = Math.max(chunk.startMs, previous?.endMs ?? Number.NEGATIVE_INFINITY);
  let lastWord = previous ? wordKey(previous.text.split(" ").at(-1)) : "";
  const ordered = [...segments].sort((a, b) => a.start - b.start);
  for (const seg of ordered) {
    let text = normalizeCueText(seg.text);
    const rawStart = chunk.startMs + Math.round(seg.start * 1000);
    if (out.length === 0 && lastWord !== "" && rawStart - chunk.startMs <= EDGE_WINDOW_MS) {
      const words = text.split(" ");
      if (words.length > 0 && wordKey(words[0]) === lastWord) text = words.slice(1).join(" ");
    }
    if (text === "") continue;
    const start = Math.min(Math.max(rawStart, floor), chunk.endMs);
    if (start >= chunk.endMs) continue;
    const rawEnd = chunk.startMs + Math.round(seg.end * 1000);
    const end = Math.min(chunk.endMs, Math.max(rawEnd, start + MIN_CUE_MS));
    if (end <= start) continue;
    out.push({ startMs: start, endMs: end, text });
    floor = end;
    lastWord = wordKey(text.split(" ").at(-1));
  }
  return out;
}
