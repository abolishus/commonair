// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** `topTags`: the tags a Category DTO carries from its live streams. */
import { describe, expect, test } from "vite-plus/test";
import { CATEGORY_TAGS, topTags } from "../src/discovery/tags.ts";

describe("topTags", () => {
  test("empty input and streams without tags give no tags", () => {
    expect(topTags([])).toEqual([]);
    expect(topTags([[], []])).toEqual([]);
  });

  test("most used first, ties by name", () => {
    expect(topTags([["b", "a"], ["c", "b"], ["c"], ["c"]])).toEqual(["c", "b", "a"]);
    expect(topTags([["zeta"], ["alpha"], ["mid"]])).toEqual(["alpha", "mid", "zeta"]);
  });

  test("a stream counts a repeated tag once", () => {
    expect(topTags([["x", "x", "x"], ["y"], ["y"]])).toEqual(["y", "x"]);
  });

  test("caps at CATEGORY_TAGS by default and at an explicit limit", () => {
    const many = Array.from({ length: 15 }, (_, i) => `t${String(i).padStart(2, "0")}`);
    expect(CATEGORY_TAGS).toBe(10);
    expect(topTags([many])).toEqual(many.slice(0, 10));
    expect(topTags([many], 3)).toEqual(["t00", "t01", "t02"]);
    expect(topTags([many], 0)).toEqual([]);
    expect(topTags([many], -1)).toEqual([]);
  });

  test("the cap keeps the most used, not the first seen", () => {
    const rare = Array.from({ length: 10 }, (_, i) => `a${i}`);
    expect(topTags([rare, ["zz"], ["zz"]], 2)).toEqual(["zz", "a0"]);
  });
});
