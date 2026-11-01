// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The studio `/captions` page's form logic (ADR 0011), apart from React: the mask list textarea,
 * the spoken languages offered, and the settings patch. The API validates mask patterns again
 * with the safe-regex check; here a pattern that is not even a regular expression is caught on its
 * own line before saving.
 */
import type { ChannelCaptionsSettings, ChannelCaptionsSettingsPatch } from "@commonair/contracts/shapes";

/** Languages the speech model handles well enough to offer (whisper's multilingual set, the common ones). */
export const SPOKEN_LANGUAGES = [
  "ar",
  "ca",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "es",
  "fi",
  "fr",
  "he",
  "hi",
  "hu",
  "id",
  "it",
  "ja",
  "ko",
  "nl",
  "no",
  "pl",
  "pt",
  "ro",
  "ru",
  "sv",
  "th",
  "tr",
  "uk",
  "vi",
  "zh",
] as const;

/** The offered languages, with the channel's own language added when the list lacks it. */
export function spokenLanguages(channelLanguage: string): string[] {
  const base = channelLanguage.split("-")[0] ?? channelLanguage;
  const list: string[] = [...SPOKEN_LANGUAGES];
  if (!list.includes(channelLanguage) && !list.includes(base)) list.push(channelLanguage);
  return list.sort();
}

/** The language a channel's captions run in: the setting, else the channel's language. */
export const effectiveLanguage = (s: Pick<ChannelCaptionsSettings, "spokenLanguage">, channelLanguage: string) =>
  s.spokenLanguage ?? channelLanguage;

/** Contract limits (`ChannelCaptionsSettings.maskWords`). */
export const MASK_LIMITS = { words: 100, chars: 200 } as const;

export type MaskError = { line: number; reason: "pattern" | "length" | "count" };

/** One pattern per non-empty line; the first problem, with its 1-based line number. */
export function parseMaskWords(text: string): { words: string[]; error: MaskError | null } {
  const words: string[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const w = (lines[i] ?? "").trim();
    if (w === "") continue;
    if (w.length > MASK_LIMITS.chars) return { words, error: { line: i + 1, reason: "length" } };
    try {
      new RegExp(w, "u");
    } catch {
      return { words, error: { line: i + 1, reason: "pattern" } };
    }
    if (!words.includes(w)) words.push(w);
    if (words.length > MASK_LIMITS.words) return { words, error: { line: i + 1, reason: "count" } };
  }
  return { words, error: null };
}

export interface CaptionsDraft {
  /** The effective switch (the channel's choice, or the instance default when it has none). */
  enabled: boolean;
  /** Whether the channel made its own choice (false: it follows the instance default). */
  own: boolean;
  language: string;
  maskText: string;
}

export function captionsDraft(
  s: ChannelCaptionsSettings,
  instanceDefault: boolean,
  channelLanguage: string,
): CaptionsDraft {
  return {
    enabled: s.enabled ?? instanceDefault,
    own: s.enabled !== null,
    language: effectiveLanguage(s, channelLanguage),
    maskText: s.maskWords.join("\n"),
  };
}

/**
 * The patch to save. A channel that follows the default keeps following it until the switch is
 * moved; the spoken language is stored only when it differs from the channel's own.
 */
export function captionsPatch(
  draft: CaptionsDraft,
  words: string[],
  channelLanguage: string,
): ChannelCaptionsSettingsPatch {
  return {
    enabled: draft.own ? draft.enabled : null,
    spokenLanguage: draft.language === channelLanguage ? null : draft.language,
    maskWords: words,
  };
}
