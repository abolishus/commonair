// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { SITE, type InstanceSite } from "@commonair/config/site";
// Not exported from @commonair/db yet (contract request); read the shipped drafts directly.
import { LEGAL_PLACEHOLDERS, legalSeedDocuments } from "@commonair/db";
import { legalVariables, normalizeConsentChoices, renderLegalText } from "../src/lib/legal.ts";

const site: InstanceSite = {
  name: "Example Air",
  publicUrl: "https://example.test",
  contacts: { ...SITE.contacts, privacy: "privacy@example.test", dmca: "dmca@example.test" },
  sourceUrl: "https://source.example.test/commonair/",
  sourceCommit: "abc123",
  isFlagship: false,
};
const vars = legalVariables(site, 16);

describe("legalVariables", () => {
  test("covers every placeholder the shipped drafts may use", () => {
    for (const p of LEGAL_PLACEHOLDERS) expect(vars[p], p).toBeTypeOf("string");
  });

  test("uses the instance identity, the source link and the configured minimum age", () => {
    expect(vars.instanceName).toBe("Example Air");
    expect(vars["contacts.privacy"]).toBe("privacy@example.test");
    expect(vars["contacts.dmca"]).toBe("dmca@example.test");
    expect(vars.sourceUrl).toBe("https://source.example.test/commonair/tree/abc123");
    expect(vars.minAge).toBe("16");
  });
});

describe("renderLegalText", () => {
  test("fills known placeholders, with or without inner spaces", () => {
    expect(renderLegalText("Hi {{instanceName}} / {{ contacts.privacy }}", vars)).toBe(
      "Hi Example Air / privacy@example.test",
    );
  });

  test("leaves unknown placeholders and plain braces alone", () => {
    expect(renderLegalText("{{nope}} {{contacts.nobody}} { x } {{}}", vars)).toBe(
      "{{nope}} {{contacts.nobody}} { x } {{}}",
    );
  });

  test("values are inserted literally (no replacement patterns)", () => {
    expect(renderLegalText("{{instanceName}}", { instanceName: "$& $1 $$" })).toBe("$& $1 $$");
  });

  test("every shipped draft renders completely", () => {
    for (const d of legalSeedDocuments()) {
      const body = renderLegalText(d.body, vars);
      expect(body, d.kind).not.toContain("{{");
      expect(body, d.kind).toContain("Example Air");
    }
  });
});

describe("normalizeConsentChoices", () => {
  test("essential is always on and missing optional categories are off", () => {
    expect(normalizeConsentChoices({})).toEqual({ ok: true, choices: { essential: true, preferences: false } });
    expect(normalizeConsentChoices({ essential: false, preferences: true })).toEqual({
      ok: true,
      choices: { essential: true, preferences: true },
    });
  });

  test("unknown categories are refused", () => {
    expect(normalizeConsentChoices({ preferences: true, analytics: true })).toEqual({
      ok: false,
      reason: "Unknown consent categories: analytics",
    });
  });

  test("the refusal echoes at most five unknown keys, each truncated to 32 characters", () => {
    const long = "x".repeat(500);
    const r = normalizeConsentChoices({ [long]: true, a: true, b: true, c: true, d: true, e: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe(`Unknown consent categories: ${"x".repeat(32)}, a, b, c, d`);
  });
});
