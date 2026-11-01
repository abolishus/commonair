// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Open captions (ADR 0011): the model entry, cue building, WebVTT and the live subtitle playlist,
 * word masking shapes, WER, and the Valkey key shapes shared by services/media, services/origin
 * and services/api.
 */
export { CAPTIONS_MODEL, type CaptionsModelEntry, captionsModelUrl, DEFAULT_CAPTIONS_MODEL_PATH } from "./model.ts";
export {
  buildCues,
  CHUNK_SECONDS,
  type Chunk,
  type Cue,
  MAX_CUE_CHARS,
  MIN_CUE_MS,
  normalizeCueText,
  parseWhisperResponse,
  type WhisperSegment,
} from "./cues.ts";
export {
  completeSegments,
  escapeCueText,
  LIVE_WINDOW_SEGMENTS,
  type LiveTrack,
  liveSubtitlePlaylist,
  liveVttSegment,
  MEDIAMTX_TIMELINE_OFFSET_S,
  parseVtt,
  parseVttTimestamp,
  SEGMENT_MS,
  segmentBounds,
  segmentIndexAt,
  timestampMap,
  toVodCues,
  unescapeCueText,
  type VodCue,
  type VodTrack,
  vodVttDocument,
  vttTimestamp,
} from "./vtt.ts";
export { MASK_TOKEN, type MaskFilterDef, maskFilterDefs, maskedText, type MaskOutcome, maskPattern } from "./mask.ts";
export { normalizeWords, wordEditDistance, wordErrorRate } from "./wer.ts";
export { CAPTIONS_KEYS, decodeCue, decodeLiveTrack, encodeCue, LIVE_TTL_SECONDS, type StoredCue } from "./keys.ts";

/** A language's own name (`English`, `español`) for a track label; the tag itself when unknown. */
export function languageLabel(language: string): string {
  try {
    return new Intl.DisplayNames([language], { type: "language" }).of(language) ?? language;
  } catch {
    return language;
  }
}
