// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { applyFilters, compileFilters, containsLink } from "../src/content.ts";
import type { WordFilterDef } from "../src/types.ts";

describe("containsLink", () => {
  test.each([
    "https://example.com",
    "go to example.com now",
    "www.example.org",
    "sub.domain.co.uk/path?q=1",
    "ftp://files.local",
    "visit example.com.",
    "localhost.dev:8080/x",
  ])("%s is a link", (body) => expect(containsLink(body)).toBe(true));

  test.each(["hello world", "e.g. this", "version 1.5.2", "i.e.", "3.14", "wait...what", "Kappa"])(
    "%s is not a link",
    (body) => expect(containsLink(body)).toBe(false),
  );
});

const f = (over: Partial<WordFilterDef>): WordFilterDef => ({
  id: "f",
  pattern: "x",
  isRegex: false,
  action: "block",
  replacement: null,
  ...over,
});

describe("word filters", () => {
  test("literal patterns are case-insensitive and regex-escaped", () => {
    const filters = compileFilters([f({ pattern: "a.b" })]);
    expect(applyFilters("A.B here", filters).action).toBe("block");
    expect(applyFilters("axb", filters).action).toBe("pass");
  });

  test("regex patterns", () => {
    const filters = compileFilters([f({ pattern: "^spam\\d+$", isRegex: true })]);
    expect(applyFilters("SPAM42", filters).action).toBe("block");
    expect(applyFilters("no spam42 here", filters).action).toBe("pass");
  });

  test("invalid regexes are skipped and reported", () => {
    const bad: string[] = [];
    const filters = compileFilters([f({ id: "bad", pattern: "(", isRegex: true })], (d) => bad.push(d.id));
    expect(filters).toHaveLength(0);
    expect(bad).toEqual(["bad"]);
  });

  test("repeated use of global regexes is stable", () => {
    const filters = compileFilters([f({ pattern: "bad" })]);
    for (let i = 0; i < 5; i++) expect(applyFilters("bad", filters).action).toBe("block");
  });

  test("replace masks by code point and keeps going", () => {
    const filters = compileFilters([
      f({ id: "r", pattern: "héllo", action: "replace" }),
      f({ id: "r2", pattern: "😀", action: "replace", replacement: ":)" }),
    ]);
    expect(applyFilters("HÉLLO 😀 héllo", filters)).toEqual({ action: "pass", body: "***** :) *****", filterId: null });
  });

  test("hold with a replace applies both", () => {
    const filters = compileFilters([
      f({ id: "h", pattern: "sus", action: "hold" }),
      f({ id: "r", pattern: "darn", action: "replace" }),
    ]);
    expect(applyFilters("darn sus", filters)).toEqual({ action: "hold", body: "**** sus", filterId: "h" });
  });
});
