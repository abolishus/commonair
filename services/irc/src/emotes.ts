// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { EmoteRange } from "@commonair/contracts";

/**
 * Convert our emote ranges (UTF-16 code units, end exclusive) to the Twitch
 * `emotes` tag (code points, end inclusive): `id:start-end,start-end/id2:start-end`.
 * Ranges that are empty, out of bounds, split a surrogate pair, or whose id
 * cannot be written in the tag syntax are skipped rather than mis-reported.
 */
export function emotesTag(body: string, emotes: readonly EmoteRange[]): string {
  if (emotes.length === 0) return "";
  const cpIndex = codePointIndex(body);
  const byId = new Map<string, string[]>();
  const sorted = [...emotes].sort((a, b) => a.start - b.start);
  for (const e of sorted) {
    if (!/^[^\s:/,;]+$/.test(e.emoteId)) continue;
    if (e.start < 0 || e.end > body.length || e.end <= e.start) continue;
    const start = cpIndex[e.start];
    const endExclusive = cpIndex[e.end];
    // undefined marks the low half of a surrogate pair: the range would split a character.
    if (start === undefined || endExclusive === undefined) continue;
    const ranges = byId.get(e.emoteId) ?? [];
    ranges.push(`${start}-${endExclusive - 1}`);
    byId.set(e.emoteId, ranges);
  }
  return [...byId].map(([id, ranges]) => `${id}:${ranges.join(",")}`).join("/");
}

/**
 * Map from UTF-16 offset to code-point offset, for every offset 0..length.
 * Offsets that fall inside a surrogate pair map to undefined.
 */
export function codePointIndex(s: string): (number | undefined)[] {
  const out: (number | undefined)[] = Array.from({ length: s.length + 1 });
  let cp = 0;
  for (let i = 0; i < s.length; i++) {
    out[i] = cp;
    const code = s.charCodeAt(i);
    const next = s.charCodeAt(i + 1);
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      out[i + 1] = undefined;
      i++;
    }
    cp++;
  }
  out[s.length] = cp;
  return out;
}
