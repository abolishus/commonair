// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Outcome unknown (follow-ups, unit money): the treasurer's summary of refunds, transfers and
 * patronage payouts whose Stripe outcome is unknown, re-checking a refund request at Stripe, and
 * settling a payout transfer by hand. The refund listing comes from an injected adapter
 * (stripe-mock lists one fixture for every PaymentIntent); the transfers are made with the
 * ledger's own payout functions, as M1-connect's worker leaves them.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema, uuidv7 } from "@commonair/db";
import {
  DEFAULT_PLATFORM_CUT,
  PAYOUT_TRANSFER_CODES,
  markPayoutTransferSending,
  markPayoutTransferUnsettled,
  openPayoutTransfer,
  paymentSucceeded,
  post,
  releaseDueHolds,
  runPayoutBatch,
  schedulePayoutTransfers,
} from "@commonair/ledger";
import type { ListedRefund } from "@commonair/payments";
import { decideRecheck, normalizeListed, setOutcomeAdapter, totalOf } from "../src/money/outcome-unknown.ts";
import { REFUND_RESOLVE_GRACE_MS } from "../src/money/stripe-refunds.ts";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;
type Total = { count: number; amounts: { cents: number; currency: string }[] };
type Summary = { refunds: Total; transfers: Total; patronagePayouts: Total };
type Recheck = { result: string; request: { id: string; state: string } };
type Transfer = { id: string; status: string; failureCode: string | null; providerRef: string | null };
interface Err {
  code: string;
  data?: Record<string, unknown>;
}

const DAY = 86_400_000;
const listed = (o: Partial<ListedRefund> & { id: string; amount: number }): ListedRefund => ({
  currency: "usd",
  status: "succeeded",
  metadata: {},
  ...o,
});

describe("pure rules", () => {
  const req = { amountCents: 500, currency: "usd", idempotencyKey: "refund-k-0-500" };
  const n = (r: ListedRefund) => normalizeListed(r);
  test("the keyed refund decides; otherwise an unclaimed one of the amount, live first", () => {
    expect(
      decideRecheck(
        req,
        [n(listed({ id: "re_1", amount: 500, metadata: { refund_key: req.idempotencyKey } }))],
        new Set(),
      ),
    ).toEqual({
      decision: "refunded",
      refundRef: "re_1",
    });
    expect(
      decideRecheck(
        req,
        [
          n(listed({ id: "re_f", amount: 500, status: "failed" })),
          n(listed({ id: "re_p", amount: 500, status: "pending" })),
        ],
        new Set(),
      ),
    ).toEqual({ decision: "pending", refundRef: "re_p" });
    expect(decideRecheck(req, [n(listed({ id: "re_c", amount: 500, status: "canceled" }))], new Set())).toEqual({
      decision: "failed",
      refundRef: "re_c",
    });
  });
  test("claimed or other-key refunds are not this request's; other amounts only are ambiguous; nothing is none", () => {
    expect(decideRecheck(req, [n(listed({ id: "re_x", amount: 500 }))], new Set(["re_x"]))).toEqual({
      decision: "none",
      refundRef: null,
    });
    expect(
      decideRecheck(req, [n(listed({ id: "re_o", amount: 500, metadata: { refund_key: "other" } }))], new Set()),
    ).toEqual({ decision: "none", refundRef: null });
    expect(decideRecheck(req, [n(listed({ id: "re_a", amount: 200 }))], new Set())).toEqual({
      decision: "ambiguous",
      refundRef: null,
    });
    expect(decideRecheck(req, [], new Set())).toEqual({ decision: "none", refundRef: null });
    // An unknown provider status counts as still pending, never as a failure.
    expect(n(listed({ id: "re_q", amount: 1, status: null })).status).toBe("pending");
  });
  test("totals per currency, in code order", () => {
    expect(totalOf([])).toEqual({ count: 0, amounts: [] });
    expect(
      totalOf([
        { cents: 5, currency: "usd" },
        { cents: 7, currency: "eur" },
        { cents: 1, currency: "usd" },
      ]),
    ).toEqual({
      count: 3,
      amounts: [
        { cents: 7, currency: "eur" },
        { cents: 6, currency: "usd" },
      ],
    });
  });
});

describe("outcome unknown", () => {
  let api: TestApi;
  let treasurer: Account;
  let other: Account;
  let viewer: Account;
  let years = 0;
  const owner = () => api.db.db;
  const app = () => api.db.app.db;
  const listedFor = new Map<string, ListedRefund[]>();
  let listFails = false;

  const summary = (as: Account) => as.client.call<Summary>("GET", "/api/treasurer/outcome-unknown");
  const recheck = (as: Account, requestId: string) =>
    as.client.call<Recheck & Err>("POST", `/api/treasurer/refund-requests/${requestId}/recheck`, {});
  const settle = (as: Account, transferId: string, body: Record<string, unknown>) =>
    as.client.call<Transfer & Err>("POST", `/api/treasurer/payout-transfers/${transferId}/settle`, body);

  /** A Stripe payment with a refund request whose provider call never answered, `ageMs` ago. */
  async function unknownRequest(amountCents: number, ageMs = REFUND_RESOLVE_GRACE_MS + 60_000) {
    const userId = (await signUpAndSignIn(api)).userId;
    const paymentId = uuidv7();
    const pi = `pi_${paymentId.replace(/-/g, "").slice(-16)}`;
    await owner().insert(schema.payments).values({
      id: paymentId,
      provider: "stripe",
      providerRef: pi,
      kind: "membership_share",
      status: "succeeded",
      userId,
      amountCents,
      currency: "usd",
      succeededAt: new Date(),
    });
    const requestId = uuidv7();
    const at = new Date(Date.now() - ageMs);
    const key = `refund-${paymentId}-0-${amountCents}`;
    await owner()
      .insert(schema.auditLog)
      .values([
        {
          actorType: "admin",
          actorId: treasurer.userId,
          action: "payment.refund_requested",
          subjectType: "payment",
          subjectId: paymentId,
          reason: "",
          details: { requestId, amountCents },
          createdAt: at,
        },
        {
          actorType: "system",
          actorId: null,
          action: "payment.refund_outcome_unknown",
          subjectType: "payment",
          subjectId: paymentId,
          reason: "",
          details: { requestId, idempotencyKey: key },
          createdAt: new Date(at.getTime() + 1_000),
        },
      ]);
    return { paymentId, pi, requestId, key };
  }

  /** A creator's scheduled Stripe payout whose transfer the worker left `outcome_unknown`. */
  async function unknownTransfer(payee: Account): Promise<{ transferId: string; payoutId: string; cents: number }> {
    years += 1;
    const cur = "usd";
    await app()
      .insert(schema.payoutAccounts)
      .values({
        userId: payee.userId,
        provider: "stripe",
        providerAccountId: `acct_${payee.userId.replace(/-/g, "").slice(-16)}`,
        payoutsEnabled: true,
      })
      .onConflictDoNothing();
    await post(
      app(),
      paymentSucceeded({
        paymentId: uuidv7(),
        paymentKind: "tip",
        provider: "stripe",
        creatorUserId: payee.userId,
        grossCents: 10_000,
        taxCents: 0,
        feeCents: 0,
        currency: cur,
        cut: DEFAULT_PLATFORM_CUT,
        cutHistoryId: null,
        occurredAt: new Date(Date.now() - 30 * DAY),
      }),
    );
    await releaseDueHolds(app(), { asOf: new Date(), holdDays: 7, currency: cur });
    const periodStart = new Date(Date.UTC(2090 + years, 0, 1));
    const periodEnd = new Date(Date.UTC(2090 + years, 1, 1));
    await runPayoutBatch(app(), { periodStart, periodEnd, currency: cur, minimumCents: 1_000 });
    const [p] = await app()
      .select()
      .from(schema.payouts)
      .where(and(eq(schema.payouts.userId, payee.userId), eq(schema.payouts.periodStart, periodStart)));
    if (!p) throw new Error("no payout");
    await schedulePayoutTransfers(app());
    const opened = await openPayoutTransfer(app(), { payoutId: p.id, at: new Date() });
    if (!opened.transfer) throw new Error(`no transfer: ${opened.reason}`);
    await markPayoutTransferSending(app(), { transferId: opened.transfer.id, at: new Date() });
    await markPayoutTransferUnsettled(app(), {
      transferId: opened.transfer.id,
      code: PAYOUT_TRANSFER_CODES.outcomeUnknown,
      at: new Date(),
    });
    return { transferId: opened.transfer.id, payoutId: p.id, cents: p.amountCents };
  }

  beforeAll(async () => {
    api = await startApi();
    [treasurer, other, viewer] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api), signUpAndSignIn(api)]);
    for (const a of [treasurer, other])
      await owner().update(schema.users).set({ role: "treasurer" }).where(eq(schema.users.id, a.userId));
    setOutcomeAdapter(api.deps, {
      provider: "stripe",
      async listRefunds(pi) {
        if (listFails) throw new Error("timeout");
        return listedFor.get(pi) ?? [];
      },
    });
  }, 180_000);
  afterAll(async () => {
    await api?.stop();
  });

  test("viewers are refused every procedure", async () => {
    expect((await summary(viewer)).status).toBe(403);
    expect((await recheck(viewer, uuidv7())).status).toBe(403);
    expect((await settle(viewer, uuidv7(), { outcome: "not_sent" })).status).toBe(403);
  });

  test("the summary counts what is unknown now, per kind and currency", async () => {
    const before = (await summary(treasurer)).body;
    expect(before).toEqual({
      refunds: { count: 0, amounts: [] },
      transfers: { count: 0, amounts: [] },
      patronagePayouts: { count: 0, amounts: [] },
    });
    await unknownRequest(700);
    await unknownRequest(300);
    const tr = await unknownTransfer(viewer);
    const s = (await summary(treasurer)).body;
    expect(s.refunds).toEqual({ count: 2, amounts: [{ cents: 1000, currency: "usd" }] });
    expect(s.transfers).toEqual({ count: 1, amounts: [{ cents: tr.cents, currency: "usd" }] });
    expect(s.patronagePayouts.count).toBe(0);
  });

  describe("recheck", () => {
    test("refused for an unknown id, a settled request, and inside the reconciler's 15 minutes", async () => {
      expect((await recheck(treasurer, uuidv7())).status).toBe(404);
      const fresh = await unknownRequest(100, 60_000);
      const r = await recheck(treasurer, fresh.requestId);
      expect(r.status).toBe(412);
      expect(r.body.data).toEqual({ requirement: "refund_reconciling" });
    });

    test("Stripe unreachable: unavailable, nothing written", async () => {
      const u = await unknownRequest(150);
      listFails = true;
      try {
        const r = await recheck(treasurer, u.requestId);
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ result: "unavailable", request: { id: u.requestId, state: "unknown" } });
      } finally {
        listFails = false;
      }
    });

    test("no refund at Stripe releases the request in the treasurer's name; a second recheck is refused", async () => {
      const u = await unknownRequest(250);
      const r = await recheck(treasurer, u.requestId);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ result: "none", request: { id: u.requestId, state: "resolved" } });
      const [m] = await owner()
        .select()
        .from(schema.auditLog)
        .where(
          and(eq(schema.auditLog.action, "payment.refund_request_failed"), eq(schema.auditLog.subjectId, u.paymentId)),
        );
      expect(m).toMatchObject({ actorType: "admin", actorId: treasurer.userId });
      expect(m?.details).toEqual({ requestId: u.requestId, reason: "rechecked_none" });
      expect((await recheck(treasurer, u.requestId)).status).toBe(409);
    });

    test("a refund Stripe has (by its key) is reported, never posted; a failed one releases with its id", async () => {
      const done = await unknownRequest(350);
      listedFor.set(done.pi, [listed({ id: "re_has", amount: 350, metadata: { refund_key: done.key } })]);
      const r = await recheck(treasurer, done.requestId);
      expect(r.body).toMatchObject({ result: "refunded", request: { state: "unknown" } });
      const posted = await owner().select().from(schema.disputes).where(eq(schema.disputes.paymentId, done.paymentId));
      expect(posted).toEqual([]);
      const failed = await unknownRequest(450);
      listedFor.set(failed.pi, [listed({ id: "re_bad", amount: 450, status: "failed" })]);
      const f = await recheck(treasurer, failed.requestId);
      expect(f.body).toMatchObject({ result: "failed", request: { state: "resolved" } });
      const [m] = await owner()
        .select()
        .from(schema.auditLog)
        .where(
          and(
            eq(schema.auditLog.action, "payment.refund_request_failed"),
            eq(schema.auditLog.subjectId, failed.paymentId),
          ),
        );
      expect(m?.details).toEqual({ requestId: failed.requestId, reason: "rechecked_failed", refundRef: "re_bad" });
    });

    test("refunds of other amounts only are ambiguous and left for the treasurer", async () => {
      const u = await unknownRequest(550);
      listedFor.set(u.pi, [listed({ id: "re_other", amount: 100 })]);
      expect((await recheck(treasurer, u.requestId)).body).toMatchObject({
        result: "ambiguous",
        request: { state: "unknown" },
      });
    });
  });

  describe("settle a transfer", () => {
    test("refused for the payee themself, a missing tr_ id, and a transfer that is not unknown", async () => {
      const own = await unknownTransfer(other);
      const self = await settle(other, own.transferId, { outcome: "not_sent" });
      expect(self.status).toBe(403);
      expect(self.body.data).toEqual({ reason: "second_approver" });
      expect((await settle(treasurer, own.transferId, { outcome: "sent" })).status).toBe(400);
      expect((await settle(treasurer, own.transferId, { outcome: "sent", reference: "BANK-1" })).status).toBe(400);
      expect((await settle(treasurer, uuidv7(), { outcome: "not_sent" })).status).toBe(404);
    });

    test("sent: the transfer is created with Stripe's id and the payout paid, audited", async () => {
      const payee = await signUpAndSignIn(api);
      const tr = await unknownTransfer(payee);
      const ref = `tr_${tr.transferId.replace(/-/g, "").slice(-14)}`;
      const r = await settle(treasurer, tr.transferId, { outcome: "sent", reference: ref, note: "seen in Stripe" });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: "created", providerRef: ref, failureCode: null });
      const [p] = await owner().select().from(schema.payouts).where(eq(schema.payouts.id, tr.payoutId));
      expect(p?.status).toBe("paid");
      const [a] = await owner()
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.action, "payout_transfer.settle"), eq(schema.auditLog.subjectId, tr.transferId)));
      expect(a).toMatchObject({ actorId: treasurer.userId, reason: "seen in Stripe" });
      expect(a?.details).toEqual({ transferId: tr.transferId, payoutId: tr.payoutId, outcome: "sent" });
      // Settled: a second attempt is refused.
      expect((await settle(other, tr.transferId, { outcome: "not_sent" })).status).toBe(409);
    });

    test("not sent: the transfer fails and the payout returns to the payable", async () => {
      const payee = await signUpAndSignIn(api);
      const tr = await unknownTransfer(payee);
      const r = await settle(treasurer, tr.transferId, { outcome: "not_sent" });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: "failed", failureCode: "settled_unsent" });
      const [p] = await owner().select().from(schema.payouts).where(eq(schema.payouts.id, tr.payoutId));
      expect(p?.status).not.toBe("paid");
      expect(p?.status).not.toBe("scheduled");
    });
  });
});
