// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `admin.*` handlers: category upserts (create, update, audit, access), platform roles (the
 * last-administrator guard, bots, audit), egress and incidents through the admin gate, manual legal
 * holds (legal role only, not on yourself) and expedited account deletion (created or brought
 * forward).
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;

let api: TestApi;
let admin: User;
beforeAll(async () => {
  api = await startApi();
  admin = await signUpAndSignIn(api);
  await setRole(admin, "admin");
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
const users = async (n: number): Promise<User[]> => Promise.all(Array.from({ length: n }, () => signUpAndSignIn(api)));
async function setRole(u: User, role: "user" | "admin" | "legal" | "moderator") {
  await db().update(schema.users).set({ role }).where(eq(schema.users.id, u.userId));
}
const audits = (action: string, subjectId: string) =>
  db()
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.subjectId, subjectId)));

type Category = { id: string; slug: string; name: string; mature: boolean; liveChannels: number; tags: string[] };

describe("admin.categories", () => {
  test("creates, then updates name and label in place, auditing each", async () => {
    const slug = `cov-admin-${crypto.randomUUID().slice(0, 8)}`;
    const created = await admin.client.call<Category>("PUT", `/api/admin/categories/${slug}`, { name: "First" });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({
      slug,
      name: "First",
      mature: false,
      liveChannels: 0,
      viewerCount: 0,
      tags: [],
    });

    const updated = await admin.client.call<Category>("PUT", `/api/admin/categories/${slug}`, {
      name: "Second",
      mature: true,
    });
    expect(updated.body).toMatchObject({ id: created.body.id, name: "Second", mature: true });
    const rows = await audits("category.upsert", created.body.id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.details)).toContainEqual({ slug, mature: true });
    expect(rows.every((r) => r.actorId === admin.userId)).toBe(true);
    const read = await client(api).call<Category>("GET", `/api/categories/${slug}`);
    expect(read.body.name).toBe("Second");
  });

  test("non-admins and anonymous callers are refused; a bad slug is invalid", async () => {
    const [plain] = await users(1);
    if (!plain) throw new Error("signup");
    expect((await plain.client.call("PUT", "/api/admin/categories/cov-nope", { name: "x" })).status).toBe(403);
    expect((await client(api).call("PUT", "/api/admin/categories/cov-nope", { name: "x" })).status).toBe(401);
    expect((await admin.client.call("PUT", "/api/admin/categories/Bad_Slug", { name: "x" })).status).toBe(400);
  });
});

describe("admin.setRole", () => {
  test("promotes and demotes with an audit row; unknown users 404; bots hold no platform role", async () => {
    const [target, bot] = await users(2);
    if (!target || !bot) throw new Error("signup");
    const path = (u: string) => `/api/admin/users/${u}/role`;
    expect((await admin.client.call("PUT", path(target.username), { role: "moderator" })).status).toBe(200);
    const [row] = await db().select().from(schema.users).where(eq(schema.users.id, target.userId));
    expect(row?.role).toBe("moderator");
    const [a] = await audits("user.set_role", target.userId);
    expect(a?.details).toEqual({ from: "user", to: "moderator" });

    expect((await admin.client.call("PUT", path("no_such_user_x"), { role: "admin" })).status).toBe(404);
    await db().update(schema.users).set({ accountType: "bot" }).where(eq(schema.users.id, bot.userId));
    expect((await admin.client.call("PUT", path(bot.username), { role: "moderator" })).status).toBe(400);
    // Setting a bot back to plain user is allowed.
    expect((await admin.client.call("PUT", path(bot.username), { role: "user" })).status).toBe(200);
  });

  test("the last administrator cannot be demoted; with a second one, either can", async () => {
    const [second] = await users(1);
    if (!second) throw new Error("signup");
    const path = (u: string) => `/api/admin/users/${u}/role`;
    // Only `admin` holds the role in this database.
    const last = await admin.client.call<{ message?: string }>("PUT", path(admin.username), { role: "user" });
    expect(last.status).toBe(400);
    expect((await db().select().from(schema.users).where(eq(schema.users.id, admin.userId)))[0]?.role).toBe("admin");

    expect((await admin.client.call("PUT", path(second.username), { role: "admin" })).status).toBe(200);
    expect((await admin.client.call("PUT", path(second.username), { role: "user" })).status).toBe(200);
  });
});

describe("admin.egress and admin.incidents", () => {
  test("an admin reads the egress report and opens an incident; others may not", async () => {
    const [plain] = await users(1);
    if (!plain) throw new Error("signup");
    const to = new Date();
    const from = new Date(to.getTime() - 86_400_000);
    const q = `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
    expect((await admin.client.call("GET", `/api/admin/egress?${q}`)).status).toBe(200);
    expect((await plain.client.call("GET", `/api/admin/egress?${q}`)).status).toBe(403);
    const incident = {
      title: "Slow",
      status: "investigating",
      components: ["postgres"],
      body: "Looking into it.",
    };
    const r = await admin.client.call<{ id: string }>("POST", "/api/admin/incidents", incident);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await plain.client.call("POST", "/api/admin/incidents", incident)).status).toBe(403);
  });
});

describe("admin.legalHold", () => {
  test("legal staff place a hold with audit and event; not on themselves; unknown users 404", async () => {
    const [legal, target] = await users(2);
    if (!legal || !target) throw new Error("signup");
    await setRole(legal, "legal");
    const path = (u: string) => `/api/admin/users/${u}/legal-hold`;
    const body = { hold: true, reasonCode: "litigation", reason: "preserve records" };

    // Outside the legal role the route does not exist.
    expect((await admin.client.call("POST", path(target.username), body)).status).toBe(404);
    expect((await legal.client.call("POST", path("no_such_user_x"), body)).status).toBe(404);
    expect((await legal.client.call("POST", path(legal.username), body)).status).toBe(403);

    const r = await legal.client.call<{ id: string; userId: string; reasonCode: string; reason: string; caseId: null }>(
      "POST",
      path(target.username),
      body,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({
      userId: target.userId,
      reasonCode: "litigation",
      reason: "preserve records",
      caseId: null,
    });
    const [a] = await audits("legal.hold.place", target.userId);
    expect(a?.details).toEqual({ holdId: r.body.id, userId: target.userId, reasonCode: "litigation" });
    const evs = await db().select().from(schema.events).where(eq(schema.events.type, "legal.hold.placed"));
    expect(evs.map((e) => (e.payload as { hold_id: string }).hold_id)).toContain(r.body.id);
  });
});

describe("admin.expediteDeletion", () => {
  test("creates a due request, or brings an existing one forward; not for yourself or unknown users", async () => {
    const [fresh, pending] = await users(2);
    if (!fresh || !pending) throw new Error("signup");
    const path = (u: string) => `/api/admin/users/${u}/deletion`;
    const body = { reason: "court order" };
    expect((await admin.client.call("POST", path("no_such_user_x"), body)).status).toBe(404);
    expect((await admin.client.call("POST", path(admin.username), body)).status).toBe(403);

    const created = await admin.client.call<{ id: string; scheduledFor: string; status: string }>(
      "POST",
      path(fresh.username),
      body,
    );
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(new Date(created.body.scheduledFor).getTime()).toBeLessThanOrEqual(Date.now());
    const [ca] = await audits("account.deletion.expedite", fresh.userId);
    expect(ca?.details).toEqual({ deletionId: created.body.id, created: true });

    // The user asked for deletion themselves; the admin makes it due now.
    const own = await pending.client.call("POST", "/api/me/deletion", { confirmUsername: pending.username });
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    const [before] = await db()
      .select()
      .from(schema.accountDeletions)
      .where(eq(schema.accountDeletions.userId, pending.userId));
    if (!before) throw new Error("no deletion row");
    expect(before.scheduledFor.getTime()).toBeGreaterThan(Date.now());
    const forward = await admin.client.call<{ id: string; scheduledFor: string }>("POST", path(pending.username), body);
    expect(forward.status).toBe(200);
    expect(forward.body.id).toBe(before.id);
    expect(new Date(forward.body.scheduledFor).getTime()).toBeLessThanOrEqual(Date.now());
    const [pa] = await audits("account.deletion.expedite", pending.userId);
    expect(pa?.details).toEqual({ deletionId: before.id, created: false });

    const [plain] = await users(1);
    if (!plain) throw new Error("signup");
    expect((await plain.client.call("POST", path(fresh.username), body)).status).toBe(403);
  });
});
