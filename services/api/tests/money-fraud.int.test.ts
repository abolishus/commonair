// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `money.treasurer.fraudFlags.*` (ADR 0036) over HTTP against a real database: access levels,
 * raise (with the hold and the re-tag of account-not-ready holds), review, four-eyes decide,
 * clear releasing holds only when nothing else holds, confirm keeping them (also for later
 * batches), the admin release, and audit rows that never carry the treasurers' note.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { DEFAULT_PLATFORM_CUT, paymentSucceeded, post } from "@commonair/ledger";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Person = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface Flag {
  id: string;
  payee: { id: string; username: string; displayName: string };
  kind: string;
  status: string;
  evidence: Record<string, string | number>;
  raisedBy: { id: string; username: string } | null;
  reviewedBy: { id: string; username: string } | null;
  recommendation: string | null;
  decidedBy: { id: string; username: string } | null;
  releasedBy: { id: string; username: string } | null;
  releasedAt: string | null;
  note: string;
  heldPayouts: number;
}
interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
interface ErrorBody {
  code: string;
  data?: { reason?: string };
}

let api: TestApi;
let t1: Person;
let t2: Person;
let admin: Person;
let plain: Person;
const db = () => api.db.db;
const DAY = 86_400_000;
const NOTE = "Secret reviewer note about the payee";

async function setRole(p: Person, role: "treasurer" | "admin") {
  await db().update(schema.users).set({ role }).where(eq(schema.users.id, p.userId));
}

beforeAll(async () => {
  api = await startApi();
  [t1, t2, admin, plain] = await Promise.all([
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
  ]);
  await setRole(t1, "treasurer");
  await setRole(t2, "treasurer");
  await setRole(admin, "admin");
});
afterAll(async () => {
  await api?.stop();
});

let periods = 0;
async function payout(userId: string, status: "pending" | "held" | "paid", holdReason: string | null = null) {
  periods += 1;
  const start = new Date(Date.UTC(2025, 0, periods));
  const [p] = await db()
    .insert(schema.payouts)
    .values({
      userId,
      periodStart: start,
      periodEnd: new Date(start.getTime() + DAY),
      amountCents: 1000,
      currency: "usd",
      provider: "manual",
      status,
      holdReason,
      paidAt: status === "paid" ? new Date() : null,
    })
    .returning();
  return p!;
}
const payoutRow = async (id: string) => (await db().select().from(schema.payouts).where(eq(schema.payouts.id, id)))[0]!;

const raise = (who: Person, username: string, note = "") =>
  who.client.call<Flag>("POST", "/api/treasurer/fraud-flags", { username, note });
const review = (who: Person, id: string, recommendation: "clear" | "confirm", note = "") =>
  who.client.call<Flag>("POST", `/api/treasurer/fraud-flags/${id}/review`, { recommendation, note });
const decide = (who: Person, id: string, decision: "clear" | "confirm", note = "") =>
  who.client.call<Flag & ErrorBody>("POST", `/api/treasurer/fraud-flags/${id}/decide`, { decision, note });
const release = (who: Person, id: string) =>
  who.client.call<Flag & ErrorBody>("POST", `/api/treasurer/fraud-flags/${id}/release`, {});
const list = (who: Person, q = "") => who.client.call<Page<Flag>>("GET", `/api/treasurer/fraud-flags${q}`);

async function auditOf(flagId: string) {
  return db()
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.subjectType, "payment_fraud_flag"), eq(schema.auditLog.subjectId, flagId)));
}
async function eventsOf(flagId: string) {
  return (await db().select().from(schema.events).where(eq(schema.events.type, "money.fraud.flag"))).filter(
    (e) => e.payload.flag_id === flagId,
  );
}

/** A creator with a manual payout account (ready unless `ready` is false). */
async function payee(ready = true): Promise<Person> {
  const p = await signUpAndSignIn(api);
  if (!ready) return p;
  const r = await t1.client.call("PUT", `/api/treasurer/payout-accounts/${p.username}`, {
    payoutsEnabled: true,
    reference: "bank-ref-1",
  });
  if (r.status !== 200) throw new Error(`setPayoutAccount: ${r.status}`);
  return p;
}

/** A flag of `payee` raised by t1 and reviewed by t2 with `recommendation`. */
async function reviewed(p: Person, recommendation: "clear" | "confirm" = "clear"): Promise<Flag> {
  const raised = await raise(t1, p.username);
  expect(raised.status).toBe(200);
  const r = await review(t2, raised.body.id, recommendation);
  expect(r.status).toBe(200);
  return r.body;
}

describe("access", () => {
  test("list: treasurer only; decide: treasurer or admin; release: admin only", async () => {
    expect((await list(plain)).status).toBe(403);
    expect((await list(admin)).status).toBe(403);
    expect((await list(t1)).status).toBe(200);
    expect((await raise(plain, t1.username)).status).toBe(403);
    const id = uuidv7();
    expect((await decide(plain, id, "clear")).status).toBe(403);
    expect((await release(t1, id)).status).toBe(403);
    expect((await release(plain, id)).status).toBe(403);
    // Admin passes the access check and reaches the handler.
    expect((await decide(admin, id, "clear")).status).toBe(404);
    expect((await release(admin, id)).status).toBe(404);
  });
});

describe("raise", () => {
  test("holds pending payouts and re-tags account-not-ready holds; paid stays paid", async () => {
    const p = await payee(false);
    const pending = await payout(p.userId, "pending");
    const notReady = await payout(p.userId, "held", "payout_account_not_ready");
    const paid = await payout(p.userId, "paid");
    const r = await raise(t1, p.username, NOTE);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      kind: "manual",
      status: "open",
      payee: { id: p.userId, username: p.username },
      raisedBy: { id: t1.userId },
      note: NOTE,
      heldPayouts: 2,
    });
    expect(await payoutRow(pending.id)).toMatchObject({ status: "held", holdReason: "fraud_review" });
    expect(await payoutRow(notReady.id)).toMatchObject({ status: "held", holdReason: "fraud_review" });
    expect((await payoutRow(paid.id)).status).toBe("paid");

    // A second undecided manual flag is a conflict; an unknown user is not found.
    expect((await raise(t2, p.username)).status).toBe(409);
    expect((await raise(t1, "nobodyhere123")).status).toBe(404);

    const [a] = await auditOf(r.body.id);
    expect(a).toMatchObject({
      actorType: "admin",
      actorId: t1.userId,
      action: "money.fraud.raise",
      reason: "",
      details: { flagId: r.body.id, kind: "manual", status: "open" },
    });
    expect(JSON.stringify(a)).not.toContain("Secret");
    const [e] = await eventsOf(r.body.id);
    expect(e?.payload).toEqual({
      flag_id: r.body.id,
      payee_user_id: p.userId,
      kind: "manual",
      status: "open",
      released: false,
      held_payouts: 2,
    });
  });

  test("the account-ready path releases nothing for a flagged payee", async () => {
    const p = await payee(false);
    const held = await payout(p.userId, "held", "payout_account_not_ready");
    expect((await raise(t1, p.username)).status).toBe(200);
    const r = await t1.client.call("PUT", `/api/treasurer/payout-accounts/${p.username}`, {
      payoutsEnabled: true,
      reference: "bank-ref-2",
    });
    expect(r.status).toBe(200);
    expect(await payoutRow(held.id)).toMatchObject({ status: "held", holdReason: "fraud_review" });
  });
});

describe("review", () => {
  test("open → reviewed once, never by the payee", async () => {
    const p = await payee();
    const raised = (await raise(t1, p.username)).body;
    const r = await review(t1, raised.id, "confirm", NOTE);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "reviewed", recommendation: "confirm", reviewedBy: { id: t1.userId } });
    expect((await review(t2, raised.id, "clear")).status).toBe(409);
    const audit = await auditOf(raised.id);
    expect(audit.map((a) => a.action).sort()).toEqual(["money.fraud.raise", "money.fraud.review"]);
    for (const a of audit) {
      expect(Object.keys(a.details).sort()).toEqual(["flagId", "kind", "status"]);
      expect(a.reason).toBe("");
      expect(JSON.stringify(a)).not.toContain("Secret");
    }

    // A treasurer acting on a flag about their own payouts is refused.
    const selfTreasurer = await signUpAndSignIn(api);
    await setRole(selfTreasurer, "treasurer");
    const own = (await raise(t1, selfTreasurer.username)).body;
    expect((await review(selfTreasurer, own.id, "clear")).status).toBe(403);
    expect((await review(t2, own.id, "clear")).status).toBe(200);
    const d = await decide(selfTreasurer, own.id, "clear");
    expect(d.status).toBe(403);
    expect(d.body.data?.reason).toBe("second_approver");
  });
});

describe("decide", () => {
  test("the reviewer and the raiser are refused with SECOND_APPROVER; a second treasurer clears", async () => {
    const p = await payee();
    const pending = await payout(p.userId, "pending");
    const flag = await reviewed(p);
    expect(await payoutRow(pending.id)).toMatchObject({ status: "held", holdReason: "fraud_review" });

    for (const who of [t2, t1]) {
      const r = await decide(who, flag.id, "clear");
      expect(r.status).toBe(403);
      expect(r.body.data?.reason).toBe("second_approver");
    }
    const r = await decide(admin, flag.id, "clear", NOTE);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "cleared", decidedBy: { id: admin.userId }, heldPayouts: 0 });
    expect(await payoutRow(pending.id)).toMatchObject({ status: "pending", holdReason: null });
    expect((await decide(admin, flag.id, "confirm")).status).toBe(409);

    const events = await eventsOf(flag.id);
    expect(events.map((e) => e.payload.status)).toEqual(["open", "reviewed", "cleared"]);
    for (const a of await auditOf(flag.id)) expect(JSON.stringify(a)).not.toContain("Secret");
  });

  test("clear releases holds only when no other flag holds; without an account they wait for it", async () => {
    const p = await payee(false);
    const held = await payout(p.userId, "pending");
    const first = await reviewed(p);
    // A second, scan-raised flag on the same payee.
    const [other] = await db()
      .insert(schema.paymentFraudFlags)
      .values({ payeeUserId: p.userId, kind: "payer_concentration", evidence: { payers: 1 } })
      .returning();
    expect((await decide(admin, first.id, "clear")).status).toBe(200);
    expect(await payoutRow(held.id)).toMatchObject({ status: "held", holdReason: "fraud_review" });

    expect((await review(t1, other!.id, "clear")).status).toBe(200);
    expect((await decide(t2, other!.id, "clear")).status).toBe(200);
    expect(await payoutRow(held.id)).toMatchObject({ status: "held", holdReason: "payout_account_not_ready" });
  });

  test("confirm keeps holds, and a later payout batch creates the payout held", async () => {
    const p = await payee();
    const flag = await reviewed(p, "confirm");
    const r = await decide(admin, flag.id, "confirm");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "confirmed", releasedAt: null, releasedBy: null });

    // Released earnings for the payee, then this month's batch.
    const [channel] = await db()
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(eq(schema.channels.ownerId, p.userId));
    expect(channel).toBeDefined();
    await post(
      db(),
      paymentSucceeded({
        paymentId: uuidv7(),
        paymentKind: "tip",
        provider: "manual",
        creatorUserId: p.userId,
        grossCents: 5000,
        taxCents: 0,
        feeCents: 0,
        currency: "usd",
        cut: DEFAULT_PLATFORM_CUT,
        cutHistoryId: null,
        occurredAt: new Date(Date.now() - 20 * DAY),
      }),
    );
    const run = await t1.client.call<{ created: number; held: number }>("POST", "/api/treasurer/payouts/run", {
      periodEnd: new Date().toISOString(),
    });
    expect(run.status).toBe(200);
    const rows = await db().select().from(schema.payouts).where(eq(schema.payouts.userId, p.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "held", holdReason: "fraud_review" });
  });
});

describe("release", () => {
  test("an admin releases a confirmed flag once; the holds move and the event says released", async () => {
    const p = await payee();
    const pending = await payout(p.userId, "pending");
    const flag = await reviewed(p, "confirm");
    expect((await release(admin, flag.id)).status).toBe(409); // reviewed, not confirmed
    expect((await decide(admin, flag.id, "confirm")).status).toBe(200);
    expect(await payoutRow(pending.id)).toMatchObject({ status: "held", holdReason: "fraud_review" });
    expect((await release(t1, flag.id)).status).toBe(403);

    const r = await release(admin, flag.id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "confirmed", releasedBy: { id: admin.userId }, heldPayouts: 0 });
    expect(r.body.releasedAt).not.toBeNull();
    expect(await payoutRow(pending.id)).toMatchObject({ status: "pending", holdReason: null });
    expect((await release(admin, flag.id)).status).toBe(409);

    const audit = await auditOf(flag.id);
    const rel = audit.find((a) => a.action === "money.fraud.release");
    expect(rel).toMatchObject({
      actorId: admin.userId,
      details: { flagId: flag.id, kind: "manual", status: "confirmed" },
    });
    const events = await eventsOf(flag.id);
    const last = events.find((e) => e.payload.released === true);
    expect(last?.payload).toMatchObject({ status: "confirmed", released: true, held_payouts: 0 });
  });

  test("a cleared flag cannot be released", async () => {
    const p = await payee();
    const flag = await reviewed(p);
    expect((await decide(admin, flag.id, "clear")).status).toBe(200);
    expect((await release(admin, flag.id)).status).toBe(409);
  });
});

describe("list", () => {
  test("newest first, filtered by status, paged by keyset", async () => {
    const all = await list(t1, "?limit=100");
    expect(all.status).toBe(200);
    const raised = all.body.items.map((f) => f.id);
    expect(raised.length).toBeGreaterThan(3);
    const first = await list(t1, "?limit=2");
    expect(first.body.items.map((f) => f.id)).toEqual(raised.slice(0, 2));
    const second = await list(t1, `?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.items.map((f) => f.id)).toEqual(raised.slice(2, 4));

    const confirmed = await list(t1, "?status=confirmed&limit=100");
    expect(confirmed.body.items.length).toBeGreaterThan(0);
    for (const f of confirmed.body.items) expect(f.status).toBe("confirmed");
    expect(confirmed.body.items.some((f) => f.releasedBy !== null)).toBe(true);
  });
});
