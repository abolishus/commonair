// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Paying approved patronage out (batch 8, M1-coop-money; ADR 0020): `coop.patronage.pay` needs two
 * approvers and is audited, it opens one row per member with a positive allocation (never a second
 * open row, so never an overpay), a manual row marked paid posts `patronagePayout` (Dr the payable,
 * Cr `cash:manual`), a deleted member's row stays owed, a member sees only their own row, and a
 * Connect reversal returns the amount to the payable with a new manual row for it. Ledger checks
 * after each: balances, and each payable equals its allocation less what was paid out.
 *
 * A Connect row whose outcome is unknown is settled by a treasurer (paid with its `tr_` id, or not
 * sent with a manual follow-up), and nobody settles their own payout.
 *
 * `markPatronagePayoutPaid`, `markPatronagePayoutUnsent` and `memberPatronagePayout` are called directly: their procedures are a
 * contract request (`coop.patronage.markPaid`, `PatronageStatement.payout`). So is the transfer
 * webhook's patronage branch, driven here through `patronageTransferEvent` as the webhook will.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7, type Database } from "@commonair/db";
import { accounts, owedCents, patronageAllocation, post, rawBalance } from "@commonair/ledger";
import type { StripeAction } from "@commonair/payments";
import {
  MANUAL_REFERENCE,
  STRIPE_TRANSFER_REFERENCE,
  markPatronagePayoutPaid,
  markPatronagePayoutUnsent,
  memberPatronagePayout,
  patronageTransferEvent,
  payStep,
} from "../src/coop/patronage-payouts.ts";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;
const byJson = (a: unknown, b: unknown) => JSON.stringify(a).localeCompare(JSON.stringify(b));
interface Row {
  id: string;
  user: { id: string; username: string };
  status: string;
  provider: string;
  amount: { cents: number; currency: string };
  reference: string | null;
}

describe("pure rules", () => {
  test("payStep: request, then a different person approves; the requester cannot", () => {
    expect(payStep([], "a")).toEqual({ kind: "request" });
    expect(payStep([{ action: "patronage.pay_request", actorId: "a" }], "a")).toEqual({ kind: "same_person" });
    expect(payStep([{ action: "patronage.pay_request", actorId: "a" }], "b")).toEqual({
      kind: "approve",
      requesterId: "a",
    });
    expect(
      payStep(
        [
          { action: "patronage.pay_request", actorId: "a" },
          { action: "patronage.pay_approve", actorId: "b" },
        ],
        "a",
      ),
    ).toEqual({ kind: "approved" });
  });

  test("owedCents: allocation less paid rows and what reversed rows kept; never negative", () => {
    expect(owedCents(1000, [])).toBe(1000);
    expect(owedCents(1000, [{ status: "paid", amountCents: 1000, reversedCents: 0 }])).toBe(0);
    expect(owedCents(1000, [{ status: "pending", amountCents: 1000, reversedCents: 0 }])).toBe(1000);
    expect(owedCents(1000, [{ status: "failed", amountCents: 1000, reversedCents: 0 }])).toBe(1000);
    expect(owedCents(1000, [{ status: "reversed", amountCents: 1000, reversedCents: 1000 }])).toBe(1000);
    expect(owedCents(1000, [{ status: "reversed", amountCents: 1000, reversedCents: 400 }])).toBe(400);
    expect(
      owedCents(1000, [
        { status: "reversed", amountCents: 1000, reversedCents: 400 },
        { status: "paid", amountCents: 400, reversedCents: 0 },
      ]),
    ).toBe(0);
    expect(owedCents(10, [{ status: "paid", amountCents: 20, reversedCents: 0 }])).toBe(0);
  });

  test("a manual reference is a short code, never free text", () => {
    for (const ok of ["BANK-123", "chq-0042", "2026/11/03#7", "a", "tr_1AbC"])
      expect(MANUAL_REFERENCE.test(ok)).toBe(true);
    for (const bad of [
      "",
      " lead",
      "x".repeat(65),
      "ada@example.test",
      "line\nbreak",
      "ünï",
      "Paid Jane Doe",
      "chq 0042",
    ])
      expect(MANUAL_REFERENCE.test(bad)).toBe(false);
  });

  test("a Connect row settled by hand takes a Stripe transfer id only", () => {
    for (const ok of ["tr_1AbC", `tr_${"a".repeat(60)}`]) expect(STRIPE_TRANSFER_REFERENCE.test(ok)).toBe(true);
    for (const bad of ["tr_", "BANK-123", "po_123", "tr_a-b", `tr_${"a".repeat(61)}`])
      expect(STRIPE_TRANSFER_REFERENCE.test(bad)).toBe(false);
  });
});

describe("patronage payouts", () => {
  let api: TestApi;
  let t1: Account; // runs the period, requests the payout
  let t2: Account; // approves the period and the payout
  let admin: Account;
  let m1: Account;
  let m2: Account;
  let gone: Account; // deletes their account after the period
  let outsider: Account;
  let periodId = "";
  let periods = 0;
  const owner = () => api.db.db;

  /** An approved period with these allocations: computed by t1, approved by t2 (the triggers' rules). */
  async function approvedPeriod(db: Database, allocations: readonly { userId: string; cents: number }[]) {
    periods += 1;
    const id = uuidv7();
    const start = new Date(Date.UTC(2001, periods, 1));
    const end = new Date(Date.UTC(2001, periods + 1, 1));
    const total = allocations.reduce((s, a) => s + a.cents, 0);
    await db.insert(schema.patronagePeriods).values({
      id,
      periodStart: start,
      periodEnd: end,
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
    await db
      .insert(schema.patronageAllocations)
      .values(allocations.map((a) => ({ periodId: id, userId: a.userId, amountCents: a.cents, lines: [] })));
    const r = await post(
      db,
      patronageAllocation({
        periodId: id,
        currency: "usd",
        occurredAt: new Date(),
        allocations: allocations.filter((a) => a.cents > 0).map((a) => ({ userId: a.userId, amountCents: a.cents })),
      }),
    );
    await db
      .update(schema.patronagePeriods)
      .set({
        status: "approved",
        approvedAt: new Date(),
        approvedById: t2.userId,
        ledgerTransactionId: r.transactionId,
      })
      .where(eq(schema.patronagePeriods.id, id));
    return id;
  }
  const pay = (as: Account, id = periodId) =>
    as.client.call<{ state: string; created: number; code?: string; data?: unknown }>(
      "POST",
      `/api/coop/patronage/${id}/pay`,
    );
  const list = (as: Account, id = periodId) => as.client.call<Row[]>("GET", `/api/coop/patronage/${id}/payouts`);
  const owed = async (userId: string) => 0 - (await rawBalance(owner(), accounts.patronagePayable(userId), "usd"));
  async function expectLedgerBalanced() {
    const off = await owner().execute<{ transaction_id: string }>(sql`
      select transaction_id from ledger_entries group by transaction_id, currency having sum(amount_cents) <> 0`);
    expect([...off]).toEqual([]);
  }
  const auditOf = (action: string, subjectId: string) =>
    owner()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, action), eq(schema.auditLog.subjectId, subjectId)));

  beforeAll(async () => {
    api = await startApi();
    [t1, t2, admin, m1, m2, gone, outsider] = await Promise.all([
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
      signUpAndSignIn(api),
    ]);
    for (const [a, role] of [
      [t1, "treasurer"],
      [t2, "treasurer"],
      [admin, "admin"],
    ] as const)
      await owner().update(schema.users).set({ role }).where(eq(schema.users.id, a.userId));
    periodId = await approvedPeriod(owner(), [
      { userId: m1.userId, cents: 700 },
      { userId: m2.userId, cents: 300 },
      { userId: gone.userId, cents: 50 },
      { userId: outsider.userId, cents: 0 },
    ]);
    await owner().update(schema.users).set({ deletedAt: new Date() }).where(eq(schema.users.id, gone.userId));
  }, 180_000);
  afterAll(async () => {
    await api?.stop();
  });

  test("members and outsiders cannot pay or list", async () => {
    expect((await pay(m1)).status).toBe(403);
    expect((await list(m1)).status).toBe(403);
  });

  test("paying needs a second approver; the requester cannot approve their own request", async () => {
    const first = await pay(t1);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ state: "awaiting_second_approver", created: 0 });
    expect((await list(t1)).body).toEqual([]);
    const self = await pay(t1);
    expect(self.status).toBe(403);
    expect(self.body.data).toEqual({ reason: "second_approver" });
    const ok = await pay(t2);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ state: "approved", created: 3 });
    const [req] = await auditOf("patronage.pay_request", periodId);
    expect(req?.actorId).toBe(t1.userId);
    const [appr] = await auditOf("patronage.pay_approve", periodId);
    expect(appr?.actorId).toBe(t2.userId);
    expect(appr?.details).toMatchObject({ periodId, members: 3, totalCents: 1050, requestedBy: t1.userId });
  });

  test("one row per member with a positive allocation; a repeat creates nothing", async () => {
    const rows = (await list(t1)).body;
    expect(rows.map((r) => [r.user.id, r.amount.cents, r.status, r.provider]).toSorted(byJson)).toEqual(
      [
        [m1.userId, 700, "pending", "manual"],
        [m2.userId, 300, "pending", "manual"],
        [gone.userId, 50, "pending", "manual"],
      ].toSorted(byJson),
    );
    // The deleted account shows as such.
    expect(rows.find((r) => r.user.id === gone.userId)?.user.username).toBe("deleted");
    for (const as of [t1, t2, admin]) expect((await pay(as)).body).toEqual({ state: "approved", created: 0 });
    expect((await list(t1)).body).toHaveLength(3);
    // Opening rows posts nothing: the money is still owed.
    expect(await owed(m1.userId)).toBe(700);
    const opened = await owner()
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "patronage.payout_open"));
    expect(opened).toHaveLength(3);
  });

  test("a period that is not approved is not paid out", async () => {
    const id = uuidv7();
    await owner()
      .insert(schema.patronagePeriods)
      .values({
        id,
        periodStart: new Date(Date.UTC(1999, 1, 1)),
        periodEnd: new Date(Date.UTC(1999, 2, 1)),
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
        surplusCents: 0,
        currency: "usd",
        computedById: t1.userId,
      });
    expect((await pay(t1, id)).status).toBe(409);
    expect((await pay(t1, uuidv7())).status).toBe(404);
  });

  test("a manual row marked paid posts patronagePayout keyed by the row, with its event and audit", async () => {
    const row = (await list(t1)).body.find((r) => r.user.id === m1.userId);
    if (!row) throw new Error("no row");
    const paid = await markPatronagePayoutPaid(api.deps, {
      payoutId: row.id,
      reference: "BANK-123",
      paidAt: new Date().toISOString(),
      actorId: t1.userId,
    });
    expect(paid).toMatchObject({ status: "paid", reference: "BANK-123", provider: "manual" });
    const [posting] = await owner()
      .select()
      .from(schema.ledgerTransactions)
      .where(eq(schema.ledgerTransactions.idempotencyKey, `patronage-payout:${row.id}`));
    expect(posting?.kind).toBe("patronage_payout");
    expect(posting?.metadata).toEqual({ userId: m1.userId, payoutId: row.id });
    expect(await owed(m1.userId)).toBe(0);
    expect(await owed(m2.userId)).toBe(300);
    const events = await owner()
      .select()
      .from(schema.events)
      .where(eq(schema.events.type, "coop.patronage_payout.paid"));
    expect(events.map((e) => (e.payload as Record<string, unknown>).patronage_payout_id)).toContain(row.id);
    const [a] = await auditOf("patronage.payout_paid", row.id);
    expect(a?.actorId).toBe(t1.userId);
    await expectLedgerBalanced();
  });

  test("mark-paid refuses a second time, a bad reference, a future time and a deleted account", async () => {
    const rows = (await list(t1)).body;
    const m1Row = rows.find((r) => r.user.id === m1.userId);
    const m2Row = rows.find((r) => r.user.id === m2.userId);
    const goneRow = rows.find((r) => r.user.id === gone.userId);
    if (!m1Row || !m2Row || !goneRow) throw new Error("rows");
    const mark = (payoutId: string, o: { reference?: string; paidAt?: string } = {}) =>
      markPatronagePayoutPaid(api.deps, {
        payoutId,
        reference: o.reference ?? "REF-1",
        paidAt: o.paidAt ?? new Date().toISOString(),
        actorId: t1.userId,
      }).then(
        () => "ok",
        (e: { code?: string; data?: { requirement?: string } }) => e.data?.requirement ?? e.code,
      );
    expect(await mark(m1Row.id)).toBe("CONFLICT");
    expect(await mark(m2Row.id, { reference: "ada@example.test" })).toBe("BAD_REQUEST");
    expect(await mark(m2Row.id, { paidAt: new Date(Date.now() + 3_600_000).toISOString() })).toBe("BAD_REQUEST");
    expect(await mark(goneRow.id)).toBe("account_deleted");
    expect(await mark(uuidv7())).toBe("NOT_FOUND");
    // The deleted member's money stays in the payable.
    expect(await owed(gone.userId)).toBe(50);
  });

  test("a member sees only their own row", async () => {
    const mine = await memberPatronagePayout(owner(), periodId, m2.userId);
    expect(mine?.user.id).toBe(m2.userId);
    expect(mine?.status).toBe("pending");
    expect((await memberPatronagePayout(owner(), periodId, m1.userId))?.status).toBe("paid");
    expect(await memberPatronagePayout(owner(), periodId, outsider.userId)).toBeNull();
  });

  test("the database never lets a second open row or an overpay through", async () => {
    const app = api.db.app.db;
    const second = app.insert(schema.patronagePayouts).values({
      id: uuidv7(),
      periodId,
      userId: m2.userId,
      amountCents: 300,
      currency: "usd",
      provider: "manual",
      idempotencyKey: `patronage-payout:${uuidv7()}`,
    });
    await expect(second).rejects.toThrow(/./);
    const over = app.insert(schema.patronagePayouts).values({
      id: uuidv7(),
      periodId,
      userId: m1.userId,
      amountCents: 701,
      currency: "usd",
      provider: "manual",
      idempotencyKey: `patronage-payout:${uuidv7()}`,
    });
    await expect(over).rejects.toThrow(/./);
  });

  /** A pending row on its own approved period, inserted as the app (the worker's shape). */
  async function rowOn(userId: string, cents: number, provider: "stripe" | "manual") {
    const pid = await approvedPeriod(owner(), [{ userId, cents }]);
    const id = uuidv7();
    await api.db.app.db.insert(schema.patronagePayouts).values({
      id,
      periodId: pid,
      userId,
      amountCents: cents,
      currency: "usd",
      provider,
      idempotencyKey: `patronage-payout:${id}`,
    });
    return { periodId: pid, payoutId: id };
  }
  const outcomeUnknown = (payoutId: string) =>
    owner()
      .insert(schema.auditLog)
      .values({
        id: uuidv7(),
        actorType: "system",
        action: "patronage.payout_outcome_unknown",
        subjectType: "patronage_payout",
        subjectId: payoutId,
        details: { reason: "no_answer" },
      });
  const refusal = (e: { code?: string; data?: { reason?: string; requirement?: string } }) =>
    e.data?.reason ?? e.data?.requirement ?? e.code;

  test("nobody marks their own payout paid or unsent", async () => {
    const own = await rowOn(t1.userId, 120, "manual");
    const mark = (actorId: string) =>
      markPatronagePayoutPaid(api.deps, {
        payoutId: own.payoutId,
        reference: "BANK-9",
        paidAt: new Date().toISOString(),
        actorId,
      }).then(() => "ok", refusal);
    expect(await mark(t1.userId)).toBe("second_approver");
    const ownStripe = await rowOn(t1.userId, 80, "stripe");
    await outcomeUnknown(ownStripe.payoutId);
    expect(
      await markPatronagePayoutUnsent(api.deps, { payoutId: ownStripe.payoutId, actorId: t1.userId }).then(
        () => "ok",
        refusal,
      ),
    ).toBe("second_approver");
    expect(await mark(t2.userId)).toBe("ok");
    expect(await owed(t1.userId)).toBe(80);
  });

  describe("a Connect payout whose outcome is unknown", () => {
    test("is the worker's until it carries the marker; then a tr_ id marks it paid (cash:stripe)", async () => {
      const r = await rowOn(m1.userId, 250, "stripe");
      const mark = (reference: string) =>
        markPatronagePayoutPaid(api.deps, {
          payoutId: r.payoutId,
          reference,
          paidAt: new Date().toISOString(),
          actorId: t2.userId,
        }).then((v) => v.status, refusal);
      expect(await mark("tr_1Known")).toBe("CONFLICT");
      await outcomeUnknown(r.payoutId);
      expect(await mark("BANK-123")).toBe("BAD_REQUEST");
      const before = await rawBalance(owner(), accounts.cash("stripe"), "usd");
      expect(await mark("tr_1Known")).toBe("paid");
      expect(await owed(m1.userId)).toBe(0);
      expect(await rawBalance(owner(), accounts.cash("stripe"), "usd")).toBe(before - 250);
      expect(await auditOf("patronage.payout_paid", r.payoutId)).toHaveLength(1);
      await expectLedgerBalanced();
    });

    test("not sent: the row fails and a manual row opens for what is still owed", async () => {
      const r = await rowOn(m1.userId, 175, "stripe");
      const unsent = () =>
        markPatronagePayoutUnsent(api.deps, { payoutId: r.payoutId, actorId: t2.userId }).then(
          (v) => v,
          (e) => refusal(e as never) ?? "error",
        );
      expect(await unsent()).toBe("CONFLICT");
      await outcomeUnknown(r.payoutId);
      const before = await owed(m1.userId);
      const out = await unsent();
      if (typeof out === "string") throw new Error(out);
      expect(out.failed).toMatchObject({ status: "failed", provider: "stripe" });
      expect(out.followUp).toMatchObject({ status: "pending", provider: "manual", amount: { cents: 175 } });
      expect(await owed(m1.userId)).toBe(before);
      const [a] = await auditOf("patronage.payout_unsent", r.payoutId);
      expect(a?.actorId).toBe(t2.userId);
      expect(await unsent()).toBe("CONFLICT");
      await expectLedgerBalanced();
    });

    test("a reversal opens a follow-up for its own member only", async () => {
      const pid = await approvedPeriod(owner(), [
        { userId: m1.userId, cents: 90 },
        { userId: m2.userId, cents: 60 },
      ]);
      const [a, b] = [uuidv7(), uuidv7()];
      for (const [id, userId, cents] of [
        [a, m1.userId, 90],
        [b, m2.userId, 60],
      ] as const)
        await api.db.app.db.insert(schema.patronagePayouts).values({
          id,
          periodId: pid,
          userId,
          amountCents: cents,
          currency: "usd",
          provider: "stripe",
          idempotencyKey: `patronage-payout:${id}`,
        });
      // A row starts pending (0049); m2's send failed.
      await api.db.app.db
        .update(schema.patronagePayouts)
        .set({ status: "failed" })
        .where(eq(schema.patronagePayouts.id, b));
      const tr = `tr_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
      const ev = (type: "transfer.updated" | "transfer.reversed", amountReversed: number) =>
        api.db.app.db.transaction((tx) =>
          patronageTransferEvent(
            tx,
            {
              type,
              transferRef: tr,
              destination: "acct_patronage",
              amountCents: 90,
              amountReversed,
              currency: "usd",
              payoutId: a,
              transferId: a,
            },
            new Date(),
          ),
        );
      expect((await ev("transfer.updated", 0))?.outcome).toBe("patronage_payout_paid");
      expect((await ev("transfer.reversed", 90))?.outcome).toBe("patronage_payout_reversed");
      const rows = await owner()
        .select()
        .from(schema.patronagePayouts)
        .where(eq(schema.patronagePayouts.periodId, pid));
      expect(rows.map((r) => [r.userId, r.status, r.provider]).toSorted(byJson)).toEqual(
        [
          [m1.userId, "reversed", "stripe"],
          [m1.userId, "pending", "manual"],
          [m2.userId, "failed", "stripe"],
        ].toSorted(byJson),
      );
      await expectLedgerBalanced();
    });
  });

  describe("a Connect payout reversed", () => {
    let rowId = "";
    let reversedPeriod = "";
    const ref = `tr_${crypto.randomUUID().replace(/-/g, "").slice(0, 14)}`;
    const action = (
      type: "transfer.updated" | "transfer.reversed",
      amountReversed: number,
    ): Extract<StripeAction, { type: "transfer.reversed" | "transfer.updated" }> => ({
      type,
      transferRef: ref,
      destination: "acct_patronage",
      amountCents: 400,
      amountReversed,
      currency: "usd",
      payoutId: rowId,
      transferId: rowId,
    });
    const apply = (a: ReturnType<typeof action>) =>
      api.db.app.db.transaction((tx) => patronageTransferEvent(tx, a, new Date()));

    beforeAll(async () => {
      reversedPeriod = await approvedPeriod(owner(), [{ userId: m2.userId, cents: 400 }]);
      // The row the worker opened for m2's Express account (an instance that can transfer).
      rowId = uuidv7();
      await api.db.app.db.insert(schema.patronagePayouts).values({
        id: rowId,
        periodId: reversedPeriod,
        userId: m2.userId,
        amountCents: 400,
        currency: "usd",
        provider: "stripe",
        idempotencyKey: `patronage-payout:${rowId}`,
      });
    });

    test("a transfer that is not a patronage payout is not ours", async () => {
      const other = {
        ...action("transfer.reversed", 0),
        transferRef: "tr_other",
        transferId: uuidv7(),
        payoutId: null,
      };
      expect(await api.db.app.db.transaction((tx) => patronageTransferEvent(tx, other, new Date()))).toBeNull();
    });

    test("an event before the worker recorded it settles the row paid (cash:stripe)", async () => {
      const before = await owed(m2.userId);
      expect((await apply(action("transfer.updated", 0)))?.outcome).toBe("patronage_payout_paid");
      const [row] = await owner().select().from(schema.patronagePayouts).where(eq(schema.patronagePayouts.id, rowId));
      expect(row).toMatchObject({ status: "paid", providerRef: ref });
      expect(await owed(m2.userId)).toBe(before - 400);
      expect((await apply(action("transfer.updated", 0)))?.outcome).toBe("duplicate");
    });

    test("a reversal returns the amount to the payable and opens a manual row for it", async () => {
      const before = await owed(m2.userId);
      expect((await apply(action("transfer.reversed", 400)))?.outcome).toBe("patronage_payout_reversed");
      expect(await owed(m2.userId)).toBe(before + 400);
      const rows = await owner()
        .select()
        .from(schema.patronagePayouts)
        .where(eq(schema.patronagePayouts.periodId, reversedPeriod));
      expect(rows.map((r) => [r.status, r.provider, r.amountCents]).toSorted(byJson)).toEqual(
        [
          ["reversed", "stripe", 400],
          ["pending", "manual", 400],
        ].toSorted(byJson),
      );
      const [posting] = await owner()
        .select()
        .from(schema.ledgerTransactions)
        .where(eq(schema.ledgerTransactions.idempotencyKey, `patronage-payout-reversed:${rowId}:400`));
      expect(posting?.kind).toBe("patronage_payout_reversal");
      const events = await owner()
        .select()
        .from(schema.events)
        .where(eq(schema.events.type, "coop.patronage_payout.reversed"));
      expect(events.some((e) => (e.payload as Record<string, unknown>).patronage_payout_id === rowId)).toBe(true);
      expect(await auditOf("patronage.payout_reversed", rowId)).toHaveLength(1);
      await expectLedgerBalanced();
    });

    test("a redelivered reversal changes nothing", async () => {
      const before = await owed(m2.userId);
      expect((await apply(action("transfer.reversed", 400)))?.outcome).toBe("duplicate");
      expect(await owed(m2.userId)).toBe(before);
      const rows = await owner()
        .select()
        .from(schema.patronagePayouts)
        .where(eq(schema.patronagePayouts.periodId, reversedPeriod));
      expect(rows).toHaveLength(2);
    });

    test("payables equal allocations less what was paid out", async () => {
      // m2: 300 (first period, unpaid) + 60 (failed, owed) + 400 (reversed back) = 760.
      expect(await owed(m2.userId)).toBe(760);
      // m1: 175 (not sent, a manual row follows) + 90 (reversed back) = 265.
      expect(await owed(m1.userId)).toBe(265);
      await expectLedgerBalanced();
    });
  });
});
