// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The gift window (batch 8 decision (d), ADR 0007 decision 1): one unpaid gift per gifter and
 * channel, refused by the API with CONFLICT `gift_pending` and by the partial unique index
 * `payments_open_gift_uq` underneath it (rule 9); unpaid gifts expire after GIFT_PAYMENT_HOURS,
 * every other payment after PAYMENT_PENDING_DAYS.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;
interface Checkout {
  paymentId: string;
  reference: string;
}
interface Refusal {
  code?: string;
  data?: { reason?: string };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TIERS = [
  { tier: 1, name: "Fan", price: { cents: 500, currency: "usd" }, benefits: "" },
  { tier: 2, name: "Super fan", price: { cents: 1000, currency: "usd" }, benefits: "" },
  { tier: 3, name: "Patron", price: { cents: 2500, currency: "usd" }, benefits: "" },
];

let api: TestApi;
let streamer: Account;
let gifter: Account;
let recipients: Account[];
const db = () => api.db.db;

beforeAll(async () => {
  api = await startApi();
  [streamer, gifter, ...recipients] = await Promise.all([
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
    signUpAndSignIn(api),
  ]);
  const set = await streamer.client.call("PUT", `/api/channels/${streamer.username}/subscription-tiers`, {
    tiers: TIERS,
  });
  if (set.status !== 200) throw new Error(`setTiers failed: ${set.status}`);
}, 180_000);
afterAll(async () => {
  await api?.stop();
});

const gift = (as: Account, to: Account) =>
  as.client.call<Checkout & Refusal>("POST", `/api/channels/${streamer.username}/subscriptions`, {
    tier: 1,
    gift: { count: 1, to: to.username },
    returnPath: `/${streamer.username}`,
  });
const paymentRow = async (id: string) => {
  const [p] = await db().select().from(schema.payments).where(eq(schema.payments.id, id));
  if (!p) throw new Error(`no payment ${id}`);
  return p;
};
const pendingGiftsOf = async (userId: string) =>
  db()
    .select()
    .from(schema.payments)
    .where(
      and(eq(schema.payments.userId, userId), eq(schema.payments.gift, true), eq(schema.payments.status, "pending")),
    );
/** Expire a gift as `money-expire-pending` would (the worker's own test covers the job). */
async function failPayment(id: string) {
  await db().update(schema.payments).set({ status: "failed", updatedAt: new Date() }).where(eq(schema.payments.id, id));
  await db()
    .update(schema.subscriptions)
    .set({ status: "expired", updatedAt: new Date() })
    .where(eq(schema.subscriptions.giftPaymentId, id));
}

describe("one unpaid gift per gifter and channel", () => {
  let first: Checkout;

  test("a gift's payment expires after GIFT_PAYMENT_HOURS (24 h), not PAYMENT_PENDING_DAYS", async () => {
    const before = Date.now();
    const r = await gift(gifter, recipients[0] as Account);
    expect(r.status).toBe(200);
    first = r.body;
    const p = await paymentRow(first.paymentId);
    expect(p).toMatchObject({ gift: true, status: "pending" });
    expect(api.deps.env.GIFT_PAYMENT_HOURS).toBe(24);
    const expires = p.expiresAt?.getTime() ?? 0;
    expect(expires).toBeGreaterThanOrEqual(before + 24 * HOUR - 5_000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 24 * HOUR + 5_000);
  });

  test("every other payment keeps PAYMENT_PENDING_DAYS", async () => {
    const self = await gifter.client.call<Checkout>("POST", `/api/channels/${streamer.username}/subscriptions`, {
      tier: 1,
      returnPath: `/${streamer.username}`,
    });
    expect(self.status).toBe(200);
    const tip = await gifter.client.call<Checkout>("POST", `/api/channels/${streamer.username}/tips`, {
      amountCents: 300,
      message: "",
      anonymous: false,
      returnPath: `/${streamer.username}`,
    });
    expect(tip.status).toBe(200);
    for (const id of [self.body.paymentId, tip.body.paymentId]) {
      const p = await paymentRow(id);
      expect(p.gift).toBe(false);
      expect(p.expiresAt?.getTime()).toBeGreaterThan(Date.now() + (api.deps.env.PAYMENT_PENDING_DAYS - 1) * DAY);
    }
  });

  test("a second gift inside the window is refused with CONFLICT gift_pending, before any checkout", async () => {
    const r = await gift(gifter, recipients[1] as Account);
    expect(r.status).toBe(409);
    expect(r.body.data?.reason).toBe("gift_pending");
    expect(await pendingGiftsOf(gifter.userId)).toHaveLength(1);
    // The second recipient was not touched.
    const held = await db()
      .select()
      .from(schema.subscriptions)
      .where(eq(schema.subscriptions.subscriberId, (recipients[1] as Account).userId));
    expect(held).toEqual([]);
  });

  test("another gifter to the same channel is not blocked", async () => {
    const other = await gift(recipients[2] as Account, recipients[3] as Account);
    expect(other.status).toBe(200);
  });

  test("once the first gift expired (failed), the gifter may gift again", async () => {
    await failPayment(first.paymentId);
    const again = await gift(gifter, recipients[1] as Account);
    expect(again.status).toBe(200);
    await failPayment(again.body.paymentId);
  });

  test("two gift checkouts racing from two tabs: exactly one wins", async () => {
    const [a, b] = await Promise.all([gift(gifter, recipients[0] as Account), gift(gifter, recipients[1] as Account)]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.data?.reason).toBe("gift_pending");
    expect(await pendingGiftsOf(gifter.userId)).toHaveLength(1);
  });

  test("the index refuses a direct insert of a second pending gift (as the app role)", async () => {
    const [c] = await db().select().from(schema.channels).where(eq(schema.channels.slug, streamer.username));
    const insert = api.db.app.db.insert(schema.payments).values({
      id: uuidv7(),
      provider: "manual",
      providerRef: `CA-DIRECT${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      kind: "subscription",
      status: "pending",
      userId: gifter.userId,
      channelId: c?.id ?? null,
      amountCents: 500,
      currency: "usd",
      tier: 1,
      quantity: 1,
      gift: true,
      expiresAt: new Date(Date.now() + HOUR),
    });
    const err = await insert.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect(String((err as { cause?: unknown }).cause ?? err)).toMatch(/payments_open_gift_uq/);
  });
});
