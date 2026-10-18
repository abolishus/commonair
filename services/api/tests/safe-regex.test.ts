// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { MAX_PATTERN_LENGTH, unsafeFilterRegexReason } from "../src/lib/safe-regex.ts";

/** Known-catastrophic or exponential/polynomial shapes: every one must be refused. */
const CATASTROPHIC = [
  "((a+))+$",
  "(a|a)*$",
  "(a*)*b",
  "(.*a){20}",
  "(a+)+",
  "^(a+)+$",
  "(a|aa)+",
  "(a|aa)*b",
  "(\\w?)+",
  "(\\w+)*!",
  "(x+x+)+y",
  "(\\d+|\\d+\\.\\d+)+",
  "([a-z]+)*$",
  "(?:a+){2}",
  "(?:a?){5}",
  "(.*){3}",
  "(a|b|ab)*c",
  "(?:\\s|\\S)+x",
  "(?:.|a)*z",
  "(?:a+)?a+!",
  "(?:a|ab)?",
  "\\w*\\w*!",
  "\\w+\\w+",
  ".*.*=.*",
  "a*a*a*b",
  "\\w+\\s*\\w+!",
  "\\w+a\\w+!",
  "[a-z]+[a-z0-9]+$",
  "\\d+\\d*x",
  "a?a?a?a?a?a?a?a?a?a?a?aaaaaaaaaaa",
  "(?:a|a)(?:a|a)(?:a|a)(?:a|a)(?:a|a)(?:a|a)(?:a|a)(?:a|a)(?:a|a)(?:a|a)(?:a|a)b",
  "\\w+(?:a\\w+|b)",
  "a{0,20}a{0,20}a{0,20}",
  "(?:ab|ac)+",
  "(?:a|)+",
];

/** Features outside the grammar. */
const UNSUPPORTED = [
  "(a)\\1",
  "(?<n>a)\\k<n>",
  "(?=a)b",
  "(?!a)b",
  "(?<=a)b",
  "(?<!a)b",
  "(?<name>abc)",
  "(?i:abc)",
  "a{21}",
  "a{0,50}",
  "a{1000}",
  "a{2,1}",
  "^*",
  "\\b+",
  "a**",
  "*a",
  "{2}",
  "a{",
  "a}",
  "]",
  "(abc",
  "abc)",
  "[abc",
  "[]",
  "[\\b]",
  "\\c",
  "\\q",
  "\\01",
  "abc\\",
  "[z-a]",
  "[\\d-z]",
  "\\p{Nope",
];

const EMPTY_MATCHING = ["a*", "a?", "^", "$", "\\b", "^$", "(?:a|)", "a|", "\\b(?:x)?\\b", "[a-z]{0,3}"];

/** Patterns a moderator would realistically write: every one must pass. */
const REALISTIC = [
  "badword",
  "\\bbadword\\b",
  "^!spam",
  "spam$",
  "bad|worse|worst",
  "\\b(?:cat|dog)s?\\b",
  "f+u+c+k+",
  "s[e3]x+y",
  "fr[e3]{2}\\s?v[i1]dz",
  "\\bbuy\\s+followers\\b",
  "discord\\.gg/\\w+",
  "(?:https?://)?bit\\.ly/[a-z0-9]+",
  "[a-z0-9._-]+@[a-z0-9-]+\\.[a-z]{2,6}",
  "\\d{3}-\\d{3}-\\d{4}",
  "\\(\\d{3}\\) ?\\d{3}-\\d{4}",
  "n[i1!|]gg?[e3]r",
  "(?:ha){3,}",
  "(?:lol)+",
  "w+o+w+",
  "\\bcrypto\\b.*\\bgiveaway\\b",
  "[^\\s]+\\.(?:ru|xyz)\\b",
  "\\p{Extended_Pictographic}{5,}",
  "\\u00e9t\\u00e9",
  "\\x41BC",
  "[\\u0400-\\u04FF]+",
  "日本語",
  "😀{3}",
  "^[A-Z !]{10,}$",
  "a.b",
  "\\$\\d+",
  "\\[link\\]",
  "\\/r\\/\\w+",
  "\\t\\n",
  "(?:\\+1)?\\d{10}",
  "free\\s(?:nitro|robux|vbucks)",
  "(foo|bar)baz",
  "(?:.|\\n)+z",
  "(?:https?|ftp)://\\S+",
];

describe("unsafeFilterRegexReason", () => {
  test.each(CATASTROPHIC)("refuses catastrophic %s", (p) => {
    expect(unsafeFilterRegexReason(p)).not.toBeNull();
  });

  test.each(UNSUPPORTED)("refuses unsupported %s", (p) => {
    expect(unsafeFilterRegexReason(p)).not.toBeNull();
  });

  test.each(EMPTY_MATCHING)("refuses empty-matching %s", (p) => {
    expect(unsafeFilterRegexReason(p)).toBe("pattern must not match empty text");
  });

  test.each(REALISTIC)("accepts realistic %s", (p) => {
    expect(unsafeFilterRegexReason(p)).toBeNull();
    // What chat does with an accepted pattern must work.
    expect(() => new RegExp(p, "giu")).not.toThrow();
  });

  test("reasons name the problem", () => {
    expect(unsafeFilterRegexReason("(a)\\1")).toMatch(/backreference/);
    expect(unsafeFilterRegexReason("(?=a)b")).toMatch(/lookaround/);
    expect(unsafeFilterRegexReason("(a+)+")).toMatch(/nested/);
    expect(unsafeFilterRegexReason("(a|ab)+")).toMatch(/different characters/);
    expect(unsafeFilterRegexReason("\\w+\\w+")).toMatch(/unbounded/);
    expect(unsafeFilterRegexReason("a{99}")).toMatch(/above 20/);
  });

  test("length cap and boundaries", () => {
    expect(unsafeFilterRegexReason("")).toBe("pattern is empty");
    expect(unsafeFilterRegexReason("a".repeat(MAX_PATTERN_LENGTH))).toBeNull();
    expect(unsafeFilterRegexReason("a".repeat(MAX_PATTERN_LENGTH + 1))).toMatch(/limited/);
    expect(unsafeFilterRegexReason("a{20}")).toBeNull();
    expect(unsafeFilterRegexReason("ba{0,20}")).toBeNull();
    expect(unsafeFilterRegexReason("a{21}")).not.toBeNull();
  });

  test("ambiguity budget: a few optional parts pass, many fail", () => {
    expect(unsafeFilterRegexReason("a?a?a?a?a?a?a?a?a?a?aaaaa")).toBeNull(); // 2^10
    expect(unsafeFilterRegexReason("a?a?a?a?a?a?a?a?a?a?a?aaaaa")).not.toBeNull(); // 2^11
    expect(unsafeFilterRegexReason("\\w+a?a?a?a?a?!")).toBeNull(); // 32 * 2^5
    expect(unsafeFilterRegexReason("\\w+a?a?a?a?a?a?!")).not.toBeNull();
  });

  test("case-insensitive overlap: A+ and a+ count as the same characters", () => {
    expect(unsafeFilterRegexReason("A+a+!")).not.toBeNull();
    expect(unsafeFilterRegexReason("(?:A|a)+")).not.toBeNull();
  });

  test("disjoint neighbours do not link repeats", () => {
    expect(unsafeFilterRegexReason("\\d+\\s+\\d+")).toBeNull();
    expect(unsafeFilterRegexReason("\\d+\\s*\\d+")).not.toBeNull(); // \s* may be empty
    expect(unsafeFilterRegexReason("[a-z]+@[a-z]+\\.[a-z]+")).toBeNull();
  });

  test("accepted patterns stay fast on adversarial input", () => {
    const inputs = [
      "a".repeat(500),
      "aaaaaaaaaa ".repeat(45),
      "1".repeat(500),
      `${"ha".repeat(249)}x`,
      "f".repeat(250) + "u".repeat(250),
    ];
    const extra = ["\\w+a?a?a?a?a?!", "a?a?a?a?a?a?a?a?a?a?aaaaa!", "\\d+\\s+\\d+!", "(?:a|b)+c", "[^x]+!"];
    for (const p of [...REALISTIC, ...extra]) {
      expect(unsafeFilterRegexReason(p)).toBeNull();
      const re = new RegExp(p, "giu");
      const started = performance.now();
      for (const s of inputs) {
        re.lastIndex = 0;
        re.test(s);
      }
      expect(performance.now() - started, p).toBeLessThan(100);
    }
  });
});
