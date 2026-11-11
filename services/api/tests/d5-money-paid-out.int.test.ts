// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * d5-money (overhaul wave 3, D5.7): `RevenueSummary.paidOut` is the period's completed payouts,
 * read from the ledger. A sent payout counts in the period it was sent; a reserved one that has
 * not been sent is pending, not paid out; a reversed Connect transfer comes back off the figure;
 * another creator's payouts never show. Postings use the ledger's own rules.
 */
import { inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import {
  creatorBalances,
  paymentSucceeded,
  payoutReserve,
  payoutSent,
  payoutTransferReversed,
  post,
  releaseDueHolds,
} from "@commonair/ledger";
import { signUpAndSignIn, startApi, uniqueName, type TestApi } from "./harness.ts";

type Person = Awaited<ReturnType<typeof signUpAndSignIn>>;
const CUT = { streamerShare: 0.9, coopShare: 0.1 };
const at = (s: string) => new Date(s);
const AUG = { from: "2026-08-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" };
const SEP = { from: "2026-09-01T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" };

let api: TestApi;
let owner: Person;
let other: Person;
/** No payments and no payouts. */
let fresh: Person;
const channelOf = new Map<string, string>();
const db = () => api.db.db;

interface Money {
  cents: number;
  currency: string;
}
interface Summary {
  gross: Money;
  coopCut: Money;
  refundsAndChargebacks: Money;
  net: Money;
  paidOut: Money;
  pendingPayout: Money;
}

async function tip(creator: Person, payer: string, cents: number, when: string): Promise<void> {
  const channelId = channelOf.get(creator.userId);
  if (!channelId) throw new Error("no channel");
  const occurredAt = at(when);
  const paymentId = uuidv7(occurredAt.getTime());
  await db()
    .insert(schema.payments)
    .values({
      id: paymentId,
      provider: "manual",
      providerRef: `CA-${uniqueName("r").toUpperCase()}`,
      kind: "tip",
      status: "succeeded",
      gift: false,
      userId: payer,
      channelId,
      amountCents: cents,
      currency: "usd",
      quantity: 1,
      succeededAt: occurredAt,
    });
  await post(
    db(),
    paymentSucceeded({
      paymentId,
      paymentKind: "tip",
      provider: "manual",
      settlement: "cash",
      creatorUserId: creator.userId,
      grossCents: cents,
      taxCents: 0,
      feeCents: 0,
      currency: "usd",
      cut: CUT,
      cutHistoryId: null,
      occurredAt,
    }),
  );
}

/** Reserve a payout from the creator's released earnings (the batch's own posting). */
async function reserve(creator: Person, cents: number, when: string): Promise<string> {
  const payoutId = uuidv7(at(when).getTime());
  const b = await creatorBalances(db(), creator.userId, "usd");
  await post(
    db(),
    payoutReserve({
      payoutId,
      userId: creator.userId,
      amountCents: cents,
      currency: "usd",
      occurredAt: at(when),
      balances: { liabilityCents: b.availableCents, receivableCents: 0 },
      minimumCents: 0,
    }),
  );
  return payoutId;
}

async function send(creator: Person, payoutId: string, cents: number, when: string): Promise<void> {
  await post(
    db(),
    payoutSent({
      payoutId,
      userId: creator.userId,
      provider: "manual",
      amountCents: cents,
      currency: "usd",
      occurredAt: at(when),
    }),
  );
}

const revenue = async (who: Person, period: { from: string; to: string }): Promise<Summary> => {
  const q = `from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`;
  const r = await who.client.call<Summary>("GET", `/api/channels/${who.username}/revenue?${q}`);
  expect(r.status).toBe(200);
  return r.body;
};

beforeAll(async () => {
  api = await startApi();
  owner = await signUpAndSignIn(api);
  other = await signUpAndSignIn(api);
  fresh = await signUpAndSignIn(api);
  const chans = await db()
    .select({ id: schema.channels.id, ownerId: schema.channels.ownerId })
    .from(schema.channels)
    .where(inArray(schema.channels.ownerId, [owner.userId, other.userId]));
  for (const c of chans) channelOf.set(c.ownerId, c.id);
  api.deps.now = () => at("2026-09-20T00:00:00Z");
  const payer = uniqueName("p");
  const [u] = await db()
    .insert(schema.users)
    .values({ name: `Payer ${payer}`, email: `${payer}@test.invalid`, username: payer, emailVerified: true })
    .returning({ id: schema.users.id });
  if (!u) throw new Error("no payer");

  // 100.00 tipped on Aug 1 (90.00 to the owner), released after the 7-day hold.
  await tip(owner, u.id, 10_000, "2026-08-01T10:00:00Z");
  await tip(other, u.id, 5_000, "2026-08-01T11:00:00Z");
  await releaseDueHolds(db(), { asOf: at("2026-08-10T00:00:00Z"), holdDays: 7, currency: "usd" });

  // August: 50.00 reserved and sent, 3.00 of its transfer reversed; 20.00 reserved, never sent.
  const first = await reserve(owner, 5_000, "2026-08-20T10:00:00Z");
  await send(owner, first, 5_000, "2026-08-25T10:00:00Z");
  await post(
    db(),
    payoutTransferReversed({
      payoutId: first,
      transferId: uuidv7(),
      userId: owner.userId,
      amountCents: 300,
      cumulativeCents: 300,
      currency: "usd",
      occurredAt: at("2026-08-27T10:00:00Z"),
    }),
  );
  await reserve(owner, 2_000, "2026-08-26T10:00:00Z");
  // Reserved in August, sent in September: September's.
  const late = await reserve(owner, 1_000, "2026-08-28T10:00:00Z");
  await send(owner, late, 1_000, "2026-09-02T10:00:00Z");
  // Another creator's payout in August.
  const theirs = await reserve(other, 4_000, "2026-08-20T11:00:00Z");
  await send(other, theirs, 4_000, "2026-08-21T10:00:00Z");
}, 120_000);
afterAll(async () => {
  await api?.stop();
});

describe("RevenueSummary.paidOut", () => {
  test("is the period's sent payouts less reversed transfers, from the ledger", async () => {
    const aug = await revenue(owner, AUG);
    expect(aug.paidOut).toEqual({ cents: 4_700, currency: "usd" });
    // The tiles reconcile: gross − co-op share − refunds and chargebacks = net.
    expect(aug.gross.cents - aug.coopCut.cents - aug.refundsAndChargebacks.cents).toBe(aug.net.cents);
    // The 20.00 reservation is still pending, not paid out.
    expect(aug.pendingPayout.cents).toBe(2_000);
  });

  test("a payout counts in the month it was sent, not the month it was reserved", async () => {
    expect((await revenue(owner, SEP)).paidOut.cents).toBe(1_000);
  });

  test("another creator's payouts stay theirs", async () => {
    expect((await revenue(other, AUG)).paidOut.cents).toBe(4_000);
    expect((await revenue(other, SEP)).paidOut.cents).toBe(0);
  });

  test("a creator with no payouts has paid out zero", async () => {
    expect((await revenue(fresh, AUG)).paidOut).toEqual({ cents: 0, currency: "usd" });
  });
});
