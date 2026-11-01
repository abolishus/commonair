// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `rule_ref` writers and `transparency.enforcement` against Postgres (batch 6 decision (d), ADR
 * 0019): each API writer stamps the clause it cites (channel scope never), the report counts
 * statements and clause-citing platform mod actions once each, suppresses cells under k = 10,
 * moves the overturn rate on an overturned appeal, splits NCII requests by their 48 h deadline,
 * never shows a CSAM-list T0 case, keeps month boundaries at 00:00 UTC and answers signed out.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";
import { EnforcementReport } from "@commonair/contracts/dto";
import { legalSeedDocuments, schema, uuidv7 } from "@commonair/db";
import { clearEnforcementCache } from "../src/transparency/enforcement.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
type Report = EnforcementReport;
type Row = Report["rows"][number];

const DAY = 86_400_000;
let api: TestApi;
let alice: User;
let bob: User;
let mod: User;
let admin: User;
let aliceChannel: string;
let broadcastId: string;
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
  [alice, bob, mod, admin] = await Promise.all([
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
  ]);
  await db().update(schema.users).set({ role: "moderator" }).where(eq(schema.users.id, mod.userId));
  await db().update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, admin.userId));
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.ownerId, alice.userId));
  aliceChannel = c!.id;
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({ id: uuidv7(), channelId: aliceChannel, ingestProtocol: "rtmp", path: `live/${aliceChannel}` })
    .returning({ id: schema.broadcasts.id });
  broadcastId = b!.id;
}, 120_000);
afterAll(async () => {
  await api?.stop();
});
beforeEach(() => clearEnforcementCache());

async function report(window = "30d", headers: Record<string, string> = {}): Promise<Report> {
  clearEnforcementCache();
  const res = await fetch(`${api.url}/api/transparency/enforcement?window=${window}`, { headers });
  expect(res.status).toBe(200);
  return EnforcementReport.parse(await res.json());
}
const rowOf = (r: Report, ref: string, tier: Row["tier"]) => r.rows.find((x) => x.ruleRef === ref && x.tier === tier);
const valueOf = (c: Report["total"] | undefined) => (c && !c.suppressed ? c.value : undefined);

async function vod(): Promise<string> {
  const id = uuidv7();
  await db()
    .insert(schema.vods)
    .values({ id, channelId: aliceChannel, broadcastId, title: "v", storagePrefix: `vods/${id}/`, status: "ready" });
  return id;
}

async function chatMessage(userId: string): Promise<string> {
  const id = uuidv7();
  await db()
    .insert(schema.chatMessages)
    .values({ id, channelId: aliceChannel, userId, body: `line ${id}` });
  return id;
}

async function fileReport(subjectType: string, subjectId: string, reason: string): Promise<string> {
  const r = await bob.client.call<{ id: string }>("POST", "/api/reports", { subjectType, subjectId, reason });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.id;
}

/** `n` statements of one clause and source action, as the worker's builder stores them. */
async function statements(
  n: number,
  s: {
    clauseId: string;
    sourceAction?: string;
    automatedDecision?: "fully" | "partially" | "not";
    automatedDetection?: boolean;
    at?: Date;
    appeal?: () => { type: string; id: string } | null;
  },
): Promise<{ id: string; appealSubjectId: string | null }[]> {
  const out: { id: string; appealSubjectId: string | null }[] = [];
  const at = s.at ?? new Date(Date.now() - DAY);
  const action = s.sourceAction ?? "moderation.t1.restrict";
  for (let i = 0; i < n; i++) {
    const auditId = uuidv7();
    // Not a source action, so the builder and the coverage sweep ignore it.
    await db().insert(schema.auditLog).values({
      id: auditId,
      actorType: "system",
      action: "test.seed",
      subjectType: "test",
      subjectId: auditId,
      details: {},
      createdAt: at,
    });
    const appeal = s.appeal ? s.appeal() : { type: "moderation_case", id: uuidv7() };
    const id = uuidv7();
    await db()
      .insert(schema.enforcementStatements)
      .values({
        id,
        sourceAuditId: auditId,
        sourceAction: action,
        recipientUserId: alice.userId,
        channelId: aliceChannel,
        contentType: "broadcast",
        contentId: uuidv7(),
        restrictionKind: "visibility",
        restrictionDetail: "restricted",
        facts: { code: "classifier", category: "weapons", tier: "t1", threshold: 0.9, capturedAt: at.toISOString() },
        source: "own_initiative",
        automatedDetection: s.automatedDetection ?? true,
        automatedDecision: s.automatedDecision ?? "fully",
        groundKind: "terms",
        clauseId: s.clauseId,
        clauseVersion: 1,
        guidelinesDocumentId: docs.guidelines,
        noticeDocumentId: docs.notice,
        appealSubjectType: appeal?.type ?? null,
        appealSubjectId: appeal?.id ?? null,
        createdAt: at,
      });
    out.push({ id, appealSubjectId: appeal?.id ?? null });
  }
  return out;
}

describe("transparency.enforcement is public", () => {
  test("signed out, default window 30d, the contract shape", async () => {
    const res = await client(api).call<Report>("GET", "/api/transparency/enforcement");
    expect(res.status).toBe(200);
    const r = EnforcementReport.parse(res.body);
    expect(r.window).toBe("30d");
    expect(new Date(r.to).getTime() - new Date(r.from).getTime()).toBe(30 * DAY);
  });

  test("a malformed window is refused", async () => {
    const res = await client(api).call("GET", "/api/transparency/enforcement?window=2026-13");
    expect(res.status).toBe(400);
  });

  test("a future month is empty, not an error", async () => {
    const next = new Date();
    const y = next.getUTCFullYear() + 1;
    const r = await report(`${y}-01`);
    expect(r.rows).toEqual([]);
    expect(r.total).toEqual({ suppressed: false, value: 0 });
    expect(r.ncii.due).toEqual({ suppressed: false, value: 0 });
  });
});

describe("rule_ref writers (API)", () => {
  test("a report that opens a case cites the report reason's clause", async () => {
    const v = await vod();
    await fileReport("vod", v, "minor_safety");
    const [c] = await db()
      .select()
      .from(schema.moderationCases)
      .where(and(eq(schema.moderationCases.subjectType, "vod"), eq(schema.moderationCases.subjectId, v)));
    expect(c?.origin).toBe("human");
    expect(c?.ruleRef).toBe("safety.minors@1");
  });

  test("a report resolution cites the staff's clause; a channel ban cites none", async () => {
    const v = await vod();
    const id = await fileReport("vod", v, "spam");
    const res = await mod.client.call("POST", `/api/admin/reports/${id}`, {
      status: "actioned",
      resolution: "removed",
      action: "remove_content",
      clauseId: "honesty.spam",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [m] = await db().select().from(schema.modActions).where(eq(schema.modActions.reportId, id));
    expect(m).toMatchObject({ scope: "platform", ruleRef: "honesty.spam@1" });

    const msg = await chatMessage(alice.userId);
    const banId = await fileReport("chat_message", msg, "harassment");
    const before = await report();
    const ban = await mod.client.call("POST", `/api/admin/reports/${banId}`, {
      status: "actioned",
      resolution: "banned",
      action: "ban_from_channel",
      clauseId: "decency.harassment",
    });
    expect(ban.status, JSON.stringify(ban.body)).toBe(200);
    const [b] = await db().select().from(schema.modActions).where(eq(schema.modActions.reportId, banId));
    expect(b).toMatchObject({ scope: "channel", ruleRef: null });
    const after = await report();
    const figures = (r: Report) => ({ rows: r.rows, total: r.total, ncii: r.ncii });
    expect(figures(after)).toEqual(figures(before));
  });

  test("an unknown clause is refused and nothing is written", async () => {
    const v = await vod();
    const id = await fileReport("vod", v, "spam");
    const res = await mod.client.call("POST", `/api/admin/reports/${id}`, {
      status: "actioned",
      resolution: "removed",
      action: "remove_content",
      clauseId: "no.such-clause",
    });
    expect(res.status).toBe(400);
    expect(await db().select().from(schema.modActions).where(eq(schema.modActions.reportId, id))).toEqual([]);
  });

  test("an admin suspension cites its clause; lifting it cites none", async () => {
    const target = await signUpAndSignIn(api);
    const sus = await admin.client.call("POST", `/api/admin/users/${target.username}/suspension`, {
      target: "user",
      suspended: true,
      reason: "test",
      clauseId: "decency.hate",
    });
    expect(sus.status, JSON.stringify(sus.body)).toBe(200);
    const lift = await admin.client.call("POST", `/api/admin/users/${target.username}/suspension`, {
      target: "user",
      suspended: false,
      reason: "test",
    });
    expect(lift.status, JSON.stringify(lift.body)).toBe(200);
    const rows = await db().select().from(schema.modActions).where(eq(schema.modActions.targetUserId, target.userId));
    expect(Object.fromEntries(rows.map((r) => [r.action, r.ruleRef]))).toEqual({
      suspend_user: "decency.hate@1",
      unsuspend_user: null,
    });
  });

  test("a case decision keeps the case's clause, or sets it; its mod actions cite it", async () => {
    // A classifier case without a rule_ref (older row): the decision sets it from the category.
    const caseId = uuidv7();
    await db().insert(schema.moderationCases).values({
      id: caseId,
      tier: "t1",
      status: "open",
      origin: "classifier",
      subjectType: "broadcast",
      subjectId: uuidv7(),
      channelId: aliceChannel,
      userId: alice.userId,
      category: "weapons",
    });
    const res = await mod.client.call("POST", `/api/admin/moderation/cases/${caseId}/review`, {
      decision: "warn",
      note: "warned",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const [c] = await db().select().from(schema.moderationCases).where(eq(schema.moderationCases.id, caseId));
    expect(c?.ruleRef).toBe("safety.weapons@1");
    const [m] = await db().select().from(schema.modActions).where(eq(schema.modActions.subjectId, caseId));
    expect(m).toMatchObject({ action: "warn", scope: "platform", ruleRef: "safety.weapons@1" });

    // A report-origin case keeps the report reason's clause through a suspension.
    const v = await vod();
    await fileReport("vod", v, "minor_safety");
    const [rc] = await db()
      .select()
      .from(schema.moderationCases)
      .where(and(eq(schema.moderationCases.subjectType, "vod"), eq(schema.moderationCases.subjectId, v)));
    const sus = await mod.client.call("POST", `/api/admin/moderation/cases/${rc!.id}/review`, {
      decision: "suspend",
      note: "suspended",
      suspendTarget: "channel",
    });
    expect(sus.status, JSON.stringify(sus.body)).toBe(200);
    const [after] = await db().select().from(schema.moderationCases).where(eq(schema.moderationCases.id, rc!.id));
    expect(after?.ruleRef).toBe("safety.minors@1");
    const acts = await db().select().from(schema.modActions).where(eq(schema.modActions.subjectId, rc!.id));
    expect(acts.map((a) => [a.action, a.ruleRef])).toEqual([["suspend_channel", "safety.minors@1"]]);
    // Lift it again so later appeals and reports about alice are not refused.
    await db()
      .update(schema.channels)
      .set({ suspendedAt: null, suspendedReason: null })
      .where(eq(schema.channels.id, aliceChannel));

    // Case-decision mod actions are counted through their statement, never by themselves.
    const r = await report();
    expect(rowOf(r, "safety.weapons@1", null)).toBeUndefined();
    expect(rowOf(r, "safety.minors@1", null)).toBeUndefined();
  });

  test("an appeal cites the statement's clause, else the case's or the mod action's", async () => {
    const appeal = async (subjectType: string, subjectId: string) => {
      const res = await alice.client.call<{ id: string }>("POST", "/api/appeals", {
        kind: "moderation",
        subjectType,
        subjectId,
        body: "Please review this decision again.",
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const [a] = await db().select().from(schema.appeals).where(eq(schema.appeals.id, res.body.id));
      return a?.ruleRef ?? null;
    };
    const kase = async (ruleRef: string | null) => {
      const id = uuidv7();
      await db().insert(schema.moderationCases).values({
        id,
        tier: "t1",
        status: "open",
        origin: "classifier",
        subjectType: "broadcast",
        subjectId: uuidv7(),
        channelId: aliceChannel,
        userId: alice.userId,
        category: "self_harm",
        ruleRef,
      });
      return id;
    };
    // The case's own rule_ref.
    expect(await appeal("moderation_case", await kase("safety.self-harm@1"))).toBe("safety.self-harm@1");
    // A statement that offered this appeal wins over the case row.
    const withStatement = await kase("safety.self-harm@1");
    await statements(1, {
      clauseId: "safety.violence",
      appeal: () => ({ type: "moderation_case", id: withStatement }),
    });
    expect(await appeal("moderation_case", withStatement)).toBe("safety.violence@1");
    // A case citing nothing: null.
    expect(await appeal("moderation_case", await kase(null))).toBeNull();
    // A platform mod action: its rule_ref.
    const [m] = await db()
      .insert(schema.modActions)
      .values({ scope: "platform", targetUserId: alice.userId, action: "warn", reason: "x", ruleRef: "honesty.spam@1" })
      .returning({ id: schema.modActions.id });
    expect(await appeal("moderation_action", m!.id)).toBe("honesty.spam@1");
  });
});

describe("the database refuses what the report must never show", () => {
  test("a channel-scope mod action cannot carry a rule_ref", async () => {
    await expect(
      db().insert(schema.modActions).values({
        scope: "channel",
        channelId: aliceChannel,
        targetUserId: bob.userId,
        action: "ban",
        reason: "x",
        ruleRef: "decency.harassment@1",
      }),
    ).rejects.toThrow("Failed query");
  });

  test("a malformed rule_ref is refused", async () => {
    await expect(
      db().insert(schema.modActions).values({ scope: "platform", action: "warn", reason: "x", ruleRef: "Bad@0" }),
    ).rejects.toThrow("Failed query");
  });
});

describe("report figures", () => {
  test("k boundary: 9 is suppressed, 10 is shown with its automated split", async () => {
    await statements(9, {
      clauseId: "creative.copyright",
      sourceAction: "moderation.case.warn",
      automatedDecision: "not",
      automatedDetection: false,
    });
    let r = await report();
    const nine = rowOf(r, "creative.copyright@1", "t1");
    expect(nine?.count).toEqual({ suppressed: true });
    expect(nine?.overturned).toEqual({ suppressed: true });
    await statements(1, {
      clauseId: "creative.copyright",
      sourceAction: "moderation.case.warn",
      automatedDecision: "not",
      automatedDetection: false,
    });
    r = await report();
    const ten = rowOf(r, "creative.copyright@1", "t1");
    expect(ten?.count).toEqual({ suppressed: false, value: 10 });
    expect(ten?.automatedDecision).toEqual({
      fully: { suppressed: false, value: 0 },
      partially: { suppressed: false, value: 0 },
      not: { suppressed: false, value: 10 },
    });
    expect(ten?.automatedDetection).toEqual({ suppressed: false, value: 0 });
    expect(ten?.group).toBe("creative");
    expect(ten?.clauseTitle).toBe("Other people's creative work");
  });

  test("an overturned appeal moves the overturn rate", async () => {
    const rows = await statements(20, { clauseId: "safety.graphic-violence", sourceAction: "moderation.t1.restrict" });
    let r = await report();
    expect(rowOf(r, "safety.graphic-violence@1", "t1")?.overturned).toEqual({ suppressed: false, value: 0 });
    // Ten appeals overturned (fewer would be a suppressed numerator).
    for (const s of rows.slice(0, 10))
      await db().insert(schema.appeals).values({
        appellantId: alice.userId,
        kind: "moderation",
        subjectType: "moderation_case",
        subjectId: s.appealSubjectId!,
        body: "b",
        status: "overturned",
        resolverId: mod.userId,
        resolution: "r",
        resolvedAt: new Date(),
      });
    // One more appealed but upheld.
    await db().insert(schema.appeals).values({
      appellantId: alice.userId,
      kind: "moderation",
      subjectType: "moderation_case",
      subjectId: rows[10]!.appealSubjectId!,
      body: "b",
      status: "upheld",
      resolverId: mod.userId,
      resolution: "r",
      resolvedAt: new Date(),
    });
    r = await report();
    const row = rowOf(r, "safety.graphic-violence@1", "t1");
    expect(row?.count).toEqual({ suppressed: false, value: 20 });
    expect(row?.appealed).toEqual({ suppressed: false, value: 11 });
    expect(row?.overturned).toEqual({ suppressed: false, value: 10 });
  });

  test("report resolutions and admin suspensions count once, as human decisions with no tier", async () => {
    // One real resolution cites honesty.spam (earlier test); top the cell up to 10 the same way.
    const existing = (
      await db().select().from(schema.modActions).where(eq(schema.modActions.ruleRef, "honesty.spam@1"))
    ).filter((m) => m.subjectType !== "moderation_case").length;
    for (let i = existing; i < 10; i++)
      await db().insert(schema.modActions).values({
        scope: "platform",
        targetUserId: alice.userId,
        action: "remove_content",
        reason: "x",
        reportId: uuidv7(),
        subjectType: "vod",
        subjectId: uuidv7(),
        ruleRef: "honesty.spam@1",
      });
    const r = await report();
    const row = rowOf(r, "honesty.spam@1", null);
    expect(row?.count).toEqual({ suppressed: false, value: 10 });
    expect(row?.automatedDecision.not).toEqual({ suppressed: false, value: 10 });
    expect(row?.automatedDetection).toEqual({ suppressed: false, value: 0 });
    // The admin suspension (decency.hate) is one cell, suppressed.
    expect(rowOf(r, "decency.hate@1", null)?.count).toEqual({ suppressed: true });
  });

  test("a CSAM-list T0 case never appears", async () => {
    const before = await report();
    const dave = await signUpAndSignIn(api);
    await db().insert(schema.moderationCases).values({
      tier: "t0",
      status: "open",
      origin: "hash_list",
      subjectType: "broadcast",
      subjectId: uuidv7(),
      userId: dave.userId,
      listCategory: "csam",
      ruleRef: null,
    });
    const after = await report();
    expect(after.rows).toEqual(before.rows);
    expect(after.rows.some((x) => x.tier === "t0")).toBe(false);
  });

  test("month windows run from 00:00 UTC; December ends at January 1", async () => {
    await statements(10, { clauseId: "honesty.impersonation", at: new Date("2020-02-01T00:00:00.000Z") });
    await statements(10, { clauseId: "honesty.impersonation", at: new Date("2020-01-31T23:59:59.999Z") });
    await statements(10, { clauseId: "decency.hate", at: new Date("2019-12-31T23:59:59.999Z") });
    const feb = await report("2020-02");
    expect(feb.from).toBe("2020-02-01T00:00:00.000Z");
    expect(feb.to).toBe("2020-03-01T00:00:00.000Z");
    expect(rowOf(feb, "honesty.impersonation@1", "t1")?.count).toEqual({ suppressed: false, value: 10 });
    const jan = await report("2020-01");
    expect(rowOf(jan, "honesty.impersonation@1", "t1")?.count).toEqual({ suppressed: false, value: 10 });
    expect(rowOf(jan, "decency.hate@1", "t1")).toBeUndefined();
    const dec = await report("2019-12");
    expect(dec.to).toBe("2020-01-01T00:00:00.000Z");
    expect(rowOf(dec, "decency.hate@1", "t1")?.count).toEqual({ suppressed: false, value: 10 });
    expect(dec.total).toEqual({ suppressed: false, value: 10 });
  });

  test("clause titles follow the request's language", async () => {
    const es = await report("2020-02", { "accept-language": "es" });
    expect(rowOf(es, "honesty.impersonation@1", "t1")?.clauseTitle).toBe("Suplantación de identidad");
    const en = await report("2020-02");
    expect(rowOf(en, "honesty.impersonation@1", "t1")?.clauseTitle).toBe("Impersonation");
  });

  test("the answer is cached for a minute", async () => {
    clearEnforcementCache();
    const first = await fetch(`${api.url}/api/transparency/enforcement?window=2019-12`).then((r) => r.json());
    await statements(5, { clauseId: "decency.hate", at: new Date("2019-12-15T00:00:00.000Z") });
    const cached = await fetch(`${api.url}/api/transparency/enforcement?window=2019-12`).then((r) => r.json());
    expect(cached).toEqual(first);
    const fresh = await report("2019-12");
    expect(rowOf(fresh, "decency.hate@1", "t1")?.count).toEqual({ suppressed: false, value: 15 });
  });

  test("NCII requests: on time, late (decided after, or past the deadline undecided)", async () => {
    const request = async () => {
      const [r] = await db()
        .insert(schema.nciiRequests)
        .values({
          requesterName: "r",
          requesterEmail: "r@example.test",
          relationship: "self",
          contentUrls: ["https://example.test/x"],
          description: "d",
          goodFaith: true,
          signature: "r",
          deadlineAt: new Date(0),
        })
        .returning();
      return r!;
    };
    for (let i = 0; i < 10; i++) {
      const r = await request();
      await db()
        .update(schema.nciiRequests)
        .set({ status: "removed", decidedAt: new Date(), decidedById: mod.userId })
        .where(eq(schema.nciiRequests.id, r.id));
    }
    for (let i = 0; i < 5; i++) {
      const r = await request();
      await db()
        .update(schema.nciiRequests)
        .set({ status: "removed", decidedAt: new Date(r.deadlineAt.getTime() + 60_000), decidedById: mod.userId })
        .where(eq(schema.nciiRequests.id, r.id));
    }
    for (let i = 0; i < 5; i++) await request();
    // Deadlines are the database clock + 48 h: read the report three days on.
    const realNow = api.deps.now;
    api.deps.now = () => new Date(Date.now() + 3 * DAY);
    try {
      const r = await report();
      expect(r.ncii).toEqual({
        due: { suppressed: false, value: 20 },
        onTime: { suppressed: false, value: 10 },
        late: { suppressed: false, value: 10 },
      });
    } finally {
      api.deps.now = realNow;
    }
    // Today, every one of those deadlines is still ahead: none is due in the last 30 days.
    expect(valueOf((await report()).ncii.due)).toBe(0);
  });
});
