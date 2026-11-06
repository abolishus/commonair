// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Patronage payouts on an instance that can send Connect transfers (follow-ups, unit money), over
 * HTTP: `pay` opens a `stripe` row for a member with a ready Express account and queues its job in
 * Valkey (one per member and period), a repeat queues the pending Connect rows again except one
 * whose outcome is unknown, `payouts` says which rows are outcome-unknown (`outcomeUnknown`), and
 * `markPaid` / `markUnsent` settle such a row. Also the refusals and edges the first file leaves
 * out: a time before approval, a period with nothing allocated, a transfer event for another
 * amount, a transfer that turns up for a row already failed (orphaned, recorded once), and a queue
 * that cannot be reached (the pay stands).
 */
import { Queue } from "bullmq";
import { and, eq } from "drizzle-orm";
import { Valkey } from "iovalkey";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { B8_JOBS, QUEUES, patronagePayoutJobId } from "@commonair/contracts/internal";
import { schema, uuidv7, type Database } from "@commonair/db";
import { patronageAllocation, post } from "@commonair/ledger";
import type { StripeAction } from "@commonair/payments";
import {
  PATRONAGE_PAYOUT_ATTEMPTS,
  closePatronagePayoutQueue,
  createPatronagePayoutQueue,
  markPatronagePayoutPaid,
  markPatronagePayoutUnsent,
  memberPatronagePayout,
  openMissingPayouts,
  outcomeUnknownPayouts,
  patronageTransferEvent,
  setPatronagePayoutQueue,
} from "../src/coop/patronage-payouts.ts";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;
type TransferAction = Extract<StripeAction, { type: "transfer.reversed" | "transfer.updated" }>;
interface Row {
  id: string;
  user: { id: string };
  status: string;
  provider: string;
  amount: { cents: number; currency: string };
  reference: string | null;
  outcomeUnknown: boolean;
}
interface Err {
  code?: string;
  data?: { reason?: string; requirement?: string };
}
const refusal = (e: Err) => e.data?.reason ?? e.data?.requirement ?? e.code;
const byJson = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b));

describe("patronage payouts through Connect", () => {
  let api: TestApi;
  let t1: Account;
  let t2: Account;
  let ready: Account; // a ready Express account
  let alsoReady: Account;
  let plain: Account; // no payout account: paid by hand
  let periods = 0;
  const prefix = `test-patronage-${crypto.randomUUID()}`;
  let reader: Queue;
  let readerConn: Valkey;
  const owner = () => api.db.db;
  const app = () => api.db.app.db;

  async function approvedPeriod(db: Database, allocations: readonly { userId: string; cents: number }[]) {
    periods += 1;
    const id = uuidv7();
    const total = allocations.reduce((s, a) => s + a.cents, 0);
    await db.insert(schema.patronagePeriods).values({
      id,
      periodStart: new Date(Date.UTC(2051, periods, 1)),
      periodEnd: new Date(Date.UTC(2051, periods + 1, 1)),
      status: "computed",
      formulaVersion: "test",
      weights: {
        revenue: 1,
        streamingHours: 0,
        relayBandwidth: 0,
        viewerHours: 0,
        dailyStreamingHourCap: 12,
        viewerHoursChannelCap: 1,
      },
      surplusCents: total,
      currency: "usd",
      computedAt: new Date(),
      computedById: t1.userId,
    });
    if (allocations.length > 0)
      await db
        .insert(schema.patronageAllocations)
        .values(allocations.map((a) => ({ periodId: id, userId: a.userId, amountCents: a.cents, lines: [] })));
    const positive = allocations.filter((a) => a.cents > 0);
    const r =
      positive.length > 0
        ? await post(
            db,
            patronageAllocation({
              periodId: id,
              currency: "usd",
              occurredAt: new Date(),
              allocations: positive.map((a) => ({ userId: a.userId, amountCents: a.cents })),
            }),
          )
        : null;
    await db
      .update(schema.patronagePeriods)
      .set({
        status: "approved",
        approvedAt: new Date(),
        approvedById: t2.userId,
        ...(r ? { ledgerTransactionId: r.transactionId } : {}),
      })
      .where(eq(schema.patronagePeriods.id, id));
    return id;
  }

  const pay = (as: Account, id: string) =>
    as.client.call<{ state: string; created: number } & Err>("POST", `/api/coop/patronage/${id}/pay`);
  const list = (as: Account, id: string) => as.client.call<Row[] & Err>("GET", `/api/coop/patronage/${id}/payouts`);
  const markPaid = (as: Account, payoutId: string, reference: string, paidAt = new Date().toISOString()) =>
    as.client.call<Row & Err>("POST", `/api/coop/patronage/payouts/${payoutId}/paid`, { reference, paidAt });
  const markUnsent = (as: Account, payoutId: string) =>
    as.client.call<{ failed: Row; followUp: Row | null } & Err>(
      "POST",
      `/api/coop/patronage/payouts/${payoutId}/unsent`,
      {},
    );
  const outcomeUnknown = (payoutId: string) =>
    owner()
      .insert(schema.auditLog)
      .values({
        actorType: "system",
        action: "patronage.payout_outcome_unknown",
        subjectType: "patronage_payout",
        subjectId: payoutId,
        details: { reason: "no_answer" },
      });
  const auditOf = (action: string, subjectId: string) =>
    owner()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.subjectId, subjectId)));
  const queued = async (periodId: string, userId: string) => reader.getJob(patronagePayoutJobId(periodId, userId));

  beforeAll(async () => {
    api = await startApi();
    // Transfers are possible (the lazy Stripe adapter makes no request until it sends one).
    Object.assign(api.deps.env, { PAYMENTS_PROVIDER: "stripe", STRIPE_SECRET_KEY: "sk_test_patronage" });
    setPatronagePayoutQueue(api.deps, createPatronagePayoutQueue(api.deps.env.VALKEY_URL, prefix));
    readerConn = new Valkey(api.deps.env.VALKEY_URL, { maxRetriesPerRequest: null });
    reader = new Queue(QUEUES.payments, { connection: readerConn, prefix });
    [t1, t2, ready, alsoReady, plain] = await Promise.all([
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
    ]);
    for (const a of [t1, t2])
      await owner().update(schema.users).set({ role: "treasurer" }).where(eq(schema.users.id, a.userId));
    for (const a of [ready, alsoReady])
      await app()
        .insert(schema.payoutAccounts)
        .values({
          userId: a.userId,
          provider: "stripe",
          providerAccountId: `acct_${a.userId.replace(/-/g, "").slice(-16)}`,
          payoutsEnabled: true,
        });
  }, 180_000);
  afterAll(async () => {
    await reader?.obliterate({ force: true }).catch(() => undefined);
    await reader?.close();
    readerConn?.disconnect();
    if (api) await closePatronagePayoutQueue(api.deps);
    await api?.stop();
  });

  describe("pay, queue, settle", () => {
    let periodId = "";
    const rowOf = (rows: Row[], userId: string) => {
      const r = rows.find((x) => x.user.id === userId && x.status === "pending");
      if (!r) throw new Error(`no pending row for ${userId}`);
      return r;
    };

    test("a ready Express account gets a stripe row and one queued job; the rest are manual", async () => {
      periodId = await approvedPeriod(owner(), [
        { userId: ready.userId, cents: 600 },
        { userId: alsoReady.userId, cents: 250 },
        { userId: plain.userId, cents: 150 },
      ]);
      expect((await pay(t1, periodId)).body.state).toBe("awaiting_second_approver");
      expect((await pay(t2, periodId)).body).toEqual({ state: "approved", created: 3 });
      const rows = (await list(t1, periodId)).body;
      expect(rows.map((r) => [r.user.id, r.provider, r.outcomeUnknown]).toSorted(byJson)).toEqual(
        [
          [ready.userId, "stripe", false],
          [alsoReady.userId, "stripe", false],
          [plain.userId, "manual", false],
        ].toSorted(byJson),
      );
      const job = await queued(periodId, ready.userId);
      expect(job?.name).toBe(B8_JOBS.patronagePayout);
      expect(job?.data).toEqual({ periodId, userId: ready.userId });
      expect(job?.opts.attempts).toBe(PATRONAGE_PAYOUT_ATTEMPTS);
      expect(await queued(periodId, alsoReady.userId)).toBeDefined();
      expect(await queued(periodId, plain.userId)).toBeUndefined();
    });

    test("a repeat queues pending Connect rows again, except one whose outcome is unknown", async () => {
      await reader.drain();
      const rows = (await list(t1, periodId)).body;
      await outcomeUnknown(rowOf(rows, ready.userId).id);
      expect((await pay(t1, periodId)).body).toEqual({ state: "approved", created: 0 });
      expect(await queued(periodId, ready.userId)).toBeUndefined();
      expect(await queued(periodId, alsoReady.userId)).toBeDefined();
    });

    test("payouts flags only the pending Connect row carrying the worker's marker", async () => {
      const rows = (await list(t1, periodId)).body;
      expect(rowOf(rows, ready.userId).outcomeUnknown).toBe(true);
      expect(rowOf(rows, alsoReady.userId).outcomeUnknown).toBe(false);
      expect(rowOf(rows, plain.userId).outcomeUnknown).toBe(false);
      // A member's own view says so too.
      expect((await memberPatronagePayout(owner(), periodId, ready.userId))?.outcomeUnknown).toBe(true);
      // A marker on a manual row (never the worker's) does not make it unknown.
      await outcomeUnknown(rowOf(rows, plain.userId).id);
      expect(rowOf((await list(t1, periodId)).body, plain.userId).outcomeUnknown).toBe(false);
    });

    test("markPaid over HTTP: a stripe row without the marker is the worker's; the unknown one takes a tr_ id", async () => {
      const rows = (await list(t1, periodId)).body;
      const waiting = rowOf(rows, alsoReady.userId);
      const r = await markPaid(t1, waiting.id, "tr_1NotYours");
      expect(r.status).toBe(409);
      const unknown = rowOf(rows, ready.userId);
      expect((await markPaid(t1, unknown.id, "BANK-1")).status).toBe(400);
      const ok = await markPaid(t1, unknown.id, "tr_1Seen");
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ status: "paid", reference: "tr_1Seen", outcomeUnknown: false });
      expect(rows.find((x) => x.id === unknown.id)?.outcomeUnknown).toBe(true);
      expect(rowOf((await list(t1, periodId)).body, plain.userId).outcomeUnknown).toBe(false);
    });

    test("markUnsent over HTTP: the unknown row fails, a manual follow-up opens; the payee cannot", async () => {
      const rows = (await list(t1, periodId)).body;
      const r = rowOf(rows, alsoReady.userId);
      expect((await markUnsent(t2, r.id)).status).toBe(409);
      await outcomeUnknown(r.id);
      await owner().update(schema.users).set({ role: "treasurer" }).where(eq(schema.users.id, alsoReady.userId));
      try {
        const self = await markUnsent(alsoReady, r.id);
        expect(self.status).toBe(403);
        expect(self.body.data).toEqual({ reason: "second_approver" });
      } finally {
        await owner().update(schema.users).set({ role: "user" }).where(eq(schema.users.id, alsoReady.userId));
      }
      const out = await markUnsent(t2, r.id);
      expect(out.status).toBe(200);
      expect(out.body.failed).toMatchObject({ id: r.id, status: "failed", outcomeUnknown: false });
      expect(out.body.followUp).toMatchObject({ provider: "manual", status: "pending", amount: { cents: 250 } });
      expect((await markUnsent(t2, r.id)).status).toBe(409);
      expect((await markUnsent(t2, uuidv7())).status).toBe(404);
      const follow = out.body.followUp;
      if (!follow) throw new Error("no follow-up");
      expect((await markPaid(t2, follow.id, "BANK-77")).body).toMatchObject({ status: "paid", provider: "manual" });
    });

    test("members cannot settle anything", async () => {
      const rows = (await list(t1, periodId)).body;
      expect((await markPaid(plain, rowOf(rows, plain.userId).id, "BANK-2")).status).toBe(403);
      expect((await markUnsent(plain, rowOf(rows, plain.userId).id)).status).toBe(403);
    });
  });

  test("a queue that cannot be reached leaves the pay standing; the rows stay pending for a repeat", async () => {
    const id = await approvedPeriod(owner(), [{ userId: ready.userId, cents: 90 }]);
    setPatronagePayoutQueue(api.deps, {
      enqueue: () => Promise.reject(new Error("valkey down")),
      close: () => Promise.resolve(),
    });
    try {
      await pay(t1, id);
      expect((await pay(t2, id)).body).toEqual({ state: "approved", created: 1 });
      expect((await list(t1, id)).body.map((r) => [r.provider, r.status])).toEqual([["stripe", "pending"]]);
    } finally {
      setPatronagePayoutQueue(api.deps, createPatronagePayoutQueue(api.deps.env.VALKEY_URL, prefix));
    }
    await pay(t1, id);
    expect(await queued(id, ready.userId)).toBeDefined();
  });

  test("refusals: no such period, nothing allocated, a time before approval or not a time", async () => {
    expect((await list(t1, uuidv7())).status).toBe(404);
    const empty = await approvedPeriod(owner(), [{ userId: plain.userId, cents: 0 }]);
    const r = await pay(t1, empty);
    expect(r.status).toBe(412);
    expect(r.body.data).toEqual({ requirement: "allocations" });
    const id = await approvedPeriod(owner(), [{ userId: plain.userId, cents: 40 }]);
    await pay(t1, id);
    await pay(t2, id);
    const [row] = (await list(t1, id)).body;
    if (!row) throw new Error("no row");
    const mark = (paidAt: string) =>
      markPatronagePayoutPaid(api.deps, { payoutId: row.id, reference: "BANK-5", paidAt, actorId: t1.userId }).then(
        () => "ok",
        refusal,
      );
    expect(await mark("not a time")).toBe("BAD_REQUEST");
    expect(await mark(new Date(Date.UTC(2000, 0, 1)).toISOString())).toBe("BAD_REQUEST");
    expect(await mark(new Date().toISOString())).toBe("ok");
    // A paid row is not settled as not sent.
    expect(
      await markPatronagePayoutUnsent(api.deps, { payoutId: row.id, actorId: t2.userId }).then(() => "ok", refusal),
    ).toBe("CONFLICT");
  });

  test("openMissingPayouts: an empty member list and a period with nothing owed open nothing", async () => {
    const id = await approvedPeriod(owner(), [{ userId: plain.userId, cents: 30 }]);
    const period = { id, currency: "usd" };
    const actor = { type: "system" as const, id: null };
    await app().transaction(async (tx) => {
      expect(await openMissingPayouts(tx, period, { canTransfer: true, actor, userIds: [] })).toEqual({
        created: 0,
        stripe: [],
      });
      expect(await openMissingPayouts(tx, period, { canTransfer: true, actor, userIds: [ready.userId] })).toEqual({
        created: 0,
        stripe: [],
      });
      expect(await openMissingPayouts(tx, period, { canTransfer: true, actor })).toEqual({ created: 1, stripe: [] });
      // The open row stands: a second call opens nothing.
      expect(await openMissingPayouts(tx, period, { canTransfer: true, actor })).toEqual({ created: 0, stripe: [] });
    });
    expect(await outcomeUnknownPayouts(owner(), [])).toEqual(new Set());
  });

  describe("transfer events", () => {
    let periodId = "";
    let rowId = "";
    const ref = `tr_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
    const event = (over: Partial<TransferAction> = {}): TransferAction => ({
      type: "transfer.updated",
      transferRef: ref,
      destination: "acct_patronage",
      amountCents: 500,
      amountReversed: 0,
      currency: "usd",
      payoutId: rowId,
      transferId: rowId,
      ...over,
    });
    const apply = (a: TransferAction) => app().transaction((tx) => patronageTransferEvent(tx, a, new Date()));

    beforeAll(async () => {
      periodId = await approvedPeriod(owner(), [{ userId: alsoReady.userId, cents: 500 }]);
      rowId = uuidv7();
      await app()
        .insert(schema.patronagePayouts)
        .values({
          id: rowId,
          periodId,
          userId: alsoReady.userId,
          amountCents: 500,
          currency: "usd",
          provider: "stripe",
          idempotencyKey: `patronage-payout:${rowId}`,
        });
    });

    test("another amount or currency is a mismatch and changes nothing", async () => {
      expect((await apply(event({ amountCents: 499 })))?.outcome).toBe("transfer_mismatch");
      expect((await apply(event({ currency: "eur" })))?.outcome).toBe("transfer_mismatch");
      const [row] = await owner().select().from(schema.patronagePayouts).where(eq(schema.patronagePayouts.id, rowId));
      expect(row?.status).toBe("pending");
    });

    test("an id that is not ours (not a uuid, or no such row) is not a patronage transfer", async () => {
      expect(await apply(event({ transferRef: "tr_unknown", transferId: "not-a-uuid" }))).toBeNull();
      expect(await apply(event({ transferRef: "tr_unknown", transferId: null }))).toBeNull();
      expect(await apply(event({ transferRef: "tr_unknown", transferId: uuidv7() }))).toBeNull();
    });

    test("a transfer for a row already failed is recorded for the treasurer once, never paid", async () => {
      await app()
        .update(schema.patronagePayouts)
        .set({ status: "failed" })
        .where(eq(schema.patronagePayouts.id, rowId));
      expect((await apply(event()))?.outcome).toBe("patronage_payout_orphaned");
      expect((await apply(event()))?.outcome).toBe("patronage_payout_orphaned");
      const marks = await auditOf("patronage.payout_orphaned", rowId);
      expect(marks).toHaveLength(1);
      expect(marks[0]?.details).toEqual({ periodId, userId: alsoReady.userId, transferRef: ref });
      const [row] = await owner().select().from(schema.patronagePayouts).where(eq(schema.patronagePayouts.id, rowId));
      expect(row).toMatchObject({ status: "failed", providerRef: null });
    });
  });
});
