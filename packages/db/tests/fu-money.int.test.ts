// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Card share chargebacks (0050, follow-ups unit money), as the least-privilege application role:
 * a `share_chargeback` posting needs a chargeback of the share's own payment, a reversal needs
 * that chargeback, a charged-back share is never refunded, and a paid share is cancelled only by a
 * chargeback. 0021's share rules still hold (re-asserted where 0050 redefines the guard).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test, vi } from "vite-plus/test";

vi.setConfig({ hookTimeout: 60_000 });
import * as s from "../src/schema/index.ts";
import { createTestDatabase, type TestDatabase } from "../src/testing.ts";
import { uuidv7 } from "../src/ids.ts";
import type { Database } from "../src/client.ts";

let t: TestDatabase;
let app: Database;

async function expectPgError(p: PromiseLike<unknown>, pattern: RegExp): Promise<void> {
  const err = await Promise.resolve(p).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err, "expected the database to reject").toBeInstanceOf(Error);
  const e = err as Error & { cause?: Error };
  expect(e.cause?.message ?? e.message).toMatch(pattern);
}

beforeAll(async () => {
  t = await createTestDatabase();
  app = t.app.db;
});
afterAll(async () => {
  await t?.drop();
});

let seq = 0;
async function makeUser(): Promise<string> {
  const name = `fumoney${++seq}`;
  const [u] = await app
    .insert(s.users)
    .values({ name, email: `${name}@example.test`, username: name })
    .returning({ id: s.users.id });
  return u!.id;
}

async function account(code: string, type: "asset" | "liability" | "expense"): Promise<string> {
  const [a] = await app
    .insert(s.ledgerAccounts)
    .values({ code: `${code}@usd`, type, name: code, currency: "usd" })
    .onConflictDoNothing()
    .returning({ id: s.ledgerAccounts.id });
  if (a) return a.id;
  const [b] = await app
    .select()
    .from(s.ledgerAccounts)
    .where(eq(s.ledgerAccounts.code, `${code}@usd`));
  return b!.id;
}

let cash = "";

/** A balanced two-line posting on a member share, in its own transaction. */
function post(
  key: string,
  kind: string,
  shareId: string | null,
  debit: string,
  credit: string,
  refType: string | null = shareId ? "membership_share" : null,
): Promise<string> {
  return app.transaction(async (tx) => {
    const [txn] = await tx
      .insert(s.ledgerTransactions)
      .values({
        kind,
        description: kind,
        occurredAt: new Date(),
        idempotencyKey: key,
        refType,
        refId: shareId,
      })
      .returning({ id: s.ledgerTransactions.id });
    await tx.insert(s.ledgerEntries).values([
      { transactionId: txn!.id, accountId: debit, amountCents: 500, currency: "usd" },
      { transactionId: txn!.id, accountId: credit, amountCents: -500, currency: "usd" },
    ]);
    return txn!.id;
  });
}

const setShare = (id: string, v: Partial<typeof s.membershipShares.$inferInsert>) =>
  app.update(s.membershipShares).set(v).where(eq(s.membershipShares.id, id));

/** A pending card share with its payment still pending; `liability` is the owner's member share. */
async function pendingShare(): Promise<{ shareId: string; paymentId: string; userId: string; liability: string }> {
  const userId = await makeUser();
  const liability = await account(`liability:member-share:${userId}`, "liability");
  const [pay] = await app
    .insert(s.payments)
    .values({
      provider: "stripe",
      providerRef: `pi_${uuidv7().replace(/-/g, "")}`,
      kind: "membership_share",
      userId,
      amountCents: 500,
      currency: "usd",
    })
    .returning({ id: s.payments.id });
  const [share] = await app
    .insert(s.membershipShares)
    .values({ userId, amountCents: 500, currency: "usd", paymentId: pay!.id })
    .returning({ id: s.membershipShares.id });
  return { shareId: share!.id, paymentId: pay!.id, userId, liability };
}

/** A held card share: payment succeeded, purchase posted. */
async function heldShare(): Promise<{ shareId: string; paymentId: string; userId: string; liability: string }> {
  const p = await pendingShare();
  await app
    .update(s.payments)
    .set({ status: "succeeded", succeededAt: new Date() })
    .where(eq(s.payments.id, p.paymentId));
  await post(`share-purchase:${p.shareId}`, "share_purchase", p.shareId, cash, p.liability);
  await setShare(p.shareId, { status: "held", purchasedAt: new Date() });
  return p;
}

async function chargebackRow(paymentId: string): Promise<string> {
  const [d] = await app
    .insert(s.disputes)
    .values({ paymentId, kind: "chargeback", status: "open", amountCents: 500, providerRef: `dp_${seq++}` })
    .returning({ id: s.disputes.id });
  return d!.id;
}

describe("share chargebacks (0050)", () => {
  beforeAll(async () => {
    cash = await account("asset:cash:stripe", "asset");
  });

  test("a share chargeback needs a chargeback of the share's own payment and the share", async () => {
    const a = await heldShare();
    const b = await heldShare();
    const other = await chargebackRow(b.paymentId);
    await expectPgError(
      post(`share-chargeback:${other}`, "share_chargeback", a.shareId, a.liability, cash),
      /share's own payment/,
    );
    await expectPgError(
      post(`share-chargeback:${uuidv7()}`, "share_chargeback", null, a.liability, cash),
      /references/,
    );
    await expectPgError(post(`share-chargeback:not-a-uuid`, "share_chargeback", a.shareId, a.liability, cash), /keyed/);
    const mine = await chargebackRow(a.paymentId);
    await post(`share-chargeback:${mine}`, "share_chargeback", a.shareId, a.liability, cash);
    // A second dispute cannot claw back a share already charged back.
    const second = await chargebackRow(a.paymentId);
    await expectPgError(
      post(`share-chargeback:${second}`, "share_chargeback", a.shareId, a.liability, cash),
      /already charged back/,
    );
  });

  test("a reversal needs its dispute's chargeback; then the share may be charged back again", async () => {
    const a = await heldShare();
    const d = await chargebackRow(a.paymentId);
    await expectPgError(
      post(`share-chargeback-reversal:${d}`, "share_chargeback_reversal", a.shareId, cash, a.liability),
      /needs that dispute's chargeback/,
    );
    await post(`share-chargeback:${d}`, "share_chargeback", a.shareId, a.liability, cash);
    await post(`share-chargeback-reversal:${d}`, "share_chargeback_reversal", a.shareId, cash, a.liability);
    // Won and restored: a paid share is cancelled only by a standing chargeback.
    await expectPgError(setShare(a.shareId, { status: "cancelled" }), /cancelled only by a chargeback/);
    const again = await chargebackRow(a.paymentId);
    await post(`share-chargeback:${again}`, "share_chargeback", a.shareId, a.liability, cash);
  });

  test("a charged-back share is never refunded; a lost dispute cancels it and frees the slot", async () => {
    const a = await heldShare();
    const d = await chargebackRow(a.paymentId);
    await post(`share-chargeback:${d}`, "share_chargeback", a.shareId, a.liability, cash);
    await setShare(a.shareId, { status: "refund_pending" });
    // The ledger refuses the second payback itself, whatever the posting references.
    for (const [key, ref] of [
      [`share-refund:${a.shareId}`, a.shareId],
      [`share-refund:${a.shareId}`, null],
    ] as const)
      await expectPgError(post(key, "share_refund", ref, a.liability, cash), /charged-back share is never refunded/);
    // 0052: any other spelling of the key is refused outright.
    await expectPgError(
      post(`share-refund:${a.shareId.toUpperCase()}`, "share_refund", null, a.liability, cash),
      /keyed share-refund/,
    );
    await expectPgError(setShare(a.shareId, { status: "refunded", refundedAt: new Date() }), /refund is posted/);
    await setShare(a.shareId, { status: "cancelled" });
    // A lost dispute is final: its chargeback is never reversed on the cancelled share.
    await expectPgError(
      post(`share-chargeback-reversal:${d}`, "share_chargeback_reversal", a.shareId, cash, a.liability),
      /chargeback is reversed/,
    );
    // No longer open: the member may buy a share again.
    await app.insert(s.membershipShares).values({ userId: a.userId, amountCents: 500, currency: "usd" });
    // A cancelled share is never charged back (nor reopened).
    const late = await chargebackRow(a.paymentId);
    await expectPgError(
      post(`share-chargeback:${late}`, "share_chargeback", a.shareId, a.liability, cash),
      /only a held or refund_pending share/,
    );
    await expectPgError(setShare(a.shareId, { status: "held" }), /cannot go from cancelled to held/);
  });

  test("a share whose refund is posted is never charged back", async () => {
    const a = await heldShare();
    await setShare(a.shareId, { status: "refund_pending" });
    await post(`share-refund:${a.shareId}`, "share_refund", a.shareId, a.liability, cash);
    const d = await chargebackRow(a.paymentId);
    await expectPgError(
      post(`share-chargeback:${d}`, "share_chargeback", a.shareId, a.liability, cash),
      /refunded share is never charged back/,
    );
  });

  test("a chargeback waiting on a concurrent refund sees the share refunded", async () => {
    const a = await heldShare();
    await setShare(a.shareId, { status: "refund_pending" });
    const d = await chargebackRow(a.paymentId);
    // The refund holds the share's row lock when the chargeback arrives; once it commits, the
    // chargeback must see `refunded`, not the `refund_pending` a read before the lock returned.
    let release = (): void => undefined;
    const gate = new Promise<void>((r) => (release = r));
    let locked = (): void => undefined;
    const holding = new Promise<void>((r) => (locked = r));
    const refund = app.transaction(async (tx) => {
      await tx.select().from(s.membershipShares).where(eq(s.membershipShares.id, a.shareId)).for("update");
      locked();
      await gate;
      const [txn] = await tx
        .insert(s.ledgerTransactions)
        .values({
          kind: "share_refund",
          description: "share_refund",
          occurredAt: new Date(),
          idempotencyKey: `share-refund:${a.shareId}`,
          refType: "membership_share",
          refId: a.shareId,
        })
        .returning({ id: s.ledgerTransactions.id });
      await tx.insert(s.ledgerEntries).values([
        { transactionId: txn!.id, accountId: a.liability, amountCents: 500, currency: "usd" },
        { transactionId: txn!.id, accountId: cash, amountCents: -500, currency: "usd" },
      ]);
      await tx
        .update(s.membershipShares)
        .set({ status: "refunded", refundedAt: new Date() })
        .where(eq(s.membershipShares.id, a.shareId));
    });
    await holding;
    // Settled at once (handled), so its rejection is never unhandled while the refund commits.
    const chargeback = post(`share-chargeback:${d}`, "share_chargeback", a.shareId, a.liability, cash).then(
      () => ({ err: null as unknown }),
      (err: unknown) => ({ err }),
    );
    await new Promise((r) => setTimeout(r, 300));
    release();
    await refund;
    const { err } = await chargeback;
    await expectPgError(err ? Promise.reject(err as Error) : Promise.resolve(), /only a held or refund_pending share/);
  });

  test("0021's rules still hold under the redefined guard", async () => {
    const a = await heldShare();
    await expectPgError(setShare(a.shareId, { amountCents: 1 }), /never change/);
    await expectPgError(setShare(a.shareId, { status: "refunded", refundedAt: new Date() }), /held to refunded/);
    await setShare(a.shareId, { status: "refund_pending" });
    await expectPgError(setShare(a.shareId, { status: "refunded", refundedAt: new Date() }), /refund is posted/);
    await post(`share-refund:${a.shareId}`, "share_refund", a.shareId, a.liability, cash);
    await setShare(a.shareId, { status: "refunded", refundedAt: new Date() });
    await expectPgError(
      app.delete(s.membershipShares).where(eq(s.membershipShares.id, a.shareId)),
      /never deleted|permission denied/,
    );
  });

  test("a won dispute on a refund_pending share restores it, and then the refund goes through", async () => {
    const a = await heldShare();
    const d = await chargebackRow(a.paymentId);
    await post(`share-chargeback:${d}`, "share_chargeback", a.shareId, a.liability, cash);
    // Frozen while charged back, but a member may still ask for the refund.
    await setShare(a.shareId, { status: "refund_pending" });
    await post(`share-chargeback-reversal:${d}`, "share_chargeback_reversal", a.shareId, cash, a.liability);
    await post(`share-refund:${a.shareId}`, "share_refund", a.shareId, a.liability, cash);
    await setShare(a.shareId, { status: "refunded", refundedAt: new Date() });
    await expectPgError(setShare(a.shareId, { status: "cancelled" }), /cannot go from refunded to cancelled/);
  });

  test("a lost dispute cancels a held share directly; a pending share is never charged back", async () => {
    const a = await heldShare();
    await expectPgError(setShare(a.shareId, { status: "cancelled" }), /cancelled only by a chargeback/);
    const d = await chargebackRow(a.paymentId);
    await post(`share-chargeback:${d}`, "share_chargeback", a.shareId, a.liability, cash);
    await setShare(a.shareId, { status: "cancelled" });
    const p = await pendingShare();
    const pd = await chargebackRow(p.paymentId);
    await expectPgError(
      post(`share-chargeback:${pd}`, "share_chargeback", p.shareId, p.liability, cash),
      /only a held or refund_pending share is charged back \(this one is pending\)/,
    );
  });

  test("a share starts pending, positive and in a currency, one open share per member", async () => {
    const userId = await makeUser();
    const insert = (v: Partial<typeof s.membershipShares.$inferInsert>) =>
      app.insert(s.membershipShares).values({ userId, amountCents: 500, currency: "usd", ...v });
    await expectPgError(insert({ status: "held" }), /starts pending/);
    await expectPgError(insert({ purchasedAt: new Date() }), /starts pending/);
    await expectPgError(insert({ refundedAt: new Date() }), /starts pending/);
    await expectPgError(insert({ amountCents: 0 }), /positive amount and a currency/);
    await expectPgError(insert({ amountCents: -1 }), /positive amount and a currency/);
    await expectPgError(insert({ currency: "USD" }), /positive amount and a currency/);
    await expectPgError(insert({ currency: "usdx" }), /positive amount and a currency/);
    await insert({});
    await expectPgError(insert({}), /already has an open share|duplicate key/);
    // refund_pending is still open (the unique index does not cover it; the trigger does).
    const a = await heldShare();
    await setShare(a.shareId, { status: "refund_pending" });
    await expectPgError(
      app.insert(s.membershipShares).values({ userId: a.userId, amountCents: 500, currency: "usd" }),
      /already has an open share/,
    );
  });

  test("pending -> held needs a succeeded share payment and the purchase posting", async () => {
    const p = await pendingShare();
    const hold = () => setShare(p.shareId, { status: "held", purchasedAt: new Date() });
    await expectPgError(hold(), /payment succeeded/);
    await app
      .update(s.payments)
      .set({ status: "succeeded", succeededAt: new Date() })
      .where(eq(s.payments.id, p.paymentId));
    await expectPgError(hold(), /purchase is posted/);
    await post(`share-purchase:${p.shareId}`, "share_purchase", p.shareId, cash, p.liability);
    await expectPgError(setShare(p.shareId, { status: "held" }), /payment succeeded and the purchase is posted/);
    await hold();
    await expectPgError(setShare(p.shareId, { status: "pending" }), /cannot go from held to pending/);
  });

  test("dates move only with their transition; a share's identity never changes", async () => {
    const a = await heldShare();
    // A no-op update is allowed; a date edit on its own is not.
    await setShare(a.shareId, { status: "held" });
    await expectPgError(
      setShare(a.shareId, { purchasedAt: new Date(0) }),
      /dates change only with a status transition/,
    );
    await expectPgError(setShare(a.shareId, { refundedAt: new Date() }), /dates change only with a status transition/);
    await expectPgError(
      setShare(a.shareId, { status: "refund_pending", purchasedAt: new Date(0) }),
      /purchased_at is set only when the share becomes held/,
    );
    await expectPgError(
      setShare(a.shareId, { status: "refund_pending", refundedAt: new Date() }),
      /refunded_at is set only when the share is refunded/,
    );
    const other = await makeUser();
    await expectPgError(setShare(a.shareId, { userId: other }), /never change/);
    await expectPgError(setShare(a.shareId, { currency: "eur" }), /never change/);
    await expectPgError(setShare(a.shareId, { paymentId: null }), /never change/);
    await expectPgError(setShare(a.shareId, { createdAt: new Date(0) }), /never change/);
    // An unpaid share is simply cancelled.
    const p = await pendingShare();
    await setShare(p.shareId, { status: "cancelled" });
  });
});
