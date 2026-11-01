// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Caption word masking (ADR 0011 decision 4): a creator's mask list becomes `replace` word filters
 * for `@commonair/chat-filter` (whose `compileFilters` re-checks every pattern with
 * `@commonair/safe-regex`). A match becomes `MASK_TOKEN`; the cue keeps its timing. Shapes only:
 * the services run the filters (media live, the API on a correction).
 */

/** What a masked word becomes: fixed and language-neutral, so it says "something was said" in every locale. */
export const MASK_TOKEN = "[***]";

/** A `WordFilterDef` (structurally; this package has no dependency on chat-filter). */
export interface MaskFilterDef {
  id: string;
  pattern: string;
  isRegex: true;
  action: "replace";
  replacement: string;
}

/** Only letters, digits, spaces, apostrophes and hyphens: a word or phrase, not a pattern. */
const PLAIN = /^[\p{L}\p{N}' -]+$/u;
const ASCII_WORD = /[A-Za-z0-9_]/;
// Only syntax characters: under the `u` flag an identity escape of anything else (`\-`) is an error.
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * A mask entry as a regex source. A plain word or phrase matches whole words only (`\b` on the
 * edges where it applies: JavaScript's `\b` knows only ASCII word characters, so an edge letter
 * like `é` gets no boundary rather than one that never matches); anything else is the creator's
 * own pattern, as written. Case never matters (the filters compile with `giu`).
 */
export function maskPattern(entry: string): string {
  const word = entry.trim();
  if (!PLAIN.test(word)) return word;
  const head = ASCII_WORD.test(word[0] ?? "") ? "\\b" : "";
  const tail = ASCII_WORD.test(word.at(-1) ?? "") ? "\\b" : "";
  return `${head}${escapeRegex(word).replace(/ +/g, "\\s+")}${tail}`;
}

/** The mask list as `replace` filters (empty entries dropped). */
export function maskFilterDefs(words: readonly string[]): MaskFilterDef[] {
  return words
    .map((w) => w.trim())
    .filter((w) => w !== "")
    .map((w, i) => ({
      id: `mask-${i}`,
      pattern: maskPattern(w),
      isRegex: true,
      action: "replace",
      replacement: MASK_TOKEN,
    }));
}

/** The shape of chat-filter's `FilterOutcome` this needs. */
export type MaskOutcome =
  | { action: "block"; filterId: string }
  | { action: "hold" | "pass"; body: string; timedOut?: boolean };

/**
 * The text to keep from a filter run. Masking fails closed: when the filters ran out of budget
 * the cue is replaced whole, because the unmasked text must never be stored or served.
 */
export function maskedText(outcome: MaskOutcome): string {
  if (outcome.action === "block" || outcome.timedOut === true) return MASK_TOKEN;
  return outcome.body;
}
