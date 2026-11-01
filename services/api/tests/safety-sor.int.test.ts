// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Statements of reasons for staff suspensions (batch 7, ADR 0019 answer 3), API side:
 *
 * - the `report.resolve`, `user.suspend` and `channel.suspend` audit rows carry what the worker's
 *   statement builder reads (`services/worker/src/moderation/sor-schemas.ts`): the `mod_actions`
 *   row, the cited clause with its version and ground, ids only; a dismissal, a suspension already
 *   in force and a lift carry nothing to state;
 * - the enforcement report counts such an action once: from `mod_actions` until its statement
 *   exists, from the statement after (`modActionCells`), so its totals do not move.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { EnforcementReport } from "@commonair/contracts/dto";
import { ENFORCEMENT_REPORT_RULES } from "@commonair/contracts/enums";
import { legalSeedDocuments, schema, uuidv7 } from "@commonair/db";
import { clearEnforcementCache } from "../src/transparency/enforcement.ts";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
const DAY = 86_400_000;
const K = ENFORCEMENT_REPORT_RULES.k;

let api: TestApi;
let reporter: User;
let mod: User;
let admin: User;
let docs: { guidelines: string; notice: string };
const db = () => api.db.db;

beforeAll(async () => {
  api = await startApi();
  const seed = legalSeedDocuments();
  const notice = seed.find((d) => d.kind === "enforcement_notice")!;
  const guidelines = seed.find((d) => d.kind === "guidelines")!;
  docs = { guidelines: uuidv7(), notice: uuidv7() };
  await db()
    .insert(schema.legalDocuments)
    .values([
      { ...notice, id: docs.notice },
      { ...guidelines, id: docs.guidelines, requiresAcceptance: false },
    ]);
  [reporter, mod, admin] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api), signUpAndSignIn(api)]);
  await db().update(schema.users).set({ role: "moderator" }).where(eq(schema.users.id, mod.userId));
  await db().update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, admin.userId));
}, 120_000);
afterAll(async () => {
  await api?.stop();
});
beforeEach(() => clearEnforcementCache());

async function fileReport(subjectType: string, subjectId: string): Promise<string> {
  const r = await reporter.client.call<{ id: string }>("POST", "/api/reports", {
    subjectType,
    subjectId,
    reason: "harassment",
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.id;
}

const auditOf = async (action: string, subjectId: string) => {
  const rows = await db()
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.subjectId, subjectId)));
  expect(rows, action).toHaveLength(1);
  return rows[0]!;
};

const channelOf = async (userId: string) =>
  (await db().select().from(schema.channels).where(eq(schema.channels.ownerId, userId)))[0]!.id;

describe("the audit rows the statement builder reads", () => {
  test("a report resolved with a suspension names its mod action and clause; ids only", async () => {
    const target = await signUpAndSignIn(api);
    const reportId = await fileReport("user", target.userId);
    const res = await mod.client.call("POST", `/api/admin/reports/${reportId}`, {
      status: "actioned",
      resolution: "Suspended for harassment (free text that must not reach the details).",
      action: "suspend_user",
      durationSeconds: 3600,
      clauseId: "decency.harassment",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [m] = await db().select().from(schema.modActions).where(eq(schema.modActions.reportId, reportId));
    const a = await auditOf("report.resolve", reportId);
    expect(a.details).toEqual({
      reportId,
      status: "actioned",
      action: "suspend_user",
      reportSubjectType: "user",
      reportSubjectId: target.userId,
      durationSeconds: 3600,
      suspended: true,
      userId: target.userId,
      modActionId: m!.id,
      clauseId: "decency.harassment",
      clauseVersion: 1,
      ground: "terms",
    });
    expect(JSON.stringify(a.details)).not.toContain("free text");
  });

  test("a report resolved with a channel suspension names the channel on the row", async () => {
    const target = await signUpAndSignIn(api);
    const channelId = await channelOf(target.userId);
    const reportId = await fileReport("channel", channelId);
    const res = await mod.client.call("POST", `/api/admin/reports/${reportId}`, {
      status: "actioned",
      resolution: "x",
      action: "suspend_channel",
      clauseId: "guidelines.general",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const a = await auditOf("report.resolve", reportId);
    expect(a.channelId).toBe(channelId);
    expect(a.details).toMatchObject({
      action: "suspend_channel",
      suspended: true,
      userId: target.userId,
      clauseId: "guidelines.general",
      clauseVersion: 1,
      ground: "terms",
    });

    // Another report on the channel, already suspended: nothing more is restricted, nothing stated.
    const again = await fileReport("channel", channelId);
    const res2 = await mod.client.call("POST", `/api/admin/reports/${again}`, {
      status: "actioned",
      resolution: "again",
      action: "suspend_channel",
      clauseId: "guidelines.general",
    });
    expect(res2.status, JSON.stringify(res2.body)).toBe(200);
    const a2 = await auditOf("report.resolve", again);
    expect(a2.details).toMatchObject({ suspended: false });
    expect(a2.details).not.toHaveProperty("modActionId");
  });

  test("a dismissal states nothing", async () => {
    const target = await signUpAndSignIn(api);
    const reportId = await fileReport("user", target.userId);
    const res = await mod.client.call("POST", `/api/admin/reports/${reportId}`, {
      status: "dismissed",
      resolution: "fine",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const a = await auditOf("report.resolve", reportId);
    expect(a.details).toMatchObject({ action: "none", suspended: false });
    expect(Object.keys(a.details as object)).not.toContain("clauseId");
  });

  test("an admin suspension of a user and of a channel carry their citation; a lift carries none", async () => {
    const target = await signUpAndSignIn(api);
    const channelId = await channelOf(target.userId);
    const call = (body: Record<string, unknown>) =>
      admin.client.call("POST", `/api/admin/users/${target.username}/suspension`, { reason: "r", ...body });
    expect(
      (await call({ target: "user", suspended: true, clauseId: "decency.hate", durationSeconds: 600 })).status,
    ).toBe(200);
    expect((await call({ target: "channel", suspended: true, clauseId: "decency.hate" })).status).toBe(200);
    expect((await call({ target: "user", suspended: false })).status).toBe(200);
    const acts = await db().select().from(schema.modActions).where(eq(schema.modActions.targetUserId, target.userId));
    const idOf = (action: string) => acts.find((m) => m.action === action)!.id;
    expect((await auditOf("user.suspend", target.userId)).details).toEqual({
      userId: target.userId,
      durationSeconds: 600,
      modActionId: idOf("suspend_user"),
      clauseId: "decency.hate",
      clauseVersion: 1,
      ground: "terms",
    });
    const ch = await auditOf("channel.suspend", channelId);
    expect(ch.channelId).toBe(channelId);
    expect(ch.details).toMatchObject({
      userId: target.userId,
      modActionId: idOf("suspend_channel"),
      clauseId: "decency.hate",
    });
    expect((await auditOf("user.unsuspend", target.userId)).details).toEqual({
      userId: target.userId,
      durationSeconds: null,
      modActionId: idOf("unsuspend_user"),
    });
  });
});

describe("the enforcement report counts a stated staff action once", () => {
  async function report(): Promise<EnforcementReport> {
    clearEnforcementCache();
    const realNow = api.deps.now;
    api.deps.now = () => new Date(Date.now() + DAY);
    try {
      const res = await fetch(`${api.url}/api/transparency/enforcement?window=30d`);
      expect(res.status).toBe(200);
      return EnforcementReport.parse(await res.json());
    } finally {
      api.deps.now = realNow;
    }
  }
  const CLAUSE = "honesty.impersonation";
  const cellOf = (r: EnforcementReport) => r.rows.find((x) => x.ruleRef === `${CLAUSE}@1` && x.tier === null);
  const value = (c: EnforcementReport["total"] | undefined) => (c && !c.suppressed ? c.value : null);

  test("moving actions to their statements changes no figure; a statement without its action adds one", async () => {
    const at = new Date(Date.now() - DAY);
    const targets = await Promise.all(Array.from({ length: K }, () => signUpAndSignIn(api)));
    // K admin suspensions citing one clause, as `safety.suspend` writes them, a day ago.
    const written: { auditId: string; modActionId: string; userId: string }[] = [];
    for (const t of targets) {
      const [m] = await db()
        .insert(schema.modActions)
        .values({
          scope: "platform",
          moderatorId: admin.userId,
          targetUserId: t.userId,
          action: "suspend_user",
          reason: "r",
          ruleRef: `${CLAUSE}@1`,
          createdAt: at,
        })
        .returning({ id: schema.modActions.id });
      const auditId = uuidv7();
      await db()
        .insert(schema.auditLog)
        .values({
          id: auditId,
          actorType: "admin",
          actorId: admin.userId,
          action: "user.suspend",
          subjectType: "user",
          subjectId: t.userId,
          details: {
            userId: t.userId,
            durationSeconds: null,
            modActionId: m!.id,
            clauseId: CLAUSE,
            clauseVersion: 1,
            ground: "terms",
          },
          createdAt: at,
        });
      written.push({ auditId, modActionId: m!.id, userId: t.userId });
    }
    const before = await report();
    expect(value(cellOf(before)?.count)).toBe(K);

    // The worker's builder writes their statements (the shape `sor-build.ts` stores).
    const stated = written.slice(0, 4);
    for (const w of stated)
      await db()
        .insert(schema.enforcementStatements)
        .values({
          id: uuidv7(),
          sourceAuditId: w.auditId,
          sourceAction: "user.suspend",
          recipientUserId: w.userId,
          contentType: "account",
          contentId: w.userId,
          restrictionKind: "account",
          restrictionDetail: "suspended",
          facts: { code: "moderator_review", caseId: w.modActionId, caseOrigin: "human", decision: "suspend" },
          source: "own_initiative",
          automatedDetection: false,
          automatedDecision: "not",
          groundKind: "terms",
          clauseId: CLAUSE,
          clauseVersion: 1,
          guidelinesDocumentId: docs.guidelines,
          noticeDocumentId: docs.notice,
          appealSubjectType: "moderation_action",
          appealSubjectId: w.modActionId,
          createdAt: at,
        });
    const moved = await report();
    const figures = (r: EnforcementReport) => ({ rows: r.rows, total: r.total, ncii: r.ncii });
    expect(figures(moved)).toEqual(figures(before));
    expect(
      await db()
        .select({ id: schema.enforcementStatements.id })
        .from(schema.enforcementStatements)
        .where(
          inArray(
            schema.enforcementStatements.sourceAuditId,
            stated.map((w) => w.auditId),
          ),
        ),
    ).toHaveLength(stated.length);

    // A statement whose audit row names no action of this cell is counted on its own.
    const extra = uuidv7();
    await db()
      .insert(schema.auditLog)
      .values({
        id: extra,
        actorType: "admin",
        action: "user.suspend",
        subjectType: "user",
        subjectId: reporter.userId,
        details: { modActionId: uuidv7() },
        createdAt: at,
      });
    await db()
      .insert(schema.enforcementStatements)
      .values({
        id: uuidv7(),
        sourceAuditId: extra,
        sourceAction: "user.suspend",
        recipientUserId: reporter.userId,
        contentType: "account",
        contentId: reporter.userId,
        restrictionKind: "account",
        restrictionDetail: "suspended",
        facts: { code: "moderator_review", caseId: uuidv7(), caseOrigin: "human", decision: "suspend" },
        source: "own_initiative",
        automatedDetection: false,
        automatedDecision: "not",
        groundKind: "terms",
        clauseId: CLAUSE,
        clauseVersion: 1,
        guidelinesDocumentId: docs.guidelines,
        noticeDocumentId: docs.notice,
        createdAt: at,
      });
    expect(value(cellOf(await report())?.count)).toBe(K + 1);
  });

  test("a statement with no appeal leaves the action's appeals counted on the action", async () => {
    // A channel suspended over someone else's message: stated to the owner with no appeal, while
    // the action's target can still appeal the action itself.
    const SPAM = "honesty.spam";
    const spamCell = (r: EnforcementReport) => r.rows.find((x) => x.ruleRef === `${SPAM}@1` && x.tier === null);
    const at = new Date(Date.now() - DAY);
    const targets = await Promise.all(Array.from({ length: K }, () => signUpAndSignIn(api)));
    const written: { auditId: string; owner: string; channelId: string }[] = [];
    for (const t of targets) {
      const channelId = await channelOf(t.userId);
      const [m] = await db()
        .insert(schema.modActions)
        .values({
          scope: "platform",
          moderatorId: mod.userId,
          targetUserId: reporter.userId,
          channelId,
          action: "suspend_channel",
          reason: "r",
          ruleRef: `${SPAM}@1`,
          createdAt: at,
        })
        .returning({ id: schema.modActions.id });
      await db().insert(schema.appeals).values({
        appellantId: reporter.userId,
        kind: "moderation",
        subjectType: "moderation_action",
        subjectId: m!.id,
        body: "b",
        status: "overturned",
      });
      const auditId = uuidv7();
      await db()
        .insert(schema.auditLog)
        .values({
          id: auditId,
          actorType: "user",
          actorId: mod.userId,
          action: "report.resolve",
          subjectType: "report",
          subjectId: uuidv7(),
          channelId,
          details: { suspended: true, modActionId: m!.id },
          createdAt: at,
        });
      written.push({ auditId, owner: t.userId, channelId });
    }
    const before = await report();
    expect(value(spamCell(before)?.count)).toBe(K);
    expect(value(spamCell(before)?.appealed)).toBe(K);
    expect(value(spamCell(before)?.overturned)).toBe(K);

    for (const w of written)
      await db()
        .insert(schema.enforcementStatements)
        .values({
          id: uuidv7(),
          sourceAuditId: w.auditId,
          sourceAction: "report.resolve",
          recipientUserId: w.owner,
          channelId: w.channelId,
          contentType: "channel",
          contentId: w.channelId,
          restrictionKind: "service",
          restrictionDetail: "suspended",
          facts: { code: "moderator_review", caseId: uuidv7(), caseOrigin: "human", decision: "suspend" },
          source: "notice_art16",
          automatedDetection: false,
          automatedDecision: "not",
          groundKind: "terms",
          clauseId: SPAM,
          clauseVersion: 1,
          guidelinesDocumentId: docs.guidelines,
          noticeDocumentId: docs.notice,
          createdAt: at,
        });
    const figures = (r: EnforcementReport) => ({ rows: r.rows, total: r.total, ncii: r.ncii });
    expect(figures(await report())).toEqual(figures(before));
  });
});
