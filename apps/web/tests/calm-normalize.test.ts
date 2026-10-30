// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Calm Chat wave keys (feature-wins §4.2): look-alikes collapse, a different word never does. */
import { describe, expect, it } from "vite-plus/test";
import { mentions, normalizeText, tokens, waveKey } from "../src/chat/calm/normalize.ts";

const key = (body: string, emotes: { emoteId: string; code: string; start: number; end: number }[] = []) =>
  waveKey({ body, emotes });

describe("normalizeText", () => {
  it("applies NFKC: full-width letters and ligatures fold to their plain forms", () => {
    expect(normalizeText("ＰｏｇＣｈａｍｐ")).toBe("pogchamp");
    expect(normalizeText("ﬁne")).toBe("fine");
    expect(normalizeText("①")).toBe("1");
  });

  it("strips zero-width characters, the soft hyphen and the BOM", () => {
    expect(normalizeText("Pog​Champ")).toBe("pogchamp");
    expect(normalizeText("﻿hi‌‍⁠")).toBe("hi");
    expect(normalizeText("spam­mer")).toBe("spammer");
  });

  it("strips bidi controls (marks, embeddings, overrides, isolates)", () => {
    expect(normalizeText("‮hello‬")).toBe("hello");
    expect(normalizeText("a‎b‏c؜d")).toBe("abcd");
    expect(normalizeText("⁦x⁩⁧y⁨")).toBe("xy");
  });

  it("collapses whitespace runs (tabs, newlines, non-breaking spaces) and trims", () => {
    expect(normalizeText("  you \t are\n great  ")).toBe("you are great");
  });

  it("folds case", () => {
    expect(normalizeText("LUL lul LuL")).toBe("lul lul lul");
  });

  it("is empty for nothing but invisible characters", () => {
    expect(normalizeText("​ ‮ ")).toBe("");
    expect(tokens("​")).toEqual([]);
  });
});

describe("waveKey", () => {
  it("equal for look-alike copies of the same words", () => {
    expect(key("PogChamp")).toBe(key("pogchamp"));
    expect(key("PogChamp")).toBe(key("Pog​Champ"));
    expect(key("PogChamp")).toBe(key("ＰｏｇＣｈａｍｐ"));
    expect(key("you  are   great")).toBe(key("You are great"));
  });

  it("never merges messages that differ by one word (a slur token)", () => {
    expect(key("you are great")).not.toBe(key("you are slurword"));
    expect(key("you are great")).not.toBe(key("you are great slurword"));
    expect(key("slurword you are great")).not.toBe(key("you are great"));
    // A zero-width character cannot hide a token boundary change.
    expect(key("you are great")).not.toBe(key("you are​ great slurword"));
  });

  it("keeps word order", () => {
    expect(key("a b")).not.toBe(key("b a"));
  });

  it("keys an emote-only body on its emote ids, in order", () => {
    const one = key("Kappa", [{ emoteId: "e1", code: "Kappa", start: 0, end: 5 }]);
    const renamed = key("KappaNew", [{ emoteId: "e1", code: "KappaNew", start: 0, end: 8 }]);
    expect(one).toBe("e:e1");
    expect(renamed).toBe(one);
    const two = key("Kappa  LUL ", [
      { emoteId: "e2", code: "LUL", start: 7, end: 10 },
      { emoteId: "e1", code: "Kappa", start: 0, end: 5 },
    ]);
    expect(two).toBe("e:e1 e2");
    expect(
      key("LUL Kappa", [
        { emoteId: "e2", code: "LUL", start: 0, end: 3 },
        { emoteId: "e1", code: "Kappa", start: 4, end: 9 },
      ]),
    ).not.toBe(two);
  });

  it("keys text around emotes as words, so text never merges with an emote-only body", () => {
    const withText = key("Kappa lol", [{ emoteId: "e1", code: "Kappa", start: 0, end: 5 }]);
    expect(withText).toBe("t:kappa lol");
    expect(withText).not.toBe(key("Kappa", [{ emoteId: "e1", code: "Kappa", start: 0, end: 5 }]));
  });

  it("treats malformed emote ranges as text", () => {
    expect(key("Kappa", [{ emoteId: "e1", code: "Kappa", start: 0, end: 50 }])).toBe("t:kappa");
    expect(
      key("Kappa", [
        { emoteId: "e1", code: "Kappa", start: 0, end: 5 },
        { emoteId: "e2", code: "appa", start: 1, end: 5 },
      ]),
    ).toBe("t:kappa");
  });
});

describe("mentions", () => {
  it("finds @username as a word, any case, with trailing punctuation", () => {
    expect(mentions("hi @Fan_One!", "fan_one")).toBe(true);
    expect(mentions("@FAN_ONE", "fan_one")).toBe(true);
    expect(mentions("hey @fan_one, look", "Fan_One")).toBe(true);
  });

  it("ignores longer names, bare names and signed-out viewers", () => {
    expect(mentions("@fan_one2 hi", "fan_one")).toBe(false);
    expect(mentions("fan_one hi", "fan_one")).toBe(false);
    expect(mentions("email@fan_one", "fan_one")).toBe(false);
    expect(mentions("@fan_one", null)).toBe(false);
  });
});
