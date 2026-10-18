// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { applyFilters, compileFilters, containsLink, unsafeRegexReason } from "../src/content.ts";
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

describe("regex safety", () => {
  test.each([
    "(a+)+",
    "(a*)*b",
    "(\\w?)+",
    "(a|aa)*",
    "(?:x|y){2,}",
    "((ab)*c)+",
    "(a)\\1",
    "(?<n>a)\\k<n>",
    "a{1,5000}",
    "(a",
  ])("%s is rejected", (pattern) => expect(unsafeRegexReason(pattern)).not.toBeNull());

  test.each([
    "^spam\\d+$",
    "bad(word)?",
    "(foo|bar)",
    "[a-z]+ing",
    "(?:ab)+",
    "a{2,10}",
    "\\(a+\\)+",
    "[(]a+[)]+",
    "x+?y",
  ])("%s is allowed", (pattern) => expect(unsafeRegexReason(pattern)).toBeNull());

  test("unsafe regex filters are skipped with a reason", () => {
    const reasons: string[] = [];
    const filters = compileFilters([f({ id: "evil", pattern: "(a+)+$", isRegex: true })], (_d, r) => reasons.push(r));
    expect(filters).toHaveLength(0);
    expect(reasons[0]).toMatch(/nested quantifiers/);
    // Literal patterns are escaped, so their shape never matters.
    expect(compileFilters([f({ pattern: "(a+)+" })])).toHaveLength(1);
  });

  test("filters that exceed the time budget hold the message instead of passing it", () => {
    let now = 0;
    const filters = compileFilters([
      f({ id: "b1", pattern: "nomatch1" }),
      f({ id: "b2", pattern: "nomatch2" }),
      f({ id: "h", pattern: "nomatch3", action: "hold" }),
    ]);
    const clock = () => (now += 10);
    expect(applyFilters("hello", filters, 25, clock)).toMatchObject({ action: "hold", timedOut: true });
    expect(applyFilters("hello", filters)).toEqual({ action: "pass", body: "hello", filterId: null });
  });
});
