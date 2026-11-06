// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `distributePatronageIfPaid` and `patronageReversedCents` against the real database, as the
 * application role: an approved period flips to `distributed` in the transaction that pays its
 * last member, once; a pending row, a failed row or what a reversal kept leaves it approved.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { type Database, schema as s, uuidv7 } from "@commonair/db";
import { createTestDatabase, type TestDatabase } from "@commonair/db/testing";
import {
  distributePatronageIfPaid,
  patronageAllocation,
  patronagePayout,
  patronagePayoutReversed,
  patronageReversedCents,
  post,
} from "../src/index.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let db: Database;

beforeAll(async () => {
  t = await createTestDatabase();
  db = t.app.db;
});
afterAll(async () => {
  await t?.drop();
});

let seq = 0;
async function makeUser(role: "user" | "treasurer" = "user"): Promise<string> {
  const name = `pdist${++seq}x${uuidv7().slice(-6)}`;
  const [u] = await db
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  if (role !== "user") await t.db.update(s.users).set({ role }).where(eq(s.users.id, u!.id));
  return u!.id;
}

let ran = "";
let approver = "";
beforeAll(async () => {
  ran = await makeUser("treasurer");
  approver = await makeUser("treasurer");
});

const WEIGHTS = {
  revenue: 0.5,
  streamingHours: 0.2,
  relayBandwidth: 0.2,
  viewerHours: 0.1,
  dailyStreamingHourCap: 8,
  viewerHoursChannelCap: 0.1,
};

/** A computed period with these allocations; approved (with its posting) unless `approve` is false. */
async function period(allocations: { userId: string; amountCents: number }[], approve = true): Promise<string> {
  const start = new Date(Date.UTC(2021, 0, 1 + ++seq));
  const [p] = await db
    .insert(s.patronagePeriods)
    .values({
      periodStart: start,
      periodEnd: new Date(start.getTime() + 86_400_000),
      status: "computed",
      formulaVersion: "2026.1",
      weights: WEIGHTS,
      surplusCents: 10_000,
      currency: "usd",
      computedAt: new Date(),
      computedById: ran,
    })
    .returning({ id: s.patronagePeriods.id });
  const id = p!.id;
  await db.insert(s.patronageAllocations).values(allocations.map((a) => ({ periodId: id, ...a, lines: [] })));
  if (!approve) return id;
  const r = await post(db, patronageAllocation({ periodId: id, currency: "usd", occurredAt: new Date(), allocations }));
  await db
    .update(s.patronagePeriods)
    .set({ status: "approved", approvedById: approver, approvedAt: new Date(), ledgerTransactionId: r.transactionId })
    .where(eq(s.patronagePeriods.id, id));
  return id;
}

/** A pending row, then (unless `pending`) paid with its posting. */
async function pay(periodId: string, userId: string, amountCents: number, opts: { pending?: boolean } = {}) {
  const id = uuidv7();
  await db.insert(s.patronagePayouts).values({
    id,
    periodId,
    userId,
    amountCents,
    currency: "usd",
    provider: "manual",
    idempotencyKey: `patronage-payout:${id}`,
  });
  if (!opts.pending) {
    await post(
      db,
      patronagePayout({
        payoutId: id,
        periodId,
        userId,
        provider: "manual",
        amountCents,
        currency: "usd",
        occurredAt: new Date(),
      }),
    );
    await db
      .update(s.patronagePayouts)
      .set({ status: "paid", providerRef: `ref-${id}`, paidAt: new Date() })
      .where(eq(s.patronagePayouts.id, id));
  }
  return id;
}

async function reverse(
  periodId: string,
  payoutId: string,
  userId: string,
  amountCents: number,
  cumulativeCents: number,
) {
  await post(
    db,
    patronagePayoutReversed({
      payoutId,
      periodId,
      userId,
      provider: "manual",
      amountCents,
      cumulativeCents,
      currency: "usd",
      occurredAt: new Date(),
    }),
  );
}

const statusOf = async (id: string) =>
  (await db.select({ st: s.patronagePeriods.status }).from(s.patronagePeriods).where(eq(s.patronagePeriods.id, id)))[0]
    ?.st;

/** As the API does: under the period's row lock, in one transaction. */
const distribute = (periodId: string) =>
  db.transaction(async (tx) => {
    await tx.select().from(s.patronagePeriods).where(eq(s.patronagePeriods.id, periodId)).for("update");
    return distributePatronageIfPaid(tx, periodId);
  });

describe("distributePatronageIfPaid", () => {
  test("flips once, when the last positive allocation is paid, with the period's totals", async () => {
    const [a, b, z] = [await makeUser(), await makeUser(), await makeUser()];
    const id = await period([
      { userId: a, amountCents: 700 },
      { userId: b, amountCents: 300 },
      { userId: z, amountCents: 0 },
    ]);
    await pay(id, a, 700);
    expect(await distribute(id)).toBeNull();
    expect(await statusOf(id)).toBe("approved");
    await pay(id, b, 300);
    // The zero allocation needs no row and is not counted as a member paid.
    expect(await distribute(id)).toEqual({ periodId: id, currency: "usd", totalCents: 1000, members: 2 });
    expect(await statusOf(id)).toBe("distributed");
    // Idempotent: a second settle (a redelivered webhook) flips nothing.
    expect(await distribute(id)).toBeNull();
  });

  test("a pending row or a failed one keeps the period approved", async () => {
    const a = await makeUser();
    const id = await period([{ userId: a, amountCents: 500 }]);
    const pendingId = await pay(id, a, 500, { pending: true });
    expect(await distribute(id)).toBeNull();
    await db.update(s.patronagePayouts).set({ status: "failed" }).where(eq(s.patronagePayouts.id, pendingId));
    expect(await distribute(id)).toBeNull();
    expect(await statusOf(id)).toBe("approved");
    await pay(id, a, 500);
    expect(await distribute(id)).toMatchObject({ totalCents: 500, members: 1 });
  });

  test("what a reversal kept is owed again until its follow-up row is paid", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const id = await period([
      { userId: a, amountCents: 1000 },
      { userId: b, amountCents: 200 },
    ]);
    const first = await pay(id, a, 1000);
    // Two partial reversals: the largest cumulative total is what came back.
    await reverse(id, first, a, 100, 100);
    await reverse(id, first, a, 300, 400);
    await db.update(s.patronagePayouts).set({ status: "reversed" }).where(eq(s.patronagePayouts.id, first));
    expect(await patronageReversedCents(db, [first])).toEqual(new Map([[first, 400]]));
    await pay(id, b, 200);
    expect(await distribute(id)).toBeNull();
    // The follow-up row (one pending or paid row per member at a time) is open: still owed.
    const followUp = await pay(id, a, 400, { pending: true });
    expect(await distribute(id)).toBeNull();
    await db
      .update(s.patronagePayouts)
      .set({ status: "paid", providerRef: `ref-${followUp}`, paidAt: new Date() })
      .where(eq(s.patronagePayouts.id, followUp));
    expect(await distribute(id)).toMatchObject({ totalCents: 1200, members: 2 });
    expect(await statusOf(id)).toBe("distributed");
  });

  test("two settles racing on a paid-out period: exactly one flips it", async () => {
    const a = await makeUser();
    const id = await period([{ userId: a, amountCents: 900 }]);
    await pay(id, a, 900);
    const both = await Promise.all([distribute(id), distribute(id)]);
    expect(both.filter((d) => d !== null)).toHaveLength(1);
    expect(await statusOf(id)).toBe("distributed");
  });

  test("even a caller that forgot the period lock flips it once (the update re-checks approved)", async () => {
    const a = await makeUser();
    const id = await period([{ userId: a, amountCents: 900 }]);
    await pay(id, a, 900);
    const unlocked = () => db.transaction((tx) => distributePatronageIfPaid(tx, id));
    const both = await Promise.all([unlocked(), unlocked(), unlocked()]);
    expect(both.filter((d) => d !== null)).toHaveLength(1);
  });

  test("an unknown, unapproved or empty period is never flipped", async () => {
    expect(await distribute(uuidv7())).toBeNull();
    const a = await makeUser();
    const computed = await period([{ userId: a, amountCents: 100 }], false);
    expect(await distribute(computed)).toBeNull();
    expect(await statusOf(computed)).toBe("computed");
  });
});

describe("patronageReversedCents", () => {
  test("no ids: no query, an empty map; rows with no reversal are absent", async () => {
    expect(await patronageReversedCents(db, [])).toEqual(new Map());
    expect(await patronageReversedCents(db, [uuidv7()])).toEqual(new Map());
  });
});
