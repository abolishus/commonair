// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Seeds: legal drafts are inserted once per (kind, version) and never rewritten. */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { LEGAL_DOCUMENT_KINDS } from "@commonair/contracts/enums";
import { PROTECTED_LITERALS } from "@commonair/config/site";
import {
  ENFORCEMENT_NOTICE_SEED_VERSION,
  LEGAL_PLACEHOLDERS,
  LEGAL_SEED_VERSION,
  PLACEHOLDER_PATTERN,
  legalSeedDocuments,
  stripSpdxHeader,
} from "../src/legal/index.ts";
import { legalDocuments } from "../src/schema/safety.ts";
import { seedLegalDocuments } from "../src/seed.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

// Suites run in parallel with every other workspace: generous deadlines for tests, and for teardown,
// since Postgres runs DROP DATABASE one at a time.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

describe("legal seed documents", () => {
  const docs = legalSeedDocuments();

  test("one draft per kind, at the seed version (the enforcement notice at its own)", () => {
    expect(docs.map((d) => d.kind).sort()).toEqual([...LEGAL_DOCUMENT_KINDS].sort());
    for (const d of docs) {
      expect(d.version, d.kind).toBe(
        d.kind === "enforcement_notice" ? ENFORCEMENT_NOTICE_SEED_VERSION : LEGAL_SEED_VERSION,
      );
      expect(d.isDraft).toBe(true);
    }
    expect(ENFORCEMENT_NOTICE_SEED_VERSION).not.toBe(LEGAL_SEED_VERSION);
  });

  test("terms, privacy and guidelines require acceptance; cookies, DMCA and the enforcement notice do not", () => {
    const required = Object.fromEntries(docs.map((d) => [d.kind, d.requiresAcceptance]));
    expect(required).toEqual({
      terms: true,
      privacy: true,
      guidelines: true,
      cookies: false,
      dmca_policy: false,
      enforcement_notice: false,
    });
  });

  test("each opens with the draft notice and has a reasonable length", () => {
    for (const d of docs) {
      expect(d.body.startsWith("> **Draft pending lawyer review.**"), d.kind).toBe(true);
      const words = d.body.split(/\s+/).filter(Boolean).length;
      // The enforcement notice is a skeleton (banner, placeholders, headings) until W0-sor writes it.
      const min = d.kind === "enforcement_notice" ? 0 : 300;
      expect(words, d.kind).toBeGreaterThanOrEqual(min);
      expect(words, d.kind).toBeLessThanOrEqual(900);
    }
  });

  test("the enforcement notice has its redress section", () => {
    const notice = docs.find((d) => d.kind === "enforcement_notice");
    expect(notice?.body).toContain("## How to challenge this decision");
  });

  test("no SPDX header, identity literal or unknown placeholder in a body", () => {
    const known = new Set<string>(LEGAL_PLACEHOLDERS);
    for (const d of docs) {
      expect(d.body).not.toContain("SPDX");
      for (const literal of PROTECTED_LITERALS) expect(d.body, d.kind).not.toContain(literal);
      for (const m of d.body.matchAll(PLACEHOLDER_PATTERN))
        expect(known.has(m[1] ?? ""), `${d.kind}: ${m[0]}`).toBe(true);
      expect(d.body).toContain("{{instanceName}}");
    }
  });

  test("stripSpdxHeader removes only the leading comment", () => {
    expect(stripSpdxHeader("<!--\nSPDX\n-->\n\nHello <!-- keep -->")).toBe("Hello <!-- keep -->\n");
    expect(stripSpdxHeader("No header")).toBe("No header\n");
  });
});

describe("seedLegalDocuments", () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await t?.drop();
  });

  // A published row is immutable (0029), so the operator's own version of a seeded (kind, version)
  // is inserted before the first seed rather than edited after it.
  test("an existing row is never rewritten", async () => {
    const terms = legalSeedDocuments().find((d) => d.kind === "terms");
    if (!terms) throw new Error("no terms seed");
    await t.db.insert(legalDocuments).values({ ...terms, title: "Edited by an operator" });
    expect(await seedLegalDocuments(t.db)).toBe(LEGAL_DOCUMENT_KINDS.length - 1);
    const [row] = await t.db.select().from(legalDocuments).where(eq(legalDocuments.kind, "terms"));
    expect(row?.title).toBe("Edited by an operator");
  });

  test("seeding again inserts nothing; one row per kind", async () => {
    expect(await seedLegalDocuments(t.db)).toBe(0);
    const rows = await t.db.select().from(legalDocuments);
    expect(rows.map((r) => r.kind).sort()).toEqual([...LEGAL_DOCUMENT_KINDS].sort());
    const notice = rows.find((r) => r.kind === "enforcement_notice");
    expect(notice?.version).toBe(ENFORCEMENT_NOTICE_SEED_VERSION);
    expect(notice?.requiresAcceptance).toBe(false);
    for (const r of rows) expect(r.isDraft).toBe(true);
  });
});
