// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 4, d7-admin (README D7.5): `admin.overview` per role, `moderation.assign` and the
 * queue's assignee filter, `admin.user` (T0 only for `legal`) and the audited `admin.revealEmail`.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { adminOverview } from "../src/admin-console/overview.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
type Role = "user" | "admin" | "legal" | "moderator" | "treasurer";
type QueueCount = {
  queue: string;
  open: number;
  overdue: number;
  dueSoon: number;
  oldestAt: string | null;
  unassigned: number | null;
};
type Case = { id: string; assignee: { id: string; username: string } | null; assignedAt: string | null };

let api: TestApi;
let admin: User;
let mod: User;
let mod2: User;
let legal: User;
let treasurer: User;
let plain: User;
beforeAll(async () => {
  api = await startApi();
  [admin, mod, mod2, legal, treasurer, plain] = (await Promise.all(
    Array.from({ length: 6 }, () => signUpAndSignIn(api)),
  )) as [User, User, User, User, User, User];
  await Promise.all([
    setRole(admin, "admin"),
    setRole(mod, "moderator"),
    setRole(mod2, "moderator"),
    setRole(legal, "legal"),
    setRole(treasurer, "treasurer"),
  ]);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
async function setRole(u: User, role: Role) {
  await db().update(schema.users).set({ role }).where(eq(schema.users.id, u.userId));
}
const audits = (action: string, subjectId: string) =>
  db()
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.subjectId, subjectId)));

async function makeCase(
  opts: { tier?: "t0" | "t1" | "t2"; userId?: string | null; slaDueAt?: Date | null; decided?: boolean } = {},
) {
  const id = uuidv7();
  const tier = opts.tier ?? "t1";
  await db()
    .insert(schema.moderationCases)
    .values({
      id,
      tier,
      status: "open",
      origin: tier === "t0" ? "hash_list" : "classifier",
      subjectType: "broadcast",
      subjectId: uuidv7(),
      userId: opts.userId ?? null,
      category: tier === "t0" ? null : "weapons",
      ...(tier === "t0" ? { listCategory: "ncii" as const } : {}),
      slaDueAt: opts.slaDueAt ?? null,
    });
  if (opts.decided)
    await db()
      .update(schema.moderationCases)
      .set({ status: "cleared", resolution: "clear", resolvedAt: new Date(), resolvedById: admin.userId })
      .where(eq(schema.moderationCases.id, id));
  return id;
}

const overview = async (u: User) => {
  const r = await u.client.call<{ queues: QueueCount[] }>("GET", "/api/admin/overview");
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.queues;
};
const queueOf = (qs: QueueCount[], q: string) => {
  const found = qs.find((x) => x.queue === q);
  if (!found) throw new Error(`no ${q} queue`);
  return found;
};

describe("admin.overview", () => {
  test("each role sees only the queues it can open", async () => {
    expect((await overview(mod)).map((q) => q.queue)).toEqual(["moderation", "appeals", "dmca", "ncii"]);
    expect((await overview(legal)).map((q) => q.queue)).toEqual(["legal", "ncii"]);
    expect((await overview(treasurer)).map((q) => q.queue)).toEqual(["payments"]);
    expect((await overview(admin)).map((q) => q.queue)).toEqual([
      "moderation",
      "appeals",
      "dmca",
      "ncii",
      "integrity",
      "incidents",
      "apps_review",
      "payments",
    ]);
    expect((await plain.client.call("GET", "/api/admin/overview")).status).toBe(403);
    expect((await client(api).call("GET", "/api/admin/overview")).status).toBe(401);
  });

  test("counts open, overdue, due-soon and unclaimed cases; T0 counts only in the legal queue", async () => {
    const before = queueOf(await overview(mod), "moderation");
    const beforeLegal = queueOf(await overview(legal), "legal");
    const now = Date.now();
    await makeCase({ slaDueAt: new Date(now - 60_000) });
    await makeCase({ slaDueAt: new Date(now + 20 * 60_000) });
    const claimed = await makeCase({ slaDueAt: new Date(now + 3 * 60 * 60_000) });
    await makeCase({ tier: "t2" });
    await makeCase({ decided: true });
    await makeCase({ tier: "t0" });
    await db()
      .update(schema.moderationCases)
      .set({ assigneeId: mod.userId, assignedAt: new Date() })
      .where(eq(schema.moderationCases.id, claimed));

    const after = queueOf(await overview(mod), "moderation");
    expect(after.open - before.open).toBe(4);
    expect(after.overdue - before.overdue).toBe(1);
    expect(after.dueSoon - before.dueSoon).toBe(1);
    expect((after.unassigned ?? 0) - (before.unassigned ?? 0)).toBe(3);
    expect(after.oldestAt).not.toBeNull();
    const legalQ = queueOf(await overview(legal), "legal");
    expect(legalQ.open - beforeLegal.open).toBe(1);
    expect(legalQ.unassigned).toBeNull();
  });

  test("the NCII clock and an open appeal reach their queues", async () => {
    const before = await overview(admin);
    const now = Date.now();
    await db()
      .insert(schema.nciiRequests)
      .values({
        requesterName: "R",
        requesterEmail: "r@test.invalid",
        relationship: "self",
        contentUrls: ["https://example.invalid/x"],
        description: "d",
        goodFaith: true,
        signature: "R",
        deadlineAt: new Date(now + 48 * 60 * 60_000),
      });
    await db()
      .insert(schema.appeals)
      .values({ appellantId: plain.userId, kind: "account", subjectType: "account", subjectId: uuidv7(), body: "b" });
    const after = await overview(admin);
    const delta = (q: string, k: "open" | "dueSoon") => queueOf(after, q)[k] - queueOf(before, q)[k];
    expect(delta("ncii", "open")).toBe(1);
    // The database dates the request and its 48-hour clock: look from near and past its end.
    const at = (h: number) => adminOverview(db(), "admin", new Date(now + h * 60 * 60_000));
    expect(queueOf((await at(47.5)).queues, "ncii")).toMatchObject({ dueSoon: 1, overdue: 0 });
    expect(queueOf((await at(49)).queues, "ncii")).toMatchObject({ dueSoon: 0, overdue: 1 });
    expect(delta("appeals", "open")).toBe(1);
    expect(queueOf(after, "appeals").dueSoon).toBe(0);
  });
});

describe("moderation.assign", () => {
  const assign = (u: User, id: string, assigneeId: string | null) =>
    u.client.call<Case>("PUT", `/api/admin/moderation/cases/${id}/assignee`, { assigneeId });

  test("claim, idempotent repeat, release: one audit row per change", async () => {
    const id = await makeCase();
    const claimed = await assign(mod, id, mod.userId);
    expect(claimed.status, JSON.stringify(claimed.body)).toBe(200);
    expect(claimed.body).toMatchObject({ id, assignee: { id: mod.userId, username: mod.username } });
    expect(claimed.body.assignedAt).not.toBeNull();
    expect((await assign(mod, id, mod.userId)).status).toBe(200);
    expect(await audits("moderation.case.assign", id)).toHaveLength(1);
    const [row] = await audits("moderation.case.assign", id);
    expect(row).toMatchObject({ actorId: mod.userId, actorType: "moderator", subjectType: "moderation_case" });
    expect(row?.details).toEqual({ assigneeId: mod.userId, previousAssigneeId: null });

    const released = await assign(mod, id, null);
    expect(released.body).toMatchObject({ assignee: null, assignedAt: null });
    expect(await audits("moderation.case.release", id)).toHaveLength(1);
  });

  test("another moderator cannot take over or assign others; an admin can", async () => {
    const id = await makeCase();
    expect((await assign(mod, id, mod.userId)).status).toBe(200);
    expect((await assign(mod2, id, mod2.userId)).status).toBe(409);
    expect((await assign(mod2, id, null)).status).toBe(409);
    const fresh = await makeCase();
    expect((await assign(mod2, fresh, mod.userId)).status).toBe(403);
    const moved = await assign(admin, id, mod2.userId);
    expect(moved.body).toMatchObject({ assignee: { id: mod2.userId } });
    expect((await audits("moderation.case.assign", id)).map((a) => a.details)).toContainEqual({
      assigneeId: mod2.userId,
      previousAssigneeId: mod.userId,
    });
  });

  test("only staff can hold a case; T0, unknown and decided cases are refused", async () => {
    const id = await makeCase();
    expect((await assign(admin, id, plain.userId)).status).toBe(400);
    expect((await assign(admin, id, treasurer.userId)).status).toBe(400);
    expect((await assign(legal, await makeCase({ tier: "t0" }), legal.userId)).status).toBe(404);
    expect((await assign(mod, uuidv7(), mod.userId)).status).toBe(404);
    expect((await assign(mod, await makeCase({ decided: true }), mod.userId)).status).toBe(409);
    expect((await assign(mod, await makeCase({ userId: mod.userId }), mod.userId)).status).toBe(403);
    expect((await assign(plain, id, plain.userId)).status).toBe(403);
    expect((await assign(treasurer, id, treasurer.userId)).status).toBe(403);
  });

  test("the queue filters by assignee", async () => {
    const mine = await makeCase();
    const theirs = await makeCase();
    const free = await makeCase();
    await assign(mod, mine, mod.userId);
    await assign(mod2, theirs, mod2.userId);
    const ids = async (assignee: string) =>
      (
        await mod.client.call<{ items: Case[] }>(
          "GET",
          `/api/admin/moderation/cases?status=open&limit=100&assignee=${assignee}`,
        )
      ).body.items.map((c) => c.id);
    const me = await ids("me");
    expect(me).toContain(mine);
    expect(me).not.toContain(theirs);
    expect(me).not.toContain(free);
    const unassigned = await ids("unassigned");
    expect(unassigned).toContain(free);
    expect(unassigned).not.toContain(mine);
    expect(unassigned).not.toContain(theirs);
  });
});

describe("admin.user and admin.revealEmail", () => {
  type View = {
    user: { id: string; username: string; role: string };
    channel: { slug: string } | null;
    suspensions: { target: string; reason: string }[];
    openReports: number;
    openCases: { id: string; tier: string }[];
    legalHolds: unknown[];
    deletion: unknown;
    recentAudit: { action: string }[];
  };
  const view = (u: User, username: string) => u.client.call<View>("GET", `/api/admin/users/${username}`);

  test("staff read a person's standing; T0 cases only for legal; others are refused", async () => {
    const target = await signUpAndSignIn(api);
    const t1 = await makeCase({ userId: target.userId });
    const t0 = await makeCase({ tier: "t0", userId: target.userId });
    await db()
      .insert(schema.reports)
      .values({ subjectType: "user", subjectId: target.userId, reason: "spam", reporterId: plain.userId });

    const asMod = await view(mod, target.username);
    expect(asMod.status, JSON.stringify(asMod.body)).toBe(200);
    expect(asMod.body).toMatchObject({
      user: { id: target.userId, username: target.username, role: "user" },
      openReports: 1,
      suspensions: [],
      deletion: null,
    });
    expect(asMod.body).not.toHaveProperty("user.email");
    expect(asMod.body.openCases.map((c) => c.id)).toContain(t1);
    expect(asMod.body.openCases.map((c) => c.id)).not.toContain(t0);
    const asLegal = await view(legal, target.username);
    expect(asLegal.body.openCases.map((c) => c.id)).toEqual(expect.arrayContaining([t0, t1]));

    expect((await view(treasurer, target.username)).status).toBe(403);
    expect((await view(plain, target.username)).status).toBe(403);
    expect((await view(mod, "nobodyhereatall1")).status).toBe(404);
  });

  test("a suspension through safety.suspend shows in the view and its audit trail", async () => {
    const target = await signUpAndSignIn(api);
    const s = await mod.client.call("POST", `/api/admin/users/${target.username}/suspension`, {
      target: "user",
      suspended: true,
      reason: "Repeated spam",
      clauseId: "honesty.spam",
    });
    expect(s.status, JSON.stringify(s.body)).toBe(200);
    const v = await view(admin, target.username);
    expect(v.body.suspensions).toMatchObject([{ target: "user", reason: "moderation" }]);
    expect(v.body.recentAudit.map((a) => a.action)).toContain("user.suspend");
  });

  test("the email reveal is admin-only, needs a reason and writes an audit row without the address", async () => {
    const target = await signUpAndSignIn(api);
    const path = `/api/admin/users/${target.username}/email-reveal`;
    expect((await mod.client.call("POST", path, { reason: "Legal request" })).status).toBe(403);
    expect((await legal.client.call("POST", path, { reason: "Legal request" })).status).toBe(403);
    expect((await admin.client.call("POST", path, { reason: "" })).status).toBe(400);
    expect(await audits("user.email.reveal", target.userId)).toHaveLength(0);

    const r = await admin.client.call<{ email: string }>("POST", path, { reason: "Payment dispute follow-up" });
    expect(r.status).toBe(200);
    expect(r.body.email).toBe(target.email);
    const rows = await audits("user.email.reveal", target.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: admin.userId, actorType: "admin", reason: "Payment dispute follow-up" });
    expect(JSON.stringify(rows[0]?.details)).not.toContain(target.email);
    expect(
      (await admin.client.call("POST", "/api/admin/users/nobodyhereatall1/email-reveal", { reason: "x" })).status,
    ).toBe(404);
  });
});
