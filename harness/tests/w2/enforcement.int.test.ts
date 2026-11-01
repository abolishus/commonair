// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The raw queries of the `enforcement` and `sor-resolve` extensions against a real database:
 * `audit_log.subject_id` is text while statement and appeal ids are uuid, so a parameter cast to
 * the wrong one fails with `operator does not exist` (batch 7 CI, run 41357496846).
 */
import { createDb, schema, uuidv7, type DbHandle } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import {
  rawCell,
  resolveAudit,
  resolveStatementProblems,
  SOR_RESOLVE_CLAUSE,
  statementsOf,
  T2_CELL,
} from "../../src/w2/enforcement.ts";

let t: TestDatabase;
let h: DbHandle;
const reportId = uuidv7();
const dismissedId = uuidv7();
const targetId = uuidv7();
const modActionId = uuidv7();
const endsAt = new Date("2026-11-01T23:51:46.123Z");
let auditId = "";

beforeAll(async () => {
  t = await createTestDatabase();
  h = createDb({ url: t.url, max: 1 });
  const past = new Date(Date.now() - 86_400_000);
  const [g, n] = await h.db
    .insert(schema.legalDocuments)
    .values([
      { kind: "guidelines", version: "sor-g", title: "G", body: "g", publishedAt: past },
      { kind: "enforcement_notice", version: "sor-n", title: "N", body: "n", publishedAt: past },
    ])
    .returning({ id: schema.legalDocuments.id });
  // What `safety.resolve` writes (`services/api/src/routes/safety.ts`): subject id is the report's uuid as text.
  const [a] = await h.db
    .insert(schema.auditLog)
    .values({
      actorType: "admin",
      action: "report.resolve",
      subjectType: "report",
      subjectId: reportId,
      details: { reportId, suspended: true, modActionId, clauseId: SOR_RESOLVE_CLAUSE },
    })
    .returning({ id: schema.auditLog.id });
  auditId = a?.id ?? "";
  await h.db.insert(schema.auditLog).values({
    actorType: "admin",
    action: "report.resolve",
    subjectType: "report",
    subjectId: dismissedId,
    details: { reportId: dismissedId, suspended: false },
  });
  // A same-subject row of another action is never read as the resolution.
  await h.db.insert(schema.auditLog).values({
    actorType: "admin",
    action: "report.create",
    subjectType: "report",
    subjectId: reportId,
  });
  // What the builder writes for it (`services/worker/src/moderation/sor-build.ts`, `staffStatement`).
  await h.db.insert(schema.enforcementStatements).values({
    sourceAuditId: auditId,
    sourceAction: "report.resolve",
    recipientUserId: targetId,
    contentType: "account",
    contentId: targetId,
    restrictionKind: "account",
    restrictionDetail: "suspended",
    restrictionEndsAt: endsAt,
    facts: { code: "moderator_review", caseId: modActionId, caseOrigin: "human", decision: "suspend" },
    source: "notice_art16",
    automatedDetection: false,
    automatedDecision: "not",
    groundKind: "terms",
    clauseId: SOR_RESOLVE_CLAUSE,
    clauseVersion: 1,
    guidelinesDocumentId: g?.id ?? "",
    noticeDocumentId: n?.id ?? "",
    appealSubjectType: "moderation_action",
    appealSubjectId: modActionId,
    createdAt: new Date(endsAt.getTime() - 3_600_000),
  });
});

afterAll(async () => {
  await h?.close();
  await t?.drop();
});

describe("sor-resolve queries", () => {
  test("resolveAudit finds a report's resolution by the text subject id", async () => {
    const a = await resolveAudit(h, reportId);
    expect(a?.id).toBe(auditId);
    expect(a?.details).toMatchObject({ suspended: true, modActionId, clauseId: SOR_RESOLVE_CLAUSE });
    expect((await resolveAudit(h, dismissedId))?.details).toMatchObject({ suspended: false });
    expect(await resolveAudit(h, uuidv7())).toBeNull();
  });

  test("statementsOf reads the statement in the shape resolveStatementProblems checks", async () => {
    const rows = await statementsOf(h, auditId);
    expect(rows).toHaveLength(1);
    const s = rows[0];
    expect(s).toBeDefined();
    if (!s) return;
    expect(s.restrictionEndsAt).toBe(endsAt.toISOString());
    expect(
      resolveStatementProblems(s, { targetId, modActionId, clauseId: SOR_RESOLVE_CLAUSE, endsAtMs: endsAt.getTime() }),
    ).toEqual([]);
    const dismissed = await resolveAudit(h, dismissedId);
    expect(await statementsOf(h, dismissed?.id ?? uuidv7())).toEqual([]);
  });
});

describe("enforcement queries", () => {
  test("rawCell runs against the schema (uuid appeal subjects, text source actions)", async () => {
    expect(await rawCell(h, T2_CELL, new Date(0))).toEqual({ count: 0, fully: 0, overturned: 0 });
  });
});
