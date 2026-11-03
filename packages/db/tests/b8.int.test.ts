// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 8 schema (0048, 0049; .claude/briefs/b8/contract-step.md §2.1-§2.2): the one-pending-gift
 * index and the gift flag, the Connect transfer guard, the patronage payout guard, the
 * `shares.cardPayments` setting and the app role's grants. Run as the least-privilege app role, by
 * direct inserts, so no application check stands in for a refusal.
 */
import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";
import type { Database } from "../src/client.ts";
import { uuidv7 } from "../src/ids.ts";
import { MIGRATIONS_DIR } from "../src/migrate.ts";
import * as s from "../src/schema/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

let t: TestDatabase;
let app: Database;
let owner: Database;

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
  owner = t.db;
});
afterAll(async () => {
  await t?.drop();
});

/** The database refused: the message (or its cause's) matches; returns the SQLSTATE. */
async function expectRefused(p: PromiseLike<unknown>, message: RegExp = /./): Promise<string | undefined> {
  const err = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, "expected the database to reject").toBeInstanceOf(Error);
  const e = err as Error & { code?: string; cause?: { code?: string; message?: string } };
  expect(e.cause?.message ?? e.message).toMatch(message);
  return e.cause?.code ?? e.code;
}

async function newUser(role: "user" | "treasurer" = "user"): Promise<string> {
  const name = `b8_${uuidv7().replace(/-/g, "").slice(-12)}`;
  const [u] = await app
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  // Roles are granted by the operator CLI, i.e. the owner.
  if (role !== "user") await owner.update(s.users).set({ role }).where(eq(s.users.id, u!.id));
  return u!.id;
}

async function newChannel(): Promise<string> {
  const ownerId = await newUser();
  const [c] = await app
    .insert(s.channels)
    .values({ ownerId, slug: `c${ownerId.slice(-10)}`, displayName: "B8" })
    .returning({ id: s.channels.id });
  return c!.id;
}

// 1. Gifts ---------------------------------------------------------------------------------

describe("one pending gift per gifter and channel", () => {
  const giftPayment = (userId: string, channelId: string, over: Partial<typeof s.payments.$inferInsert> = {}) =>
    app.insert(s.payments).values({
      provider: "manual",
      providerRef: `CA-${uuidv7()}`,
      kind: "subscription",
      status: "pending",
      userId,
      channelId,
      amountCents: 499,
      currency: "usd",
      tier: 1,
      quantity: 1,
      gift: true,
      ...over,
    });

  test("a second pending gift for the same channel is refused; others are not", async () => {
    const gifter = await newUser();
    const channel = await newChannel();
    const other = await newChannel();
    await giftPayment(gifter, channel);
    expect(await expectRefused(giftPayment(gifter, channel), /payments_open_gift_uq/)).toBe("23505");
    // Another channel, a non-gift payment and a finished gift are all outside the index.
    await giftPayment(gifter, other);
    await giftPayment(gifter, channel, { gift: false });
    await giftPayment(gifter, channel, { status: "failed" });
    // Once the pending gift ends, a new one may start.
    await app
      .update(s.payments)
      .set({ status: "failed" })
      .where(sql`${s.payments.userId} = ${gifter} and ${s.payments.channelId} = ${channel} and ${s.payments.gift}`);
    await giftPayment(gifter, channel);
  });

  test("the flag is only on subscriptions and never changes", async () => {
    const gifter = await newUser();
    const channel = await newChannel();
    expect(
      await expectRefused(giftPayment(gifter, channel, { kind: "tip", tier: null }), /payments_gift_is_subscription/),
    ).toBe("23514");
    const [p] = await giftPayment(gifter, channel, { gift: false }).returning({ id: s.payments.id });
    await expectRefused(
      app.update(s.payments).set({ gift: true }).where(eq(s.payments.id, p!.id)),
      /gift flag never changes/,
    );
    await expectRefused(
      owner.update(s.payments).set({ gift: true }).where(eq(s.payments.id, p!.id)),
      /gift flag never changes/,
    );
  });

  test("two connections racing for the same gift slot: exactly one wins", async () => {
    const gifter = await newUser();
    const channel = await newChannel();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let firstInserted: () => void = () => {};
    const inserted = new Promise<void>((r) => {
      firstInserted = r;
    });
    const first = app.transaction(async (tx) => {
      await tx.insert(s.payments).values({
        provider: "manual",
        providerRef: `CA-${uuidv7()}`,
        kind: "subscription",
        status: "pending",
        userId: gifter,
        channelId: channel,
        amountCents: 499,
        currency: "usd",
        tier: 1,
        gift: true,
      });
      firstInserted();
      await gate;
    });
    await inserted;
    // The second connection blocks on the first's uncommitted index entry, then loses.
    const second = giftPayment(gifter, channel).then(
      () => "inserted",
      (e: unknown) => {
        const err = e as { code?: string; cause?: { code?: string } };
        return err.cause?.code ?? err.code ?? "error";
      },
    );
    await new Promise((r) => setTimeout(r, 200));
    release();
    await first;
    expect(await second).toBe("23505");
    const rows = await app
      .select({ id: s.payments.id })
      .from(s.payments)
      .where(
        sql`${s.payments.userId} = ${gifter} and ${s.payments.channelId} = ${channel} and ${s.payments.gift} and ${s.payments.status} = 'pending'`,
      );
    expect(rows).toHaveLength(1);
  });

  test("a gift has a gifter and a channel (NULLs would slip past the index)", async () => {
    const gifter = await newUser();
    const channel = await newChannel();
    await expectRefused(giftPayment(gifter, channel, { userId: null }), /has a gifter and a channel/);
    await expectRefused(giftPayment(gifter, channel, { channelId: null }), /has a gifter and a channel/);
    // A non-gift payment without a channel is unaffected.
    await giftPayment(gifter, channel, { channelId: null, gift: false });
  });

  const giftSub = (
    db: Pick<Database, "insert">,
    gifter: string,
    recipient: string,
    channel: string,
    giftPaymentId: string,
  ) =>
    db.insert(s.subscriptions).values({
      subscriberId: recipient,
      channelId: channel,
      tier: 1,
      status: "incomplete",
      provider: "manual",
      priceCents: 499,
      currency: "usd",
      giftedById: gifter,
      giftPaymentId,
    });

  test("a subscription's gift payment must be flagged a gift (the index cannot be dodged)", async () => {
    const gifter = await newUser();
    const recipient = await newUser();
    const channel = await newChannel();
    const [plain] = await giftPayment(gifter, channel, { gift: false }).returning({ id: s.payments.id });
    const [gift] = await giftPayment(gifter, channel).returning({ id: s.payments.id });
    await expectRefused(giftSub(app, gifter, recipient, channel, plain!.id), /gift payment is a gift payment/);
    const [row] = await giftSub(app, gifter, recipient, channel, gift!.id).returning({ id: s.subscriptions.id });
    await expectRefused(
      app.update(s.subscriptions).set({ giftPaymentId: plain!.id }).where(eq(s.subscriptions.id, row!.id)),
      /gift payment is a gift payment/,
    );
  });

  test("0048's backfill marks the newest pending gift and expires the older duplicates", async () => {
    const migration = readFileSync(`${MIGRATIONS_DIR}/0048_b8.sql`, "utf8");
    const backfill = migration
      .slice(migration.indexOf("-- Batch 8 decision (d)"))
      .split("--> statement-breakpoint")
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
    expect(backfill).toHaveLength(2);
    const gifter = await newUser();
    const channel = await newChannel();
    const later = new Date(Date.now() + 86_400_000);
    type Row = { gift: boolean; expiresAt: Date | null };
    const rollback = new Error("rollback");
    let result: Row[] = [];
    const outcome = await owner
      .transaction(async (tx) => {
        // Rows from before 0048 (gift payments not yet flagged), which 0049 now refuses to link, and
        // the backfill as it ran before 0049 froze the flag. Rolled back below.
        await tx.execute(sql`alter table subscriptions disable trigger subscriptions_gift_payment_ck`);
        await tx.execute(sql`alter table payments disable trigger payments_gift_frozen`);
        const made: string[] = [];
        for (const [i, status] of (["succeeded", "pending", "pending"] as const).entries()) {
          const [p] = await tx
            .insert(s.payments)
            .values({
              provider: "manual",
              providerRef: `CA-${uuidv7()}`,
              kind: "subscription",
              status,
              userId: gifter,
              channelId: channel,
              amountCents: 499,
              currency: "usd",
              tier: 1,
              createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
              expiresAt: later,
            })
            .returning({ id: s.payments.id });
          await giftSub(tx, gifter, await newUser(), channel, p!.id);
          made.push(p!.id);
        }
        for (const statement of backfill) await tx.execute(sql.raw(statement));
        const rows = await tx
          .select({ id: s.payments.id, gift: s.payments.gift, expiresAt: s.payments.expiresAt })
          .from(s.payments)
          .where(sql`${s.payments.id} in ${made}`);
        result = made.map((id) => rows.find((r) => r.id === id)!);
        throw rollback;
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(outcome).toBe(rollback);
    const [done, older, newest] = result;
    expect(done!.gift).toBe(true);
    expect(newest!.gift).toBe(true);
    expect(newest!.expiresAt).toEqual(later);
    // The older pending duplicate stays unflagged and is due now, so money-expire-pending fails it.
    expect(older!.gift).toBe(false);
    expect(older!.expiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

// 2. Connect transfers ----------------------------------------------------------------------

let periodSeq = 0;
async function stripePayee(): Promise<{ userId: string; account: string }> {
  const userId = await newUser();
  const account = `acct_${userId.replace(/-/g, "").slice(-16)}`;
  await app
    .insert(s.payoutAccounts)
    .values({ userId, provider: "stripe", providerAccountId: account, payoutsEnabled: true });
  return { userId, account };
}
async function payout(
  userId: string,
  over: Partial<typeof s.payouts.$inferInsert> = {},
): Promise<{ id: string; amountCents: number }> {
  periodSeq += 1;
  const start = new Date(Date.UTC(2026, 0, periodSeq));
  const [p] = await app
    .insert(s.payouts)
    .values({
      userId,
      periodStart: start,
      periodEnd: new Date(start.getTime() + 86_400_000),
      amountCents: 5_000,
      currency: "usd",
      status: "scheduled",
      provider: "stripe",
      ...over,
    })
    .returning({ id: s.payouts.id, amountCents: s.payouts.amountCents });
  return p!;
}
const transferRow = (
  payoutId: string,
  destinationRef: string,
  over: Partial<typeof s.payoutTransfers.$inferInsert> = {},
) => ({
  payoutId,
  provider: "stripe" as const,
  destinationRef,
  amountCents: 5_000,
  currency: "usd",
  idempotencyKey: `payout-transfer:${payoutId}`,
  ...over,
});
async function transfer(): Promise<{ id: string; payoutId: string }> {
  const { userId, account } = await stripePayee();
  const p = await payout(userId);
  const [row] = await app
    .insert(s.payoutTransfers)
    .values(transferRow(p.id, account))
    .returning({ id: s.payoutTransfers.id });
  return { id: row!.id, payoutId: p.id };
}
const setTransfer = (id: string, set: Partial<typeof s.payoutTransfers.$inferInsert>) =>
  app.update(s.payoutTransfers).set(set).where(eq(s.payoutTransfers.id, id));

describe("payout_transfers: who may be paid", () => {
  test("a scheduled Stripe payout to the payee's own account takes one transfer", async () => {
    const { userId, account } = await stripePayee();
    const p = await payout(userId);
    await app.insert(s.payoutTransfers).values(transferRow(p.id, account));
    expect(
      await expectRefused(
        app.insert(s.payoutTransfers).values(transferRow(p.id, account, { idempotencyKey: `again:${p.id}` })),
        /payout_transfers_payout_uq/,
      ),
    ).toBe("23505");
  });

  test("a manual payout, or one that is not scheduled, is refused", async () => {
    const { userId, account } = await stripePayee();
    const manual = await payout(userId, { provider: "manual" });
    await expectRefused(app.insert(s.payoutTransfers).values(transferRow(manual.id, account)), /only a Stripe payout/);
    for (const status of ["pending", "paid", "failed"] as const) {
      const p = await payout(userId, { status });
      await expectRefused(app.insert(s.payoutTransfers).values(transferRow(p.id, account)), /needs a scheduled payout/);
    }
  });

  test("the amount, currency and destination must be the payout's own", async () => {
    const { userId, account } = await stripePayee();
    const p = await payout(userId);
    await expectRefused(
      app.insert(s.payoutTransfers).values(transferRow(p.id, account, { amountCents: 5_001 })),
      /exactly its payout/,
    );
    await expectRefused(
      app.insert(s.payoutTransfers).values(transferRow(p.id, account, { currency: "eur" })),
      /exactly its payout/,
    );
    await expectRefused(
      app.insert(s.payoutTransfers).values(transferRow(p.id, "acct_someoneelse")),
      /payee's own Stripe payout account/,
    );
    // A payee whose account is manual cannot be paid by transfer either.
    const manualPayee = await newUser();
    await app
      .insert(s.payoutAccounts)
      .values({ userId: manualPayee, provider: "manual", providerAccountId: "bank ref", payoutsEnabled: true });
    const q = await payout(manualPayee);
    await expectRefused(
      app.insert(s.payoutTransfers).values(transferRow(q.id, "bank ref")),
      /payee's own Stripe payout account/,
    );
  });

  test("a transfer starts pending with nothing set", async () => {
    const { userId, account } = await stripePayee();
    const p = await payout(userId);
    for (const over of [
      { status: "created" as const, providerRef: "tr_1" },
      { providerRef: "tr_1" },
      { reversedCents: 1 },
      { failureCode: "held" },
    ])
      await expectRefused(app.insert(s.payoutTransfers).values(transferRow(p.id, account, over)), /starts pending/);
  });
});

describe("payout_transfers: the status machine", () => {
  test("pending -> created needs the provider reference, set once", async () => {
    const { id } = await transfer();
    await expectRefused(setTransfer(id, { status: "reversed" }), /cannot go from pending to reversed/);
    await expectRefused(setTransfer(id, { status: "created" }), /has its provider reference/);
    await setTransfer(id, { status: "created", providerRef: `tr_${id.slice(-8)}` });
    await expectRefused(setTransfer(id, { providerRef: "tr_other" }), /set once/);
    await expectRefused(setTransfer(id, { status: "pending" }), /cannot go from created to pending/);
    await expectRefused(setTransfer(id, { status: "failed" }), /cannot go from created to failed/);
  });

  test("reversals only rise, never past the amount; reversed means every cent", async () => {
    const { id } = await transfer();
    await expectRefused(setTransfer(id, { reversedCents: 100 }), /only a created transfer is reversed/);
    await setTransfer(id, { status: "created", providerRef: `tr_${id.slice(-8)}` });
    await setTransfer(id, { reversedCents: 1_000 });
    await expectRefused(setTransfer(id, { reversedCents: 900 }), /only rises/);
    expect(await expectRefused(setTransfer(id, { reversedCents: 5_001 }), /payout_transfers_reversed_bounds/)).toBe(
      "23514",
    );
    await expectRefused(setTransfer(id, { status: "reversed" }), /every cent/);
    await setTransfer(id, { status: "reversed", reversedCents: 5_000 });
    await expectRefused(setTransfer(id, { status: "created" }), /cannot go from reversed to created/);
  });

  test("a failed transfer keeps its code; the payout, destination, amount and key never change", async () => {
    const { id } = await transfer();
    await setTransfer(id, { failureCode: "outcome_unknown" });
    await setTransfer(id, { status: "failed", failureCode: "account_not_ready" });
    await expectRefused(setTransfer(id, { failureCode: "held" }), /only while it is pending/);
    await expectRefused(
      setTransfer(id, { status: "created", providerRef: "tr_x" }),
      /cannot go from failed to created/,
    );
    const other = await transfer();
    for (const set of [
      { amountCents: 4_000 },
      { currency: "eur" },
      { destinationRef: "acct_x" },
      { idempotencyKey: "k" },
      { payoutId: (await transfer()).payoutId },
    ])
      await expectRefused(setTransfer(other.id, set), /never change/);
  });

  test("transfers are never deleted, by the app or the owner", async () => {
    const { id } = await transfer();
    expect(
      await expectRefused(app.delete(s.payoutTransfers).where(eq(s.payoutTransfers.id, id)), /permission denied/),
    ).toBe("42501");
    await expectRefused(owner.delete(s.payoutTransfers).where(eq(s.payoutTransfers.id, id)), /never deleted/);
    await expectRefused(owner.execute(sql`truncate payout_transfers cascade`), /append-only/);
  });
});

describe("payout_transfers: the payout is frozen under its transfer", () => {
  const setPayout = (id: string, set: Partial<typeof s.payouts.$inferInsert>) =>
    app.update(s.payouts).set(set).where(eq(s.payouts.id, id));
  const created = (id: string) => setTransfer(id, { status: "created", providerRef: `tr_${uuidv7()}` });

  test("with a pending transfer: payee, provider, amount and currency never change", async () => {
    const { payoutId } = await transfer();
    const someoneElse = await newUser();
    for (const set of [
      { provider: "manual" as const },
      { amountCents: 99_999 },
      { currency: "eur" },
      { userId: someoneElse },
    ])
      await expectRefused(setPayout(payoutId, set), /never change under its transfer/);
  });

  test("with a pending transfer: only pending, scheduled and held; never failed or paid", async () => {
    const { payoutId } = await transfer();
    await expectRefused(
      setPayout(payoutId, { status: "failed" }),
      /from scheduled to failed while its transfer is pending/,
    );
    await expectRefused(
      setPayout(payoutId, { status: "paid" }),
      /from scheduled to paid while its transfer is pending/,
    );
    // A fraud hold and its release (held -> pending) still work.
    await setPayout(payoutId, { status: "held" });
    await setPayout(payoutId, { status: "pending" });
    await setPayout(payoutId, { status: "scheduled" });
  });

  test("pending -> created needs the payout still scheduled", async () => {
    for (const status of ["held", "pending"] as const) {
      const { id, payoutId } = await transfer();
      await setPayout(payoutId, { status });
      await expectRefused(created(id), /only for a scheduled payout/);
    }
    // The payout fails only after its transfer did, and then the transfer is final.
    const { id, payoutId } = await transfer();
    await setTransfer(id, { status: "failed", failureCode: "account_not_ready" });
    await setPayout(payoutId, { status: "failed" });
    await expectRefused(created(id), /cannot go from failed to created/);
  });

  test("with a created transfer: only scheduled -> paid; never failed or held", async () => {
    const { id, payoutId } = await transfer();
    await created(id);
    await expectRefused(setPayout(payoutId, { status: "failed" }), /while its transfer is created/);
    await expectRefused(setPayout(payoutId, { status: "held" }), /while its transfer is created/);
    await expectRefused(setPayout(payoutId, { amountCents: 99_999 }), /never change under its transfer/);
    await expectRefused(
      setPayout(payoutId, { provider: "manual", status: "paid", amountCents: 99_999 }),
      /never change under its transfer/,
    );
    await setPayout(payoutId, { status: "paid" });
    await expectRefused(setPayout(payoutId, { status: "failed" }), /while its transfer is created/);
    await expectRefused(setPayout(payoutId, { status: "scheduled" }), /while its transfer is created/);
  });

  test("with a failed transfer: the payout may fail, never be paid", async () => {
    const { id, payoutId } = await transfer();
    await setTransfer(id, { status: "failed", failureCode: "account_not_ready" });
    await expectRefused(setPayout(payoutId, { status: "paid" }), /while its transfer is failed/);
    await setPayout(payoutId, { status: "failed" });
  });

  test("a payout without a transfer is unaffected", async () => {
    const { userId } = await stripePayee();
    const p = await payout(userId);
    await setPayout(p.id, { status: "failed" });
    const [row] = await app.select({ status: s.payouts.status }).from(s.payouts).where(eq(s.payouts.id, p.id));
    expect(row?.status).toBe("failed");
  });
});

// 3. Patronage payouts ---------------------------------------------------------------------

let patronageSeq = 0;
async function ledgerAccount(code: string, type: "asset" | "liability" | "equity"): Promise<string> {
  await app
    .insert(s.ledgerAccounts)
    .values({ code: `${code}@usd`, type, name: code, currency: "usd" })
    .onConflictDoNothing();
  const [a] = await app
    .select()
    .from(s.ledgerAccounts)
    .where(eq(s.ledgerAccounts.code, `${code}@usd`));
  return a!.id;
}

/** An approved period with `allocationCents` for `member` (its allocation posted, as 0021 needs). */
async function approvedPeriod(member: string, allocationCents: number): Promise<string> {
  const runner = await newUser("treasurer");
  const approver = await newUser("treasurer");
  const start = new Date(Date.UTC(2021, 0, 1 + ++patronageSeq));
  const [p] = await app
    .insert(s.patronagePeriods)
    .values({
      periodStart: start,
      periodEnd: new Date(start.getTime() + 86_400_000),
      status: "computed",
      formulaVersion: "2026.1",
      weights: {
        revenue: 0.5,
        streamingHours: 0.2,
        relayBandwidth: 0.2,
        viewerHours: 0.1,
        dailyStreamingHourCap: 8,
        viewerHoursChannelCap: 0.1,
      },
      surplusCents: allocationCents,
      currency: "usd",
      computedAt: new Date(),
      computedById: runner,
    })
    .returning({ id: s.patronagePeriods.id });
  const periodId = p!.id;
  await app
    .insert(s.patronageAllocations)
    .values({ periodId, userId: member, amountCents: allocationCents, lines: [] });
  const surplus = await ledgerAccount("equity:retained-surplus", "equity");
  const payable = await ledgerAccount(`liability:patronage-payable:${member}`, "liability");
  const txnId = await app.transaction(async (tx) => {
    const [txn] = await tx
      .insert(s.ledgerTransactions)
      .values({
        kind: "patronage_allocation",
        description: "patronage_allocation",
        occurredAt: new Date(),
        idempotencyKey: `patronage-allocation:${periodId}`,
      })
      .returning({ id: s.ledgerTransactions.id });
    await tx.insert(s.ledgerEntries).values([
      { transactionId: txn!.id, accountId: surplus, amountCents: allocationCents, currency: "usd" },
      { transactionId: txn!.id, accountId: payable, amountCents: -allocationCents, currency: "usd" },
    ]);
    return txn!.id;
  });
  await app
    .update(s.patronagePeriods)
    .set({ status: "approved", approvedById: approver, approvedAt: new Date(), ledgerTransactionId: txnId })
    .where(eq(s.patronagePeriods.id, periodId));
  return periodId;
}
const patronageRow = (periodId: string, userId: string, amountCents: number) => ({
  periodId,
  userId,
  amountCents,
  currency: "usd",
  provider: "manual" as const,
  idempotencyKey: `patronage-payout:${periodId}:${userId}`,
});
const setPatronage = (id: string, set: Partial<typeof s.patronagePayouts.$inferInsert>) =>
  app.update(s.patronagePayouts).set(set).where(eq(s.patronagePayouts.id, id));

describe("patronage_payouts", () => {
  test("only an approved period, in its currency, up to the member's allocation", async () => {
    const member = await newUser();
    const periodId = await approvedPeriod(member, 700);
    await expectRefused(
      app.insert(s.patronagePayouts).values(patronageRow(periodId, member, 701)),
      /never exceeds the allocation/,
    );
    await expectRefused(
      app.insert(s.patronagePayouts).values({ ...patronageRow(periodId, member, 700), currency: "eur" }),
      /period's currency/,
    );
    const stranger = await newUser();
    await expectRefused(
      app.insert(s.patronagePayouts).values(patronageRow(periodId, stranger, 1)),
      /needs the member's allocation/,
    );
    await expectRefused(
      app.insert(s.patronagePayouts).values({ ...patronageRow(periodId, member, 700), status: "paid" }),
      /starts pending/,
    );
    await app.insert(s.patronagePayouts).values(patronageRow(periodId, member, 700));
    expect(
      await expectRefused(
        app.insert(s.patronagePayouts).values({ ...patronageRow(periodId, member, 1), idempotencyKey: "other" }),
        /patronage_payouts_period_user_uq/,
      ),
    ).toBe("23505");
  });

  test("a period that is not approved is refused", async () => {
    const member = await newUser();
    const runner = await newUser("treasurer");
    const start = new Date(Date.UTC(2022, 0, 1 + ++patronageSeq));
    const [p] = await app
      .insert(s.patronagePeriods)
      .values({
        periodStart: start,
        periodEnd: new Date(start.getTime() + 86_400_000),
        status: "computed",
        formulaVersion: "2026.1",
        weights: {
          revenue: 0.5,
          streamingHours: 0.2,
          relayBandwidth: 0.2,
          viewerHours: 0.1,
          dailyStreamingHourCap: 8,
          viewerHoursChannelCap: 0.1,
        },
        surplusCents: 100,
        currency: "usd",
        computedAt: new Date(),
        computedById: runner,
      })
      .returning({ id: s.patronagePeriods.id });
    await app.insert(s.patronageAllocations).values({ periodId: p!.id, userId: member, amountCents: 100, lines: [] });
    await expectRefused(
      app.insert(s.patronagePayouts).values(patronageRow(p!.id, member, 100)),
      /only an approved patronage period/,
    );
  });

  test("pending -> paid needs a reference and a time, each set once; then only reversed", async () => {
    const member = await newUser();
    const periodId = await approvedPeriod(member, 500);
    const [row] = await app
      .insert(s.patronagePayouts)
      .values(patronageRow(periodId, member, 500))
      .returning({ id: s.patronagePayouts.id });
    const id = row!.id;
    await setPatronage(id, { provider: "stripe" });
    await expectRefused(setPatronage(id, { status: "reversed" }), /cannot go from pending to reversed/);
    await expectRefused(setPatronage(id, { status: "paid" }), /has its reference and time/);
    await setPatronage(id, { status: "paid", providerRef: "BANK-1", paidAt: new Date() });
    await expectRefused(setPatronage(id, { providerRef: "BANK-2" }), /set once/);
    await expectRefused(setPatronage(id, { paidAt: new Date(Date.UTC(2020, 0, 1)) }), /set once/);
    await expectRefused(setPatronage(id, { provider: "manual" }), /only while it is pending/);
    await expectRefused(setPatronage(id, { amountCents: 400 }), /never change/);
    await expectRefused(setPatronage(id, { status: "failed" }), /cannot go from paid to failed/);
    await setPatronage(id, { status: "reversed" });
    await expectRefused(setPatronage(id, { status: "paid" }), /cannot go from reversed to paid/);
  });

  test("never deleted, by the app or the owner", async () => {
    const member = await newUser();
    const periodId = await approvedPeriod(member, 300);
    const [row] = await app
      .insert(s.patronagePayouts)
      .values(patronageRow(periodId, member, 300))
      .returning({ id: s.patronagePayouts.id });
    expect(
      await expectRefused(
        app.delete(s.patronagePayouts).where(eq(s.patronagePayouts.id, row!.id)),
        /permission denied/,
      ),
    ).toBe("42501");
    await expectRefused(owner.delete(s.patronagePayouts).where(eq(s.patronagePayouts.id, row!.id)), /never deleted/);
    await expectRefused(owner.execute(sql`truncate patronage_payouts cascade`), /append-only/);
  });

  const newRow = async (periodId: string, member: string, amountCents: number) => {
    const id = uuidv7();
    await app
      .insert(s.patronagePayouts)
      .values({ ...patronageRow(periodId, member, amountCents), id, idempotencyKey: `patronage-payout:${id}` });
    return id;
  };
  const pay = (id: string) => setPatronage(id, { status: "paid", providerRef: `REF-${id}`, paidAt: new Date() });

  test("a failed payout is followed by a new row, which can be paid", async () => {
    const member = await newUser();
    const periodId = await approvedPeriod(member, 600);
    const first = await newRow(periodId, member, 600);
    await setPatronage(first, { status: "failed" });
    // A failed row never gains a reference or a paid time.
    await expectRefused(setPatronage(first, { providerRef: "late" }), /only while it is pending/);
    await expectRefused(setPatronage(first, { paidAt: new Date() }), /only while it is pending/);
    const second = await newRow(periodId, member, 600);
    await pay(second);
  });

  test("one open row at a time; after a reversal the member can be paid again", async () => {
    const member = await newUser();
    const periodId = await approvedPeriod(member, 400);
    const first = await newRow(periodId, member, 400);
    await pay(first);
    // A pending or paid row holds the slot.
    expect(await expectRefused(newRow(periodId, member, 400), /patronage_payouts_period_user_uq/)).toBe("23505");
    await setPatronage(first, { status: "reversed" });
    const second = await newRow(periodId, member, 400);
    await pay(second);
    expect(await expectRefused(newRow(periodId, member, 1), /patronage_payouts_period_user_uq/)).toBe("23505");
  });
});

// 4. Governance and seed --------------------------------------------------------------------

describe("shares.cardPayments", () => {
  test("is seeded off, as an ordinary setting, and keeps its shape", async () => {
    const [row] = await app
      .select()
      .from(s.governanceSettings)
      .where(eq(s.governanceSettings.key, "shares.cardPayments"));
    expect(row?.value).toEqual({ enabled: false });
    expect(row?.protected).toBe(false);
    // Updates only happen through applied proposals; the check is BEFORE INSERT OR UPDATE, so
    // inserts exercise it (a valid value reaches the unique key, past the check).
    const insert = (value: unknown) =>
      owner
        .insert(s.governanceSettings)
        .values({ key: "shares.cardPayments", description: "x", protected: false, value });
    expect(await expectRefused(insert({ enabled: true }), /duplicate key/)).toBe("23505");
    for (const value of [{ enabled: "yes" }, {}, { enabled: null }])
      expect(await expectRefused(insert(value), /needs a boolean enabled/)).toBe("23514");
  });
});
