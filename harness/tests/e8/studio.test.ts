// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The studio steps' pure helpers and the ids they select by (docs/testing/e8-selectors.md). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { E8_ID_PATTERNS, E8_TEST_IDS, e8Option } from "../../src/e8/selectors.ts";
import {
  STUDIO_TIMER_MARK,
  needsToggle,
  sameVotes,
  stepBotStudio,
  stepInteractStudio,
  studioPollTitle,
  studioTimerName,
  votesOf,
} from "../../src/e8/studio.ts";

describe("studio step helpers", () => {
  it("keeps run-scoped names inside the contract's bounds", () => {
    const long = "r".repeat(80);
    expect(studioPollTitle("abc")).toBe("Studio poll abc");
    expect(studioPollTitle(long)).toHaveLength(60);
    expect(studioTimerName("abc")).toBe("studio-abc");
    expect(studioTimerName(long)).toHaveLength(50);
  });

  it("clicks a switch only when it differs", () => {
    expect(needsToggle("true", true)).toBe(false);
    expect(needsToggle("false", true)).toBe(true);
    expect(needsToggle(null, true)).toBe(true);
    expect(needsToggle("true", false)).toBe(true);
    expect(needsToggle(null, false)).toBe(false);
  });

  it("reads data-votes and compares counts", () => {
    expect(votesOf(["2", "1", "0"])).toEqual([2, 1, 0]);
    expect(votesOf([null, ""]).every(Number.isNaN)).toBe(true);
    expect(sameVotes([2, 1, 0], [2, 1, 0])).toBe(true);
    expect(sameVotes([2, 1], [2, 1, 0])).toBe(false);
    expect(sameVotes([Number.NaN], [Number.NaN])).toBe(false);
  });

  it("marks the studio timer apart from step 3's", () => {
    expect(`Follow ann! ${STUDIO_TIMER_MARK}`.endsWith(STUDIO_TIMER_MARK)).toBe(true);
    expect("Follow ann! (timer)".endsWith(STUDIO_TIMER_MARK)).toBe(false);
  });

  it("exports both steps", () => {
    expect(typeof stepInteractStudio).toBe("function");
    expect(typeof stepBotStudio).toBe("function");
  });
});

describe("ids the studio steps select by", () => {
  const source = readFileSync(new URL("../../src/e8/studio.ts", import.meta.url), "utf8");
  const known = new Set<string>(Object.values(E8_TEST_IDS));

  it("names every E8_TEST_IDS key it uses", () => {
    const keys = [...source.matchAll(/\bT\.([A-Za-z]+)/g)].map((m) => m[1] ?? "");
    expect(keys.length).toBeGreaterThan(40);
    for (const key of keys) expect(Object.keys(E8_TEST_IDS)).toContain(key);
  });

  it("builds literal per-item ids from the documented patterns", () => {
    for (const literal of source.matchAll(/"(poll-choice-\d)"/g))
      expect(literal[1]).toBe(E8_ID_PATTERNS.pollChoice.id(literal[1]?.slice("poll-choice-".length) ?? ""));
    expect(known.has(e8Option("raid-policy", "off"))).toBe(true);
    expect(known.has(e8Option("goal-type", "followers"))).toBe(true);
    expect(E8_ID_PATTERNS.commandLevel.id("moderator")).toBe("command-level-moderator");
  });
});
