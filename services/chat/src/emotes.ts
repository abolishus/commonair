// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Emote parsing. A whitespace-delimited word that exactly equals an emote code becomes an
 * emote when the sender's tier allows it. Offsets are UTF-16 code units (what JavaScript
 * string indices are), end exclusive, so clients can slice the body directly.
 */
import type { EmoteRange } from "@commonair/contracts";
import type { EmoteDef, Standing } from "./types.ts";

export interface ParsedEmotes {
  ranges: EmoteRange[];
  /** True when the body has at least one word and every word is a usable emote. */
  onlyEmotes: boolean;
}

/** The highest emote tier the user may use: broadcasters use everything. */
export function emoteTierFor(standing: Standing): number {
  if (standing.isBroadcaster) return Number.POSITIVE_INFINITY;
  return standing.subscriberTier ?? 0;
}

const WORD = /\S+/gu;

export function parseEmotes(body: string, emotes: ReadonlyMap<string, EmoteDef>, userTier: number): ParsedEmotes {
  const ranges: EmoteRange[] = [];
  let words = 0;
  let usable = 0;
  for (const m of body.matchAll(WORD)) {
    words++;
    const emote = emotes.get(m[0]);
    if (!emote || emote.tier > userTier) continue;
    usable++;
    ranges.push({ emoteId: emote.id, code: emote.code, start: m.index, end: m.index + m[0].length });
  }
  return { ranges, onlyEmotes: words > 0 && usable === words };
}

/** Channel emotes win over global emotes with the same code. */
export function mergeEmotes(global: readonly EmoteDef[], channel: readonly EmoteDef[]): Map<string, EmoteDef> {
  const map = new Map<string, EmoteDef>();
  for (const e of global) map.set(e.code, e);
  for (const e of channel) map.set(e.code, e);
  return map;
}
