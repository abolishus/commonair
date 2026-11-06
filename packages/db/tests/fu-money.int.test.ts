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
let liability = "";

/** A balanced two-line posting on a member share, in its own transaction. */
function post(key: string, kind: string, shareId: string | null, debit: string, credit: string): Promise<string> {
  return app.transaction(async (tx) => {
    const [txn] = await tx
      .insert(s.ledgerTransactions)
      .values({
        kind,
        description: kind,
        occurredAt: new Date(),
        idempotencyKey: key,
        refType: shareId ? "membership_share" : null,
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

/** A held card share: payment succeeded, purchase posted. */
async function heldShare(): Promise<{ shareId: string; paymentId: string; userId: string }> {
  const userId = await makeUser();
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
  await app.update(s.payments).set({ status: "succeeded", succeededAt: new Date() }).where(eq(s.payments.id, pay!.id));
  await post(`share-purchase:${share!.id}`, "share_purchase", share!.id, cash, liability);
  await setShare(share!.id, { status: "held", purchasedAt: new Date() });
  return { shareId: share!.id, paymentId: pay!.id, userId };
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
    liability = await account("liability:member-share:fu", "liability");
  });

  test("a share chargeback needs a chargeback of the share's own payment and the share", async () => {
    const a = await heldShare();
    const b = await heldShare();
    const other = await chargebackRow(b.paymentId);
    await expectPgError(
      post(`share-chargeback:${other}`, "share_chargeback", a.shareId, liability, cash),
      /share's own payment/,
    );
    await expectPgError(post(`share-chargeback:${uuidv7()}`, "share_chargeback", null, liability, cash), /references/);
    await expectPgError(post(`share-chargeback:not-a-uuid`, "share_chargeback", a.shareId, liability, cash), /keyed/);
    const mine = await chargebackRow(a.paymentId);
    await post(`share-chargeback:${mine}`, "share_chargeback", a.shareId, liability, cash);
    // A second dispute cannot claw back a share already charged back.
    const second = await chargebackRow(a.paymentId);
    await expectPgError(
      post(`share-chargeback:${second}`, "share_chargeback", a.shareId, liability, cash),
      /already charged back/,
    );
  });

  test("a reversal needs its dispute's chargeback; then the share may be charged back again", async () => {
    const a = await heldShare();
    const d = await chargebackRow(a.paymentId);
    await expectPgError(
      post(`share-chargeback-reversal:${d}`, "share_chargeback_reversal", a.shareId, cash, liability),
      /needs that dispute's chargeback/,
    );
    await post(`share-chargeback:${d}`, "share_chargeback", a.shareId, liability, cash);
    await post(`share-chargeback-reversal:${d}`, "share_chargeback_reversal", a.shareId, cash, liability);
    // Won and restored: a paid share is cancelled only by a standing chargeback.
    await expectPgError(setShare(a.shareId, { status: "cancelled" }), /cancelled only by a chargeback/);
    const again = await chargebackRow(a.paymentId);
    await post(`share-chargeback:${again}`, "share_chargeback", a.shareId, liability, cash);
  });

  test("a charged-back share is never refunded; a lost dispute cancels it and frees the slot", async () => {
    const a = await heldShare();
    const d = await chargebackRow(a.paymentId);
    await post(`share-chargeback:${d}`, "share_chargeback", a.shareId, liability, cash);
    await setShare(a.shareId, { status: "refund_pending" });
    // The ledger refuses the second payback itself, whatever the posting references.
    for (const [key, ref] of [
      [`share-refund:${a.shareId}`, a.shareId],
      [`share-refund:${a.shareId}`, null],
      [`share-refund:${a.shareId.toUpperCase()}`, null],
    ] as const)
      await expectPgError(post(key, "share_refund", ref, liability, cash), /charged-back share is never refunded/);
    await expectPgError(setShare(a.shareId, { status: "refunded", refundedAt: new Date() }), /refund is posted/);
    await setShare(a.shareId, { status: "cancelled" });
    // A lost dispute is final: its chargeback is never reversed on the cancelled share.
    await expectPgError(
      post(`share-chargeback-reversal:${d}`, "share_chargeback_reversal", a.shareId, cash, liability),
      /chargeback is reversed/,
    );
    // No longer open: the member may buy a share again.
    await app.insert(s.membershipShares).values({ userId: a.userId, amountCents: 500, currency: "usd" });
    // A cancelled share is never charged back (nor reopened).
    const late = await chargebackRow(a.paymentId);
    await expectPgError(
      post(`share-chargeback:${late}`, "share_chargeback", a.shareId, liability, cash),
      /only a held or refund_pending share/,
    );
    await expectPgError(setShare(a.shareId, { status: "held" }), /cannot go from cancelled to held/);
  });

  test("a share whose refund is posted is never charged back", async () => {
    const a = await heldShare();
    await setShare(a.shareId, { status: "refund_pending" });
    await post(`share-refund:${a.shareId}`, "share_refund", a.shareId, liability, cash);
    const d = await chargebackRow(a.paymentId);
    await expectPgError(
      post(`share-chargeback:${d}`, "share_chargeback", a.shareId, liability, cash),
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
        { transactionId: txn!.id, accountId: liability, amountCents: 500, currency: "usd" },
        { transactionId: txn!.id, accountId: cash, amountCents: -500, currency: "usd" },
      ]);
      await tx
        .update(s.membershipShares)
        .set({ status: "refunded", refundedAt: new Date() })
        .where(eq(s.membershipShares.id, a.shareId));
    });
    await holding;
    // Settled at once (handled), so its rejection is never unhandled while the refund commits.
    const chargeback = post(`share-chargeback:${d}`, "share_chargeback", a.shareId, liability, cash).then(
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
    await post(`share-refund:${a.shareId}`, "share_refund", a.shareId, liability, cash);
    await setShare(a.shareId, { status: "refunded", refundedAt: new Date() });
    await expectPgError(
      app.delete(s.membershipShares).where(eq(s.membershipShares.id, a.shareId)),
      /never deleted|permission denied/,
    );
  });
});
