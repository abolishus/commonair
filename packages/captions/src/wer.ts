// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Word error rate (ADR 0011: the `captions` harness keeps the model only while WER < 0.40 against
 * a reference transcript, History 2026-11-01). WER = (substitutions + deletions + insertions) / reference words, on
 * words normalized the way a caption reader would compare them: case, punctuation and the mask
 * token do not count.
 */

/** Lowercased words with punctuation removed (letters and digits in any script are kept). */
export function normalizeWords(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/['’](?=\p{L})/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter((w) => w !== "");
}

/** Edit distance between two word lists (Levenshtein over words, O(n·m) time, O(m) memory). */
export function wordEditDistance(ref: readonly string[], hyp: readonly string[]): number {
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      const sub = (prev[j - 1] ?? 0) + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      cur.push(Math.min(sub, (prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1));
    }
    prev = cur;
  }
  return prev[hyp.length] ?? 0;
}

/**
 * WER of `hypothesis` against `reference`. An empty reference gives 0 for an empty hypothesis
 * and 1 otherwise (every word is an insertion), so the result is always finite.
 */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  if (ref.length === 0) return hyp.length === 0 ? 0 : 1;
  return wordEditDistance(ref, hyp) / ref.length;
}
