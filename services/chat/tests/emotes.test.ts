// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { emoteTierFor, mergeEmotes, parseEmotes } from "../src/emotes.ts";
import { emote, standing } from "./fixtures.ts";

const set = mergeEmotes(
  [emote("Kappa"), emote("PogChamp"), emote("Hype", 0, "global-hype")],
  [emote("Hype", 0, "chan-hype"), emote("Gold", 3)],
);

describe("parseEmotes", () => {
  test("finds whole-word emotes with exclusive end offsets", () => {
    const r = parseEmotes("Kappa hello PogChamp", set, 0);
    expect(r.ranges).toEqual([
      { emoteId: "e-Kappa", code: "Kappa", start: 0, end: 5 },
      { emoteId: "e-PogChamp", code: "PogChamp", start: 12, end: 20 },
    ]);
    expect(r.onlyEmotes).toBe(false);
  });

  test("offsets are UTF-16 code units across surrogate pairs", () => {
    const body = "😀 Kappa 👍🏽 Kappa";
    const r = parseEmotes(body, set, 0);
    expect(r.ranges.map((x) => [x.start, x.end])).toEqual([
      [3, 8],
      [14, 19],
    ]);
    for (const x of r.ranges) expect(body.slice(x.start, x.end)).toBe("Kappa");
  });

  test("an emote inside a word or with punctuation is not an emote", () => {
    expect(parseEmotes("KappaKappa Kappa! xKappa", set, 0).ranges).toEqual([]);
  });

  test("is case-sensitive", () => {
    expect(parseEmotes("kappa", set, 0).ranges).toEqual([]);
  });

  test("tier gating leaves locked emotes as text", () => {
    expect(parseEmotes("Gold", set, 2).ranges).toEqual([]);
    expect(parseEmotes("Gold", set, 3).ranges).toHaveLength(1);
    expect(parseEmotes("Gold", set, emoteTierFor(standing({ isBroadcaster: true }))).ranges).toHaveLength(1);
  });

  test("channel emotes override global emotes with the same code", () => {
    expect(parseEmotes("Hype", set, 0).ranges[0]?.emoteId).toBe("chan-hype");
  });

  test("onlyEmotes needs at least one word, all usable", () => {
    expect(parseEmotes("  Kappa\tPogChamp  ", set, 0).onlyEmotes).toBe(true);
    expect(parseEmotes("   ", set, 0).onlyEmotes).toBe(false);
    expect(parseEmotes("Kappa Gold", set, 0).onlyEmotes).toBe(false);
  });

  test("emoteTierFor uses the subscription tier", () => {
    expect(emoteTierFor(standing())).toBe(0);
    expect(emoteTierFor(standing({ subscriberTier: 2 }))).toBe(2);
  });
});
