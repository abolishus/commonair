// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 5, w5-admin: `safety.auditLog`'s time range (from inclusive, to exclusive, with the
 * other filters and the cursor) and `AdminQueueCount.nextDueAt` per queue that runs on a clock.
 * This file owns its database (`startApi` → `createTestDatabase()`), so every queue row is its own.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { adminOverview } from "../src/admin-console/overview.ts";
import { auditRange } from "../src/safety/audit-log.ts";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
type Entry = { id: string; actorId: string | null; createdAt: string };
type Page = { items: Entry[]; nextCursor: string | null };

let api: TestApi;
let admin: User;
let other: User;
beforeAll(async () => {
  api = await startApi();
  [admin, other] = (await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)])) as [User, User];
  await db().update(schema.users).set({ role: "admin" }).where(eq(schema.users.id, admin.userId));
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;
const H = 60 * 60_000;

describe("safety.auditLog from/to", () => {
  const T = new Date("2026-11-01T00:00:00.000Z");
  const plus = (ms: number) => new Date(T.getTime() + ms);
  const subjectType = "w5_admin_test";
  const ids = new Map<string, string>();

  beforeAll(async () => {
    const rows: [string, Date, string | null][] = [
      ["before", plus(-1), admin.userId],
      ["atFrom", T, admin.userId],
      ["middle", plus(30 * 60_000), other.userId],
      ["lastIn", plus(H - 1), admin.userId],
      ["atTo", plus(H), admin.userId],
    ];
    for (const [name, at, actorId] of rows) {
      const id = uuidv7();
      ids.set(name, id);
      await db()
        .insert(schema.auditLog)
        .values({
          id,
          actorType: actorId ? "admin" : "system",
          actorId,
          action: "w5.test",
          subjectType,
          subjectId: name,
          details: {},
          createdAt: at,
        });
    }
  });

  const list = (q: Record<string, string>) =>
    admin.client.call<Page>("GET", `/api/admin/audit-log?${new URLSearchParams({ subjectType, ...q }).toString()}`);
  const names = (p: Page) => p.items.map((e) => [...ids].find(([, id]) => id === e.id)?.[0]);

  test("from is inclusive and to exclusive", async () => {
    const r = await list({ from: T.toISOString(), to: plus(H).toISOString() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(names(r.body)).toEqual(["lastIn", "middle", "atFrom"]);
  });

  test("either end may be open", async () => {
    expect(names((await list({ from: T.toISOString() })).body)).toEqual(["atTo", "lastIn", "middle", "atFrom"]);
    expect(names((await list({ to: T.toISOString() })).body)).toEqual(["before"]);
    expect(names((await list({})).body)).toHaveLength(5);
  });

  test("an offset is honoured: the same instant in another zone", async () => {
    const r = await list({ from: "2026-11-01T01:00:00+01:00", to: "2026-11-01T00:00:00.001Z" });
    expect(names(r.body)).toEqual(["atFrom"]);
  });

  test("combines with the actor filter and pages with the cursor", async () => {
    const range = { from: T.toISOString(), to: plus(H).toISOString() };
    expect(names((await list({ ...range, actorId: admin.userId })).body)).toEqual(["lastIn", "atFrom"]);
    const first = await list({ ...range, limit: "2" });
    expect(names(first.body)).toEqual(["lastIn", "middle"]);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await list({ ...range, limit: "2", cursor: first.body.nextCursor ?? "" });
    expect(names(second.body)).toEqual(["atFrom"]);
    expect(second.body.nextCursor).toBeNull();
  });

  test("an empty or reversed range is a 400; the range stays admin-only", async () => {
    expect((await list({ from: T.toISOString(), to: T.toISOString() })).status).toBe(400);
    expect((await list({ from: plus(H).toISOString(), to: T.toISOString() })).status).toBe(400);
    expect((await list({ from: "yesterday" })).status).toBe(400);
    const plain = await other.client.call("GET", `/api/admin/audit-log?from=${encodeURIComponent(T.toISOString())}`);
    expect(plain.status).toBe(403);
  });

  test("auditRange: bounds as dates, open ends null", () => {
    expect(auditRange()).toEqual({ from: null, to: null });
    expect(auditRange(T.toISOString())).toEqual({ from: T, to: null });
    expect(auditRange(undefined, T.toISOString())).toEqual({ from: null, to: T });
    expect(() => auditRange(T.toISOString(), T.toISOString())).toThrow("`from` must be before `to`");
  });
});

describe("admin.overview nextDueAt", () => {
  const NOW = new Date("2030-01-01T12:00:00.000Z");
  const at = (h: number) => new Date(NOW.getTime() + h * H);
  const queue = async (q: string, now = NOW) => {
    const found = (await adminOverview(db(), "admin", now)).queues.find((x) => x.queue === q);
    if (!found) throw new Error(`no ${q} queue`);
    return found;
  };
  const legalQueue = async () => (await adminOverview(db(), "legal", NOW)).queues.find((x) => x.queue === "legal");

  test("is null on every queue while nothing waits", async () => {
    for (const q of (await adminOverview(db(), "admin", NOW)).queues) expect(q.nextDueAt).toBeNull();
    expect((await legalQueue())?.nextDueAt).toBeNull();
  });

  test("moderation and legal: the soonest SLA not yet passed, open cases only", async () => {
    const make = async (slaDueAt: Date | null, tier: "t0" | "t1" = "t1", status: "open" | "cleared" = "open") => {
      const id = uuidv7();
      await db()
        .insert(schema.moderationCases)
        .values({
          id,
          tier,
          status: "open",
          origin: tier === "t0" ? "hash_list" : "classifier",
          subjectType: "broadcast",
          subjectId: uuidv7(),
          category: tier === "t0" ? null : "weapons",
          ...(tier === "t0" ? { listCategory: "ncii" as const } : {}),
          slaDueAt,
        });
      if (status === "cleared")
        await db()
          .update(schema.moderationCases)
          .set({ status: "cleared", resolution: "clear", resolvedAt: new Date(), resolvedById: admin.userId })
          .where(eq(schema.moderationCases.id, id));
    };
    await make(at(-1)); // overdue: counted as overdue, never "next"
    await make(at(3));
    await make(at(2), "t1", "cleared"); // decided: not open
    await make(null);
    await make(at(5), "t0");
    const mod = await queue("moderation");
    expect(mod).toMatchObject({ overdue: 1, nextDueAt: at(3).toISOString() });
    expect((await legalQueue())?.nextDueAt).toBe(at(5).toISOString());
    // A deadline exactly now is due, not overdue (the same edge as dueSoon).
    expect((await queue("moderation", at(3))).nextDueAt).toBe(at(3).toISOString());
    expect((await queue("moderation", at(4))).nextDueAt).toBeNull();
  });

  test("dmca: the soonest counter-notice restore date; a notice awaiting a decision has none", async () => {
    const notice = async (status: "received" | "countered") => {
      const id = uuidv7();
      await db()
        .insert(schema.dmcaNotices)
        .values({
          id,
          claimantName: "C",
          claimantEmail: "c@example.test",
          claimantAddress: "A",
          copyrightedWork: "W",
          infringingUrls: ["https://example.test/x"],
          goodFaithStatement: true,
          accuracyStatement: true,
          signature: "C",
          status,
        });
      return id;
    };
    await notice("received");
    expect(await queue("dmca")).toMatchObject({ open: 1, nextDueAt: null });
    // One counter-notice per notice and person, so each gets its own (countered) notice.
    const counter = async (restoreAfter: Date, extra: { restoredAt?: Date } = {}) =>
      db()
        .insert(schema.dmcaCounterNotices)
        .values({
          noticeId: await notice("countered"),
          userId: other.userId,
          fullName: "F",
          address: "A",
          phone: "1",
          itemIds: [],
          statement: "S",
          goodFaithStatement: true,
          consentToJurisdiction: true,
          signature: "F",
          restoreAfter,
          ...extra,
        });
    await counter(at(-2));
    await counter(at(10), { restoredAt: at(-1) }); // restored: closed
    await counter(at(24));
    await counter(at(48));
    expect(await queue("dmca")).toMatchObject({ open: 4, overdue: 1, nextDueAt: at(24).toISOString() });
  });

  test("ncii: the request's own legal clock, until it passes", async () => {
    const [row] = await db()
      .insert(schema.nciiRequests)
      .values({
        requesterName: "R",
        requesterEmail: "r@test.invalid",
        relationship: "self",
        contentUrls: ["https://example.invalid/x"],
        description: "d",
        goodFaith: true,
        signature: "R",
        deadlineAt: new Date(Date.now() + 48 * H),
      })
      .returning({ deadlineAt: schema.nciiRequests.deadlineAt });
    // The database dates the clock itself: read it back, then look from before and after it.
    const deadline = row?.deadlineAt;
    if (!deadline) throw new Error("no deadline");
    const before = new Date(deadline.getTime() - H);
    expect((await queue("ncii", before)).nextDueAt).toBe(deadline.toISOString());
    expect((await queue("ncii", new Date(deadline.getTime() + 1))).nextDueAt).toBeNull();
  });

  test("payments: the soonest expiry of a pending manual payment", async () => {
    const pay = (
      expiresAt: Date | null,
      over: { provider?: "manual" | "stripe"; status?: "pending" | "failed" } = {},
    ) =>
      db()
        .insert(schema.payments)
        .values({
          provider: over.provider ?? "manual",
          providerRef: uuidv7(),
          kind: "membership_share",
          status: over.status ?? "pending",
          userId: other.userId,
          amountCents: 2500,
          currency: "usd",
          expiresAt,
        });
    await pay(at(1), { status: "failed" });
    await pay(at(2), { provider: "stripe" });
    await pay(at(6));
    await pay(null);
    await pay(at(-1));
    expect(await queue("payments")).toMatchObject({ open: 3, overdue: 1, nextDueAt: at(6).toISOString() });
  });

  test("queues without deadlines stay null with open work", async () => {
    await db()
      .insert(schema.appeals)
      .values({ appellantId: other.userId, kind: "account", subjectType: "account", subjectId: uuidv7(), body: "b" });
    expect(await queue("appeals")).toMatchObject({ open: 1, nextDueAt: null });
    for (const q of ["integrity", "incidents", "apps_review"]) expect((await queue(q)).nextDueAt).toBeNull();
  });
});
