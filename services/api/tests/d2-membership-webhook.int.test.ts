// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 2 (d2-membership): a qualifying subscription starts viewer membership in the
 * payment's own transaction, on the Stripe webhook and on the treasurer's manual confirm, with the
 * `membership.activate` audit row, the `coop.membership.update` event and one `membership` inbox
 * notice; retries, redeliveries and the hourly sync never add a second. A cheap sub, a voluntary
 * viewer exit and a gift start nothing. The Stripe API is the same local `Bun.serve` fake as
 * `money-stripe.int.test.ts` (stripe-mock is stateless: one fixture id for every create, and no
 * balance transaction on its PaymentIntents, which the confirm path needs for the fee).
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import { syncMemberships } from "@commonair/governance";
import { loadStripeSignature } from "@commonair/payments";
import { membershipNoticeKey, startSubscriptionMembershipTx } from "../src/coop/membership.ts";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface Redirect {
  kind: "redirect";
  url: string;
  paymentId: string;
}
interface Instructions {
  kind: "instructions";
  paymentId: string;
}

const SECRET = "whsec_d2_membership";
const TIERS = [
  { tier: 1, name: "Small", price: { cents: 200, currency: "usd" }, benefits: "" },
  { tier: 2, name: "Fan", price: { cents: 499, currency: "usd" }, benefits: "" },
  { tier: 3, name: "Patron", price: { cents: 999, currency: "usd" }, benefits: "" },
];

let api: TestApi;
let fake: ReturnType<typeof Bun.serve>;
let streamer: Account;
let alice: Account;
let bob: Account;
let carol: Account;
let dana: Account;
let treasurer: Account;
const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 14);
const db = () => api.db.db;

beforeAll(async () => {
  fake = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== "Bearer sk_test_d2")
        return Response.json({ error: { message: "bad key" } }, { status: 401 });
      if (url.pathname === "/v1/checkout/sessions") {
        const id = `cs_test_${rand()}`;
        return Response.json({ id, url: `https://checkout.stripe.test/c/pay/${id}` });
      }
      if (url.pathname.startsWith("/v1/payment_intents/"))
        return Response.json({ latest_charge: { balance_transaction: { fee: 30, currency: "usd" } } });
      return Response.json({ error: { message: "not faked" } }, { status: 404 });
    },
  });
  api = await startApi();
  Object.assign(api.deps.env, {
    PAYMENTS_PROVIDER: "stripe",
    STRIPE_SECRET_KEY: "sk_test_d2",
    STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_API_BASE: `http://127.0.0.1:${fake.port}`,
  });
  [streamer, alice, bob, carol, dana, treasurer] = await Promise.all([
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
  ]);
  await db().update(schema.users).set({ role: "treasurer" }).where(eq(schema.users.id, treasurer.userId));
  const set = await streamer.client.call("PUT", `/api/channels/${streamer.username}/subscription-tiers`, {
    tiers: TIERS,
  });
  if (set.status !== 200) throw new Error(`setTiers failed: ${set.status}`);
}, 180_000);
afterAll(async () => {
  await api?.stop();
  await fake?.stop(true);
});

const nowS = () => Math.floor(Date.now() / 1000);
function event(type: string, object: Record<string, unknown>, id = `evt_${rand()}`) {
  return { id, object: "event", type, api_version: "2024-06-20", created: nowS(), livemode: false, data: { object } };
}
async function deliver(evt: unknown) {
  const { signStripePayload } = await loadStripeSignature();
  const body = JSON.stringify(evt);
  const header = await signStripePayload(SECRET, body, nowS());
  const res = await fetch(`${api.url}/api/webhooks/stripe`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body,
  });
  return { status: res.status, body: (await res.json()) as { outcome?: string; duplicate?: boolean } };
}
const subscribe = (as: Account, tier: number, extra: Record<string, unknown> = {}) =>
  as.client.call<Redirect | Instructions>("POST", `/api/channels/${streamer.username}/subscriptions`, {
    returnPath: `/${streamer.username}`,
    tier,
    ...extra,
  });
const firstInvoice = (paymentId: string, cents: number, sub: string, pi: string) =>
  event("invoice.paid", {
    id: `in_${rand()}`,
    object: "invoice",
    billing_reason: "subscription_create",
    subscription: sub,
    subscription_details: { metadata: { payment_id: paymentId } },
    payment_intent: pi,
    amount_paid: cents,
    tax: 0,
    currency: "usd",
    status_transitions: { paid_at: nowS() },
    lines: { data: [{ period: { start: nowS(), end: nowS() + 31 * 86_400 } }] },
  });

const viewerRows = (userId: string) =>
  db()
    .select()
    .from(schema.memberships)
    .where(and(eq(schema.memberships.userId, userId), eq(schema.memberships.class, "viewer")));
const notices = (userId: string) =>
  db()
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.userId, userId), eq(schema.notifications.type, "membership")));
const activations = (membershipId: string) =>
  db()
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.action, "membership.activate"), eq(schema.auditLog.subjectId, membershipId)));
const membershipEvents = (membershipId: string) =>
  db()
    .select()
    .from(schema.events)
    .where(
      and(
        eq(schema.events.type, "coop.membership.update"),
        sql`${schema.events.payload}->>'membership_id' = ${membershipId}`,
      ),
    );

describe("the Stripe webhook", () => {
  let pay: Redirect;
  let firstEvent: ReturnType<typeof firstInvoice>;
  const SUB = `sub_${rand()}`;
  const PI = `pi_${rand()}`;

  test("a $4.99 sub's first invoice starts viewer membership in the same transaction, with its notice", async () => {
    const r = await subscribe(alice, 2);
    expect(r.status).toBe(200);
    pay = r.body as Redirect;
    expect(pay.kind).toBe("redirect");
    expect(await viewerRows(alice.userId)).toEqual([]);

    firstEvent = firstInvoice(pay.paymentId, 499, SUB, PI);
    expect((await deliver(firstEvent)).body.outcome).toBe("confirmed");
    const [m] = await viewerRows(alice.userId);
    expect(m).toMatchObject({ status: "active", basis: "subscription" });
    const id = m?.id ?? "";

    const [a] = await activations(id);
    expect(a).toMatchObject({ actorType: "system", actorId: null, subjectType: "membership" });
    expect(a?.details).toMatchObject({ userId: alice.userId, class: "viewer", basis: "subscription" });
    const evts = await membershipEvents(id);
    expect(evts).toHaveLength(1);
    expect(evts[0]?.payload).toMatchObject({ user_id: alice.userId, status: "active", basis: "subscription" });

    const n = await notices(alice.userId);
    expect(n).toHaveLength(1);
    expect(n[0]?.payload).toEqual({ kind: "membership_started", basis: "subscription" });
    expect(n[0]?.dedupeKey).toBe(membershipNoticeKey("membership_started", id));
  });

  test("redeliveries, the later checkout event and the sync add nothing", async () => {
    expect((await deliver(firstEvent)).body).toMatchObject({ duplicate: true });
    // A second event for the same invoice payment (a new event id).
    const again = { ...firstEvent, id: `evt_${rand()}` };
    expect((await deliver(again)).body.outcome).toBe("already_processed");
    expect(
      (
        await deliver(
          event("checkout.session.completed", {
            id: `cs_test_${rand()}`,
            mode: "subscription",
            payment_status: "paid",
            client_reference_id: pay.paymentId,
            metadata: { payment_id: pay.paymentId },
            subscription: SUB,
            amount_total: 499,
            currency: "usd",
          }),
        )
      ).body.outcome,
    ).toBe("subscription_linked");
    const sync = await syncMemberships(api.db.app.db, new Date());
    expect(sync.activated.map((c) => c.userId)).not.toContain(alice.userId);

    const rows = await viewerRows(alice.userId);
    expect(rows).toHaveLength(1);
    expect(await activations(rows[0]?.id ?? "")).toHaveLength(1);
    expect(await membershipEvents(rows[0]?.id ?? "")).toHaveLength(1);
    expect(await notices(alice.userId)).toHaveLength(1);
  });

  test("a renewal of an active member changes nothing about the membership", async () => {
    const r = await deliver(
      event("invoice.paid", {
        id: `in_${rand()}`,
        billing_reason: "subscription_cycle",
        subscription: SUB,
        subscription_details: { metadata: { payment_id: pay.paymentId } },
        payment_intent: `pi_${rand()}`,
        amount_paid: 499,
        tax: 0,
        currency: "usd",
        status_transitions: { paid_at: nowS() },
        lines: { data: [] },
      }),
    );
    expect(r.body.outcome).toBe("renewed");
    expect(await viewerRows(alice.userId)).toHaveLength(1);
    expect(await notices(alice.userId)).toHaveLength(1);
  });

  test("a $2 sub is below the minimum: confirmed, no membership, no notice", async () => {
    const r = await subscribe(bob, 1);
    const p = r.body as Redirect;
    expect((await deliver(firstInvoice(p.paymentId, 200, `sub_${rand()}`, `pi_${rand()}`))).body.outcome).toBe(
      "confirmed",
    );
    expect(await viewerRows(bob.userId)).toEqual([]);
    expect(await notices(bob.userId)).toEqual([]);
  });

  test("a member who left the viewer class is not re-enrolled by a new sub (they rejoin themselves)", async () => {
    await db()
      .insert(schema.memberships)
      .values({ userId: carol.userId, class: "viewer", basis: "share", status: "exited", exitedAt: new Date() });
    const r = await subscribe(carol, 3);
    const p = r.body as Redirect;
    expect((await deliver(firstInvoice(p.paymentId, 999, `sub_${rand()}`, `pi_${rand()}`))).body.outcome).toBe(
      "confirmed",
    );
    expect((await viewerRows(carol.userId)).map((m) => m.status)).toEqual(["exited"]);
    expect(await notices(carol.userId)).toEqual([]);
  });
});

describe("the treasurer's manual confirm", () => {
  test("a confirmed $4.99 transfer sub starts membership once; a repeat confirm is refused and adds nothing", async () => {
    api.deps.env.PAYMENTS_PROVIDER = "manual";
    try {
      const r = await subscribe(dana, 2);
      expect(r.status).toBe(200);
      const p = r.body as Instructions;
      expect(p.kind).toBe("instructions");
      const confirm = () =>
        treasurer.client.call("POST", `/api/treasurer/payments/${p.paymentId}/confirm`, {
          receivedAt: new Date().toISOString(),
        });
      expect((await confirm()).status).toBe(200);
      const [m] = await viewerRows(dana.userId);
      expect(m).toMatchObject({ status: "active", basis: "subscription" });
      expect((await confirm()).status).toBe(409);
      expect(await viewerRows(dana.userId)).toHaveLength(1);
      const n = await notices(dana.userId);
      expect(n.map((x) => x.payload)).toEqual([{ kind: "membership_started", basis: "subscription" }]);
    } finally {
      api.deps.env.PAYMENTS_PROVIDER = "stripe";
    }
  });
});

describe("a member share", () => {
  test("a confirmed bank-transfer share announces the share membership once", async () => {
    api.deps.env.PAYMENTS_PROVIDER = "manual";
    try {
      const eve = await signUpAndSignIn(api);
      const r = await eve.client.call<Instructions>("POST", "/api/coop/shares", { returnPath: "/coop/membership" });
      expect(r.status).toBe(200);
      expect(r.body.kind).toBe("instructions");
      const confirm = () =>
        treasurer.client.call("POST", `/api/treasurer/payments/${r.body.paymentId}/confirm`, {
          receivedAt: new Date().toISOString(),
        });
      expect((await confirm()).status).toBe(200);
      expect((await confirm()).status).toBe(409);
      const [m] = await viewerRows(eve.userId);
      expect(m).toMatchObject({ status: "active", basis: "share" });
      const n = await notices(eve.userId);
      expect(n.map((x) => [x.payload, x.dedupeKey])).toEqual([
        [{ kind: "membership_started", basis: "share" }, membershipNoticeKey("membership_started", m?.id ?? "")],
      ]);
    } finally {
      api.deps.env.PAYMENTS_PROVIDER = "stripe";
    }
  });
});

describe("startSubscriptionMembershipTx", () => {
  test("does nothing without a qualifying sub, for a suspended account, or when one is active", async () => {
    const none = await signUpAndSignIn(api);
    const now = new Date();
    expect(await api.db.app.db.transaction((tx) => startSubscriptionMembershipTx(tx, none.userId, now))).toBeNull();
    // Alice is already a member: a second start is a no-op.
    expect(await api.db.app.db.transaction((tx) => startSubscriptionMembershipTx(tx, alice.userId, now))).toBeNull();
    // A suspended subscriber never becomes a member.
    await db().update(schema.users).set({ banned: true }).where(eq(schema.users.id, bob.userId));
    await db()
      .update(schema.subscriptions)
      .set({ priceCents: 499 })
      .where(eq(schema.subscriptions.subscriberId, bob.userId));
    expect(await api.db.app.db.transaction((tx) => startSubscriptionMembershipTx(tx, bob.userId, now))).toBeNull();
    expect(await viewerRows(bob.userId)).toEqual([]);
  });

  test("a lapsed member with a qualifying sub starts again (a renewal after past due)", async () => {
    const [m] = await viewerRows(alice.userId);
    await db()
      .update(schema.memberships)
      .set({ status: "lapsed", lapsedAt: new Date() })
      .where(eq(schema.memberships.id, m?.id ?? ""));
    const again = await api.db.app.db.transaction((tx) => startSubscriptionMembershipTx(tx, alice.userId, new Date()));
    expect(again).toMatchObject({ status: "active", basis: "subscription" });
    expect(again?.id).not.toBe(m?.id);
    const n = await notices(alice.userId);
    expect(new Set(n.map((x) => x.dedupeKey))).toEqual(
      new Set([
        membershipNoticeKey("membership_started", m?.id ?? ""),
        membershipNoticeKey("membership_started", again?.id ?? ""),
      ]),
    );
  });
});
