// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Checkout edges under the manual provider that `money-checkout.int.test.ts` leaves out: unknown
 * and suspended channels, a held slot that cannot be resumed (a gift
 * waiting for payment, no pending payment, a payment open with another provider), a gift draw
 * with nobody eligible, cancelling a provider-managed subscription the instance cannot reach, a
 * past-due cancel with no open renewal, a repeat cancel, an anonymous tip in the owner's list, and
 * the shared helpers' empty cases.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { endSubscriptions, holdingSubscription, loadTiers, userEventFields } from "../src/money/checkout-shared.ts";
import { client, signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type User = Awaited<ReturnType<typeof signUpAndSignIn>>;
type Sub = { id: string; status: string; cancelAtPeriodEnd: boolean; provider: string };

let api: TestApi;
let streamer: User;
let fan: User;

const TIERS = [
  { tier: 1, name: "One", price: { cents: 500, currency: "usd" }, benefits: "" },
  { tier: 2, name: "Two", price: { cents: 1000, currency: "usd" }, benefits: "" },
  { tier: 3, name: "Three", price: { cents: 2500, currency: "usd" }, benefits: "" },
];

beforeAll(async () => {
  api = await startApi();
  [streamer, fan] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
  const currency = api.deps.env.CURRENCY;
  const r = await streamer.client.call("PUT", `/api/channels/${streamer.username}/subscription-tiers`, {
    tiers: TIERS.map((t) => ({ ...t, price: { ...t.price, currency } })),
  });
  if (r.status !== 200) throw new Error(`set tiers: ${r.status} ${JSON.stringify(r.body)}`);
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

const db = () => api.db.db;

async function channelOf(slug: string) {
  const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, slug));
  if (!c) throw new Error(`no channel ${slug}`);
  return c;
}

async function subRow(
  subscriberId: string,
  channelId: string,
  over: Partial<typeof schema.subscriptions.$inferInsert> = {},
) {
  const [s] = await db()
    .insert(schema.subscriptions)
    .values({
      subscriberId,
      channelId,
      tier: 1,
      status: "active",
      provider: "manual",
      priceCents: 500,
      currency: api.deps.env.CURRENCY,
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
      ...over,
    })
    .returning();
  if (!s) throw new Error("no subscription");
  return s;
}

async function payment(over: Partial<typeof schema.payments.$inferInsert> & { userId: string; channelId: string }) {
  const [p] = await db()
    .insert(schema.payments)
    .values({
      provider: "manual",
      providerRef: `CA-${uuidv7().slice(-8).toUpperCase()}`,
      kind: "subscription",
      status: "pending",
      amountCents: 500,
      currency: api.deps.env.CURRENCY,
      tier: 1,
      quantity: 1,
      expiresAt: new Date(Date.now() + 86_400_000),
      ...over,
    })
    .returning();
  if (!p) throw new Error("no payment");
  return p;
}

const subscribe = (as: User, channel: string, body: Record<string, unknown>) =>
  as.client.call<{ kind: string; paymentId: string; reference?: string; message?: string }>(
    "POST",
    `/api/channels/${channel}/subscriptions`,
    { returnPath: `/${channel}`, ...body },
  );

describe("support and tiers", () => {
  test("unknown channel 404; anonymous support has no viewer; the owner is flagged", async () => {
    expect((await client(api).call("GET", "/api/channels/no_such_channel_x/support")).status).toBe(404);
    expect((await client(api).call("GET", "/api/channels/no_such_channel_x/subscription-tiers")).status).toBe(404);
    const anon = await client(api).call<{ viewer: unknown; tiers: unknown[] }>(
      "GET",
      `/api/channels/${streamer.username}/support`,
    );
    expect(anon.status).toBe(200);
    expect(anon.body.viewer).toBeNull();
    expect(anon.body.tiers).toHaveLength(3);
    const own = await streamer.client.call<{ viewer: { isOwner: boolean; subscription: null } }>(
      "GET",
      `/api/channels/${streamer.username}/support`,
    );
    expect(own.body.viewer).toEqual({ isOwner: true, subscription: null });
  });

  test("an editor may not set prices", async () => {
    const [owner, editor] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
    await owner.client.call("PUT", `/api/channels/${owner.username}/roles/${editor.username}`, { role: "editor" });
    const r = await editor.client.call("PUT", `/api/channels/${owner.username}/subscription-tiers`, { tiers: TIERS });
    expect(r.status).toBe(403);
  });

  test("loadTiers is empty unless tiers 1, 2 and 3 are all set", async () => {
    const owner = await signUpAndSignIn(api);
    const c = await channelOf(owner.username);
    const currency = api.deps.env.CURRENCY;
    expect(await loadTiers(db(), c.id, currency)).toEqual([]);
    await db()
      .insert(schema.channelSubTiers)
      .values([
        { channelId: c.id, tier: 1, name: "a", priceCents: 100 },
        { channelId: c.id, tier: 3, name: "c", priceCents: 300 },
      ]);
    expect(await loadTiers(db(), c.id, currency)).toEqual([]);
  });
});

describe("subscribe and tip refusals", () => {
  test("unknown channel 404, suspended channel 412, no tiers 412", async () => {
    expect((await subscribe(fan, "no_such_channel_x", { tier: 1 })).status).toBe(404);
    const [susp, bare] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
    await db().update(schema.channels).set({ suspendedAt: new Date() }).where(eq(schema.channels.slug, susp.username));
    expect((await subscribe(fan, susp.username, { tier: 1 })).status).toBe(412);
    expect(
      (await fan.client.call("POST", `/api/channels/${susp.username}/tips`, { amountCents: 500, returnPath: "/" }))
        .status,
    ).toBe(412);
    expect((await subscribe(fan, bare.username, { tier: 1 })).status).toBe(412);
  });

  test("no new payment from an account being deleted, or to a channel whose owner's is (F0)", async () => {
    const [leaving, owner] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
    const schedule = (userId: string) =>
      db()
        .insert(schema.accountDeletions)
        .values({ userId, scheduledFor: new Date(Date.now() + 86_400_000) });
    const requirement = (r: { body: unknown }) => (r.body as { data?: { requirement?: string } }).data?.requirement;

    await schedule(leaving.userId);
    const sub = await subscribe(leaving, streamer.username, { tier: 1 });
    expect(sub.status).toBe(412);
    expect(requirement(sub)).toBe("account_active");
    const tip = await leaving.client.call("POST", `/api/channels/${streamer.username}/tips`, {
      amountCents: 500,
      returnPath: "/",
    });
    expect(tip.status).toBe(412);
    expect(requirement(tip)).toBe("account_active");
    const share = await leaving.client.call("POST", "/api/coop/shares", { returnPath: "/coop" });
    expect(share.status).toBe(412);
    expect(requirement(share)).toBe("account_active");

    // A channel whose owner is leaving: its subscriptions would end at the deletion.
    await owner.client.call("PUT", `/api/channels/${owner.username}/subscription-tiers`, { tiers: TIERS });
    await schedule(owner.userId);
    const toLeaving = await subscribe(fan, owner.username, { tier: 1 });
    expect(toLeaving.status).toBe(412);
    expect(requirement(toLeaving)).toBe("channel_active");
  });

  test("the same pending checkout resumes with the same payment and reference", async () => {
    const buyer = await signUpAndSignIn(api);
    const first = await subscribe(buyer, streamer.username, { tier: 1 });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.kind).toBe("instructions");
    const again = await subscribe(buyer, streamer.username, { tier: 1 });
    expect(again.body.paymentId).toBe(first.body.paymentId);
    expect(again.body.reference).toBe(first.body.reference);
  });

  test("a held slot that cannot resume: gift waiting, no pending payment, another provider", async () => {
    const c = await channelOf(streamer.username);
    const [gifted, stuck, other] = await Promise.all([
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
    ]);

    const giftPay = await payment({ userId: fan.userId, channelId: c.id, gift: true });
    await subRow(gifted.userId, c.id, { status: "incomplete", giftedById: fan.userId, giftPaymentId: giftPay.id });
    const g = await subscribe(gifted, streamer.username, { tier: 1 });
    expect(g.status).toBe(409);
    expect(g.body.message).toMatch(/gifted/i);

    await subRow(stuck.userId, c.id, { status: "incomplete" });
    const s = await subscribe(stuck, streamer.username, { tier: 1 });
    expect(s.status).toBe(409);
    expect(s.body.message).toMatch(/being updated/i);

    const held = await subRow(other.userId, c.id, { status: "incomplete", provider: "stripe" });
    await payment({
      userId: other.userId,
      channelId: c.id,
      subscriptionId: held.id,
      provider: "stripe",
      providerRef: `cs_${uuidv7()}`,
    });
    const o = await subscribe(other, streamer.username, { tier: 1 });
    expect(o.status).toBe(409);
    expect(o.body.message).toMatch(/another payment provider/i);

    // An active subscription is simply already there.
    const active = await signUpAndSignIn(api);
    await subRow(active.userId, c.id);
    expect((await subscribe(active, streamer.username, { tier: 1 })).status).toBe(409);
  });

  test("a random gift with nobody eligible says so", async () => {
    const lonely = await signUpAndSignIn(api);
    const currency = api.deps.env.CURRENCY;
    await lonely.client.call("PUT", `/api/channels/${lonely.username}/subscription-tiers`, {
      tiers: TIERS.map((t) => ({ ...t, price: { ...t.price, currency } })),
    });
    const r = await subscribe(fan, lonely.username, { tier: 1, gift: { count: 1 } });
    expect(r.status).toBe(412);
    expect(r.body.message).toMatch(/^No viewers/);
    // No live checkout is left behind.
    const pending = await db()
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.channelId, (await channelOf(lonely.username)).id));
    expect(pending).toEqual([]);
  });

  test("a gift to an unknown user is 404", async () => {
    // `fan` already has a gift waiting for payment here (above): a fresh gifter.
    const gifter = await signUpAndSignIn(api);
    const r = await subscribe(gifter, streamer.username, { tier: 1, gift: { count: 1, to: "no_such_user_x" } });
    expect(r.status).toBe(404);
    const again = await subscribe(fan, streamer.username, { tier: 1, gift: { count: 1, to: "no_such_user_x" } });
    expect(again.status).toBe(409);
  });
});

describe("cancelSubscription", () => {
  const cancel = (u: User, id: string) =>
    u.client.call<Sub & { message?: string }>("POST", `/api/me/subscriptions/${id}/cancel`);

  test("someone else's or an unknown subscription is 404", async () => {
    const c = await channelOf(streamer.username);
    const owner = await signUpAndSignIn(api);
    const s = await subRow(owner.userId, c.id);
    expect((await cancel(fan, s.id)).status).toBe(404);
    expect((await cancel(fan, uuidv7())).status).toBe(404);
  });

  test("a provider-managed subscription the instance cannot reach is refused", async () => {
    const c = await channelOf(streamer.username);
    const [noRef, withRef] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
    const a = await subRow(noRef.userId, c.id, { provider: "stripe" });
    const b = await subRow(withRef.userId, c.id, { provider: "stripe", providerRef: `sub_${uuidv7()}` });
    for (const [u, s] of [
      [noRef, a],
      [withRef, b],
    ] as const) {
      const r = await cancel(u, s.id);
      expect(r.status).toBe(412);
      const [row] = await db().select().from(schema.subscriptions).where(eq(schema.subscriptions.id, s.id));
      expect(row?.cancelAtPeriodEnd).toBe(false);
    }
  });

  test("an already-cancelling subscription is returned as it is; a past-due one with no renewal ends now", async () => {
    const c = await channelOf(streamer.username);
    const [cancelling, overdue] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
    const s = await subRow(cancelling.userId, c.id, { cancelAtPeriodEnd: true });
    const r = await cancel(cancelling, s.id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: s.id, status: "active", cancelAtPeriodEnd: true });
    // Provider-managed but already cancelling: no provider call is needed either.
    const viaStripe = await signUpAndSignIn(api);
    const sp = await subRow(viaStripe.userId, c.id, { provider: "stripe", cancelAtPeriodEnd: true });
    const spr = await cancel(viaStripe, sp.id);
    expect(spr.status).toBe(200);
    expect(spr.body).toMatchObject({ id: sp.id, provider: "stripe", cancelAtPeriodEnd: true });

    const pd = await subRow(overdue.userId, c.id, { status: "past_due" });
    const ended = await cancel(overdue, pd.id);
    expect(ended.status, JSON.stringify(ended.body)).toBe(200);
    expect(ended.body).toMatchObject({ status: "canceled", cancelAtPeriodEnd: false });
    const evs = await db().select().from(schema.events).where(eq(schema.events.type, "channel.subscription.end"));
    expect(evs.some((e) => (e.payload as { user_id: string }).user_id === overdue.userId)).toBe(true);
  });

  test("incomplete and gifted subscriptions cannot be cancelled", async () => {
    const c = await channelOf(streamer.username);
    const [inc, gift] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
    const a = await subRow(inc.userId, c.id, { status: "incomplete" });
    expect((await cancel(inc, a.id)).status).toBe(409);
    const b = await subRow(gift.userId, c.id, { giftedById: fan.userId });
    expect((await cancel(gift, b.id)).status).toBe(412);
  });
});

describe("tips", () => {
  test("anonymous tippers show no sender; pending and failed tips are not listed", async () => {
    const owner = await signUpAndSignIn(api);
    const c = await channelOf(owner.username);
    const insertTip = async (status: "succeeded" | "pending" | "failed", anonymous: boolean) => {
      const id = uuidv7();
      await db().insert(schema.tips).values({
        id,
        fromUserId: fan.userId,
        channelId: c.id,
        amountCents: 300,
        currency: api.deps.env.CURRENCY,
        message: "hi",
        anonymous,
        status,
      });
      return id;
    };
    const named = await insertTip("succeeded", false);
    const anonymous = await insertTip("succeeded", true);
    await insertTip("pending", false);
    await insertTip("failed", false);
    const r = await owner.client.call<{ items: { id: string; from: { username: string } | null }[] }>(
      "GET",
      `/api/channels/${owner.username}/tips?limit=10`,
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.items.map((t) => [t.id, t.from?.username ?? null])).toEqual([
      [anonymous, null],
      [named, fan.username],
    ]);
  });

  test("a tip message is stored trimmed", async () => {
    const r = await fan.client.call<{ paymentId: string }>("POST", `/api/channels/${streamer.username}/tips`, {
      amountCents: 500,
      message: "   thanks!   ",
      returnPath: "/",
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [t] = await db().select().from(schema.tips).where(eq(schema.tips.paymentId, r.body.paymentId));
    expect(t?.message).toBe("thanks!");
  });
});

describe("subscribers paging", () => {
  test("active and past-due only, by id descending, with a cursor", async () => {
    const owner = await signUpAndSignIn(api);
    const c = await channelOf(owner.username);
    const people = await Promise.all(Array.from({ length: 3 }, () => signUpAndSignIn(api)));
    const [a, b, d] = people;
    if (!a || !b || !d) throw new Error("signup");
    const s1 = await subRow(a.userId, c.id);
    const s2 = await subRow(b.userId, c.id, { status: "past_due" });
    await subRow(d.userId, c.id, { status: "canceled" });
    type P = { items: { id: string }[]; nextCursor: string | null };
    const p1 = await owner.client.call<P>("GET", `/api/channels/${owner.username}/subscriptions?limit=1`);
    expect(p1.body.items.map((s) => s.id)).toEqual([s2.id]);
    const p2 = await owner.client.call<P>(
      "GET",
      `/api/channels/${owner.username}/subscriptions?limit=1&cursor=${encodeURIComponent(p1.body.nextCursor ?? "")}`,
    );
    expect(p2.body.items.map((s) => s.id)).toEqual([s1.id]);
    expect(p2.body.nextCursor).toBeNull();
  });
});

describe("checkout-shared helpers", () => {
  test("userEventFields: none for no user or an unknown one", async () => {
    expect(await userEventFields(db(), null)).toBeNull();
    expect(await userEventFields(db(), uuidv7())).toBeNull();
    expect(await userEventFields(db(), fan.userId)).toMatchObject({ user_login: fan.username });
  });

  test("holdingSubscription: none, then the slot holder", async () => {
    const owner = await signUpAndSignIn(api);
    const c = await channelOf(owner.username);
    expect(await holdingSubscription(api.deps, fan.userId, c.id)).toBeNull();
    await subRow(fan.userId, c.id, { status: "canceled" });
    expect(await holdingSubscription(api.deps, fan.userId, c.id)).toBeNull();
    const s = await subRow(fan.userId, c.id, { status: "past_due" });
    expect((await holdingSubscription(api.deps, fan.userId, c.id))?.id).toBe(s.id);
  });

  test("endSubscriptions ends only slot-holding rows and returns their subscribers", async () => {
    const owner = await signUpAndSignIn(api);
    const c = await channelOf(owner.username);
    const [x, y] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
    await subRow(x.userId, c.id);
    await subRow(y.userId, c.id, { status: "canceled" });
    const now = new Date();
    const ended = await db().transaction((tx) =>
      endSubscriptions(tx, c, eq(schema.subscriptions.channelId, c.id), now),
    );
    expect(ended).toEqual([x.userId]);
    const again = await db().transaction((tx) =>
      endSubscriptions(tx, c, eq(schema.subscriptions.channelId, c.id), now),
    );
    expect(again).toEqual([]);
  });
});
