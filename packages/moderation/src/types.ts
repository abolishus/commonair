// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The provider interfaces (ADR 0006 decision 3). Only providers are swappable; the pipeline is not. */
import type { HashListCategory, ModerationCategory } from "@commonair/contracts/enums";
import type { ModerationScores } from "@commonair/contracts/internal";

/** A PDQ hash: 256 bits as 64 lowercase hex characters, and its quality (0–100). */
export interface PdqHash {
  hash: string;
  quality: number;
}

/** `pdq:operator-list` (an operator file) or `pdq:local` (the database block list). */
export type HashListProvider = "pdq:operator-list" | "pdq:local";

/** One loaded list. Immutable: a reload produces a new list. */
export interface HashList {
  readonly category: HashListCategory;
  readonly provider: HashListProvider;
  /** Operator files: `sha256:<hex of the file>:<entry count>`; local list: `local:<entry count>:<newest id>`. */
  readonly version: string;
  readonly size: number;
  /** The closest entry's distance, or null for an empty list. */
  nearest(hash: string): number | null;
}

export interface HashMatch {
  category: HashListCategory;
  provider: HashListProvider;
  listVersion: string;
  distance: number;
  quality: number;
}

/**
 * Matches against every loaded list. `match` returns null when quality < PDQ_MIN_QUALITY or no
 * entry is within PDQ_MATCH_DISTANCE; otherwise the closest match (CSAM before NCII on a tie).
 * `replace` swaps one list atomically (reload); callers keep the last good list on a parse error.
 */
export interface HashMatcher {
  match(hash: PdqHash): HashMatch | null;
  replace(list: HashList): void;
  lists(): readonly HashList[];
}

export interface ClassifierInput {
  /** Raw RGB, CLASSIFIER_INPUT_SIZE × CLASSIFIER_INPUT_SIZE × 3 bytes. */
  rgb: Uint8Array;
  /** The channel the frame came from (the scripted classifier reads its script by channel). */
  channelId: string;
}

/**
 * Per-category scores in [0, 1]. A category the provider does not score is absent from the
 * result (never 0) and listed in neither `scored` nor the result.
 */
export interface Classifier {
  /** e.g. `onnx:adamcodd-vit-nsfw` or `scripted`; recorded in every flag. */
  readonly provider: string;
  /** Model revision + file sha256, or `scripted-v1`; recorded in every flag. */
  readonly providerVersion: string;
  readonly scored: readonly ModerationCategory[];
  classify(input: ClassifierInput): Promise<ModerationScores>;
}

/** A decoded image or video frame at the two sizes moderation reads. */
export interface DecodedFrame {
  /** Raw 8-bit luma, PDQ_LUMA_SIZE². */
  luma: Uint8Array;
  /** Raw RGB, CLASSIFIER_INPUT_SIZE² × 3. */
  rgb: Uint8Array;
}
