// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 5, ADR 0042 (paid time and share refunds on deletion):
 *
 * - requesting a deletion stops renewal on every subscription it would end (paid by the member or
 *   on the member's channel, gifts excepted), at the provider first and locally with the marker;
 *   a provider that cannot be reached refuses the request and changes nothing;
 * - cancelling it turns renewal back on for exactly the marked ones; a provider that fails then
 *   leaves that one ending on both sides, unmarked, and the cancel still succeeds;
 * - the preview counts subscriptions paid past the deletion date (`endingBeforePaidThrough`);
 * - `coop.shares.askRefundDetails`: treasurer only, refund_pending or a leaving member's held
 *   share, once a day, audited by id, mailed through Mailpit, never returning the address;
 *   `coop.shares.list` fills `deletionScheduledFor`.
 *
 * Stripe runs against stripe-mock (skipped with a note when it is not running, failing in CI).
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import { mailTo, signUpAndSignIn, startApi, uniqueName, waitFor, type TestApi } from "./harness.ts";

type Person = Awaited<ReturnType<typeof signUpAndSignIn>>;
type Sub = typeof schema.subscriptions.$inferSelect;

const STRIPE_MOCK = process.env.STRIPE_MOCK_URL ?? "http://127.0.0.1:12111";
const DEAD_STRIPE = "http://127.0.0.1:9";
const DAY = 86_400_000;

async function stripeMockUp(): Promise<boolean> {
  try {
    const res = await fetch(`${STRIPE_MOCK}/v1/customers`, {
      headers: { authorization: "Bearer sk_test_123" },
      signal: AbortSignal.timeout(1_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
const stripeUp = await stripeMockUp();
if (!stripeUp && process.env.CI) throw new Error(`stripe-mock is not reachable at ${STRIPE_MOCK} (CI is set)`);
if (!stripeUp) console.warn(`stripe-mock is not reachable at ${STRIPE_MOCK}; skipping its tests`);

let api: TestApi;
const db = () => api.db.db;

function useProvider(provider: "manual" | "stripe", base = STRIPE_MOCK) {
  Object.assign(api.deps.env, {
    PAYMENTS_PROVIDER: provider,
    STRIPE_SECRET_KEY: provider === "stripe" ? "sk_test_123" : undefined,
    STRIPE_API_BASE: provider === "stripe" ? base : undefined,
  });
}

async function channelOf(who: Person): Promise<string> {
  const [c] = await db()
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(eq(schema.channels.ownerId, who.userId));
  if (!c) throw new Error("no channel");
  return c.id;
}

async function subscribe(
  subscriber: Person,
  channel: Person,
  over: Partial<typeof schema.subscriptions.$inferInsert> = {},
): Promise<Sub> {
  const [row] = await db()
    .insert(schema.subscriptions)
    .values({
      subscriberId: subscriber.userId,
      channelId: await channelOf(channel),
      tier: 1,
      status: "active",
      provider: "manual",
      providerRef: uniqueName("ref"),
      priceCents: 500,
      currency: "usd",
      currentPeriodStart: new Date(Date.now() - 5 * DAY),
      currentPeriodEnd: new Date(Date.now() + 25 * DAY),
      ...over,
    })
    .returning();
  if (!row) throw new Error("no subscription");
  return row;
}

const subRow = async (id: string): Promise<Sub> => {
  const [r] = await db().select().from(schema.subscriptions).where(eq(schema.subscriptions.id, id));
  if (!r) throw new Error("no subscription");
  return r;
};

async function requestDeletion(who: Person) {
  return who.client.call<{ id: string; status: string; scheduledFor: string }>("POST", "/api/me/deletion", {
    confirmUsername: who.username,
  });
}

/** A pending renewal payment for `sub` (what a late transfer or a dunning retry would confirm). */
async function pendingRenewal(sub: Sub, provider: "manual" | "stripe" = "manual"): Promise<string> {
  const [p] = await db()
    .insert(schema.payments)
    .values({
      provider,
      providerRef: uniqueName("renew"),
      kind: "subscription",
      status: "pending",
      userId: sub.subscriberId,
      channelId: sub.channelId,
      subscriptionId: sub.id,
      amountCents: sub.priceCents,
      currency: "usd",
      tier: sub.tier,
      quantity: 1,
    })
    .returning({ id: schema.payments.id });
  if (!p) throw new Error("no payment");
  return p.id;
}

const paymentStatus = async (id: string) => {
  const [p] = await db()
    .select({ status: schema.payments.status })
    .from(schema.payments)
    .where(eq(schema.payments.id, id));
  return p?.status;
};

const auditOf = (action: string, subjectId: string) =>
  db()
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.subjectId, subjectId)));

beforeAll(async () => {
  api = await startApi();
}, 120_000);
afterAll(async () => {
  useProvider("manual");
  await api?.stop();
});

describe("renewal stops when a deletion is requested (manual)", () => {
  test("marks exactly the concerned subscriptions; cancelling restores exactly those", async () => {
    useProvider("manual");
    const [leaver, creator, fan, other, gifter] = await Promise.all([
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
    ]);
    const pays = await subscribe(leaver, creator);
    const pastDue = await subscribe(leaver, other, { status: "past_due" });
    const pastDueRenewal = await pendingRenewal(pastDue);
    const onChannel = await subscribe(fan, leaver);
    const gift = await subscribe(leaver, await signUpAndSignIn(api), { giftedById: gifter.userId });
    const unrelated = await subscribe(fan, creator);
    // The member had already turned renewal off themselves: the deletion leaves it alone.
    const ownCancel = await subscribe(leaver, fan, { cancelAtPeriodEnd: true });
    // A subscription the member turns back on during the grace period loses the marker.
    const resumed = await subscribe(other, leaver);

    const r = await requestDeletion(leaver);
    expect(r.status).toBe(200);
    const deletionId = r.body.id;

    for (const s of [pays, onChannel, resumed])
      expect(await subRow(s.id)).toMatchObject({ cancelAtPeriodEnd: true, renewalStoppedByDeletionId: deletionId });
    // past_due: its period is over, so it ends now and its open renewal fails (a late transfer
    // cannot revive it). Nothing marks it: cancelling the deletion has nothing to restore.
    expect(await subRow(pastDue.id)).toMatchObject({ status: "canceled", renewalStoppedByDeletionId: null });
    expect(await paymentStatus(pastDueRenewal)).toBe("failed");
    const [endedAudit] = await auditOf("subscription.renewal_stop", pastDue.id);
    expect(endedAudit?.details).toEqual({ deletionId, subscriptionId: pastDue.id, priceCents: 500, endedNow: true });
    for (const s of [gift, unrelated])
      expect(await subRow(s.id)).toMatchObject({ cancelAtPeriodEnd: false, renewalStoppedByDeletionId: null });
    expect(await subRow(ownCancel.id)).toMatchObject({ cancelAtPeriodEnd: true, renewalStoppedByDeletionId: null });

    // One audit row per subscription, ids and cents only.
    const [a] = await auditOf("subscription.renewal_stop", pays.id);
    expect(a).toMatchObject({ actorType: "user", actorId: leaver.userId });
    expect(a?.details).toEqual({ deletionId, subscriptionId: pays.id, priceCents: 500 });
    expect(await auditOf("subscription.renewal_stop", gift.id)).toHaveLength(0);

    // Asking again is the same deletion and stops nothing more.
    const again = await requestDeletion(leaver);
    expect(again.body.id).toBe(deletionId);
    expect(await auditOf("subscription.renewal_stop", pays.id)).toHaveLength(1);

    // The member turns `resumed` back on by hand: the trigger drops the marker.
    await db()
      .update(schema.subscriptions)
      .set({ cancelAtPeriodEnd: false })
      .where(eq(schema.subscriptions.id, resumed.id));
    expect(await subRow(resumed.id)).toMatchObject({ cancelAtPeriodEnd: false, renewalStoppedByDeletionId: null });
    await db()
      .update(schema.subscriptions)
      .set({ cancelAtPeriodEnd: true })
      .where(eq(schema.subscriptions.id, resumed.id));

    expect((await leaver.client.call("DELETE", "/api/me/deletion")).status).toBe(200);
    for (const s of [pays, onChannel])
      expect(await subRow(s.id)).toMatchObject({ cancelAtPeriodEnd: false, renewalStoppedByDeletionId: null });
    expect(await subRow(pastDue.id)).toMatchObject({ status: "canceled" });
    // Not this deletion's to restore: the member's own cancels stay.
    expect(await subRow(ownCancel.id)).toMatchObject({ cancelAtPeriodEnd: true });
    expect(await subRow(resumed.id)).toMatchObject({ cancelAtPeriodEnd: true, renewalStoppedByDeletionId: null });
    const [back] = await auditOf("subscription.renewal_resume", pays.id);
    expect(back?.details).toEqual({ deletionId, subscriptionId: pays.id, resumed: true });
    expect(await auditOf("subscription.renewal_resume", resumed.id)).toHaveLength(0);
  });

  test("a Stripe subscription on an instance that cannot reach the provider refuses the request", async () => {
    useProvider("stripe", DEAD_STRIPE);
    const [leaver, creator] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
    const manual = await subscribe(leaver, creator);
    const card = await subscribe(leaver, await signUpAndSignIn(api), {
      provider: "stripe",
      providerRef: `sub_${uniqueName("")}`,
    });
    const r = await requestDeletion(leaver);
    expect(r.status).toBe(412);
    expect(JSON.stringify(r.body)).toContain("payment_provider");
    const rows = await db()
      .select()
      .from(schema.accountDeletions)
      .where(eq(schema.accountDeletions.userId, leaver.userId));
    expect(rows).toHaveLength(0);
    for (const s of [manual, card])
      expect(await subRow(s.id)).toMatchObject({ cancelAtPeriodEnd: false, renewalStoppedByDeletionId: null });
    useProvider("manual");
  });

  test("a manual-only instance refuses when a provider subscription exists (nothing to stop it with)", async () => {
    useProvider("manual");
    const [leaver, creator] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
    await subscribe(leaver, creator, { provider: "stripe", providerRef: `sub_${uniqueName("")}` });
    expect((await requestDeletion(leaver)).status).toBe(412);
  });
});

describe.skipIf(!stripeUp)("renewal stops at Stripe (stripe-mock)", () => {
  test("request stops and marks; cancel resumes at Stripe and locally", async () => {
    useProvider("stripe");
    const [leaver, creator] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
    const card = await subscribe(leaver, creator, { provider: "stripe", providerRef: `sub_${uniqueName("")}` });
    const r = await requestDeletion(leaver);
    expect(r.status).toBe(200);
    expect(await subRow(card.id)).toMatchObject({ cancelAtPeriodEnd: true, renewalStoppedByDeletionId: r.body.id });
    expect((await leaver.client.call("DELETE", "/api/me/deletion")).status).toBe(200);
    expect(await subRow(card.id)).toMatchObject({ cancelAtPeriodEnd: false, renewalStoppedByDeletionId: null });
    useProvider("manual");
  });

  test("a past_due Stripe subscription ends now at Stripe and here, its renewal failed", async () => {
    useProvider("stripe");
    const [leaver, creator] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
    const card = await subscribe(leaver, creator, {
      provider: "stripe",
      providerRef: `sub_${uniqueName("")}`,
      status: "past_due",
      currentPeriodEnd: new Date(Date.now() - DAY),
    });
    const renewal = await pendingRenewal(card, "stripe");
    const calls: { atPeriodEnd: boolean; idempotencyKey: string }[] = [];
    const { createAdapter } = await import("@commonair/payments");
    const real = createAdapter(api.deps.env);
    const { stopRenewalsAtProvider, endPastDue } = await import("../src/moderation/deletion.ts");
    // The request through the API, against stripe-mock.
    const r = await requestDeletion(leaver);
    expect(r.status).toBe(200);
    expect(await subRow(card.id)).toMatchObject({ status: "canceled", renewalStoppedByDeletionId: null });
    expect(await paymentStatus(renewal)).toBe("failed");
    expect((await leaver.client.call("DELETE", "/api/me/deletion")).status).toBe(200);
    expect(await subRow(card.id)).toMatchObject({ status: "canceled" });

    // What the provider is told: end now (not at period end), under the stable "-now" key.
    const other = await signUpAndSignIn(api);
    const due = await subscribe(other, creator, {
      provider: "stripe",
      providerRef: `sub_${uniqueName("")}`,
      status: "past_due",
    });
    const spy = {
      provider: real.provider,
      cancelSubscription: async (ref: string, opts: { atPeriodEnd: boolean; idempotencyKey: string }) => {
        calls.push(opts);
        await real.cancelSubscription?.(ref, opts);
      },
      resumeSubscription: real.resumeSubscription?.bind(real),
    };
    const stopped = await stopRenewalsAtProvider(db(), spy, other.userId, "d1", api.deps.logger);
    expect(stopped).toMatchObject({ ids: [], endedIds: [due.id] });
    expect(calls).toEqual([{ atPeriodEnd: false, idempotencyKey: `deletion-d1-stop-${due.id}-now` }]);
    // A row the provider did not end is left alone locally.
    const ended = await db().transaction((tx) =>
      endPastDue(tx, {
        userId: other.userId,
        deletionId: "d1",
        providerEnded: [],
        actorId: other.userId,
        now: new Date(),
      }),
    );
    expect(ended.size).toBe(0);
    expect(await subRow(due.id)).toMatchObject({ status: "past_due" });
    useProvider("manual");
  });

  test("a provider failure on cancel keeps the deletion cancelled and the subscription ending, unmarked", async () => {
    useProvider("stripe");
    const [leaver, creator] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
    const card = await subscribe(leaver, creator, { provider: "stripe", providerRef: `sub_${uniqueName("")}` });
    const manual = await subscribe(leaver, await signUpAndSignIn(api));
    const r = await requestDeletion(leaver);
    expect(r.status).toBe(200);
    useProvider("stripe", DEAD_STRIPE);
    expect((await leaver.client.call("DELETE", "/api/me/deletion")).status).toBe(200);
    const [d] = await db().select().from(schema.accountDeletions).where(eq(schema.accountDeletions.id, r.body.id));
    expect(d?.status).toBe("canceled");
    expect(await subRow(card.id)).toMatchObject({ cancelAtPeriodEnd: true, renewalStoppedByDeletionId: null });
    expect(await subRow(manual.id)).toMatchObject({ cancelAtPeriodEnd: false });
    const [a] = await auditOf("subscription.renewal_resume", card.id);
    expect(a?.details).toMatchObject({ resumed: false });
    useProvider("manual");
  });
});

describe("me.deletion.preview endingBeforePaidThrough", () => {
  test("counts concerned subscriptions paid past the deletion date (now + grace, then the scheduled date)", async () => {
    useProvider("manual");
    const [leaver, creator, fan, gifter] = await Promise.all([
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
    ]);
    await subscribe(leaver, creator, { currentPeriodEnd: new Date(Date.now() + 10 * DAY) });
    await subscribe(leaver, await signUpAndSignIn(api), { currentPeriodEnd: new Date(Date.now() + 40 * DAY) });
    await subscribe(fan, leaver, { currentPeriodEnd: new Date(Date.now() + 45 * DAY) });
    await subscribe(leaver, await signUpAndSignIn(api), {
      currentPeriodEnd: new Date(Date.now() + 60 * DAY),
      giftedById: gifter.userId,
    });
    await subscribe(leaver, await signUpAndSignIn(api), {
      currentPeriodEnd: new Date(Date.now() + 60 * DAY),
      status: "canceled",
    });
    const preview = async () =>
      (await leaver.client.call<{ endingBeforePaidThrough: number }>("GET", "/api/me/deletion/preview")).body;
    expect((await preview()).endingBeforePaidThrough).toBe(2);
    const r = await requestDeletion(leaver);
    expect(r.status).toBe(200);
    // Move the scheduled date out past both: nothing ends early any more.
    await db()
      .update(schema.accountDeletions)
      .set({ scheduledFor: new Date(Date.now() + 50 * DAY) })
      .where(eq(schema.accountDeletions.id, r.body.id));
    expect((await preview()).endingBeforePaidThrough).toBe(0);
  });
});

describe("coop.shares.askRefundDetails", () => {
  let treasurer: Person;
  beforeAll(async () => {
    treasurer = await signUpAndSignIn(api);
    await db().update(schema.users).set({ role: "treasurer" }).where(eq(schema.users.id, treasurer.userId));
  }, 60_000);

  async function share(member: Person, status: "held" | "refund_pending") {
    return db().transaction(async (tx) => {
      // The purchase is out of scope here, so the guard is bypassed by the owner.
      await tx.execute(sql`alter table membership_shares disable trigger membership_shares_guard`);
      const [row] = await tx
        .insert(schema.membershipShares)
        .values({ userId: member.userId, amountCents: 500, currency: "usd", status, purchasedAt: new Date() })
        .returning();
      await tx.execute(sql`alter table membership_shares enable trigger membership_shares_guard`);
      if (!row) throw new Error("no share");
      return row;
    });
  }
  const ask = (who: Person, shareId: string) =>
    who.client.call<Record<string, unknown>>("POST", `/api/coop/shares/${shareId}/refund-details`, {});

  test("treasurer only; a held share needs a scheduled deletion", async () => {
    const member = await signUpAndSignIn(api);
    const s = await share(member, "held");
    expect((await ask(member, s.id)).status).toBe(403);
    expect((await ask(treasurer, s.id)).status).toBe(409);
    expect((await ask(treasurer, crypto.randomUUID())).status).toBe(404);
  });

  test("a leaving member is emailed; once a day; audited by id; the address never returned", async () => {
    const member = await signUpAndSignIn(api);
    const s = await share(member, "held");
    const d = await requestDeletion(member);
    expect(d.status).toBe(200);

    const listed = await treasurer.client.call<{ items: { id: string; deletionScheduledFor: string | null }[] }>(
      "GET",
      "/api/coop/shares?status=held&limit=100",
    );
    expect(listed.body.items.find((i) => i.id === s.id)?.deletionScheduledFor).toBe(
      new Date(d.body.scheduledFor).toISOString(),
    );

    const r = await ask(treasurer, s.id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: s.id, status: "held", deletionScheduledFor: expect.any(String) });
    expect(typeof r.body.refundDetailsRequestedAt).toBe("string");
    expect(JSON.stringify(r.body)).not.toContain(member.email);

    const mail = await waitFor(async () => {
      const m = await mailTo(member.email);
      return m && m.subject.includes("member share") ? m : null;
    });
    expect(mail.text).toContain(s.id);

    const [a] = await auditOf("coop.share.refund_details_requested", s.id);
    expect(a).toMatchObject({ actorId: treasurer.userId, subjectType: "membership_share" });
    expect(a?.details).toEqual({ shareId: s.id, userId: member.userId, amountCents: 500 });
    expect(JSON.stringify(a)).not.toContain(member.email);

    // Once a day.
    expect((await ask(treasurer, s.id)).status).toBe(409);
    await db()
      .update(schema.membershipShares)
      .set({ refundDetailsRequestedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(schema.membershipShares.id, s.id));
    expect((await ask(treasurer, s.id)).status).toBe(200);
  });

  test("a refund_pending share can be asked about; a deleted member cannot be emailed", async () => {
    const member = await signUpAndSignIn(api);
    const s = await share(member, "refund_pending");
    expect((await ask(treasurer, s.id)).status).toBe(200);

    const gone = await signUpAndSignIn(api);
    const t = await share(gone, "refund_pending");
    await db()
      .update(schema.users)
      .set({ deletedAt: new Date(), pseudonymizedAt: new Date() })
      .where(eq(schema.users.id, gone.userId));
    expect((await ask(treasurer, t.id)).status).toBe(412);
    const [row] = await db().select().from(schema.membershipShares).where(eq(schema.membershipShares.id, t.id));
    expect(row?.refundDetailsRequestedAt).toBeNull();
  });
});
