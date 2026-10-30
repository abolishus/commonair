// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { accounts } from "../src/accounts.ts";
import { PaymentMetaV2, ReversalMetaV2 } from "../src/meta.ts";
import { type Posting, UnbalancedPostingError, validatePosting } from "../src/posting.ts";
import {
  DEFAULT_PLATFORM_CUT,
  InsufficientBalanceError,
  type PaymentReversalInput,
  PayoutBelowMinimumError,
  chargeback,
  holdRelease,
  holdReleaseDueAt,
  infrastructureCost,
  manualConfirmation,
  patronageAllocation,
  patronagePayout,
  paymentSucceeded,
  chargebackReversal,
  holdMemo,
  payoutCancel,
  payoutReserve,
  payoutSent,
  periodClose,
  refund,
  reversalSplit,
  sharePurchase,
  shareRefund,
  splitNet,
} from "../src/rules.ts";

const CREATOR = "01890000-0000-7000-8000-00000000c0de";
const PAYMENT = "01890000-0000-7000-8000-0000000000aa";
const AT = new Date("2026-03-15T12:00:00Z");

/** Deterministic PRNG so property tests are reproducible. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const int = (r: () => number, max: number) => Math.floor(r() * (max + 1));

function sumOf(p: Posting): number {
  return p.entries.reduce((s, e) => s + e.amountCents, 0);
}
function on(p: Posting, code: string): number {
  return 0 + onRaw(p, code);
}
function onRaw(p: Posting, code: string): number {
  return p.entries.filter((e) => e.code === code).reduce((s, e) => s + e.amountCents, 0);
}
function expectWellFormed(p: Posting): void {
  expect(sumOf(p)).toBe(0);
  expect(p.entries.length).toBeGreaterThanOrEqual(2);
  for (const e of p.entries) {
    expect(e.amountCents).not.toBe(0);
    expect(Number.isSafeInteger(e.amountCents)).toBe(true);
  }
  expect(() => validatePosting(p)).not.toThrow();
}

function pay(gross: number, tax: number, fee: number, cut = DEFAULT_PLATFORM_CUT) {
  return paymentSucceeded({
    paymentId: PAYMENT,
    paymentKind: "subscription",
    provider: "stripe",
    creatorUserId: CREATOR,
    grossCents: gross,
    taxCents: tax,
    feeCents: fee,
    currency: "usd",
    cut,
    cutHistoryId: null,
    occurredAt: AT,
  });
}

function reversalInput(over: Partial<PaymentReversalInput> = {}): PaymentReversalInput {
  return {
    disputeId: "01890000-0000-7000-8000-0000000000d1",
    paymentId: PAYMENT,
    provider: "stripe",
    creatorUserId: CREATOR,
    currency: "usd",
    occurredAt: AT,
    original: { grossCents: 1099, taxCents: 99 },
    cut: DEFAULT_PLATFORM_CUT,
    alreadyReversedCents: 0,
    amountCents: 1099,
    balances: { liabilityCents: 0, holdLots: [{ paymentId: PAYMENT, cents: 900 }] },
    ...over,
  };
}

describe("splitNet", () => {
  test("creator gets the floor, co-op the remainder", () => {
    expect(splitNet(1000, DEFAULT_PLATFORM_CUT)).toEqual({ creatorCents: 900, coopCents: 100 });
    expect(splitNet(999, DEFAULT_PLATFORM_CUT)).toEqual({ creatorCents: 899, coopCents: 100 });
    expect(splitNet(1, DEFAULT_PLATFORM_CUT)).toEqual({ creatorCents: 0, coopCents: 1 });
    expect(splitNet(0, DEFAULT_PLATFORM_CUT)).toEqual({ creatorCents: 0, coopCents: 0 });
    expect(splitNet(500, { streamerShare: 1, coopShare: 0 })).toEqual({ creatorCents: 500, coopCents: 0 });
  });

  test("rejects cuts that do not sum to one", () => {
    expect(() => splitNet(100, { streamerShare: 0.9, coopShare: 0.2 })).toThrow(RangeError);
    expect(() => splitNet(100, { streamerShare: 1.1, coopShare: -0.1 })).toThrow(RangeError);
  });
});

describe("paymentSucceeded", () => {
  test("worked example: $10.99 incl. $0.99 tax, $0.62 fee", () => {
    const p = pay(1099, 99, 62);
    expectWellFormed(p);
    expect(p.idempotencyKey).toBe(`payment:${PAYMENT}`);
    expect(on(p, accounts.cash("stripe"))).toBe(1099 - 62);
    expect(on(p, accounts.taxPayable())).toBe(-99);
    expect(on(p, accounts.creatorHold(CREATOR))).toBe(-900);
    expect(on(p, accounts.platformCut())).toBe(-100);
    expect(on(p, accounts.paymentFees())).toBe(62);
    expect(p.metadata).toMatchObject({ creatorUserId: CREATOR, revenueGrossCents: 1099, streamerShare: 0.9 });
  });

  test("zero tax and zero fee legs are omitted", () => {
    const p = pay(500, 0, 0);
    expectWellFormed(p);
    expect(p.entries.map((e) => e.code).sort()).toEqual(
      [accounts.cash("stripe"), accounts.creatorHold(CREATOR), accounts.platformCut()].sort(),
    );
  });

  test("manual payments settle into the provider receivable", () => {
    const p = paymentSucceeded({
      paymentId: PAYMENT,
      paymentKind: "tip",
      provider: "manual",
      settlement: "receivable",
      creatorUserId: CREATOR,
      grossCents: 2000,
      taxCents: 0,
      feeCents: 0,
      currency: "eur",
      cut: DEFAULT_PLATFORM_CUT,
      cutHistoryId: null,
      occurredAt: AT,
    });
    expectWellFormed(p);
    expect(on(p, accounts.providerReceivable("manual"))).toBe(2000);
    expect(p.description).toBe("Tip payment");
  });

  test("rejects invalid amounts", () => {
    expect(() => pay(0, 0, 0)).toThrow(RangeError);
    expect(() => pay(100, 101, 0)).toThrow(RangeError);
    expect(() => pay(100.5, 0, 0)).toThrow(RangeError);
    expect(() => pay(100, 0, -1)).toThrow(RangeError);
  });

  test("property: random amounts, cuts and tax always balance with an exact split", () => {
    const r = prng(42);
    for (let i = 0; i < 2000; i++) {
      const gross = 1 + int(r, 5_000_000);
      const tax = int(r, gross);
      const fee = int(r, gross);
      const streamerShare = int(r, 1000) / 1000;
      const cut = { streamerShare, coopShare: 1 - streamerShare };
      const p = pay(gross, tax, fee, cut);
      expectWellFormed(p);
      const creator = 0 - on(p, accounts.creatorHold(CREATOR));
      const coop = 0 - on(p, accounts.platformCut());
      expect(creator + coop).toBe(gross - tax);
      expect(creator).toBe(Number((BigInt(gross - tax) * BigInt(Math.round(streamerShare * 1e6))) / 1_000_000n));
    }
  });
});

describe("hold release", () => {
  test("moves hold to payable", () => {
    const p = holdRelease({
      paymentId: PAYMENT,
      creatorUserId: CREATOR,
      amountCents: 900,
      currency: "usd",
      occurredAt: AT,
    });
    expectWellFormed(p);
    expect(on(p, accounts.creatorHold(CREATOR))).toBe(900);
    expect(on(p, accounts.creator(CREATOR))).toBe(-900);
    expect(p.idempotencyKey).toBe(`hold-release:${PAYMENT}`);
    expect(p.entries.find((e) => e.code === accounts.creatorHold(CREATOR))?.memo).toBe(holdMemo(PAYMENT));
  });

  test("due date and amount bounds", () => {
    expect(holdReleaseDueAt(AT, 7).toISOString()).toBe("2026-03-22T12:00:00.000Z");
    expect(() => holdReleaseDueAt(AT, -1)).toThrow(RangeError);
    expect(() =>
      holdRelease({ paymentId: PAYMENT, creatorUserId: CREATOR, amountCents: 0, currency: "usd", occurredAt: AT }),
    ).toThrow(RangeError);
  });
});

describe("reversalSplit", () => {
  test("a full reversal returns exactly the original split", () => {
    const s = reversalSplit({ grossCents: 1099, taxCents: 99 }, DEFAULT_PLATFORM_CUT, 0, 1099);
    expect(s).toEqual({ taxCents: 99, creatorCents: 900, coopCents: 100 });
  });

  test("property: any sequence of partial reversals sums to the original split", () => {
    const r = prng(7);
    for (let i = 0; i < 1000; i++) {
      const gross = 1 + int(r, 100_000);
      const tax = int(r, gross);
      const streamerShare = int(r, 100) / 100;
      const cut = { streamerShare, coopShare: 1 - streamerShare };
      const original = pay(gross, tax, 0, cut);
      let done = 0;
      const total = { taxCents: 0, creatorCents: 0, coopCents: 0 };
      while (done < gross) {
        const amount = 1 + int(r, gross - done - 1);
        const s = reversalSplit({ grossCents: gross, taxCents: tax }, cut, done, amount);
        expect(s.taxCents).toBeGreaterThanOrEqual(0);
        expect(s.creatorCents).toBeGreaterThanOrEqual(0);
        expect(s.coopCents).toBeGreaterThanOrEqual(0);
        expect(s.taxCents + s.creatorCents + s.coopCents).toBe(amount);
        total.taxCents += s.taxCents;
        total.creatorCents += s.creatorCents;
        total.coopCents += s.coopCents;
        done += amount;
      }
      expect(total.taxCents).toBe(0 - on(original, accounts.taxPayable()));
      expect(total.creatorCents).toBe(0 - on(original, accounts.creatorHold(CREATOR)));
      expect(total.coopCents).toBe(0 - on(original, accounts.platformCut()));
    }
  });

  test("cannot reverse more than the gross", () => {
    expect(() => reversalSplit({ grossCents: 100, taxCents: 0 }, DEFAULT_PLATFORM_CUT, 60, 41)).toThrow(RangeError);
    expect(() => reversalSplit({ grossCents: 100, taxCents: 0 }, DEFAULT_PLATFORM_CUT, 0, 0)).toThrow(RangeError);
  });
});

const OTHER = "01890000-0000-7000-8000-0000000000bb";
const OLDEST = "01890000-0000-7000-8000-0000000000cc";
/** Hold entries by lot. */
function lots(p: Posting): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of p.entries)
    if (e.code === accounts.creatorHold(CREATOR)) out[e.memo ?? ""] = (out[e.memo ?? ""] ?? 0) + e.amountCents;
  return out;
}

describe("refund", () => {
  test("full refund within the hold reverses everything from this payment's own lot", () => {
    const p = refund(reversalInput());
    expectWellFormed(p);
    expect(on(p, accounts.cash("stripe"))).toBe(-1099);
    expect(on(p, accounts.taxPayable())).toBe(99);
    expect(lots(p)).toEqual({ [holdMemo(PAYMENT)]: 900 });
    expect(on(p, accounts.platformCut())).toBe(100);
    expect(on(p, accounts.creator(CREATOR))).toBe(0);
    expect(p.kind).toBe("refund");
    expect(p.metadata).toMatchObject({
      revenueGrossCents: -1099,
      provider: "stripe",
      settlement: "cash",
      receivableCents: 0,
    });
  });

  test("refund after release draws on released earnings", () => {
    const p = refund(reversalInput({ amountCents: 550, balances: { liabilityCents: 2000, holdLots: [] } }));
    expectWellFormed(p);
    const s = reversalSplit({ grossCents: 1099, taxCents: 99 }, DEFAULT_PLATFORM_CUT, 0, 550);
    expect(on(p, accounts.creator(CREATOR))).toBe(s.creatorCents);
    expect(on(p, accounts.platformCut())).toBe(s.coopCents);
    expect(on(p, accounts.taxPayable())).toBe(s.taxCents);
  });

  test("order: own lot, released earnings, other lots oldest first, then a receivable", () => {
    const p = refund(
      reversalInput({
        balances: {
          liabilityCents: 100,
          holdLots: [
            { paymentId: OLDEST, cents: 150 },
            { paymentId: PAYMENT, cents: 50 },
            { paymentId: OTHER, cents: 300 },
          ],
        },
      }),
    );
    expectWellFormed(p);
    // 900 = 50 own + 100 released + 150 oldest + 300 other + 300 receivable
    expect(lots(p)).toEqual({ [holdMemo(PAYMENT)]: 50, [holdMemo(OLDEST)]: 150, [holdMemo(OTHER)]: 300 });
    expect(on(p, accounts.creator(CREATOR))).toBe(100);
    expect(on(p, accounts.creatorReceivable(CREATOR))).toBe(300);
    expect(p.metadata.receivableCents).toBe(300);
  });

  test("property: random partial refunds balance and never over-draw a lot", () => {
    const r = prng(99);
    for (let i = 0; i < 1000; i++) {
      const gross = 1 + int(r, 200_000);
      const tax = int(r, gross);
      const already = int(r, gross - 1);
      const amount = 1 + int(r, gross - already - 1);
      const holdLots = [
        { paymentId: OLDEST, cents: int(r, 20_000) },
        { paymentId: PAYMENT, cents: int(r, 20_000) },
        { paymentId: OTHER, cents: int(r, 20_000) },
      ];
      const balances = { liabilityCents: int(r, 50_000), holdLots };
      const p = refund(
        reversalInput({
          original: { grossCents: gross, taxCents: tax },
          alreadyReversedCents: already,
          amountCents: amount,
          balances,
        }),
      );
      expectWellFormed(p);
      const drawn = lots(p);
      for (const l of holdLots) expect(drawn[holdMemo(l.paymentId)] ?? 0).toBeLessThanOrEqual(l.cents);
      expect(on(p, accounts.creator(CREATOR))).toBeLessThanOrEqual(balances.liabilityCents);
      expect(on(p, accounts.creatorReceivable(CREATOR))).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("chargeback", () => {
  test("claws back from released earnings, then lots (own first), then a receivable; records the fee", () => {
    const p = chargeback({
      ...reversalInput({
        balances: {
          liabilityCents: 300,
          holdLots: [
            { paymentId: OTHER, cents: 100 },
            { paymentId: PAYMENT, cents: 300 },
          ],
        },
      }),
      disputeFeeCents: 1500,
    });
    expectWellFormed(p);
    expect(on(p, accounts.creator(CREATOR))).toBe(300);
    expect(lots(p)).toEqual({ [holdMemo(PAYMENT)]: 300, [holdMemo(OTHER)]: 100 });
    expect(on(p, accounts.creatorReceivable(CREATOR))).toBe(200);
    expect(on(p, accounts.paymentFees())).toBe(1500);
    expect(on(p, accounts.cash("stripe"))).toBe(-1099 - 1500);
    expect(p.idempotencyKey).toMatch(/^chargeback:/);
  });

  test("with insufficient balance everything becomes a receivable", () => {
    const p = chargeback({ ...reversalInput({ balances: { liabilityCents: 0, holdLots: [] } }), disputeFeeCents: 0 });
    expectWellFormed(p);
    expect(on(p, accounts.creatorReceivable(CREATOR))).toBe(900);
    expect(on(p, accounts.paymentFees())).toBe(0);
  });

  test("negative balances are treated as nothing available", () => {
    const p = chargeback({
      ...reversalInput({ balances: { liabilityCents: -500, holdLots: [{ paymentId: OTHER, cents: 100 }] } }),
      disputeFeeCents: 0,
    });
    expectWellFormed(p);
    expect(on(p, accounts.creator(CREATOR))).toBe(0);
    expect(on(p, accounts.creatorHold(CREATOR))).toBe(100);
    expect(on(p, accounts.creatorReceivable(CREATOR))).toBe(800);
  });
});

describe("chargeback reversal", () => {
  const base = {
    disputeId: "01890000-0000-7000-8000-0000000000d1",
    paymentId: PAYMENT,
    creatorUserId: CREATOR,
    provider: "stripe",
    currency: "usd",
    occurredAt: AT,
    chargeback: { amountCents: 1099, taxCents: 99, creatorCents: 900, coopCents: 100 },
  };

  test("restores tax and cut, cancels the receivable first, credits the rest as released", () => {
    const p = chargebackReversal({ ...base, receivableCents: 600, feeRefundCents: 1500 });
    expectWellFormed(p);
    expect(on(p, accounts.cash("stripe"))).toBe(1099 + 1500);
    expect(on(p, accounts.taxPayable())).toBe(-99);
    expect(on(p, accounts.platformCut())).toBe(-100);
    expect(on(p, accounts.creatorReceivable(CREATOR))).toBe(-600);
    expect(on(p, accounts.creator(CREATOR))).toBe(-300);
    expect(on(p, accounts.paymentFees())).toBe(-1500);
    expect(on(p, accounts.creatorHold(CREATOR))).toBe(0);
    expect(p.metadata.revenueGrossCents).toBe(1099);
  });

  test("never cancels more receivable than the creator share", () => {
    const p = chargebackReversal({ ...base, receivableCents: 5000 });
    expect(on(p, accounts.creatorReceivable(CREATOR))).toBe(-900);
    expect(on(p, accounts.creator(CREATOR))).toBe(0);
  });

  test("rejects inconsistent components", () => {
    expect(() =>
      chargebackReversal({ ...base, chargeback: { ...base.chargeback, coopCents: 99 }, receivableCents: 0 }),
    ).toThrow(RangeError);
  });
});

describe("PaymentMeta v2 (ADR 0013 decision 2)", () => {
  const HISTORY = "01890000-0000-7000-8000-0000000000c7";

  test("a payment writes v2 with one owner share and its cut history id", () => {
    const meta = PaymentMetaV2.parse(
      paymentSucceeded({
        paymentId: PAYMENT,
        paymentKind: "tip",
        provider: "stripe",
        creatorUserId: CREATOR,
        grossCents: 1099,
        taxCents: 99,
        feeCents: 62,
        currency: "usd",
        cut: DEFAULT_PLATFORM_CUT,
        cutHistoryId: HISTORY,
        occurredAt: AT,
      }).metadata,
    );
    expect(meta).toMatchObject({ v: 2, cutHistoryId: HISTORY, splitVersionId: null, creatorCents: 900 });
    expect(meta.shares).toEqual([{ userId: CREATOR, role: "owner", bps: 10_000, creatorCents: 900 }]);
    expect(PaymentMetaV2.parse(pay(1099, 99, 62).metadata).cutHistoryId).toBeNull();
  });

  const invariant = (m: ReversalMetaV2) => {
    for (const s of m.shares) expect(s.fromOwnLotCents + s.ownerCoveredCents).toBe(-s.creatorCents);
    expect(m.shares.reduce((t, s) => t + s.creatorCents, 0)).toBe(m.creatorCents);
  };

  test("a partial refund splits its share between the own lot and the owner's other sources", () => {
    const meta = ReversalMetaV2.parse(
      refund(
        reversalInput({
          amountCents: 1000,
          balances: { liabilityCents: 500, holdLots: [{ paymentId: PAYMENT, cents: 300 }] },
        }),
      ).metadata,
    );
    expect(meta.v).toBe(2);
    expect(meta.shares).toHaveLength(1);
    expect(meta.shares[0]).toMatchObject({ userId: CREATOR, role: "owner", fromOwnLotCents: 300 });
    expect(meta.shares[0]?.ownerCoveredCents).toBe(-meta.creatorCents - 300);
    invariant(meta);
  });

  test("a chargeback takes released earnings first, so the own lot covers only the rest", () => {
    const meta = ReversalMetaV2.parse(
      chargeback({
        ...reversalInput({ balances: { liabilityCents: 500, holdLots: [{ paymentId: PAYMENT, cents: 900 }] } }),
        disputeFeeCents: 1500,
      }).metadata,
    );
    expect(meta).toMatchObject({ v: 2, creatorCents: -900, disputeFeeCents: 1500 });
    expect(meta.shares[0]).toMatchObject({ fromOwnLotCents: 400, ownerCoveredCents: 500 });
    invariant(meta);
  });

  test("a shortfall booked as a receivable counts as covered by the owner", () => {
    const meta = ReversalMetaV2.parse(
      refund(reversalInput({ balances: { liabilityCents: 0, holdLots: [] } })).metadata,
    );
    expect(meta.shares[0]).toMatchObject({ fromOwnLotCents: 0, ownerCoveredCents: 900 });
    expect(meta.receivableCents).toBe(900);
    invariant(meta);
  });

  test("a won chargeback writes v2 with one owner share restored outside the lot", () => {
    const meta = ReversalMetaV2.parse(
      chargebackReversal({
        disputeId: "01890000-0000-7000-8000-0000000000d1",
        paymentId: PAYMENT,
        creatorUserId: CREATOR,
        provider: "stripe",
        currency: "usd",
        occurredAt: AT,
        chargeback: { amountCents: 1099, taxCents: 99, creatorCents: 900, coopCents: 100 },
        receivableCents: 600,
      }).metadata,
    );
    expect(meta).toMatchObject({ v: 2, creatorCents: 900, feeRefundCents: 0 });
    expect(meta.shares).toEqual([
      { userId: CREATOR, role: "owner", creatorCents: 900, fromOwnLotCents: 0, ownerCoveredCents: -900 },
    ]);
    invariant(meta);
  });

  test("property: every refund keeps own lot + owner covered = the reversed creator share", () => {
    const r = prng(13);
    let checked = 0;
    for (let n = 0; n < 200; n++) {
      const gross = 1 + int(r, 50_000);
      const amount = 1 + int(r, gross - 1);
      const meta = ReversalMetaV2.parse(
        refund(
          reversalInput({
            original: { grossCents: gross, taxCents: int(r, gross) },
            amountCents: amount,
            balances: {
              liabilityCents: int(r, 20_000),
              holdLots: [
                { paymentId: "01890000-0000-7000-8000-0000000000ab", cents: int(r, 20_000) },
                { paymentId: PAYMENT, cents: int(r, 20_000) },
              ],
            },
          }),
        ).metadata,
      );
      invariant(meta);
      checked += 1;
    }
    expect(checked).toBe(200);
  });
});

describe("payouts", () => {
  const base = {
    payoutId: "01890000-0000-7000-8000-0000000000b1",
    userId: CREATOR,
    currency: "usd",
    occurredAt: AT,
    minimumCents: 2500,
  };

  test("reserve moves earnings to clearing; send moves clearing to cash", () => {
    const r = payoutReserve({ ...base, amountCents: 3000, balances: { liabilityCents: 3000, receivableCents: 0 } });
    expectWellFormed(r);
    expect(on(r, accounts.creator(CREATOR))).toBe(3000);
    expect(on(r, accounts.payoutClearing(CREATOR))).toBe(-3000);
    expect(r.kind).toBe("payout_reserve");
    const s = payoutSent({
      payoutId: base.payoutId,
      userId: CREATOR,
      provider: "stripe",
      amountCents: 3000,
      currency: "usd",
      occurredAt: AT,
    });
    expectWellFormed(s);
    expect(on(s, accounts.payoutClearing(CREATOR))).toBe(3000);
    expect(on(s, accounts.cash("stripe"))).toBe(-3000);
    expect(s.kind).toBe("payout");
  });

  test("reserve nets a clawback receivable; cancel restores it exactly", () => {
    const r = payoutReserve({ ...base, amountCents: 2600, balances: { liabilityCents: 3000, receivableCents: 400 } });
    expectWellFormed(r);
    expect(on(r, accounts.creator(CREATOR))).toBe(3000);
    expect(on(r, accounts.creatorReceivable(CREATOR))).toBe(-400);
    expect(on(r, accounts.payoutClearing(CREATOR))).toBe(-2600);
    const c = payoutCancel({
      payoutId: base.payoutId,
      userId: CREATOR,
      amountCents: 2600,
      receivableNettedCents: Number(r.metadata.receivableNettedCents),
      currency: "usd",
      occurredAt: AT,
    });
    expectWellFormed(c);
    for (const code of [
      accounts.creator(CREATOR),
      accounts.creatorReceivable(CREATOR),
      accounts.payoutClearing(CREATOR),
    ]) {
      expect(on(r, code) + on(c, code)).toBe(0);
    }
  });

  test("reserve refuses below the minimum unless closing the account", () => {
    const b = { liabilityCents: 2000, receivableCents: 0 };
    expect(() => payoutReserve({ ...base, amountCents: 2000, balances: b })).toThrow(PayoutBelowMinimumError);
    const p = payoutReserve({ ...base, amountCents: 2000, balances: b, closingAccount: true });
    expectWellFormed(p);
    expect(p.description).toMatch(/closed/);
  });

  test("reserve refuses more than is available", () => {
    expect(() =>
      payoutReserve({ ...base, amountCents: 3000, balances: { liabilityCents: 3000, receivableCents: 1 } }),
    ).toThrow(InsufficientBalanceError);
    expect(() =>
      payoutReserve({ ...base, amountCents: 0, balances: { liabilityCents: 3000, receivableCents: 0 } }),
    ).toThrow(RangeError);
  });
});

describe("period close", () => {
  const range = {
    periodStart: new Date("2026-01-01Z"),
    periodEnd: new Date("2026-02-01Z"),
    currency: "usd",
    occurredAt: AT,
  };
  test("moves revenue and expenses into retained surplus", () => {
    const p = periodClose({
      ...range,
      balances: [
        { code: accounts.platformCut(), rawCents: -10_000 },
        { code: accounts.paymentFees(), rawCents: 700 },
        { code: accounts.infrastructure("hosting"), rawCents: 2000 },
      ],
    });
    expectWellFormed(p);
    expect(on(p, accounts.platformCut())).toBe(10_000);
    expect(on(p, accounts.paymentFees())).toBe(-700);
    expect(on(p, accounts.retainedSurplus())).toBe(-7300);
    expect(p.metadata.surplusCents).toBe(7300);
  });

  test("a loss closes as a debit to retained surplus", () => {
    const p = periodClose({ ...range, balances: [{ code: accounts.infrastructure("hosting"), rawCents: 500 }] });
    expect(on(p, accounts.retainedSurplus())).toBe(500);
    expect(p.metadata.surplusCents).toBe(-500);
  });

  test("only revenue and expense accounts can be closed", () => {
    expect(() => periodClose({ ...range, balances: [{ code: accounts.cash("stripe"), rawCents: 5 }] })).toThrow(
      RangeError,
    );
    expect(() => periodClose({ ...range, periodEnd: range.periodStart, balances: [] })).toThrow(RangeError);
  });
});

describe("other rules", () => {
  const USER = CREATOR;
  test("membership share purchase and refund mirror each other", () => {
    const i = { shareId: PAYMENT, userId: USER, provider: "manual", amountCents: 500, currency: "usd", occurredAt: AT };
    const buy = sharePurchase(i);
    const back = shareRefund(i);
    expectWellFormed(buy);
    expectWellFormed(back);
    expect(on(buy, accounts.memberShare(USER))).toBe(-500);
    expect(on(back, accounts.memberShare(USER))).toBe(500);
    expect(buy.idempotencyKey).not.toBe(back.idempotencyKey);
  });

  test("infrastructure cost", () => {
    const p = infrastructureCost({
      infraCostId: PAYMENT,
      category: "bandwidth",
      provider: "manual",
      amountCents: 12_345,
      currency: "usd",
      occurredAt: AT,
    });
    expectWellFormed(p);
    expect(on(p, accounts.infrastructure("bandwidth"))).toBe(12_345);
  });

  test("patronage allocation debits retained surplus by the total and skips zero lines", () => {
    const other = "01890000-0000-7000-8000-000000000002";
    const third = "01890000-0000-7000-8000-000000000003";
    const p = patronageAllocation({
      periodId: PAYMENT,
      currency: "usd",
      occurredAt: AT,
      allocations: [
        { userId: USER, amountCents: 700 },
        { userId: other, amountCents: 300 },
        { userId: third, amountCents: 0 },
      ],
    });
    expectWellFormed(p);
    expect(on(p, accounts.retainedSurplus())).toBe(1000);
    expect(p.entries).toHaveLength(3);
    expect(() => patronageAllocation({ periodId: PAYMENT, currency: "usd", occurredAt: AT, allocations: [] })).toThrow(
      RangeError,
    );
  });

  test("patronage payout and manual confirmation", () => {
    const pp = patronagePayout({
      periodId: PAYMENT,
      userId: USER,
      provider: "manual",
      amountCents: 70,
      currency: "usd",
      occurredAt: AT,
    });
    expectWellFormed(pp);
    expect(on(pp, accounts.patronagePayable(USER))).toBe(70);
    const mc = manualConfirmation({ paymentId: PAYMENT, amountCents: 2000, currency: "usd", occurredAt: AT });
    expectWellFormed(mc);
    expect(on(mc, accounts.cash("manual"))).toBe(2000);
    expect(on(mc, accounts.providerReceivable("manual"))).toBe(-2000);
  });
});

describe("validatePosting", () => {
  const ok = pay(1000, 0, 0);
  test("rejects unbalanced, single-entry, zero and unknown entries", () => {
    expect(() =>
      validatePosting({
        ...ok,
        entries: [
          { code: accounts.platformCut(), amountCents: 5 },
          { code: accounts.cash("stripe"), amountCents: -4 },
        ],
      }),
    ).toThrow(UnbalancedPostingError);
    expect(() =>
      validatePosting({
        ...ok,
        entries: [
          { code: accounts.platformCut(), amountCents: 0 },
          { code: accounts.cash("stripe"), amountCents: 0 },
        ],
      }),
    ).toThrow(RangeError);
    expect(() => validatePosting({ ...ok, entries: [{ code: accounts.platformCut(), amountCents: 5 }] })).toThrow(
      UnbalancedPostingError,
    );
    expect(() =>
      validatePosting({
        ...ok,
        entries: [
          { code: "asset:mystery", amountCents: 5 },
          { code: accounts.cash("stripe"), amountCents: -5 },
        ],
      }),
    ).toThrow(RangeError);
    expect(() => validatePosting({ ...ok, currency: "US" })).toThrow(RangeError);
    expect(() => validatePosting({ ...ok, idempotencyKey: "" })).toThrow(RangeError);
  });
});
