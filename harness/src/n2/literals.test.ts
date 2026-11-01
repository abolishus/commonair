// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { pseudoLocalize } from "../../../packages/i18n/src/pseudo.ts";
import {
  LITERAL_ALLOWLIST,
  PSEUDO_LETTERS,
  type ScannedNode,
  findLiterals,
  intlWords,
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

  test("ASCII inside a pseudo segment (an interpolated value) is not flagged", () => {
    expect(untranslatedWords(pseudoLocalize("Welcome back, {name}").replace("{name}", "anything"))).toEqual([]);
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

  test("dates and times from Intl are ignored when the vocabulary is given", () => {
    const vocabulary = intlWords(["en-XA", "en"]);
    const relative = new Intl.RelativeTimeFormat("en-XA", { numeric: "auto" });
    const date = new Intl.DateTimeFormat("en-XA", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
    for (const text of [
      relative.format(-5, "minute"),
      relative.format(-1, "day"),
      relative.format(0, "second"),
      date.format(new Date(Date.UTC(2026, 9, 31, 15, 4))),
      new Intl.NumberFormat("en-XA", { notation: "compact" }).format(12_300),
    ])
      expect(untranslatedWords(text, { vocabulary })).toEqual([]);
    // Without it, the English month is caught.
    expect(untranslatedWords(date.format(new Date(Date.UTC(2026, 9, 31))))).toContain("Oct");
  });

  test("vocabulary does not hide other words in the same text", () => {
    const vocabulary = intlWords(["en"]);
    expect(untranslatedWords("Started 5 minutes ago", { vocabulary })).toEqual(["Started"]);
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

describe("intlWords", () => {
  test("covers month, weekday and relative-time words, lowercased", () => {
    const words = new Set(intlWords(["en"]));
    for (const w of ["october", "oct", "friday", "ago", "yesterday", "minutes"]) expect(words.has(w)).toBe(true);
  });

  test("an unknown locale tag adds nothing and does not throw", () => {
    expect(() => intlWords(["not a tag!"])).not.toThrow();
  });
});
