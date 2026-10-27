// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `me.enforcement.list` (ADR 0019 decision 8, docs/testing/w0-selectors.md): the caller's
 * statements of reasons, newest first with a keyset cursor, never anyone else's; the note,
 * appeal and reversal computed on read; readable (and appealable) while suspended; a T0 NCII
 * statement listed without its case. Also records whether a suspended user can sign in at all.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { en } from "@commonair/email";
import { legalSeedDocuments, schema, uuidv7 } from "@commonair/db";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface StatementDto {
  id: string;
  sourceAction: string;
  recipientUserId: string;
  restriction: { kind: string; detail: string; endsAt: string | null; territorialScope: string };
  ground: { clauseId: string; clauseVersion: number };
  appeal: { kind: string; subjectType: string; subjectId: string } | null;
  clauseTitle: string;
  explanation: string;
  noticeIsDraft: boolean;
  moderatorNote: string | null;
  appealId: string | null;
  reversedAt: string | null;
  createdAt: string;
}
interface Page {
  items: StatementDto[];
  nextCursor: string | null;
}

let api: TestApi;
let alice: User;
let bob: User;
let staff: User;
let aliceChannel: string;
let docs: { guidelines: string; notice: string };
const db = () => api.db.db;

beforeAll(async () => {
  api = await startApi();
  // The shipped notice, and a guidelines row that asks for no acceptance (seeding the real set
  // would make every sign-up here accept it first; statements only need the ids to pin).
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
  [alice, bob, staff] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api), signUpAndSignIn(api)]);
  await db().update(schema.users).set({ role: "moderator" }).where(eq(schema.users.id, staff.userId));
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.ownerId, alice.userId));
  aliceChannel = c!.id;
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

/** A T1 case about the user's channel (classifier origin unless told otherwise). */
async function makeCase(userId: string, opts: { tier?: "t1" | "t0"; note?: string; resolution?: string } = {}) {
  const id = uuidv7();
  // Cases start undecided (database guard); a decision is an update, as `moderation.review` makes it.
  await db()
    .insert(schema.moderationCases)
    .values({
      id,
      tier: opts.tier ?? "t1",
      status: "open",
      origin: opts.tier === "t0" ? "hash_list" : "classifier",
      subjectType: "broadcast",
      subjectId: uuidv7(),
      channelId: aliceChannel,
      userId,
      category: opts.tier === "t0" ? null : "weapons",
      ...(opts.tier === "t0" ? { listCategory: "ncii" as const } : {}),
    });
  if (opts.resolution)
    await db()
      .update(schema.moderationCases)
      .set({
        status: opts.resolution === "clear" ? "cleared" : "actioned",
        resolution: opts.resolution,
        resolutionNote: opts.note ?? null,
        resolvedAt: new Date(),
        resolvedById: staff.userId,
      })
      .where(eq(schema.moderationCases.id, id));
  return id;
}

/** An audit row and its statement, as the worker's builder would store them. */
async function statement(
  userId: string,
  at: Date,
  s: {
    action?: string;
    facts?: Record<string, unknown>;
    clauseId?: string;
    ground?: "terms" | "illegal";
    appeal?: { type: string; id: string } | null;
    restriction?: [string, string];
  } = {},
): Promise<string> {
  const auditId = uuidv7();
  const action = s.action ?? "moderation.t1.restrict";
  await db().insert(schema.auditLog).values({
    id: auditId,
    actorType: "system",
    action,
    subjectType: "test",
    subjectId: auditId,
    details: {},
    createdAt: at,
  });
  const id = uuidv7();
  const appeal = s.appeal === undefined ? { type: "moderation_case", id: uuidv7() } : s.appeal;
  const [kind, detail] = s.restriction ?? ["visibility", "restricted"];
  await db()
    .insert(schema.enforcementStatements)
    .values({
      id,
      sourceAuditId: auditId,
      sourceAction: action,
      recipientUserId: userId,
      channelId: aliceChannel,
      contentType: "broadcast",
      contentId: uuidv7(),
      restrictionKind: kind as "visibility",
      restrictionDetail: detail as "restricted",
      facts: (s.facts ?? {
        code: "classifier",
        category: "weapons",
        tier: "t1",
        threshold: 0.95,
        capturedAt: at.toISOString(),
      }) as never,
      source: "own_initiative",
      automatedDetection: true,
      automatedDecision: "fully",
      groundKind: s.ground ?? "terms",
      clauseId: s.clauseId ?? "safety.weapons",
      clauseVersion: 1,
      legalBasis: s.ground === "illegal" ? "us.take-it-down" : null,
      guidelinesDocumentId: docs.guidelines,
      noticeDocumentId: docs.notice,
      appealSubjectType: appeal?.type ?? null,
      appealSubjectId: appeal?.id ?? null,
      createdAt: at,
    });
  return id;
}

const list = (who: User, cursor?: string, limit = 2) =>
  who.client.call<Page>(
    "GET",
    `/api/me/enforcement?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  );

describe("me.enforcement.list", () => {
  test("pages newest first on (created_at, id), and never returns another user's statements", async () => {
    const base = Date.now() - 3_600_000;
    const same = new Date(base + 10_000);
    const ids = [
      await statement(alice.userId, new Date(base)),
      await statement(alice.userId, same),
      await statement(alice.userId, same),
      await statement(alice.userId, new Date(base + 20_000)),
    ];
    const bobs = await statement(bob.userId, new Date(base + 15_000));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 5; i++) {
      const res = await list(alice, cursor);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      seen.push(...res.body.items.map((s) => s.id));
      for (const s of res.body.items) expect(s.recipientUserId).toBe(alice.userId);
      if (!res.body.nextCursor) break;
      cursor = res.body.nextCursor;
    }
    const sameOrder = [ids[1]!, ids[2]!].toSorted().toReversed();
    expect(seen.filter((id) => ids.includes(id))).toEqual([ids[3], ...sameOrder, ids[0]]);
    expect(seen).not.toContain(bobs);
    expect((await list(bob, undefined, 50)).body.items.map((s) => s.id)).toEqual([bobs]);
    expect((await client(api).call("GET", "/api/me/enforcement")).status).toBe(401);
  });

  test("the clause title from the catalog and the explanation from the pinned notice", async () => {
    const id = await statement(alice.userId, new Date());
    const s = (await list(alice, undefined, 50)).body.items.find((x) => x.id === id)!;
    expect(s.clauseTitle).toBe(en.enforcementStatement["clause.safety.weapons"]);
    expect(s.explanation).toMatch(/weapons/i);
    expect(s.explanation).not.toContain("{{");
    expect(s.noticeIsDraft).toBe(true);
    expect(s.restriction.territorialScope).toBe("all");
  });

  test("a moderator decision joins the case's note on read; a cleared T1 case reverses its restriction", async () => {
    const decided = await makeCase(alice.userId, { resolution: "warn", note: "Please label the stream." });
    const warn = await statement(alice.userId, new Date(), {
      action: "moderation.case.warn",
      facts: { code: "moderator_review", caseId: decided, caseOrigin: "classifier", decision: "warn" },
      appeal: { type: "moderation_case", id: decided },
      restriction: ["warning", "none"],
    });
    const cleared = await makeCase(alice.userId, { resolution: "clear", note: "False positive." });
    const restricted = await statement(alice.userId, new Date(), { appeal: { type: "moderation_case", id: cleared } });
    const items = (await list(alice, undefined, 50)).body.items;
    expect(items.find((x) => x.id === warn)).toMatchObject({
      moderatorNote: "Please label the stream.",
      reversedAt: null,
    });
    const r = items.find((x) => x.id === restricted)!;
    // A classifier action carries no moderator note even when its case later has one.
    expect(r.moderatorNote).toBeNull();
    expect(r.reversedAt).not.toBeNull();
  });

  test("an appeal on the same subject is linked, and an overturned appeal reverses the statement", async () => {
    const caseId = await makeCase(alice.userId);
    const id = await statement(alice.userId, new Date(), { appeal: { type: "moderation_case", id: caseId } });
    const filed = await alice.client.call<{ id: string }>("POST", "/api/appeals", {
      kind: "moderation",
      subjectType: "moderation_case",
      subjectId: caseId,
      body: "The object in the frame was a prop for a play.",
    });
    expect(filed.status, JSON.stringify(filed.body)).toBe(200);
    let s = (await list(alice, undefined, 50)).body.items.find((x) => x.id === id)!;
    expect(s).toMatchObject({ appealId: filed.body.id, reversedAt: null });
    const resolved = await staff.client.call("POST", `/api/admin/appeals/${filed.body.id}`, {
      status: "overturned",
      resolution: "Reviewed.",
    });
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    s = (await list(alice, undefined, 50)).body.items.find((x) => x.id === id)!;
    expect(s.reversedAt).not.toBeNull();
  });

  test("a T0 NCII-list statement is listed without its case: no appeal, note or reversal", async () => {
    const t0 = await makeCase(alice.userId, { tier: "t0" });
    const id = await statement(alice.userId, new Date(), {
      action: "moderation.t0.match",
      facts: { code: "hash_match", listCategory: "ncii", capturedAt: new Date().toISOString() },
      clauseId: "illegal.ncii",
      ground: "illegal",
      appeal: null,
      restriction: ["account", "suspended"],
    });
    const s = (await list(alice, undefined, 50)).body.items.find((x) => x.id === id)!;
    expect(s).toMatchObject({
      appeal: null,
      moderatorNote: null,
      reversedAt: null,
      appealId: null,
      clauseTitle: en.enforcementStatement["clause.illegal.ncii"],
    });
    expect(JSON.stringify(s)).not.toContain(t0);
  });
  test("a T1 statement whose case was escalated to T0 since offers no appeal (appeals would refuse it)", async () => {
    const caseId = await makeCase(alice.userId);
    const id = await statement(alice.userId, new Date(), { appeal: { type: "moderation_case", id: caseId } });
    expect((await list(alice, undefined, 50)).body.items.find((x) => x.id === id)?.appeal).toEqual({
      kind: "moderation",
      subjectType: "moderation_case",
      subjectId: caseId,
    });
    // `moderation.review` with `escalate_legal` moves the case to T0.
    await db()
      .update(schema.moderationCases)
      .set({ tier: "t0", origin: "human" })
      .where(eq(schema.moderationCases.id, caseId));
    const s = (await list(alice, undefined, 50)).body.items.find((x) => x.id === id)!;
    expect(s).toMatchObject({ appeal: null, moderatorNote: null, reversedAt: null });
    const filed = await alice.client.call("POST", "/api/appeals", {
      kind: "moderation",
      subjectType: "moderation_case",
      subjectId: caseId,
      body: "This should not be offered.",
    });
    expect(filed.status).toBe(404);
  });
});

describe("while suspended", () => {
  test("a session from before the suspension reads its statements and files an appeal from one", async () => {
    const carol = await signUpAndSignIn(api);
    const caseId = await makeCase(carol.userId);
    const id = await statement(carol.userId, new Date(), {
      action: "moderation.case.suspend",
      facts: { code: "moderator_review", caseId, caseOrigin: "classifier", decision: "suspend" },
      appeal: { type: "moderation_case", id: caseId },
      restriction: ["account", "suspended"],
    });
    await db()
      .update(schema.users)
      .set({ banned: true, banReason: "moderation", banExpires: null })
      .where(eq(schema.users.id, carol.userId));
    const res = await list(carol, undefined, 50);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const s = res.body.items.find((x) => x.id === id)!;
    expect(s.appeal).toEqual({ kind: "moderation", subjectType: "moderation_case", subjectId: caseId });
    // Any other write is refused while suspended…
    expect((await carol.client.call("PATCH", "/api/me", { displayName: "x" })).status).toBe(403);
    // …but the statement's appeal goes through.
    const appeal = await carol.client.call<{ id: string }>("POST", "/api/appeals", {
      ...s.appeal,
      body: "I was not streaming at the time of the report.",
    });
    expect(appeal.status, JSON.stringify(appeal.body)).toBe(200);
    expect((await list(carol, undefined, 50)).body.items.find((x) => x.id === id)?.appealId).toBe(appeal.body.id);
  });

  test("Build 9: the auth library refuses a new sign-in for a suspended (banned) account", async () => {
    const dave = await signUpAndSignIn(api);
    await db()
      .update(schema.users)
      .set({ banned: true, banReason: "moderation", banExpires: null })
      .where(eq(schema.users.id, dave.userId));
    const fresh = client(api);
    const res = await fresh.call("POST", "/api/auth/sign-in/email", { email: dave.email, password: dave.password });
    expect(res.status, JSON.stringify(res.body)).not.toBe(200);
    expect(res.status).toBe(403);
    expect(fresh.jar.cookies.size).toBe(0);
    expect((await fresh.call("GET", "/api/me/enforcement")).status).toBe(401);
  });
});

describe("moderation.review suspend audit details", () => {
  /** An open T1 case about a fresh user's own channel. */
  async function suspendCase(u: User) {
    const [c] = await db().select().from(schema.channels).where(eq(schema.channels.ownerId, u.userId));
    const id = uuidv7();
    await db().insert(schema.moderationCases).values({
      id,
      tier: "t1",
      status: "open",
      origin: "classifier",
      subjectType: "broadcast",
      subjectId: uuidv7(),
      channelId: c!.id,
      userId: u.userId,
      category: "weapons",
    });
    return { caseId: id, channelId: c!.id };
  }
  const review = (caseId: string) =>
    staff.client.call("POST", `/api/admin/moderation/cases/${caseId}/review`, {
      decision: "suspend",
      note: "Repeated weapons sales.",
      suspendTarget: "both",
      durationSeconds: 3600,
    });
  const suspendDetails = async (caseId: string) => {
    const [row] = await db()
      .select({ details: schema.auditLog.details })
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.subjectId, caseId), eq(schema.auditLog.action, "moderation.case.suspend")));
    return row?.details as Record<string, unknown> | undefined;
  };

  test("records which suspensions were applied, so the statement builder states only those", async () => {
    const erin = await signUpAndSignIn(api);
    const applied = await suspendCase(erin);
    const res = await review(applied.caseId);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await suspendDetails(applied.caseId)).toMatchObject({
      decision: "suspend",
      suspendTarget: "both",
      durationSeconds: 3600,
      userSuspended: true,
      channelSuspended: true,
    });

    // An account under a T0 ban and a channel already suspended are left as they are.
    const frank = await signUpAndSignIn(api);
    const skipped = await suspendCase(frank);
    await db()
      .update(schema.users)
      .set({ banned: true, banReason: "t0_hash_match", banExpires: null })
      .where(eq(schema.users.id, frank.userId));
    await db()
      .update(schema.channels)
      .set({ suspendedAt: new Date(), suspendedReason: "t0_hash_match" })
      .where(eq(schema.channels.id, skipped.channelId));
    const res2 = await review(skipped.caseId);
    expect(res2.status, JSON.stringify(res2.body)).toBe(200);
    expect(await suspendDetails(skipped.caseId)).toMatchObject({ userSuspended: false, channelSuspended: false });
  });
});
