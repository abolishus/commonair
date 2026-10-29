// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vite-plus/test";
import { PSEUDO_LOCALE, formatMessage, parseMessage, pseudoLocalize } from "../src/index.ts";

describe("pseudoLocalize", () => {
  it("is en-XA", () => {
    expect(PSEUDO_LOCALE).toBe("en-XA");
  });

  it("accents every ASCII letter, brackets and pads the text", () => {
    const out = pseudoLocalize("Sign in");
    expect(out.startsWith("[")).toBe(true);
    expect(out.endsWith("]")).toBe(true);
    expect(out).toMatch(/^\[Šîĝñ îñ~+\]$/);
    expect(out).not.toMatch(/[A-Za-z]/);
  });

  it("is about 35% longer", () => {
    const source = "Live streaming, owned by the people who make it";
    const out = pseudoLocalize(source);
    const padded = out.length - 2;
    expect(padded / source.length).toBeGreaterThanOrEqual(1.35);
    expect(padded / source.length).toBeLessThan(1.4);
  });

  it("is deterministic", () => {
    expect(pseudoLocalize("Hello {name}")).toBe(pseudoLocalize("Hello {name}"));
  });

  it("keeps placeholders, plural/select syntax and #", () => {
    expect(pseudoLocalize("Welcome to {name}")).toMatch(/^\[Ŵéļçöɱé ţö \{name\}~+\]$/);
    const plural = pseudoLocalize("{count, plural, =0 {none} one {# vote} other {# votes}}");
    expect(plural).toContain("{count, plural, =0 {ñöñé} one {# ṽöţé} other {# ṽöţéš}}");
    expect(formatMessage(plural, { count: 2 }, "en-XA")).toMatch(/^\[2 ṽöţéš~+\]$/);
    const select = pseudoLocalize("{role, select, admin {Admin} other {Member}}");
    expect(formatMessage(select, { role: "admin" }, "en-XA")).toMatch(/^\[Åðɱîñ~+\]$/);
    const ordinal = pseudoLocalize("{n, selectordinal, one {#st} other {#th}}");
    expect(formatMessage(ordinal, { n: 1 }, "en-XA")).toMatch(/^\[1šţ~+\]$/);
  });

  it("keeps apostrophes and quoted literals meaning the same", () => {
    const out = pseudoLocalize("Allow {name}'s message");
    expect(formatMessage(out, { name: "Ann" }, "en-XA")).toMatch(/^\[Åļļöŵ Ann'š ɱéššåĝé~+\]$/);
    expect(formatMessage(pseudoLocalize("It''s '{literal}'"), {}, "en-XA")).toMatch(/^\[Îţ'š \{ļîţéŕåļ\}~+\]$/);
    expect(formatMessage(pseudoLocalize("{n, plural, other {'#' #}}"), { n: 3 }, "en-XA")).toMatch(/^\[# 3~*\]$/);
    // The output is always a valid message.
    expect(() => parseMessage(pseudoLocalize("x' {a}'"))).not.toThrow();
  });

  it("leaves an empty string empty and survives a message that does not parse", () => {
    expect(pseudoLocalize("")).toBe("");
    expect(pseudoLocalize("a { b")).toBe("[å { ƀ]");
  });
});
