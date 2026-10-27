// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * W0 schema (0028, 0029; ADR 0019): statements of reasons are append-only for every role and the
 * app role holds no UPDATE/DELETE on them; deliveries stay mutable; a published legal document
 * is immutable for every role and an unpublished one changes only as the owner.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import type { Database } from "../src/client.ts";
import { uuidv7 } from "../src/ids.ts";
import * as s from "../src/schema/index.ts";
import { createTestDatabase, TEST_APP_ROLE, type TestDatabase } from "../src/testing.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let app: Database;
let guidelinesId: string;
let noticeId: string;

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
  const past = new Date(Date.now() - 86_400_000);
  const [g, n] = await t.db
    .insert(s.legalDocuments)
    .values([
      { kind: "guidelines", version: "w0-g", title: "G", body: "g", publishedAt: past },
      { kind: "enforcement_notice", version: "w0-n", title: "N", body: "n", publishedAt: past },
    ])
    .returning({ id: s.legalDocuments.id });
  guidelinesId = g!.id;
  noticeId = n!.id;
});
afterAll(async () => {
  await t?.drop();
});

async function expectPgError(p: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  const err = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, "expected the database to reject").toBeInstanceOf(Error);
  const e = err as Error & { cause?: Error };
  expect(e.cause?.message ?? e.message).toMatch(pattern);
}

async function auditRow(action = "moderation.t2.label"): Promise<string> {
  const [a] = await app
    .insert(s.auditLog)
    .values({ actorType: "system", action, subjectType: "moderation_case", subjectId: uuidv7() })
    .returning({ id: s.auditLog.id });
  return a!.id;
}

function statement(sourceAuditId: string, over: Partial<typeof s.enforcementStatements.$inferInsert> = {}) {
  return {
    sourceAuditId,
    sourceAction: "moderation.t2.label",
    recipientUserId: uuidv7(),
    channelId: uuidv7(),
    contentType: "broadcast" as const,
    contentId: uuidv7(),
    restrictionKind: "visibility" as const,
    restrictionDetail: "age_gated" as const,
    facts: {
      code: "classifier" as const,
      category: "sexual" as const,
      tier: "t2" as const,
      threshold: 0.8,
      capturedAt: new Date().toISOString(),
    },
    source: "own_initiative" as const,
    automatedDetection: true,
    automatedDecision: "fully" as const,
    groundKind: "terms" as const,
    clauseId: "mature.unlabelled",
    clauseVersion: 1,
    guidelinesDocumentId: guidelinesId,
    noticeDocumentId: noticeId,
    appealSubjectType: "content_label",
    appealSubjectId: uuidv7(),
    createdAt: new Date(),
    ...over,
  };
}

async function insertStatement(over: Partial<typeof s.enforcementStatements.$inferInsert> = {}) {
  const [row] = await app
    .insert(s.enforcementStatements)
    .values(statement(await auditRow(), over))
    .returning();
  return row!;
}

describe("enforcement_statements", () => {
  test("the app role inserts and reads; the territorial scope defaults to all", async () => {
    const row = await insertStatement();
    expect(row.territorialScope).toBe("all");
    const [read] = await app.select().from(s.enforcementStatements).where(eq(s.enforcementStatements.id, row.id));
    expect(read?.facts).toMatchObject({ code: "classifier", threshold: 0.8 });
  });

  test("append-only for the app role (no privilege) and the owner (trigger)", async () => {
    const row = await insertStatement();
    const where = eq(s.enforcementStatements.id, row.id);
    await expectPgError(
      app.update(s.enforcementStatements).set({ clauseVersion: 2 }).where(where),
      /permission denied/,
    );
    await expectPgError(app.delete(s.enforcementStatements).where(where), /permission denied/);
    await expectPgError(t.db.update(s.enforcementStatements).set({ clauseVersion: 2 }).where(where), /append-only/);
    await expectPgError(t.db.delete(s.enforcementStatements).where(where), /append-only/);
    await expectPgError(t.db.execute(sql`truncate enforcement_statements cascade`), /append-only/);
  });

  test("the app role holds exactly SELECT and INSERT on statements, everything on deliveries", async () => {
    const privileges = async (table: string) => {
      const out: string[] = [];
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
        const r = await t.db.execute<{ ok: boolean }>(
          sql`select has_table_privilege(${TEST_APP_ROLE}, ${`public.${table}`}, ${p}) as ok`,
        );
        if (r[0]?.ok) out.push(p);
      }
      return out;
    };
    expect(await privileges("enforcement_statements")).toEqual(["SELECT", "INSERT"]);
    expect(await privileges("enforcement_statement_deliveries")).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE"]);
  });

  test("one statement per (audit row, recipient)", async () => {
    const auditId = await auditRow();
    const recipientUserId = uuidv7();
    await app.insert(s.enforcementStatements).values(statement(auditId, { recipientUserId }));
    await expectPgError(
      app.insert(s.enforcementStatements).values(statement(auditId, { recipientUserId })),
      /enforcement_statements_source_recipient_uq/,
    );
    // A second target of the same action (suspend user and channel owner) is a second statement.
    await app.insert(s.enforcementStatements).values(statement(auditId, { recipientUserId: uuidv7() }));
  });

  test("checks: legal basis only on illegal grounds, scope all, appeal pair, version, facts code", async () => {
    const audit = await auditRow();
    await expectPgError(
      app.insert(s.enforcementStatements).values(statement(audit, { legalBasis: "us.take-it-down" })),
      /enforcement_statements_legal_basis_ck/,
    );
    await app
      .insert(s.enforcementStatements)
      .values(statement(audit, { groundKind: "illegal", legalBasis: "us.take-it-down", clauseId: "illegal.ncii" }));
    await expectPgError(
      app.insert(s.enforcementStatements).values(statement(await auditRow(), { territorialScope: "eu" })),
      /enforcement_statements_territorial_scope_ck/,
    );
    await expectPgError(
      app.insert(s.enforcementStatements).values(statement(await auditRow(), { appealSubjectId: null })),
      /enforcement_statements_appeal_ck/,
    );
    await app
      .insert(s.enforcementStatements)
      .values(statement(await auditRow(), { appealSubjectType: null, appealSubjectId: null }));
    await expectPgError(
      app.insert(s.enforcementStatements).values(statement(await auditRow(), { clauseVersion: 0 })),
      /enforcement_statements_clause_version_ck/,
    );
    await expectPgError(
      app.insert(s.enforcementStatements).values(statement(await auditRow(), { facts: {} as never })),
      /enforcement_statements_facts_ck/,
    );
  });

  test("the source audit row must exist", async () => {
    await expectPgError(
      app.insert(s.enforcementStatements).values(statement(uuidv7())),
      /enforcement_statements_source_audit_id_audit_log_id_fk/,
    );
  });
});

describe("enforcement_statement_deliveries", () => {
  test("mutable by the app role, one row per channel", async () => {
    const st = await insertStatement();
    const [d] = await app
      .insert(s.enforcementStatementDeliveries)
      .values({ statementId: st.id, channel: "email" })
      .returning();
    expect(d?.attempts).toBe(0);
    await app
      .update(s.enforcementStatementDeliveries)
      .set({ attempts: 1, lastErrorCode: "no_email" })
      .where(eq(s.enforcementStatementDeliveries.id, d!.id));
    await app.insert(s.enforcementStatementDeliveries).values({ statementId: st.id, channel: "in_app" });
    await expectPgError(
      app.insert(s.enforcementStatementDeliveries).values({ statementId: st.id, channel: "email" }),
      /enforcement_statement_deliveries_uq/,
    );
  });
});

describe("legal_documents guard", () => {
  test("a published version is immutable for the app role and the owner", async () => {
    const where = eq(s.legalDocuments.id, noticeId);
    for (const db of [app, t.db]) {
      await expectPgError(
        db.update(s.legalDocuments).set({ title: "Changed" }).where(where),
        /published and immutable/,
      );
      await expectPgError(db.delete(s.legalDocuments).where(where), /published and immutable/);
    }
    // Moving the publication date into the future does not get around it.
    await expectPgError(
      t.db
        .update(s.legalDocuments)
        .set({ publishedAt: new Date(Date.now() + 86_400_000) })
        .where(where),
      /published and immutable/,
    );
  });

  test("an unpublished version changes only as the owner", async () => {
    const [future] = await t.db
      .insert(s.legalDocuments)
      .values({
        kind: "enforcement_notice",
        version: "w0-future",
        title: "Future",
        body: "x",
        publishedAt: new Date(Date.now() + 7 * 86_400_000),
      })
      .returning({ id: s.legalDocuments.id });
    const where = eq(s.legalDocuments.id, future!.id);
    await expectPgError(
      app.update(s.legalDocuments).set({ title: "Typo fixed" }).where(where),
      /only the database owner/,
    );
    await expectPgError(app.delete(s.legalDocuments).where(where), /only the database owner/);
    await t.db.update(s.legalDocuments).set({ title: "Typo fixed" }).where(where);
    const [row] = await t.db.select().from(s.legalDocuments).where(where);
    expect(row?.title).toBe("Typo fixed");
    await t.db.delete(s.legalDocuments).where(where);
    expect(await t.db.select().from(s.legalDocuments).where(where)).toHaveLength(0);
  });

  test("the app role may still insert a version (inserts are not guarded)", async () => {
    const rows = await app
      .insert(s.legalDocuments)
      .values({ kind: "cookies", version: "w0-app", title: "C", body: "c" })
      .returning({ id: s.legalDocuments.id });
    expect(rows).toHaveLength(1);
  });
});

describe("audit_log_action_idx", () => {
  test("exists on (action, created_at)", async () => {
    const r = await t.db.execute<{ indexdef: string }>(
      sql`select indexdef from pg_indexes where tablename = 'audit_log' and indexname = 'audit_log_action_idx'`,
    );
    expect(r[0]?.indexdef).toMatch(/\(action, created_at\)/);
  });
});
