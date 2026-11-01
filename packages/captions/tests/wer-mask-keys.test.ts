// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { CAPTIONS_KEYS, decodeCue, decodeLiveTrack, encodeCue } from "../src/keys.ts";
import { MASK_TOKEN, maskedText, maskFilterDefs, maskPattern } from "../src/mask.ts";
import { CAPTIONS_MODEL, captionsModelUrl } from "../src/model.ts";
import { languageLabel } from "../src/index.ts";
import { normalizeWords, wordEditDistance, wordErrorRate } from "../src/wer.ts";

describe("wordErrorRate", () => {
  test("identical text, punctuation and case do not count", () => {
    expect(wordErrorRate("Hello, world!", "hello world")).toBe(0);
    expect(wordErrorRate("It's here.", "its here")).toBe(0);
  });

  test("substitutions, deletions and insertions over reference words", () => {
    expect(wordErrorRate("the cat sat on the mat", "the cat sat on a mat")).toBeCloseTo(1 / 6);
    expect(wordErrorRate("the cat sat", "the sat")).toBeCloseTo(1 / 3);
    expect(wordErrorRate("the cat", "the big cat")).toBeCloseTo(1 / 2);
    expect(wordErrorRate("one two", "")).toBe(1);
  });

  test("empty reference stays finite", () => {
    expect(wordErrorRate("", "")).toBe(0);
    expect(wordErrorRate("  ", "extra")).toBe(1);
  });

  test("unicode words", () => {
    expect(normalizeWords("¿Qué tal? Señora, 你好")).toEqual(["qué", "tal", "señora", "你好"]);
    expect(wordEditDistance(["a", "b"], ["b", "a"])).toBe(2);
  });
});

describe("mask shapes", () => {
  test("plain words get ASCII word boundaries where they apply; patterns stay as written", () => {
    expect(maskPattern("darn")).toBe("\\bdarn\\b");
    expect(maskPattern(" heck it ")).toBe("\\bheck\\s+it\\b");
    expect(maskPattern("café")).toBe("\\bcafé");
    expect(maskPattern("ñandú")).toBe("ñandú");
    expect(maskPattern("da+rn")).toBe("da+rn");
    expect(maskFilterDefs(["a", " ", "b+"]).map((d) => [d.id, d.pattern, d.action, d.replacement])).toEqual([
      ["mask-0", "\\ba\\b", "replace", MASK_TOKEN],
      ["mask-1", "b+", "replace", MASK_TOKEN],
    ]);
  });

  test("a filter run out of budget masks the whole cue (fail closed)", () => {
    expect(maskedText({ action: "pass", body: "ok [***]" })).toBe("ok [***]");
    expect(maskedText({ action: "hold", body: "half masked", timedOut: true })).toBe(MASK_TOKEN);
    expect(maskedText({ action: "block", filterId: "x" })).toBe(MASK_TOKEN);
  });
});

describe("keys", () => {
  test("shapes and codecs", () => {
    expect(CAPTIONS_KEYS.live("b")).toBe("captions:live:b");
    expect(CAPTIONS_KEYS.cues("b", "en")).toBe("captions:cues:b:en");
    const raw = encodeCue(3, { startMs: 1, endMs: 2, text: "x" });
    expect(decodeCue(raw)).toEqual({ startMs: 1, endMs: 2, text: "x" });
    expect(decodeCue("{")).toBeNull();
    expect(decodeCue('{"s":1}')).toBeNull();
    const t = { language: "en", w0Ms: 1, anchorMs: 2, throughMs: 3 };
    expect(decodeLiveTrack(JSON.stringify(t))).toEqual(t);
    expect(decodeLiveTrack(null)).toBeNull();
    expect(decodeLiveTrack('{"language":"en"}')).toBeNull();
  });
});

describe("model entry", () => {
  test("pinned by revision and sha256 (required for captions)", () => {
    expect(CAPTIONS_MODEL.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(CAPTIONS_MODEL.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(CAPTIONS_MODEL.sizeBytes).toBeGreaterThan(50_000_000);
    expect(captionsModelUrl()).toBe(
      `https://huggingface.co/ggerganov/whisper.cpp/resolve/${CAPTIONS_MODEL.revision}/ggml-base-q5_1.bin`,
    );
    expect(captionsModelUrl({ ...CAPTIONS_MODEL, revision: null })).toBeNull();
  });

  test("language labels are autonyms", () => {
    expect(languageLabel("en")).toBe("English");
    // ICU versions differ on capitalization.
    expect(languageLabel("es").toLowerCase()).toBe("español");
    expect(languageLabel("zz-ZZZZZ!")).toBe("zz-ZZZZZ!");
  });
});
