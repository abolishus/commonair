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
import { type ListedRefund, type TransferStatus, loadStripe } from "@commonair/payments";
import {
  type OutcomeAdapter,
  decideRecheck,
  normalizeListed,
  outcomeUnknownSummary,
  setOutcomeAdapter,
  totalOf,
  transferMismatches,
  transferOfPayout,
} from "../src/money/outcome-unknown.ts";
import { REFUND_RESOLVE_GRACE_MS, paymentRefundStates } from "../src/money/stripe-refunds.ts";
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

describe("transfer checks (pure)", () => {
  const row = { id: "row-1", payoutId: "payout-1", amountCents: 4321, currency: "usd", destinationRef: "acct_1A" };
  const at = (over: Partial<TransferStatus> = {}): TransferStatus => ({
    providerRef: "tr_1",
    amountCents: 4321,
    currency: "usd",
    destination: "acct_1A",
    reversedCents: 0,
    metadata: { payout_id: "payout-1", transfer_id: "row-1" },
    ...over,
  });
  test("this payout's transfer matches; each field that differs is named", () => {
    expect(transferMismatches(row, at())).toEqual([]);
    // Stripe's currency case does not matter; a reversal since does not make it another transfer.
    expect(transferMismatches(row, at({ currency: "USD", reversedCents: 4321 }))).toEqual([]);
    expect(transferMismatches(row, at({ amountCents: 4320 }))).toEqual(["amount"]);
    expect(transferMismatches(row, at({ currency: "eur" }))).toEqual(["currency"]);
    expect(transferMismatches(row, at({ destination: "acct_2B" }))).toEqual(["destination"]);
    expect(transferMismatches(row, at({ metadata: {} }))).toEqual(["payout_id"]);
    expect(
      transferMismatches(
        row,
        at({ amountCents: 1, currency: "eur", destination: "acct_x", metadata: { payout_id: "p2" } }),
      ),
    ).toEqual(["amount", "currency", "destination", "payout_id"]);
  });
  test("a listed transfer is this payout's by either of its metadata ids", () => {
    expect(transferOfPayout(row, [])).toBeUndefined();
    expect(transferOfPayout(row, [at({ providerRef: "tr_o", metadata: { payout_id: "other" } })])).toBeUndefined();
    expect(transferOfPayout(row, [at({ providerRef: "tr_p", metadata: { payout_id: "payout-1" } })])?.providerRef).toBe(
      "tr_p",
    );
    expect(transferOfPayout(row, [at({ providerRef: "tr_t", metadata: { transfer_id: "row-1" } })])?.providerRef).toBe(
      "tr_t",
    );
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
  // Mutable: a test gives it transfer lookups and takes them away again (`withLookups`).
  const fake: OutcomeAdapter = {
    provider: "stripe",
    async listRefunds(pi) {
      if (listFails) throw new Error("timeout");
      return listedFor.get(pi) ?? [];
    },
  };
  async function withLookups<T>(lookups: Omit<OutcomeAdapter, "provider" | "listRefunds">, run: () => Promise<T>) {
    Object.assign(fake, lookups);
    try {
      return await run();
    } finally {
      delete fake.transferStatus;
      delete fake.listTransfers;
    }
  }

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
  async function unknownTransfer(
    payee: Account,
  ): Promise<{ transferId: string; payoutId: string; cents: number; destination: string; group: string }> {
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
    return {
      transferId: opened.transfer.id,
      payoutId: p.id,
      cents: p.amountCents,
      destination: opened.transfer.destinationRef,
      group: periodStart.toISOString(),
    };
  }

  beforeAll(async () => {
    api = await startApi();
    [treasurer, other, viewer] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api), signUpAndSignIn(api)]);
    for (const a of [treasurer, other])
      await owner().update(schema.users).set({ role: "treasurer" }).where(eq(schema.users.id, a.userId));
    setOutcomeAdapter(api.deps, fake);
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
      // This adapter cannot look transfers up: the treasurer's finding is recorded as theirs.
      expect(a?.details).toEqual({
        transferId: tr.transferId,
        payoutId: tr.payoutId,
        outcome: "sent",
        checkedAtProvider: false,
      });
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

    const refusedOf = (transferId: string) =>
      owner()
        .select()
        .from(schema.auditLog)
        .where(
          and(eq(schema.auditLog.action, "payout_transfer.settle_refused"), eq(schema.auditLog.subjectId, transferId)),
        );
    const stateOf = async (transferId: string) =>
      (await owner().select().from(schema.payoutTransfers).where(eq(schema.payoutTransfers.id, transferId)))[0];

    test("sent is checked at Stripe: this payout's transfer is recorded, checked", async () => {
      const payee = await signUpAndSignIn(api);
      const tr = await unknownTransfer(payee);
      const asked: string[] = [];
      const r = await withLookups(
        {
          async transferStatus(ref) {
            asked.push(ref);
            return {
              providerRef: ref,
              amountCents: tr.cents,
              currency: "usd",
              destination: tr.destination,
              reversedCents: 0,
              metadata: { payout_id: tr.payoutId, transfer_id: tr.transferId },
            };
          },
        },
        () => settle(treasurer, tr.transferId, { outcome: "sent", reference: "tr_1Checked" }),
      );
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ status: "created", providerRef: "tr_1Checked" });
      expect(asked).toEqual(["tr_1Checked"]);
      const [a] = await owner()
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.action, "payout_transfer.settle"), eq(schema.auditLog.subjectId, tr.transferId)));
      expect(a?.details).toMatchObject({ outcome: "sent", checkedAtProvider: true });
    });

    test("sent is refused (CONFLICT, audited) for another payout's transfer or one Stripe does not have", async () => {
      const payee = await signUpAndSignIn(api);
      const tr = await unknownTransfer(payee);
      const other: TransferStatus = {
        providerRef: "tr_1Other",
        amountCents: tr.cents + 1,
        currency: "usd",
        destination: "acct_1SomeoneElse",
        reversedCents: 0,
        metadata: { payout_id: uuidv7() },
      };
      const r = await withLookups({ transferStatus: async () => other }, () =>
        settle(treasurer, tr.transferId, { outcome: "sent", reference: "tr_1Other", note: "dashboard" }),
      );
      expect(r.status).toBe(409);
      const none = await withLookups({ transferStatus: async () => null }, () =>
        settle(treasurer, tr.transferId, { outcome: "sent", reference: "tr_1Missing" }),
      );
      expect(none.status).toBe(409);
      const refused = await refusedOf(tr.transferId);
      expect(
        refused.map((x) => x.details).toSorted((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
      ).toEqual(
        [
          {
            transferId: tr.transferId,
            payoutId: tr.payoutId,
            outcome: "sent",
            mismatch: ["amount", "destination", "payout_id"],
            providerRef: "tr_1Other",
          },
          {
            transferId: tr.transferId,
            payoutId: tr.payoutId,
            outcome: "sent",
            mismatch: ["not_found"],
            providerRef: "tr_1Missing",
          },
        ].toSorted((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y))),
      );
      expect(refused.every((x) => x.actorId === treasurer.userId)).toBe(true);
      expect(
        refused.find((x) => x.details && (x.details as { providerRef?: string }).providerRef === "tr_1Other")?.reason,
      ).toBe("dashboard");
      // Nothing was recorded: still pending, still unknown.
      expect(await stateOf(tr.transferId)).toMatchObject({ status: "pending", failureCode: "outcome_unknown" });
    });

    test("not sent is refused while Stripe lists a transfer of this payout in its run", async () => {
      const payee = await signUpAndSignIn(api);
      const tr = await unknownTransfer(payee);
      const queries: { destination: string; group: string }[] = [];
      const r = await withLookups(
        {
          async listTransfers(q): Promise<TransferStatus[]> {
            queries.push(q);
            return [
              {
                providerRef: "tr_1Elsewhere",
                amountCents: 5,
                currency: "usd",
                destination: tr.destination,
                reversedCents: 0,
                metadata: { payout_id: uuidv7() },
              },
              {
                providerRef: "tr_1Exists",
                amountCents: tr.cents,
                currency: "usd",
                destination: tr.destination,
                reversedCents: 0,
                metadata: { payout_id: tr.payoutId, transfer_id: tr.transferId },
              },
            ];
          },
        },
        () => settle(treasurer, tr.transferId, { outcome: "not_sent" }),
      );
      expect(r.status).toBe(409);
      expect(queries).toEqual([{ destination: tr.destination, group: tr.group }]);
      const [refused] = await refusedOf(tr.transferId);
      expect(refused?.details).toEqual({
        transferId: tr.transferId,
        payoutId: tr.payoutId,
        outcome: "not_sent",
        mismatch: ["exists"],
        providerRef: "tr_1Exists",
      });
      expect(await stateOf(tr.transferId)).toMatchObject({ status: "pending" });
      // Stripe lists only other payouts' transfers: settled as not sent, checked.
      const ok = await withLookups({ listTransfers: async () => [] }, () =>
        settle(treasurer, tr.transferId, { outcome: "not_sent" }),
      );
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ status: "failed", failureCode: "settled_unsent" });
    });

    test("Stripe not answering refuses with PRECONDITION_FAILED and writes nothing", async () => {
      const payee = await signUpAndSignIn(api);
      const tr = await unknownTransfer(payee);
      const down = () => Promise.reject(new Error("timeout"));
      const sent = await withLookups({ transferStatus: down }, () =>
        settle(treasurer, tr.transferId, { outcome: "sent", reference: "tr_1Down" }),
      );
      const unsent = await withLookups({ listTransfers: down }, () =>
        settle(treasurer, tr.transferId, { outcome: "not_sent" }),
      );
      for (const r of [sent, unsent]) {
        expect(r.status).toBe(412);
        expect(r.body.data).toEqual({ requirement: "payment_provider" });
      }
      expect(await refusedOf(tr.transferId)).toEqual([]);
      expect(await stateOf(tr.transferId)).toMatchObject({ status: "pending", failureCode: "outcome_unknown" });
    });

    test("an instance whose adapter is not the transfer's provider records the treasurer's word", async () => {
      const payee = await signUpAndSignIn(api);
      const tr = await unknownTransfer(payee);
      setOutcomeAdapter(api.deps, { provider: "manual" });
      try {
        const r = await settle(treasurer, tr.transferId, { outcome: "not_sent" });
        expect(r.status).toBe(200);
      } finally {
        setOutcomeAdapter(api.deps, fake);
      }
      const [a] = await owner()
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.action, "payout_transfer.settle"), eq(schema.auditLog.subjectId, tr.transferId)));
      expect(a?.details).toMatchObject({ outcome: "not_sent", checkedAtProvider: false });
    });

    test("against stripe-mock: its fixture transfer is not this payout's (refused); it lists none of ours", async () => {
      const base = process.env.STRIPE_MOCK_URL ?? "http://127.0.0.1:12111";
      const reachable = await fetch(`${base}/v1/customers`, {
        headers: { authorization: "Bearer sk_test_123" },
        signal: AbortSignal.timeout(1_000),
      }).then(
        (res) => res.ok,
        () => false,
      );
      if (!reachable && process.env.CI) throw new Error(`stripe-mock is not reachable at ${base} (CI is set)`);
      if (!reachable) return;
      const payee = await signUpAndSignIn(api);
      const tr = await unknownTransfer(payee);
      const { stripeAdapter } = await loadStripe();
      setOutcomeAdapter(api.deps, stripeAdapter({ client: { secretKey: "sk_test_123", apiBase: base, retries: 0 } }));
      try {
        // stripe-mock answers every id with its fixture: another account, amount and no metadata.
        const sent = await settle(treasurer, tr.transferId, { outcome: "sent", reference: "tr_1MockFixture" });
        expect(sent.status).toBe(409);
        const [refused] = await refusedOf(tr.transferId);
        expect(refused?.details).toMatchObject({ mismatch: expect.arrayContaining(["payout_id"]) });
        const unsent = await settle(treasurer, tr.transferId, { outcome: "not_sent" });
        expect(unsent.status).toBe(200);
        expect(unsent.body).toMatchObject({ status: "failed", failureCode: "settled_unsent" });
      } finally {
        setOutcomeAdapter(api.deps, fake);
      }
    });
  });

  describe("refund request list and resolve edges", () => {
    type Page = { items: { id: string; state: string }[]; nextCursor: string | null };
    const listOf = (state: string) =>
      treasurer.client.call<Page>("GET", `/api/treasurer/refund-requests?state=${state}&limit=100`);
    const resolve = (requestId: string) =>
      treasurer.client.call<Err>("POST", `/api/treasurer/refund-requests/${requestId}/resolve`, { outcome: "failed" });

    test("an unknown request past the 24 h TTL is listed as unknown, not as outstanding", async () => {
      const old = await unknownRequest(612, 25 * 60 * 60 * 1000);
      const fresh = await unknownRequest(613);
      const ids = async (state: string) => (await listOf(state)).body.items.map((i) => i.id);
      expect(await ids("unknown")).toEqual(expect.arrayContaining([old.requestId, fresh.requestId]));
      const outstanding = await ids("outstanding");
      expect(outstanding).toContain(fresh.requestId);
      expect(outstanding).not.toContain(old.requestId);
    });

    test("resolve refuses an unknown id, a settled request and one the provider answered", async () => {
      expect((await resolve(uuidv7())).status).toBe(404);
      const settled = await unknownRequest(614);
      expect((await resolve(settled.requestId)).status).toBe(200);
      expect((await resolve(settled.requestId)).status).toBe(409);
      // Stripe answered (a submitted marker with its refund id): the refund's event settles it.
      const answered = await unknownRequest(615);
      await owner()
        .insert(schema.auditLog)
        .values({
          actorType: "system",
          action: "payment.refund_submitted",
          subjectType: "payment",
          subjectId: answered.paymentId,
          reason: "",
          details: { requestId: answered.requestId, refundRef: "re_answered" },
        });
      expect((await resolve(answered.requestId)).status).toBe(409);
    });

    test("recheck of a payment another provider took is unavailable and changes nothing", async () => {
      const u = await unknownRequest(616);
      await owner()
        .update(schema.payments)
        .set({ provider: "manual", providerRef: "CA-RECHECK1" })
        .where(eq(schema.payments.id, u.paymentId));
      const r = await recheck(treasurer, u.requestId);
      expect(r.body).toMatchObject({ result: "unavailable", request: { state: "unknown" } });
    });
  });

  test("the summary's batched refund states equal each payment's own (the N+1 it replaced)", async () => {
    // A spread of states: unknown, released by a failed marker, resolved by hand, settled by a
    // posting of its amount, a payment with one unknown and one released request, and an unknown
    // marker without a request id (never a request).
    const a = await unknownRequest(111);
    const b = await unknownRequest(222);
    const c = await unknownRequest(333);
    const d = await unknownRequest(444);
    const e = await unknownRequest(555);
    const marker = (paymentId: string, action: string, details: Record<string, unknown>) =>
      owner().insert(schema.auditLog).values({
        actorType: "admin",
        actorId: treasurer.userId,
        action,
        subjectType: "payment",
        subjectId: paymentId,
        reason: "",
        details,
      });
    await marker(b.paymentId, "payment.refund_request_failed", { requestId: b.requestId, reason: "rechecked_none" });
    await marker(c.paymentId, "payment.refund_resolved", { requestId: c.requestId });
    await owner().insert(schema.disputes).values({
      paymentId: d.paymentId,
      kind: "refund",
      providerRef: "re_posted_d",
      amountCents: 444,
      status: "closed",
    });
    // e: a second request on the same payment, released; the first stays unknown.
    const second = uuidv7();
    await marker(e.paymentId, "payment.refund_requested", { requestId: second, amountCents: 5 });
    await marker(e.paymentId, "payment.refund_outcome_unknown", { requestId: second, idempotencyKey: "k" });
    await marker(e.paymentId, "payment.refund_request_failed", { requestId: second });
    await marker(a.paymentId, "payment.refund_outcome_unknown", { idempotencyKey: "no-request" });
    const now = new Date();
    const s = await outcomeUnknownSummary(owner(), now);
    // The old path: every payment ever marked, one paymentRefundStates each.
    const flagged = await owner()
      .selectDistinct({ id: schema.auditLog.subjectId })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "payment.refund_outcome_unknown"));
    const rows: { cents: number; currency: string }[] = [];
    for (const f of flagged)
      for (const st of await paymentRefundStates(owner(), f.id, now))
        if (st.state === "unknown") rows.push({ cents: st.amountCents ?? 0, currency: "usd" });
    expect(s.refunds).toEqual(totalOf(rows));
    const unknownIds = new Set<string>();
    for (const x of [a, b, c, d, e])
      for (const st of await paymentRefundStates(owner(), x.paymentId, now))
        if (st.state === "unknown") unknownIds.add(x.paymentId);
    expect([...unknownIds].toSorted()).toEqual([a.paymentId, e.paymentId].toSorted());
  });
});
