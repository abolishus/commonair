// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Seeds: legal drafts are inserted once per (kind, version) and never rewritten. */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { LEGAL_DOCUMENT_KINDS } from "@commonair/contracts/enums";
import { PROTECTED_LITERALS } from "@commonair/config/site";
import {
  LEGAL_PLACEHOLDERS,
  LEGAL_SEED_VERSION,
  PLACEHOLDER_PATTERN,
  legalSeedDocuments,
  stripSpdxHeader,
} from "../src/legal/index.ts";
import { legalDocuments } from "../src/schema/safety.ts";
import { seedLegalDocuments } from "../src/seed.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

describe("legal seed documents", () => {
  const docs = legalSeedDocuments();

  test("one draft per kind, at the seed version", () => {
    expect(docs.map((d) => d.kind).sort()).toEqual([...LEGAL_DOCUMENT_KINDS].sort());
    for (const d of docs) {
      expect(d.version).toBe(LEGAL_SEED_VERSION);
      expect(d.isDraft).toBe(true);
    }
  });

  test("terms, privacy and guidelines require acceptance; cookies and DMCA do not", () => {
    const required = Object.fromEntries(docs.map((d) => [d.kind, d.requiresAcceptance]));
    expect(required).toEqual({ terms: true, privacy: true, guidelines: true, cookies: false, dmca_policy: false });
  });

  test("each opens with the draft notice and has a reasonable length", () => {
    for (const d of docs) {
      expect(d.body.startsWith("> **Draft pending lawyer review.**"), d.kind).toBe(true);
      const words = d.body.split(/\s+/).filter(Boolean).length;
      expect(words, d.kind).toBeGreaterThanOrEqual(300);
      expect(words, d.kind).toBeLessThanOrEqual(900);
    }
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

  test("seeding twice inserts each document once", async () => {
    await seedLegalDocuments(t.db);
    expect(await seedLegalDocuments(t.db)).toBe(0);
    const rows = await t.db.select().from(legalDocuments).where(eq(legalDocuments.version, LEGAL_SEED_VERSION));
    expect(rows.map((r) => r.kind).sort()).toEqual([...LEGAL_DOCUMENT_KINDS].sort());
    for (const r of rows) expect(r.isDraft).toBe(true);
  });

  test("an existing row is never rewritten", async () => {
    await t.db.update(legalDocuments).set({ title: "Edited by an operator" }).where(eq(legalDocuments.kind, "terms"));
    expect(await seedLegalDocuments(t.db)).toBe(0);
    const [terms] = await t.db.select().from(legalDocuments).where(eq(legalDocuments.kind, "terms"));
    expect(terms?.title).toBe("Edited by an operator");
  });
});
