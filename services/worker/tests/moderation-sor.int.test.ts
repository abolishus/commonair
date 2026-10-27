// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Statements of reasons against Postgres (as the app role) and Mailpit (ADR 0019): the real
 * T1/T2 writers produce audit rows, the builder turns them into statements once, the table is
 * append-only, deliveries are recorded and bounded, the coverage sweep counts what is missing,
 * and the operator's documented publish command (docs/operators/trust-safety.md) pins a new
 * notice for the next statement.
 */
import { readFileSync } from "node:fs";
import { loadEnv, mailEnv } from "@commonair/config";
import { schema, seedLegalDocuments, uuidv7, type Database } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import { createMailer, type Mailer } from "@commonair/email";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import type { WorkerContext } from "../src/context.ts";
import { sorBuildRun } from "../src/jobs/moderation-sor.ts";
import { applyT1, applyT2 } from "../src/moderation/scan.ts";
import { buildStatements, currentDocumentId } from "../src/moderation/sor-build.ts";
import { sorCoverage } from "../src/moderation/sor-coverage.ts";
import { deliverStatements, MAX_DELIVERY_ATTEMPTS } from "../src/moderation/sor-deliver.ts";
import { mailTo, siteAt } from "./e6-fixtures.ts";
import { makeBroadcast, makeUser } from "./fixtures.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const site = siteAt("http://localhost:3100");
const mailer = createMailer(loadEnv(mailEnv), { site });

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
  // The migrate job seeds legal documents on the stack; test databases start without them.
  await seedLegalDocuments(t.db);
}, 60_000);
afterAll(async () => {
  await t?.drop();
  await mailer.close();
});

/** Every log line, so a test can check no address reached the logs. */
const lines: { level: string; msg: string; fields: Record<string, unknown> }[] = [];
const logger = Object.fromEntries(
  ["debug", "info", "warn", "error", "fatal"].map((level) => [
    level,
    (msg: string, fields: Record<string, unknown> = {}) => lines.push({ level, msg, fields }),
  ]),
);

function ctx(over: Partial<WorkerContext> = {}): WorkerContext {
  return {
    db: t.app.db,
    sql: t.app.sql,
    logger,
    now: () => new Date(),
    mailer,
    site,
    ...over,
  } as unknown as WorkerContext;
}

const app = (): Database => t.app.db;
const owner = (): Database => t.db;

async function restrict(): Promise<{ userId: string; email: string; channelId: string; caseId: string }> {
  const { user, channel } = await makeUser(owner());
  const b = await makeBroadcast(owner(), channel.id);
  const job = {
    frameId: uuidv7(),
    broadcastId: b.id,
    channelId: channel.id,
    capturedAt: new Date().toISOString(),
    pdq: null,
    quality: 90,
  };
  const out = await applyT1(ctx(), {
    job,
    channel,
    flagId: uuidv7(),
    frameKey: `moderation/frames/${uuidv7()}.jpg`,
    candidateCaseId: uuidv7(),
    capturedAt: new Date(job.capturedAt),
    provider: "test",
    providerVersion: "1",
    category: "weapons",
    score: 0.99,
  });
  return { userId: user.id, email: user.email, channelId: channel.id, caseId: out.caseId };
}

const statementsFor = (userId: string) =>
  owner().select().from(schema.enforcementStatements).where(eq(schema.enforcementStatements.recipientUserId, userId));

async function audit(action: string, details: Record<string, unknown>, createdAt = new Date()) {
  const id = uuidv7();
  await owner()
    .insert(schema.auditLog)
    .values({ id, actorType: "system", action, subjectType: "test", subjectId: id, details, createdAt });
  return id;
}

describe("build", () => {
  test("the real T1 and T2 writers each yield one statement; a rerun inserts nothing", async () => {
    const r = await restrict();
    const { user, channel } = await makeUser(owner());
    const b = await makeBroadcast(owner(), channel.id);
    await applyT2(ctx(), {
      job: {
        frameId: uuidv7(),
        broadcastId: b.id,
        channelId: channel.id,
        capturedAt: new Date().toISOString(),
        pdq: null,
        quality: 90,
      },
      channel,
      flagId: uuidv7(),
      frameKey: `moderation/frames/${uuidv7()}.jpg`,
      candidateCaseId: uuidv7(),
      capturedAt: new Date(),
      provider: "test",
      providerVersion: "1",
      score: 0.85,
    });

    const first = await buildStatements(ctx());
    expect(first.inserted).toBeGreaterThanOrEqual(2);
    const [s1] = await statementsFor(r.userId);
    expect(s1).toMatchObject({
      sourceAction: "moderation.t1.restrict",
      restrictionKind: "visibility",
      restrictionDetail: "restricted",
      clauseId: "safety.weapons",
      appealSubjectType: "moderation_case",
      appealSubjectId: r.caseId,
      noticeDocumentId: await currentDocumentId(app(), "enforcement_notice", new Date()),
    });
    expect(s1?.facts).toMatchObject({ code: "classifier", tier: "t1", threshold: 0.95 });
    const [s2] = await statementsFor(user.id);
    expect(s2).toMatchObject({
      sourceAction: "moderation.t2.label",
      restrictionDetail: "age_gated",
      appealSubjectType: "content_label",
    });

    const again = await buildStatements(ctx());
    expect(again.inserted).toBe(0);
    expect(await statementsFor(r.userId)).toHaveLength(1);
    // Two pending deliveries per statement, written with it.
    const d = await owner()
      .select()
      .from(schema.enforcementStatementDeliveries)
      .where(eq(schema.enforcementStatementDeliveries.statementId, s1!.id));
    expect(d.map((x) => x.channel).toSorted()).toEqual(["email", "in_app"]);
  });

  test("channel moderation (a ban and a timeout) produces no statement", async () => {
    const mod = await makeUser(owner());
    const target = await makeUser(owner());
    for (const action of ["ban", "timeout"] as const)
      await owner()
        .insert(schema.modActions)
        .values({
          scope: "channel",
          channelId: mod.channel.id,
          moderatorId: mod.user.id,
          targetUserId: target.user.id,
          action,
          durationSeconds: action === "timeout" ? 600 : null,
        });
    await buildStatements(ctx());
    expect(await statementsFor(target.user.id)).toEqual([]);
  });

  test("the statement table is append-only for the owner and the app role", async () => {
    const r = await restrict();
    await buildStatements(ctx());
    const [s] = await statementsFor(r.userId);
    // The trigger refuses the owner; the app role holds no UPDATE or DELETE at all.
    const refused = {
      cause: expect.objectContaining({ message: expect.stringMatching(/append-only|permission denied/) }),
    };
    for (const db of [owner(), app()]) {
      await expect(
        db
          .update(schema.enforcementStatements)
          .set({ clauseVersion: 2 })
          .where(eq(schema.enforcementStatements.id, s!.id)),
      ).rejects.toMatchObject(refused);
      await expect(
        db.delete(schema.enforcementStatements).where(eq(schema.enforcementStatements.id, s!.id)),
      ).rejects.toMatchObject(refused);
    }
  });
});

describe("delivery", () => {
  test("in-app and email once each, to Mailpit, with no address in any log line", async () => {
    const r = await restrict();
    lines.length = 0;
    await sorBuildRun(ctx());
    const [s] = await statementsFor(r.userId);
    const deliveries = await owner()
      .select()
      .from(schema.enforcementStatementDeliveries)
      .where(eq(schema.enforcementStatementDeliveries.statementId, s!.id));
    expect(deliveries.every((d) => d.sentAt !== null && d.attempts === 1 && d.lastErrorCode === null)).toBe(true);
    const notes = await owner().select().from(schema.notifications).where(eq(schema.notifications.userId, r.userId));
    expect(notes.map((n) => n.payload)).toContainEqual({ kind: "enforcement_statement", statementId: s!.id });
    const mail = await mailTo(r.email);
    expect(mail.subject).toContain("Statement of reasons");
    expect(mail.text).toContain("safety.weapons@1");
    expect(mail.text).toContain(`${site.publicUrl}/settings/appeals`);

    // A second run sends nothing again.
    const second = await deliverStatements(ctx());
    expect(second.sent).toBe(0);
    expect(
      (await owner().select().from(schema.notifications).where(eq(schema.notifications.userId, r.userId))).filter(
        (n) => (n.payload as { kind?: string }).kind === "enforcement_statement",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain(r.email);
  });

  test("a failing mailer is retried up to the bound with a code only; a sent channel never resends", async () => {
    const r = await restrict();
    await buildStatements(ctx());
    const [s] = await statementsFor(r.userId);
    const failing: Mailer = {
      send: () => Promise.reject(Object.assign(new Error(`rejected ${r.email}`), { code: "EENVELOPE" })),
      close: async () => {},
    };
    lines.length = 0;
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 2; i++) await deliverStatements(ctx({ mailer: failing }));
    const rows = await owner()
      .select()
      .from(schema.enforcementStatementDeliveries)
      .where(eq(schema.enforcementStatementDeliveries.statementId, s!.id));
    const email = rows.find((d) => d.channel === "email");
    const inApp = rows.find((d) => d.channel === "in_app");
    expect(email).toMatchObject({ sentAt: null, attempts: MAX_DELIVERY_ATTEMPTS, lastErrorCode: "EENVELOPE" });
    expect(inApp).toMatchObject({ attempts: 1, lastErrorCode: null });
    expect(inApp?.sentAt).not.toBeNull();
    expect(lines.some((l) => l.fields.alert === "sor_delivery_exhausted")).toBe(true);
    expect(JSON.stringify(lines)).not.toContain(r.email);
  });

  test("a deleted account is skipped with a code and never retried", async () => {
    const r = await restrict();
    await buildStatements(ctx());
    await owner().update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, r.userId));
    await deliverStatements(ctx());
    await deliverStatements(ctx());
    const [s] = await statementsFor(r.userId);
    const rows = await owner()
      .select()
      .from(schema.enforcementStatementDeliveries)
      .where(eq(schema.enforcementStatementDeliveries.statementId, s!.id));
    for (const d of rows) expect(d).toMatchObject({ sentAt: null, attempts: 1, lastErrorCode: "account_deleted" });
  });
});

describe("coverage", () => {
  test("counts unbuildable rows older than 5 minutes, never CSAM-list or rejected NCII rows", async () => {
    const old = new Date(Date.now() - 10 * 60_000);
    // Drop whatever earlier tests left pending, then measure from zero.
    await buildStatements(ctx());
    const base = (await sorCoverage(ctx())).missing;
    const bad = await audit("moderation.t1.restrict", { caseId: "nope" }, old);
    await audit("moderation.t0.match", { caseId: uuidv7(), listCategory: "csam", userId: uuidv7() }, old);
    await audit("ncii.decide", { requestId: uuidv7(), decision: "rejected" }, old);
    // Too recent to count.
    await audit("moderation.t1.restrict", { caseId: "nope" });
    lines.length = 0;
    const r = await buildStatements(ctx());
    expect(r.failures).toBeGreaterThanOrEqual(1);
    const cov = await sorCoverage(ctx());
    expect(cov.missing).toBe(base + 1);
    expect(cov.byAction["moderation.t1.restrict"]).toBeGreaterThanOrEqual(1);
    const alert = lines.find((l) => l.fields.alert === "sor_coverage");
    expect(alert?.fields.auditIds).toContain(bad);
  });
});

describe("operator publishes their own enforcement_notice (docs/operators/trust-safety.md)", () => {
  /** The documented command, read from the guide so the test proves exactly what operators run. */
  function documentedSql(): string {
    const guide = readFileSync(new URL("../../../docs/operators/trust-safety.md", import.meta.url), "utf8");
    const block = [...guide.matchAll(/```sql\n([\s\S]*?)```/g)]
      .map((m) => m[1] ?? "")
      .find((b) => b.includes("'enforcement_notice'"));
    if (!block) throw new Error("no enforcement_notice publish command in the operator guide");
    return block;
  }

  test("run as the owner, the next statement pins the new version; the published row is immutable", async () => {
    const before = await currentDocumentId(app(), "enforcement_notice", new Date());
    await t.sql.unsafe(documentedSql());
    const [row] = await owner()
      .select()
      .from(schema.legalDocuments)
      .where(and(eq(schema.legalDocuments.kind, "enforcement_notice"), eq(schema.legalDocuments.isDraft, false)));
    expect(row).toBeDefined();
    expect(row!.id).not.toBe(before);
    expect(await currentDocumentId(app(), "enforcement_notice", new Date(Date.now() + 1000))).toBe(row!.id);

    const r = await restrict();
    // `published_at = now()` in the command: build a moment later, as the 15 s job would.
    await buildStatements(ctx({ now: () => new Date(Date.now() + 1000) }));
    const [s] = await statementsFor(r.userId);
    expect(s?.noticeDocumentId).toBe(row!.id);

    await expect(
      t.sql`update legal_documents set body = 'changed' where id = ${row!.id}`.then(() => "updated"),
    ).rejects.toThrow(/immutable/);
  });
});
