// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Payment breakdowns and the fee schedule over REST (feature-wins §4.1): manual payments the
 * treasurer confirms, refunds and charges back, and a Stripe tip (a local fake Stripe API plus
 * signed webhook events) whose dispute is won. The tests share state and run in order.
 */
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import { loadStripeSignature } from "@commonair/payments";
import { clearFeeScheduleCache } from "../src/money/fee-schedule.ts";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface Line {
  kind: string;
  amount: { cents: number; currency: string };
  recipientUserId: string | null;
  component: string | null;
  transactionId: string | null;
}
interface Breakdown {
  paymentId: string;
  kind: string;
  channel: { slug: string; displayName: string };
  viewerRole: "payer" | "payee";
  payer: { id: string; username: string; displayName: string } | null;
  gross: { cents: number; currency: string };
  succeededAt: string;
  lines: Line[];
  holdReleasesAt: string | null;
  holdReleasedAt: string | null;
  cutSource: {
    historyId: string | null;
    changedAt: string | null;
    proposalId: string | null;
    streamerShare: number;
    coopShare: number;
  };
  timeline: { kind: string; at: string; amount: { cents: number } | null; transactionId: string }[];
}
interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
interface FeeEntry {
  id: string | null;
  key: string;
  value: Record<string, unknown>;
  previous: Record<string, unknown> | null;
  changedAt: string | null;
  proposalId: string | null;
}

const SECRET = "whsec_breakdown_test";
const FEE = 59;
const TIERS = [
  { tier: 1, name: "Fan", price: { cents: 499, currency: "usd" }, benefits: "" },
  { tier: 2, name: "Super fan", price: { cents: 999, currency: "usd" }, benefits: "" },
  { tier: 3, name: "Patron", price: { cents: 2499, currency: "usd" }, benefits: "" },
];

let api: TestApi;
let fake: ReturnType<typeof Bun.serve>;
let streamer: Account;
let alice: Account;
let bob: Account;
let mod: Account;
let treasurer: Account;
const db = () => api.db.db;
const rand = () => crypto.randomUUID().replace(/-/g, "").slice(0, 14);

function startFakeStripe() {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/checkout/sessions") {
        const id = `cs_test_${rand()}`;
        return Response.json({ id, url: `https://checkout.stripe.test/c/pay/${id}` });
      }
      if (url.pathname.startsWith("/v1/payment_intents/"))
        return Response.json({ latest_charge: { balance_transaction: { fee: FEE, currency: "usd" } } });
      return Response.json({ error: { message: "not faked" } }, { status: 404 });
    },
  });
}

beforeAll(async () => {
  fake = startFakeStripe();
  api = await startApi();
  [streamer, alice, bob, mod, treasurer] = await Promise.all([
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
  ]);
  await db().update(schema.users).set({ role: "treasurer" }).where(eq(schema.users.id, treasurer.userId));
  const [channel] = await db().select().from(schema.channels).where(eq(schema.channels.slug, streamer.username));
  if (!channel) throw new Error("no channel");
  await db().insert(schema.channelRoles).values({ channelId: channel.id, userId: mod.userId, role: "moderator" });
  const set = await streamer.client.call("PUT", `/api/channels/${streamer.username}/subscription-tiers`, {
    tiers: TIERS,
  });
  if (set.status !== 200) throw new Error(`setTiers failed: ${set.status}`);
}, 180_000);
afterAll(async () => {
  await api?.stop();
  await fake?.stop(true);
});

const breakdown = (as: Account, paymentId: string) =>
  as.client.call<Breakdown>("GET", `/api/payments/${paymentId}/breakdown`);
const list = (as: Account, role: "payer" | "payee", limit: number, cursor?: string) =>
  as.client.call<Page<Breakdown>>(
    "GET",
    `/api/me/payment-breakdowns?role=${role}&limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
  );
const confirm = async (paymentId: string) => {
  const r = await treasurer.client.call("POST", `/api/treasurer/payments/${paymentId}/confirm`, {
    receivedAt: new Date().toISOString(),
  });
  if (r.status !== 200) throw new Error(`confirm failed: ${r.status} ${JSON.stringify(r.body)}`);
};
async function manualTip(as: Account, cents: number, anonymous: boolean): Promise<string> {
  const r = await as.client.call<{ paymentId: string }>("POST", `/api/channels/${streamer.username}/tips`, {
    amountCents: cents,
    message: "thanks",
    anonymous,
    returnPath: `/${streamer.username}`,
  });
  if (r.status !== 200) throw new Error(`tip failed: ${r.status} ${JSON.stringify(r.body)}`);
  await confirm(r.body.paymentId);
  return r.body.paymentId;
}

const sumOf = (b: Breakdown, pick: (l: Line) => boolean) =>
  b.lines.filter(pick).reduce((s, l) => s + l.amount.cents, 0);
const grossSide = (b: Breakdown) => sumOf(b, (l) => ["tax", "creator", "coop_share"].includes(l.kind));
const line = (b: Breakdown, kind: string) => b.lines.find((l) => l.kind === kind);
/** The balance of a payment's settlement account, straight from the ledger. */
async function settlementMoved(paymentId: string, accountPrefix: string): Promise<number> {
  const rows = await db().execute<{ sum: string }>(sql`
    select coalesce(sum(e.amount_cents), 0)::text as sum from ledger_entries e
    join ledger_transactions t on t.id = e.transaction_id
    join ledger_accounts a on a.id = e.account_id
    where t.ref_type = 'payment' and t.ref_id = ${paymentId} and a.code like ${`${accountPrefix}%`}`);
  return Number(rows[0]?.sum ?? 0);
}
/** gross side + reversals − fees, as `reconciles` reads a breakdown. */
const settledByBreakdown = (b: Breakdown) =>
  sumOf(b, (l) => ["tax", "creator", "coop_share", "reversal"].includes(l.kind)) -
  sumOf(b, (l) => ["processor_fee", "dispute_fee"].includes(l.kind));

let subPayment: string;
let anonTip: string;

describe("manual payments", () => {
  test("a confirmed subscription: lines sum to gross, the fee sits outside it, the hold is dated", async () => {
    const r = await alice.client.call<{ paymentId: string }>(
      "POST",
      `/api/channels/${streamer.username}/subscriptions`,
      { tier: 2, returnPath: `/${streamer.username}` },
    );
    expect(r.status).toBe(200);
    subPayment = r.body.paymentId;
    // Not succeeded yet: nobody sees a breakdown.
    expect((await breakdown(alice, subPayment)).status).toBe(404);
    await confirm(subPayment);

    const b = await breakdown(alice, subPayment);
    expect(b.status).toBe(200);
    expect(b.body).toMatchObject({
      paymentId: subPayment,
      kind: "subscription",
      channel: { slug: streamer.username },
      viewerRole: "payer",
      payer: { id: alice.userId, username: alice.username },
      gross: { cents: 999, currency: "usd" },
      holdReleasedAt: null,
      cutSource: { historyId: null, changedAt: null, proposalId: null, streamerShare: 0.9, coopShare: 0.1 },
    });
    expect(grossSide(b.body)).toBe(999);
    expect(line(b.body, "creator")).toMatchObject({ amount: { cents: 899 }, recipientUserId: streamer.userId });
    expect(line(b.body, "coop_share")?.amount.cents).toBe(100);
    expect(line(b.body, "processor_fee")?.amount.cents).toBe(0);
    expect(line(b.body, "coop_net")).toMatchObject({ amount: { cents: 100 }, transactionId: null });
    const holdDays = 7;
    expect(Date.parse(b.body.holdReleasesAt ?? "") - Date.parse(b.body.timeline[0]?.at ?? "")).toBe(
      holdDays * 86_400_000,
    );
    expect(b.body.timeline.map((e) => e.kind)).toEqual(["paid"]);
  });

  test("the payee (channel owner) sees it; a stranger and the channel's moderator get NOT_FOUND", async () => {
    const owner = await breakdown(streamer, subPayment);
    expect(owner.status).toBe(200);
    expect(owner.body).toMatchObject({ viewerRole: "payee", payer: { username: alice.username } });
    for (const who of [bob, mod, treasurer]) {
      const r = await breakdown(who, subPayment);
      expect(r.status).toBe(404);
    }
    expect((await breakdown(alice, "01890000-0000-7000-8000-000000000000")).status).toBe(404);
  });

  test("an anonymous tip hides the payer from the owner only", async () => {
    anonTip = await manualTip(alice, 500, true);
    const mine = await breakdown(alice, anonTip);
    expect(mine.body).toMatchObject({ viewerRole: "payer", payer: { id: alice.userId } });
    const theirs = await breakdown(streamer, anonTip);
    expect(theirs.body).toMatchObject({ viewerRole: "payee", payer: null });
    const page = await list(streamer, "payee", 10);
    expect(page.body.items.find((i) => i.paymentId === anonTip)?.payer).toBeNull();
  });

  test("a partial refund and a chargeback add reversal lines that sum to their amounts", async () => {
    const refund = await treasurer.client.call("POST", `/api/treasurer/payments/${anonTip}/refund`, {
      amountCents: 200,
      reason: "partial",
    });
    expect(refund.status).toBe(200);
    const cb = await treasurer.client.call("POST", `/api/treasurer/payments/${anonTip}/chargeback`, {
      amountCents: 300,
      reason: "bank",
    });
    expect(cb.status).toBe(200);
    const b = (await breakdown(alice, anonTip)).body;
    expect(b.timeline.map((e) => [e.kind, e.amount?.cents])).toEqual([
      ["paid", 500],
      ["refunded", -200],
      ["charged_back", -300],
    ]);
    for (const e of b.timeline.slice(1)) {
      const reversal = b.lines.filter((l) => l.kind === "reversal" && l.transactionId === e.transactionId);
      expect(reversal.every((l) => l.component !== null)).toBe(true);
      expect(reversal.reduce((s, l) => s + l.amount.cents, 0)).toBe(e.amount?.cents);
    }
    expect(grossSide(b)).toBe(500);
    // Co-op share fully reversed, no fees: the co-op nets nothing.
    expect(line(b, "coop_net")?.amount.cents).toBe(0);
    expect(settledByBreakdown(b)).toBe(await settlementMoved(anonTip, "asset:cash:manual"));
  });

  test("paging works for both roles (newest first)", async () => {
    const payer: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await list(alice, "payer", 1, cursor);
      expect(r.status).toBe(200);
      expect(r.body.items.length).toBeLessThanOrEqual(1);
      payer.push(...r.body.items.map((i) => i.paymentId));
      for (const i of r.body.items) expect(i.viewerRole).toBe("payer");
      cursor = r.body.nextCursor ?? undefined;
    } while (cursor);
    expect(payer).toEqual([anonTip, subPayment]);

    const first = await list(streamer, "payee", 1);
    expect(first.body.items.map((i) => i.paymentId)).toEqual([anonTip]);
    const second = await list(streamer, "payee", 1, first.body.nextCursor ?? "");
    expect(second.body.items.map((i) => i.paymentId)).toEqual([subPayment]);
    expect(second.body.nextCursor).toBeNull();
    // Nobody paid bob, and bob paid nobody.
    expect((await list(bob, "payee", 10)).body.items).toEqual([]);
    expect((await list(bob, "payer", 10)).body.items).toEqual([]);
    expect((await list(alice, "payer", 10, "not-a-cursor")).status).toBe(400);
  });
});

describe("cut source and fee schedule", () => {
  test("the fee schedule without history: one seed entry per key", async () => {
    clearFeeScheduleCache(api.deps.db);
    const r = await bob.client.call<FeeEntry[]>("GET", "/api/transparency/fee-schedule");
    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      expect.objectContaining({
        id: null,
        key: "platform.cut",
        value: { streamerShare: 0.9, coopShare: 0.1 },
        previous: null,
        changedAt: null,
      }),
      expect.objectContaining({ id: null, key: "payout.rules", previous: null, changedAt: null }),
    ]);
  });

  let historyId: string;
  test("after a platform.cut change a new payment names the history row", async () => {
    // A passed proposal is the only way to change the cut; the test database's owner skips the guard.
    await db().transaction(async (tx) => {
      await tx.execute(sql`alter table governance_settings disable trigger governance_settings_guard`);
      await tx
        .update(schema.governanceSettings)
        .set({ value: { streamerShare: 0.85, coopShare: 0.15 } })
        .where(eq(schema.governanceSettings.key, "platform.cut"));
      await tx.execute(sql`alter table governance_settings enable trigger governance_settings_guard`);
    });
    const [h] = await db()
      .select()
      .from(schema.governanceSettingsHistory)
      .where(sql`${schema.governanceSettingsHistory.key} = 'platform.cut' and old_value is not null`);
    if (!h) throw new Error("no history row");
    historyId = h.id;

    const tip = await manualTip(bob, 1000, false);
    const b = (await breakdown(bob, tip)).body;
    expect(b.cutSource).toEqual({
      historyId,
      changedAt: h.changedAt.toISOString(),
      proposalId: h.proposalId,
      streamerShare: 0.85,
      coopShare: 0.15,
    });
    expect(line(b, "creator")?.amount.cents).toBe(850);
    // The older payment keeps the cut it was made under.
    expect((await breakdown(alice, subPayment)).body.cutSource.historyId).toBeNull();
  });

  test("the fee schedule with history: the change first, then the founding value", async () => {
    clearFeeScheduleCache(api.deps.db);
    const r = await bob.client.call<FeeEntry[]>("GET", "/api/transparency/fee-schedule");
    expect(r.body[0]).toMatchObject({
      id: historyId,
      key: "platform.cut",
      value: { streamerShare: 0.85, coopShare: 0.15 },
      previous: { streamerShare: 0.9, coopShare: 0.1 },
    });
    expect(r.body[0]?.changedAt).not.toBeNull();
    const seeds = r.body.filter((e) => e.id === null);
    expect(seeds.map((e) => e.key)).toEqual(["platform.cut", "payout.rules"]);
    expect(seeds[0]?.value).toEqual({ streamerShare: 0.9, coopShare: 0.1 });
    expect(r.body.indexOf(seeds[0] as FeeEntry)).toBeGreaterThan(0);
  });
});

describe("stripe", () => {
  const nowS = () => Math.floor(Date.now() / 1000);
  const event = (type: string, object: Record<string, unknown>) => ({
    id: `evt_${rand()}`,
    object: "event",
    type,
    api_version: "2024-06-20",
    created: nowS(),
    livemode: false,
    data: { object },
  });
  async function deliver(evt: unknown) {
    const { signStripePayload } = await loadStripeSignature();
    const body = JSON.stringify(evt);
    const res = await fetch(`${api.url}/api/webhooks/stripe`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": await signStripePayload(SECRET, body, nowS()),
      },
      body,
    });
    return (await res.json()) as { outcome?: string };
  }

  test("a Stripe tip carries the processor fee; a won dispute restores it and returns the fee", async () => {
    Object.assign(api.deps.env, {
      PAYMENTS_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_test_int",
      STRIPE_WEBHOOK_SECRET: SECRET,
      STRIPE_API_BASE: `http://127.0.0.1:${fake.port}`,
    });
    try {
      const r = await alice.client.call<{ paymentId: string }>("POST", `/api/channels/${streamer.username}/tips`, {
        amountCents: 200,
        message: "hi",
        anonymous: false,
        returnPath: `/${streamer.username}`,
      });
      expect(r.status).toBe(200);
      const pi = `pi_${rand()}`;
      const done = await deliver(
        event("checkout.session.completed", {
          mode: "payment",
          payment_status: "paid",
          client_reference_id: r.body.paymentId,
          metadata: { payment_id: r.body.paymentId },
          payment_intent: pi,
          amount_total: 200,
          currency: "usd",
          total_details: { amount_tax: 0 },
        }),
      );
      expect(done.outcome).toBe("confirmed");
      const paid = (await breakdown(alice, r.body.paymentId)).body;
      expect(line(paid, "processor_fee")?.amount.cents).toBe(FEE);
      // 15 % of 2.00 is 30 cents, below Stripe's 59: the co-op loses money on this tip.
      expect(line(paid, "coop_net")?.amount.cents).toBe(30 - FEE);

      const dispute = (type: string, status: string, fees: number[]) =>
        event(type, {
          id: "dp_breakdown",
          payment_intent: pi,
          amount: 200,
          currency: "usd",
          status,
          balance_transactions: fees.map((fee) => ({ fee })),
        });
      expect((await deliver(dispute("charge.dispute.created", "needs_response", [1500]))).outcome).toBe("charged_back");
      expect((await deliver(dispute("charge.dispute.closed", "won", [1500, -1500]))).outcome).toBe("won");
      const b = (await breakdown(streamer, r.body.paymentId)).body;
      expect(b.timeline.map((e) => [e.kind, e.amount?.cents])).toEqual([
        ["paid", 200],
        ["charged_back", -200],
        ["chargeback_won", 200],
      ]);
      expect(b.lines.filter((l) => l.kind === "dispute_fee").map((l) => l.amount.cents)).toEqual([1500, -1500]);
      expect(grossSide(b)).toBe(200);
      expect(line(b, "coop_net")?.amount.cents).toBe(30 - FEE);
      expect(settledByBreakdown(b)).toBe(await settlementMoved(r.body.paymentId, "asset:cash:stripe"));
    } finally {
      api.deps.env.PAYMENTS_PROVIDER = "manual";
    }
  });
});
