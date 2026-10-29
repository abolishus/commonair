// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vite-plus/test";
import { I18nSyntaxError, createTranslator, formatMessage, parseMessage, printMessage } from "../src/index.ts";

const f = (message: string, args?: Record<string, string | number>, locale = "en") =>
  formatMessage(message, args, locale);

function syntaxError(source: string): I18nSyntaxError {
  try {
    parseMessage(source);
  } catch (error) {
    if (error instanceof I18nSyntaxError) return error;
    throw error;
  }
  throw new Error(`expected ${JSON.stringify(source)} not to parse`);
}

describe("placeholders", () => {
  it("fills present arguments, numeric ones with String()", () => {
    expect(f("Welcome to {name}", { name: "Test Air" })).toBe("Welcome to Test Air");
    expect(f("{a}{b} and {a}", { a: 1, b: "x" })).toBe("1x and 1");
    expect(f("{n} items", { n: 1234.5 })).toBe("1234.5 items");
    expect(f("{n}", { n: 0 })).toBe("0");
  });

  it("keeps unknown or missing placeholders verbatim", () => {
    expect(f("Version {version}", {})).toBe("Version {version}");
    expect(f("Version {version}")).toBe("Version {version}");
    expect(f("{a} and {b}", { a: "x" })).toBe("x and {b}");
    expect(f("{ name }", {})).toBe("{name}");
  });

  it("returns plain text unchanged", () => {
    expect(f("")).toBe("");
    expect(f("Sign in")).toBe("Sign in");
    expect(f("100% #1 | done")).toBe("100% #1 | done");
  });
});

describe("plural", () => {
  const items = "{n, plural, one {# item} other {# items}}";

  it("uses English rules", () => {
    expect([0, 1, 2, 1.5].map((n) => f(items, { n }))).toEqual(["0 items", "1 item", "2 items", "1.5 items"]);
  });

  it("uses French rules (0 is one)", () => {
    const m = "{n, plural, one {# élément} other {# éléments}}";
    expect([0, 1, 2].map((n) => f(m, { n }, "fr"))).toEqual(["0 élément", "1 élément", "2 éléments"]);
  });

  it("uses Russian rules (one, few, many)", () => {
    const m = "{n, plural, one {one} few {few} many {many} other {other}}";
    expect([1, 2, 5, 11, 21, 22, 25, 1.5].map((n) => f(m, { n }, "ru"))).toEqual([
      "one",
      "few",
      "many",
      "many",
      "one",
      "few",
      "many",
      "other",
    ]);
  });

  it("uses Arabic rules (all six categories)", () => {
    const m = "{n, plural, zero {zero} one {one} two {two} few {few} many {many} other {other}}";
    expect([0, 1, 2, 3, 11, 100].map((n) => f(m, { n }, "ar"))).toEqual(["zero", "one", "two", "few", "many", "other"]);
  });

  it("uses Japanese rules (only other)", () => {
    const m = "{n, plural, one {one} other {other #}}";
    expect([0, 1, 2].map((n) => f(m, { n }, "ja"))).toEqual(["other 0", "other 1", "other 2"]);
  });

  it("lets exact matches beat categories", () => {
    const m = "{n, plural, =0 {none} =1 {just one} one {# item} other {# items}}";
    expect([0, 1, 2].map((n) => f(m, { n }))).toEqual(["none", "just one", "2 items"]);
    expect(f("{n, plural, =0 {nul} one {#} other {#}}", { n: 0 }, "fr")).toBe("nul");
  });

  it("applies offset to categories and #, not to exact matches", () => {
    const m = "{n, plural, offset:1 =0 {nobody} =1 {{host}} one {{host} and # other} other {{host} and # others}}";
    expect(f(m, { n: 0, host: "Ann" })).toBe("nobody");
    expect(f(m, { n: 1, host: "Ann" })).toBe("Ann");
    expect(f(m, { n: 2, host: "Ann" })).toBe("Ann and 1 other");
    expect(f(m, { n: 5, host: "Ann" })).toBe("Ann and 4 others");
  });

  it("formats # in a select nested in a plural, and plurals nested in selects", () => {
    const m = "{n, plural, one {{g, select, a {# A} other {# X}}} other {{g, select, a {# As} other {# Xs}}}}";
    expect(f(m, { n: 1, g: "a" })).toBe("1 A");
    expect(f(m, { n: 3, g: "b" })).toBe("3 Xs");
    const outer = "{g, select, a {{n, plural, one {# a} other {# as}}} other {none}}";
    expect(f(outer, { g: "a", n: 2 })).toBe("2 as");
    // `#` outside any plural is text.
    expect(f("{g, select, a {#1} other {#2}}", { g: "a" })).toBe("#1");
  });

  it("formats # per locale", () => {
    const m = "{n, plural, other {#}}";
    expect(f(m, { n: 1234 })).toBe("1,234");
    expect(f(m, { n: 1234 }, "de")).toBe("1.234");
    expect(f(m, { n: 1234 }, "en-XA")).toBe("1,234");
  });

  it("formats a non-numeric argument as other with # as given", () => {
    const m = "{n, plural, one {# one} other {[#] other}}";
    expect(f(m, { n: "" })).toBe("[] other");
    expect(f(m, { n: "abc" })).toBe("[abc] other");
    expect(f(m, { n: "1" })).toBe("[1] other");
    expect(f(m, {})).toBe("[] other");
    expect(f(m)).toBe("[] other");
    expect(f(m, { n: Number.NaN })).toBe("[NaN] other");
    expect(f(m, { n: Number.POSITIVE_INFINITY })).toBe("[Infinity] other");
  });

  it("formats selectordinal with English ordinal rules", () => {
    const m = "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}";
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 101].map((n) => f(m, { n }))).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "22nd",
      "101st",
    ]);
  });
});

describe("select", () => {
  const m = "{role, select, admin {Admin} moderator {Mod} other {Member}}";

  it("picks the matching option, else other", () => {
    expect(f(m, { role: "admin" })).toBe("Admin");
    expect(f(m, { role: "moderator" })).toBe("Mod");
    expect(f(m, { role: "viewer" })).toBe("Member");
    expect(f(m, {})).toBe("Member");
    expect(f("{x, select, 1 {one} other {many}}", { x: 1 })).toBe("one");
    expect(f("{x, select, self_harm {sh} other {o}}", { x: "self_harm" })).toBe("sh");
  });
});

describe("apostrophes", () => {
  it("keeps a lone apostrophe literal", () => {
    expect(f("Allow {name}'s message", { name: "Ann" })).toBe("Allow Ann's message");
    expect(f("Don't", {})).toBe("Don't");
    expect(f("It's '5'", {})).toBe("It's '5'");
  });

  it("reads '' as one apostrophe", () => {
    expect(f("It''s")).toBe("It's");
    expect(f("''{name}''", { name: "x" })).toBe("'x'");
  });

  it("quotes braces and # with an apostrophe", () => {
    expect(f("'{literal}'")).toBe("{literal}");
    expect(f("Use '{name}' for {name}", { name: "Ann" })).toBe("Use {name} for Ann");
    expect(f("'{'unclosed")).toBe("{unclosed");
    expect(f("{n, plural, other {'#' is #}}", { n: 3 })).toBe("# is 3");
    expect(f("'{it''s}'")).toBe("{it's}");
  });
});

describe("syntax errors", () => {
  it.each([
    ["Hello {name", "Unclosed", 6],
    ["{n, plural, one {x} other {y}", "Unclosed", 0],
    ["{n, plural, one {x}}", "Missing 'other'", 19],
    ["{x, select, a {x}}", "Missing 'other'", 17],
    ["{n, selectordinal, one {x}}", "Missing 'other'", 26],
    ["{n, number}", "Unsupported argument type 'number'", 4],
    ["{d, date, short}", "Unsupported argument type 'date'", 4],
    ["{}", "Expected an argument name", 1],
    ["{ }", "Expected an argument name", 2],
    ["a } b", "Unmatched '}'", 2],
    ["{n, plural, few {a} lots {b} other {c}}", "Unknown plural category 'lots'", 20],
    ["{n, plural, one {a} one {b} other {c}}", "Duplicate option 'one'", 20],
    ["{n, plural, one x other {c}}", "Expected '{'", 16],
    ["{n, plural, =x {a} other {c}}", "Expected a number", 12],
    ["{n, plural, offset:x other {c}}", "Expected an offset", 19],
    ["{n, plural, one {a} other {b", "Unclosed", 26],
    ["{n plural}", "Expected ','", 3],
  ])("%j → %s at %i", (source, message, offset) => {
    const error = syntaxError(source);
    expect(error.message).toContain(message);
    expect(error.offset).toBe(offset);
  });

  it("is thrown by formatMessage too", () => {
    expect(() => formatMessage("{n, number}", { n: 1 }, "en")).toThrow(I18nSyntaxError);
  });
});

describe("printMessage", () => {
  it("round-trips through parse", () => {
    for (const source of [
      "Allow {name}'s message",
      "It''s '{literal}' and {name}'",
      "{n, plural, offset:1 =0 {none} one {# '#'} other {# items}}",
      "{g, select, a {{n, selectordinal, one {#st} other {#th}}} other {x}}",
    ]) {
      const ast = parseMessage(source);
      const printed = printMessage(ast);
      expect(parseMessage(printed)).toEqual(ast);
    }
  });
});

describe("createTranslator", () => {
  const fallback = { "a.one": "One {x}", "a.two": "Two", "a.plural": "{n, plural, one {# thing} other {# things}}" };

  it("falls back to English per key and reports the missing key", () => {
    const missing: string[] = [];
    const tr = createTranslator<keyof typeof fallback>({
      locale: "fr",
      messages: { "a.one": "Un {x}", "a.plural": "{n, plural, one {# chose} other {# choses}}" },
      fallback,
      onMissing: (key) => missing.push(key),
    });
    expect(tr("a.one", { x: 1 })).toBe("Un 1");
    expect(tr("a.two")).toBe("Two");
    expect(tr("a.two")).toBe("Two");
    expect(tr("a.plural", { n: 0 })).toBe("0 chose");
    expect(missing).toEqual(["a.two"]);
  });

  it("renders an unparsable message's raw source instead of throwing", () => {
    const missing: string[] = [];
    const tr = createTranslator<"k">({
      locale: "en",
      messages: { k: "{n, number}" },
      fallback: { k: "fine" },
      onMissing: (key) => missing.push(key),
    });
    expect(tr("k", { n: 1 })).toBe("{n, number}");
    expect(missing).toEqual(["k"]);
  });

  it("treats an empty translation as missing (Weblate's untranslated units)", () => {
    const missing: string[] = [];
    const tr = createTranslator<"k">({
      locale: "es",
      messages: { k: "" },
      fallback: { k: "English {x}" },
      onMissing: (key) => missing.push(key),
    });
    expect(tr("k", { x: 1 })).toBe("English 1");
    expect(missing).toEqual(["k"]);
  });

  it("returns the key itself when no catalog has it", () => {
    const tr = createTranslator<string>({ locale: "en", messages: {}, fallback: {} });
    expect(tr("nope.key")).toBe("nope.key");
  });

  it("ignores inherited object properties", () => {
    const tr = createTranslator<string>({ locale: "en", messages: {}, fallback: { "a.b": "x" } });
    expect(tr("toString")).toBe("toString");
  });
});
