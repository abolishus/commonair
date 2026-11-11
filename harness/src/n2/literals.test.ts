// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { pseudoLocalize } from "../../../packages/i18n/src/pseudo.ts";
import {
  LITERAL_ALLOWLIST,
  PSEUDO_LETTERS,
  type ScannedNode,
  findLiterals,
  intlPhrases,
  phrasePattern,
  stripPseudoSegments,
  untranslatedWords,
} from "./literals.ts";

const node = (text: string, kind: ScannedNode["kind"] = "text"): ScannedNode => ({ kind, text, selector: "p" });

describe("PSEUDO_LETTERS", () => {
  test("has one accented letter per ASCII letter, none of them ASCII", () => {
    expect(PSEUDO_LETTERS.size).toBe(52);
    for (const ch of PSEUDO_LETTERS) expect(/[A-Za-z]/.test(ch)).toBe(false);
  });
});

describe("untranslatedWords", () => {
  test("a pseudo-localized string passes", () => {
    for (const source of ["Settings", "Sign in", "Go live now", "Free software under the AGPL-3.0", "Chat"])
      expect(untranslatedWords(pseudoLocalize(source))).toEqual([]);
  });

  test("a pseudo-localized message with plural and arguments passes once formatted", () => {
    const shaped = pseudoLocalize("{count, plural, one {# viewer} other {# viewers}}");
    // What the formatter renders for count=12: the branch's accented text.
    const branch = /other \{([^}]*)\}/.exec(shaped)?.[1]?.replace("#", "12") ?? "";
    expect(untranslatedWords(`[${branch}~~]`)).toEqual([]);
  });

  test("an English literal is flagged", () => {
    expect(untranslatedWords("Settings")).toEqual(["Settings"]);
    expect(untranslatedWords("Stream key copied")).toEqual(["Stream", "key", "copied"]);
  });

  test("runs shorter than three letters are not flagged", () => {
    expect(untranslatedWords("OK · ID · a b")).toEqual([]);
  });

  test("a mixed node flags only the English", () => {
    expect(untranslatedWords(`${pseudoLocalize("Settings")} Settings`)).toEqual(["Settings"]);
    expect(untranslatedWords(`Profile ${pseudoLocalize("Settings")}`)).toEqual(["Profile"]);
  });

  test("an interpolated nested message goes with its parent", () => {
    const inner = pseudoLocalize("Settings");
    const outer = pseudoLocalize("Open {page}").replace("{page}", inner);
    expect(untranslatedWords(outer)).toEqual([]);
  });

  test("a hard-coded English argument inside a pseudo message is flagged", () => {
    const welcome = pseudoLocalize("Welcome back, {name}");
    expect(untranslatedWords(welcome.replace("{name}", "Settings"))).toEqual(["Settings"]);
    expect(untranslatedWords(pseudoLocalize("Open {page}").replace("{page}", "Settings page"))).toEqual([
      "Settings",
      "page",
    ]);
  });

  test("a user-content or number argument inside a pseudo message is not flagged", () => {
    const welcome = pseudoLocalize("Welcome back, {name}");
    expect(untranslatedWords(welcome.replace("{name}", "e2e_fan_abc"), { userContent: ["e2e_fan_abc"] })).toEqual([]);
    expect(untranslatedWords(pseudoLocalize("{count} viewers").replace("{count}", "1,234"))).toEqual([]);
  });

  test("an Intl argument inside a pseudo message is not flagged", () => {
    const phrases = intlPhrases({ locales: ["en"] });
    const started = pseudoLocalize("Started {when}").replace("{when}", "5 minutes ago");
    expect(untranslatedWords(started, { intlPhrases: phrases })).toEqual([]);
  });

  test("a bracket that is not pseudo keeps its English", () => {
    expect(stripPseudoSegments("[beta] ok")).toBe("[beta] ok");
    expect(untranslatedWords("[beta]")).toEqual(["beta"]);
  });

  test("user content is ignored, case-insensitively and inside longer text", () => {
    const userContent = ["e2e_st_abc123", "hello from e2e_fan_x run42", "My test stream"];
    expect(untranslatedWords("e2e_st_abc123", { userContent })).toEqual([]);
    expect(untranslatedWords("E2E_ST_ABC123", { userContent })).toEqual([]);
    expect(untranslatedWords(`${pseudoLocalize("Live")} My test stream`, { userContent })).toEqual([]);
    expect(untranslatedWords("hello from e2e_fan_x run42 · Reply", { userContent })).toEqual(["Reply"]);
    // A handle the scenario never saw (another run's live channel in the side rail) is not text.
    expect(untranslatedWords("e2e_st_239acg")).toEqual([]);
    expect(untranslatedWords("e2e_st_239acg · Live now")).toEqual(["Live", "now"]);
  });

  test("allowlisted terms are ignored, case-sensitively", () => {
    expect(untranslatedWords("OBS RTMP HLS")).toEqual([]);
    expect(untranslatedWords("obs")).toEqual(["obs"]);
    expect(untranslatedWords("OBS", { allowlist: [] })).toEqual(["OBS"]);
  });

  test("every allowlist entry has a reason", () => {
    for (const entry of LITERAL_ALLOWLIST) expect(entry.reason.length).toBeGreaterThan(5);
  });

  test("numbers, URLs, e-mail addresses and hosts are ignored", () => {
    expect(untranslatedWords("1,234 · 12.5% · 00:42:17 · 2026-10-31T12:00:00Z")).toEqual([]);
    expect(untranslatedWords("rtmp://ingest.example.test:1935/live")).toEqual([]);
    expect(untranslatedWords("https://web.example.test/media/avatar.png?x=abc")).toEqual([]);
    expect(untranslatedWords("someone@example.test")).toEqual([]);
    expect(untranslatedWords("localhost:3000/dashboard")).toEqual([]);
  });

  test("addresses and hosts do not swallow English next to them", () => {
    expect(untranslatedWords("alice@example.test Settings")).toEqual(["Settings"]);
    expect(untranslatedWords("Saved.Next")).toEqual(["Saved", "Next"]);
    expect(untranslatedWords("e.g.Settings")).toEqual(["Settings"]);
  });

  test("keyboard shortcuts are not words, but English next to them is", () => {
    expect(untranslatedWords("alt+T")).toEqual([]);
    expect(untranslatedWords("Ctrl+Shift+K")).toEqual([]);
    expect(untranslatedWords("Notifications alt+T")).toEqual(["Notifications"]);
    expect(untranslatedWords("Alternative")).toEqual(["Alternative"]);
  });

  test("dates, times, numbers and language names from Intl are ignored when given", () => {
    const phrases = intlPhrases({ locales: ["en-XA", "en"], languages: ["en", "es"] });
    const relative = new Intl.RelativeTimeFormat("en-XA", { numeric: "auto" });
    const date = new Intl.DateTimeFormat("en-XA", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
    for (const text of [
      relative.format(-5, "minute"),
      relative.format(-17, "minute"),
      relative.format(-1, "day"),
      relative.format(0, "second"),
      relative.format(1, "week"),
      date.format(new Date(Date.UTC(2026, 9, 31, 15, 4))),
      new Intl.DateTimeFormat("en", { dateStyle: "long", timeStyle: "short" }).format(
        new Date(Date.UTC(2026, 4, 9, 9)),
      ),
      new Intl.NumberFormat("en-XA", { notation: "compact", maximumFractionDigits: 1 }).format(12_300),
      new Intl.NumberFormat("en", { notation: "compact", compactDisplay: "long" }).format(1_200_000),
      new Intl.NumberFormat("en", { style: "currency", currency: "USD", currencyDisplay: "name" }).format(1234.5),
      "English",
      "Español",
      "Spanish",
    ])
      expect(untranslatedWords(text, { intlPhrases: phrases }), text).toEqual([]);
    // Without them, the English month is caught.
    expect(untranslatedWords(date.format(new Date(Date.UTC(2026, 9, 31))))).toContain("Oct");
  });

  test("Intl words on their own, or in other case, are still flagged", () => {
    const phrases = intlPhrases({ locales: ["en-XA", "en"], languages: ["en", "es"] });
    for (const text of ["Next", "Last", "Today", "Now", "This", "Time", "Per"])
      expect(untranslatedWords(text, { intlPhrases: phrases })).toEqual([text]);
    expect(untranslatedWords("Next page", { intlPhrases: phrases })).toEqual(["Next", "page"]);
    // "next week" is an Intl phrase; "Next" alone is a label.
    expect(untranslatedWords("next week · Next", { intlPhrases: phrases })).toEqual(["Next"]);
    expect(untranslatedWords("you may continue", { intlPhrases: phrases })).toEqual(["you", "may", "continue"]);
  });

  test("Intl phrases do not hide other words in the same text", () => {
    const phrases = intlPhrases({ locales: ["en"] });
    expect(untranslatedWords("Started 5 minutes ago", { intlPhrases: phrases })).toEqual(["Started"]);
    expect(untranslatedWords("Octopus", { intlPhrases: phrases })).toEqual(["Octopus"]);
  });
});

describe("findLiterals", () => {
  test("returns only nodes with hits, keeping kind and selector", () => {
    const nodes: ScannedNode[] = [
      node(pseudoLocalize("Dashboard")),
      { kind: "aria-label", text: "Close", selector: '[data-testid="x"] > button:nth-of-type(1)' },
      node("e2e_st_abc"),
      { kind: "placeholder", text: pseudoLocalize("Send a message"), selector: "input:nth-of-type(1)" },
    ];
    expect(findLiterals(nodes, { userContent: ["e2e_st_abc"] })).toEqual([
      { kind: "aria-label", text: "Close", selector: '[data-testid="x"] > button:nth-of-type(1)', words: ["Close"] },
    ]);
  });

  test("an empty page has no hits", () => {
    expect(findLiterals([])).toEqual([]);
  });
});

describe("intlPhrases", () => {
  test("covers month, weekday, relative-time and language phrases", () => {
    const phrases = new Set(intlPhrases({ locales: ["en"], languages: ["es"] }));
    for (const p of ["October", "Oct", "Monday", "Wed", "Friday", "yesterday", "next week", "Spanish", "Español"])
      expect(phrases.has(p), p).toBe(true);
    expect([...phrases].some((p) => /^\d+ minutes ago$/.test(p))).toBe(true);
  });

  test("an unknown locale tag adds nothing and does not throw", () => {
    expect(() => intlPhrases({ locales: ["not a tag!"], languages: ["also not!"] })).not.toThrow();
  });
});

describe("phrasePattern", () => {
  test("generalizes numbers and spaces, and matches whole phrases only", () => {
    const re = phrasePattern(["5 minutes ago", "1.2K"]);
    expect(re).not.toBeNull();
    expect("12 minutes\u00a0ago".replace(re as RegExp, "")).toBe("");
    expect("3.4K".replace(re as RegExp, "")).toBe("");
    expect("x5 minutes ago".replace(re as RegExp, "")).toBe("x5 minutes ago");
  });

  test("no phrases with letters gives no pattern", () => {
    expect(phrasePattern([])).toBeNull();
    expect(phrasePattern(["1,234", "  "])).toBeNull();
  });
});
