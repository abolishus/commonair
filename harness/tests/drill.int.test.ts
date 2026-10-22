// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The drill's database half against a real Postgres (a throwaway test database, never the
 * stack's): the demo seed and ledger postings as the app role, the fingerprint, the marker
 * comparison, the refusal checks, and that tampering with a protection is caught. The podman
 * half (backup, wipe, restore) runs only in the `backup-restore` scenario.
 */
import { TEST_APP_ROLE, type TestDatabase, createTestDatabase } from "@commonair/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { collectFingerprint, compareFingerprints, missingRequired } from "../src/drill/fingerprint.ts";
import {
  REFUSALS,
  postDrillLedger,
  postMarker,
  refusalChecks,
  refusalProblems,
  seedDemoAsAppRole,
} from "../src/drill/seed.ts";

let t: TestDatabase;
const runId = `it${Date.now().toString(36)}`;

beforeAll(async () => {
  t = await createTestDatabase();
}, 120_000);
afterAll(async () => {
  await t?.drop();
});

describe("restore drill against Postgres", () => {
  test("seed, fingerprint, marker, refusals, and tampering is caught", async () => {
    await seedDemoAsAppRole(t.appUrl);
    const posted = await postDrillLedger(t.appUrl, runId, 5);
    expect(new Set(posted).size).toBe(5);

    const before = await collectFingerprint(t.sql, TEST_APP_ROLE);
    expect(missingRequired(before)).toEqual([]);
    expect(before.imbalances).toEqual([]);
    expect(before.rowCounts.ledger_transactions).toBeGreaterThanOrEqual(5);
    expect(before.rowCounts.users).toBeGreaterThan(0);
    expect(before.rowCounts.audit_log).toBeGreaterThan(0);
    expect(before.triggers.every((x) => x.enabled === "O")).toBe(true);

    const marker = await postMarker(t.appUrl, runId);
    const after = await collectFingerprint(t.sql, TEST_APP_ROLE, [marker.transactionId]);
    expect(compareFingerprints(before, after, marker)).toEqual([]);

    const refusals = await refusalChecks(t.appUrl);
    expect(refusals.map((r) => r.name)).toEqual([...REFUSALS]);
    expect(refusalProblems(refusals)).toEqual([]);
    // The refused writes left nothing behind.
    const again = await collectFingerprint(t.sql, TEST_APP_ROLE, [marker.transactionId]);
    expect(compareFingerprints(before, again, marker)).toEqual([]);

    // Tamper on this throwaway database only, as its owner, and check the comparison sees it.
    await t.sql.unsafe("alter table ledger_entries disable trigger ledger_entries_append_only");
    await t.sql.unsafe(`revoke update on public.users from ${TEST_APP_ROLE}`);
    try {
      const tampered = await collectFingerprint(t.sql, TEST_APP_ROLE, [marker.transactionId]);
      const problems = compareFingerprints(before, tampered, marker);
      expect(problems).toContain("trigger ledger_entries.ledger_entries_append_only enabled state O → D");
      expect(problems).toContain("after restore: trigger ledger_entries.ledger_entries_append_only is disabled");
      expect(problems).toContain("grant UPDATE on users missing after restore");
    } finally {
      await t.sql.unsafe("alter table ledger_entries enable trigger ledger_entries_append_only");
      await t.sql.unsafe(`grant update on public.users to ${TEST_APP_ROLE}`);
    }
  }, 120_000);
});
