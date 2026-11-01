// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { buildCues, MAX_CUE_CHARS, MIN_CUE_MS, normalizeCueText, parseWhisperResponse } from "../src/cues.ts";

const T0 = Date.parse("2026-11-01T12:00:00.000Z");
const chunk = (i: number) => ({ startMs: T0 + i * 3000, endMs: T0 + (i + 1) * 3000 });

describe("parseWhisperResponse", () => {
  test("verbose_json segments, with junk entries skipped", () => {
    const segs = parseWhisperResponse({
      text: "hello world",
      segments: [
        { id: 0, start: 0.2, end: 1.4, text: " hello" },
        { id: 1, start: "x", end: 2, text: "bad" },
        null,
        { id: 2, start: 1.5, end: 2.9, text: " world" },
      ],
    });
    expect(segs).toEqual([
      { start: 0.2, end: 1.4, text: " hello" },
      { start: 1.5, end: 2.9, text: " world" },
    ]);
  });

  test("a plain json answer spans the chunk; anything else is no speech", () => {
    expect(parseWhisperResponse({ text: "hi" })).toEqual([{ start: 0, end: 3, text: "hi" }]);
    expect(parseWhisperResponse("nope")).toEqual([]);
    expect(parseWhisperResponse(null)).toEqual([]);
    expect(parseWhisperResponse({})).toEqual([]);
  });
});

describe("normalizeCueText", () => {
  test("drops whisper's non-speech markers and collapses whitespace", () => {
    expect(normalizeCueText(" [BLANK_AUDIO] ")).toBe("");
    expect(normalizeCueText("(music) ♪ ♪")).toBe("");
    expect(normalizeCueText("  hello\n  there  [Music] ")).toBe("hello there");
  });

  test("keeps unicode text and caps the length at a word", () => {
    expect(normalizeCueText("¿Qué tal, señora? 你好 🙂")).toBe("¿Qué tal, señora? 你好 🙂");
    const long = `${"word ".repeat(200)}end`;
    const out = normalizeCueText(long);
    expect(out.length).toBeLessThanOrEqual(MAX_CUE_CHARS);
    expect(out.endsWith("word")).toBe(true);
  });
});

describe("buildCues", () => {
  test("maps segment times onto the broadcast clock (PDT = chunk start + offset)", () => {
    const cues = buildCues(chunk(2), [
      { start: 0.25, end: 1.5, text: " Hello there." },
      { start: 1.6, end: 2.8, text: " General." },
    ]);
    expect(cues).toEqual([
      { startMs: T0 + 6250, endMs: T0 + 7500, text: "Hello there." },
      { startMs: T0 + 7600, endMs: T0 + 8800, text: "General." },
    ]);
  });

  test("clamps a segment that runs past the chunk edge and never overlaps the previous cue", () => {
    const [first] = buildCues(chunk(0), [{ start: 2.5, end: 3.7, text: "across the" }]);
    expect(first).toEqual({ startMs: T0 + 2500, endMs: T0 + 3000, text: "across the" });
    // The next chunk's whisper starts a little "before" the previous cue ended: pushed after it.
    const next = buildCues(chunk(1), [{ start: -0.2, end: 0.8, text: "edge" }], first);
    expect(next).toEqual([{ startMs: T0 + 3000, endMs: T0 + 3800, text: "edge" }]);
  });

  test("a word cut by the chunk edge and heard again at the next chunk's start is kept once", () => {
    const prev = { startMs: T0 + 1000, endMs: T0 + 3000, text: "we went to the" };
    const cues = buildCues(chunk(1), [{ start: 0, end: 1.2, text: "The market today" }], prev);
    expect(cues.map((c) => c.text)).toEqual(["market today"]);
    // Later in the chunk the same word is a real repeat and stays.
    const late = buildCues(chunk(1), [{ start: 1.5, end: 2, text: "the end" }], prev);
    expect(late.map((c) => c.text)).toEqual(["the end"]);
    // A cue that was only the repeated word disappears.
    expect(buildCues(chunk(1), [{ start: 0.1, end: 0.4, text: "The." }], prev)).toEqual([]);
  });

  test("silence and empty text give no cue", () => {
    expect(buildCues(chunk(0), [])).toEqual([]);
    expect(buildCues(chunk(0), [{ start: 0, end: 3, text: "[BLANK_AUDIO]" }])).toEqual([]);
    expect(buildCues(chunk(0), [{ start: 0, end: 3, text: "   " }])).toEqual([]);
  });

  test("a too-short cue is stretched within the chunk; one at the very end is dropped", () => {
    const [c] = buildCues(chunk(0), [{ start: 1, end: 1.05, text: "oh" }]);
    expect(c).toEqual({ startMs: T0 + 1000, endMs: T0 + 1000 + MIN_CUE_MS, text: "oh" });
    expect(buildCues(chunk(0), [{ start: 3.2, end: 3.5, text: "late" }])).toEqual([]);
    const [edge] = buildCues(chunk(0), [{ start: 2.9, end: 2.95, text: "ok" }]);
    expect(edge).toEqual({ startMs: T0 + 2900, endMs: T0 + 3000, text: "ok" });
  });

  test("unicode text survives untouched", () => {
    const [c] = buildCues(chunk(0), [{ start: 0, end: 2, text: " Ça va très bien, 谢谢 " }]);
    expect(c?.text).toBe("Ça va très bien, 谢谢");
  });

  test("segments out of order are sorted", () => {
    const cues = buildCues(chunk(0), [
      { start: 1.5, end: 2.5, text: "second" },
      { start: 0, end: 1, text: "first" },
    ]);
    expect(cues.map((c) => c.text)).toEqual(["first", "second"]);
  });
});
