// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 4 (D7): `report_outcome` tells a reporter how their report was decided (J5-f),
 * `moderator_added` tells a member they were made a moderator or editor (J5-g). Both are written
 * in the deciding transaction, carry ids and enums only, and never reach the other party.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;

let api: TestApi;
let staff: User;
let legal1: User;
let legal2: User;
const db = () => api.db.db;
const people = async (n: number): Promise<User[]> => Promise.all(Array.from({ length: n }, () => signUpAndSignIn(api)));

beforeAll(async () => {
  api = await startApi();
  [staff, legal1, legal2] = (await people(3)) as [User, User, User];
  await db().update(schema.users).set({ role: "moderator" }).where(eq(schema.users.id, staff.userId));
  await db()
    .update(schema.users)
    .set({ role: "legal" })
    .where(inArray(schema.users.id, [legal1.userId, legal2.userId]));
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

async function channelOf(owner: User) {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.ownerId, owner.userId));
  if (!c) throw new Error("no channel");
  return c;
}

const notes = async (u: User, type: "report_outcome" | "moderator_added") =>
  db()
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, u.userId), eq(schema.notifications.type, type)));

async function message(channelId: string, from: User): Promise<string> {
  const id = uuidv7();
  await db().insert(schema.chatMessages).values({ id, channelId, userId: from.userId, body: "rude line" });
  return id;
}

async function broadcastOf(owner: User): Promise<string> {
  const c = await channelOf(owner);
  const [b] = await db()
    .insert(schema.broadcasts)
    .values({ channelId: c.id, ingestProtocol: "rtmp", path: `live/${uuidv7()}`, endedAt: new Date() })
    .returning();
  if (!b) throw new Error("no broadcast");
  return b.id;
}

const report = async (who: User, body: Record<string, unknown>) => {
  const res = await who.client.call<{ id: string }>("POST", "/api/reports", {
    reason: "harassment",
    details: "",
    ...body,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.id;
};

const resolve = (id: string, status: "actioned" | "dismissed", action = "none") =>
  staff.client.call("POST", `/api/admin/reports/${id}`, {
    status,
    resolution: "decided",
    action,
    ...(action === "none" || action === "ban_from_channel" ? {} : { clauseId: "decency.harassment" }),
  });

async function caseFor(subjectId: string) {
  const [c] = await db().select().from(schema.moderationCases).where(eq(schema.moderationCases.subjectId, subjectId));
  if (!c) throw new Error("no case");
  return c;
}

describe("report_outcome", () => {
  test("a resolved report tells its reporter the outcome, ids and enums only; the reported user hears nothing", async () => {
    const [owner, reporter, author] = await people(3);
    if (!owner || !reporter || !author) throw new Error("signup");
    const msgId = await message((await channelOf(owner)).id, author);
    const reportId = await report(reporter, { subjectType: "chat_message", subjectId: msgId });
    expect(await notes(reporter, "report_outcome")).toEqual([]);
    expect((await resolve(reportId, "actioned", "remove_content")).status).toBe(200);
    const rows = await notes(reporter, "report_outcome");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.payload).toEqual({ reportId, subjectType: "chat_message", outcome: "action_taken" });
    expect(rows[0]?.dedupeKey).toBe(`report-outcome-${reportId}`);
    expect(await notes(author, "report_outcome")).toEqual([]);
    expect(await notes(staff, "report_outcome")).toEqual([]);
    // Resolving again is refused, and still one row.
    expect((await resolve(reportId, "dismissed")).status).toBe(409);
    expect(await notes(reporter, "report_outcome")).toHaveLength(1);
  });

  test("a dismissal is no_action; each reporter of the same subject is told about their own report", async () => {
    const [owner, r1, r2, author] = await people(4);
    if (!owner || !r1 || !r2 || !author) throw new Error("signup");
    const msgId = await message((await channelOf(owner)).id, author);
    const a = await report(r1, { subjectType: "chat_message", subjectId: msgId });
    const b = await report(r2, { subjectType: "chat_message", subjectId: msgId });
    expect((await resolve(a, "dismissed")).status).toBe(200);
    expect((await notes(r1, "report_outcome")).map((n) => n.payload)).toEqual([
      { reportId: a, subjectType: "chat_message", outcome: "no_action" },
    ]);
    // r2's report is still open: nothing yet.
    expect(await notes(r2, "report_outcome")).toEqual([]);
    expect((await resolve(b, "actioned")).status).toBe(200);
    expect((await notes(r2, "report_outcome")).map((n) => n.payload)).toEqual([
      { reportId: b, subjectType: "chat_message", outcome: "action_taken" },
    ]);
  });

  test("a wave report tells the reporter and none of the wave's senders", async () => {
    const [owner, reporter, s1, s2] = await people(4);
    if (!owner || !reporter || !s1 || !s2) throw new Error("signup");
    const c = await channelOf(owner);
    const ids = [await message(c.id, s1), await message(c.id, s2)];
    const reportId = await report(reporter, { subjectType: "message_set", subjectId: ids[0], messageIds: ids });
    expect((await resolve(reportId, "actioned", "remove_content")).status).toBe(200);
    expect((await notes(reporter, "report_outcome")).map((n) => n.payload)).toEqual([
      { reportId, subjectType: "message_set", outcome: "action_taken" },
    ]);
    expect(await notes(s1, "report_outcome")).toEqual([]);
    expect(await notes(s2, "report_outcome")).toEqual([]);
  });

  test("a report-derived case decided clear is no_action; a later resolve of the report adds nothing", async () => {
    const [owner, reporter] = await people(2);
    if (!owner || !reporter) throw new Error("signup");
    const broadcastId = await broadcastOf(owner);
    const reportId = await report(reporter, {
      subjectType: "broadcast",
      subjectId: broadcastId,
      reason: "minor_safety",
    });
    const c = await caseFor(broadcastId);
    const res = await staff.client.call("POST", `/api/admin/moderation/cases/${c.id}/review`, {
      decision: "clear",
      note: "nothing found",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await notes(reporter, "report_outcome")).map((n) => n.payload)).toEqual([
      { reportId, subjectType: "broadcast", outcome: "no_action" },
    ]);
    expect(await notes(owner, "report_outcome")).toEqual([]);
    // The same report resolved afterwards from the reports queue: still one row.
    expect((await resolve(reportId, "actioned")).status).toBe(200);
    expect(await notes(reporter, "report_outcome")).toHaveLength(1);
  });

  test("a case decided warn is action_taken; an escalation decides nothing until legal dismisses it", async () => {
    const [o1, o2, reporter] = await people(3);
    if (!o1 || !o2 || !reporter) throw new Error("signup");
    const warned = await broadcastOf(o1);
    const warnedReport = await report(reporter, {
      subjectType: "broadcast",
      subjectId: warned,
      reason: "minor_safety",
    });
    const wc = await caseFor(warned);
    expect(
      (await staff.client.call("POST", `/api/admin/moderation/cases/${wc.id}/review`, { decision: "warn", note: "w" }))
        .status,
    ).toBe(200);
    expect((await notes(reporter, "report_outcome")).map((n) => n.payload)).toEqual([
      { reportId: warnedReport, subjectType: "broadcast", outcome: "action_taken" },
    ]);

    const escalated = await broadcastOf(o2);
    const escalatedReport = await report(reporter, {
      subjectType: "broadcast",
      subjectId: escalated,
      reason: "minor_safety",
    });
    const ec = await caseFor(escalated);
    const esc = await staff.client.call("POST", `/api/admin/moderation/cases/${ec.id}/review`, {
      decision: "escalate_legal",
      note: "to legal",
    });
    expect(esc.status, JSON.stringify(esc.body)).toBe(200);
    expect(await notes(reporter, "report_outcome")).toHaveLength(1);
    // Two different legal reviewers dismiss it: the second step decides it.
    expect((await legal1.client.call("POST", `/api/admin/legal/cases/${ec.id}/dismiss`, { note: "a" })).status).toBe(
      200,
    );
    expect(await notes(reporter, "report_outcome")).toHaveLength(1);
    const second = await legal2.client.call("POST", `/api/admin/legal/cases/${ec.id}/dismiss`, { note: "b" });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    const payloads = (await notes(reporter, "report_outcome")).map((n) => n.payload);
    expect(payloads).toContainEqual({ reportId: escalatedReport, subjectType: "broadcast", outcome: "no_action" });
    expect(payloads).toHaveLength(2);
    expect(await notes(o2, "report_outcome")).toEqual([]);
  });
});

describe("moderator_added", () => {
  const grant = (owner: User, to: User, role: string) =>
    owner.client.call("PUT", `/api/channels/${owner.username}/roles/${to.username}`, { role });
  const revoke = (owner: User, to: User, role: string) =>
    owner.client.call("DELETE", `/api/channels/${owner.username}/roles/${to.username}`, { role });

  test("moderator and editor each notify once; a re-grant and a VIP badge do not", async () => {
    const [owner, member, vip] = await people(3);
    if (!owner || !member || !vip) throw new Error("signup");
    const c = await channelOf(owner);
    expect((await grant(owner, member, "moderator")).status).toBe(200);
    expect((await grant(owner, member, "moderator")).status).toBe(200);
    expect((await grant(owner, member, "editor")).status).toBe(200);
    expect((await grant(owner, vip, "vip")).status).toBe(200);
    const rows = await notes(member, "moderator_added");
    expect(rows.map((n) => n.payload)).toEqual([
      { channelId: c.id, slug: c.slug, role: "moderator" },
      { channelId: c.id, slug: c.slug, role: "editor" },
    ]);
    expect(await notes(vip, "moderator_added")).toEqual([]);
    expect(await notes(owner, "moderator_added")).toEqual([]);
  });

  test("a revoke notifies nothing; granting again after a revoke is a new notice", async () => {
    const [owner, member] = await people(2);
    if (!owner || !member) throw new Error("signup");
    expect((await grant(owner, member, "moderator")).status).toBe(200);
    expect((await revoke(owner, member, "moderator")).status).toBe(200);
    expect(await notes(member, "moderator_added")).toHaveLength(1);
    expect((await grant(owner, member, "moderator")).status).toBe(200);
    expect(await notes(member, "moderator_added")).toHaveLength(2);
  });

  test("only the owner grants: a refused grant writes nothing", async () => {
    const [owner, mod, member] = await people(3);
    if (!owner || !mod || !member) throw new Error("signup");
    expect((await grant(owner, mod, "moderator")).status).toBe(200);
    const res = await mod.client.call("PUT", `/api/channels/${owner.username}/roles/${member.username}`, {
      role: "moderator",
    });
    expect(res.status).toBe(403);
    expect(await notes(member, "moderator_added")).toEqual([]);
  });
});
