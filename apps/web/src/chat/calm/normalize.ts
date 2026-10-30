// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The wave key of a chat line (feature-wins §4.2): two messages collapse into one wave only when
 * their keys are equal. The key is the message's token sequence after NFKC, with zero-width and
 * bidi-control characters removed, whitespace collapsed and case folded, so look-alike spam
 * (full-width letters, a zero-width space inside a word) collapses while two messages that differ by any word never do
 * ("you are great" and "you are <slur>" keep separate keys). No hashing, no fuzzy matching. Pure.
 */
import type { EmoteRange } from "@commonair/contracts/shapes";

// Zero-width and invisible formatting characters, including the soft hyphen and the BOM.
const INVISIBLE = /[­᠎​-‍⁠-⁤﻿]/gu;
// Bidi controls: marks, embeddings, overrides and isolates.
const BIDI = /[؜‎‏‪-‮⁦-⁩]/gu;
const SPACE = /\s+/gu;

/** NFKC, invisible and bidi controls removed, whitespace collapsed and trimmed, case folded. */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE, "").replace(BIDI, "").replace(SPACE, " ").trim().toLowerCase();
}

/** The words of a normalized text, in order. */
export function tokens(text: string): string[] {
  const n = normalizeText(text);
  return n === "" ? [] : n.split(" ");
}

/** True when nothing but whitespace (or invisible characters) is left once the emotes are cut out. */
function emoteOnly(body: string, emotes: readonly EmoteRange[]): boolean {
  if (emotes.length === 0) return false;
  let rest = "";
  let at = 0;
  for (const e of [...emotes].sort((a, b) => a.start - b.start)) {
    if (e.start < at || e.end > body.length) return false;
    rest += body.slice(at, e.start);
    at = e.end;
  }
  rest += body.slice(at);
  return normalizeText(rest) === "";
}

/**
 * The wave key: `e:` + the emote ids in order for an emote-only body (an emote's code can be
 * renamed or look alike; its id cannot), else `t:` + the token sequence. Equal keys means the
 * same words in the same order.
 */
export function waveKey(message: { body: string; emotes: readonly EmoteRange[] }): string {
  if (emoteOnly(message.body, message.emotes))
    return `e:${[...message.emotes]
      .sort((a, b) => a.start - b.start)
      .map((e) => e.emoteId)
      .join(" ")}`;
  return `t:${tokens(message.body).join(" ")}`;
}

/** Whether `body` mentions `username` as `@username` (case-insensitive, NFKC-folded). */
export function mentions(body: string, username: string | null): boolean {
  if (!username) return false;
  const want = `@${username.toLowerCase()}`;
  return tokens(body).some((tok) => tok.replace(/[^\p{L}\p{N}_@]+$/u, "") === want);
}
