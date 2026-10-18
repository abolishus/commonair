// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { accounts } from "../src/accounts.ts";
import { type Posting, UnbalancedPostingError, validatePosting } from "../src/posting.ts";
import {
  DEFAULT_PLATFORM_CUT,
  InsufficientBalanceError,
  type PaymentReversalInput,
  PayoutBelowMinimumError,
  chargeback,
  holdRelease,
  holdReleaseAmount,
  holdReleaseDueAt,
  infrastructureCost,
  manualConfirmation,
  patronageAllocation,
  patronagePayout,
  paymentSucceeded,
  payout,
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
    balances: { liabilityCents: 0, holdCents: 900, paymentHoldCents: 900 },
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
  });

  test("due date and amount bounds", () => {
    expect(holdReleaseDueAt(AT, 7).toISOString()).toBe("2026-03-22T12:00:00.000Z");
    expect(() => holdReleaseDueAt(AT, -1)).toThrow(RangeError);
    expect(holdReleaseAmount(900, 1000)).toBe(900);
    expect(holdReleaseAmount(900, 300)).toBe(300);
    expect(holdReleaseAmount(900, -50)).toBe(0);
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

describe("refund", () => {
  test("full refund within the hold reverses everything from this payment's hold", () => {
    const p = refund(reversalInput());
    expectWellFormed(p);
    expect(on(p, accounts.cash("stripe"))).toBe(-1099);
    expect(on(p, accounts.taxPayable())).toBe(99);
    expect(on(p, accounts.creatorHold(CREATOR))).toBe(900);
    expect(on(p, accounts.platformCut())).toBe(100);
    expect(on(p, accounts.creator(CREATOR))).toBe(0);
    expect(p.kind).toBe("refund");
    expect(p.metadata.revenueGrossCents).toBe(-1099);
  });

  test("refund after the cut and after release draws on released earnings", () => {
    const p = refund(
      reversalInput({ amountCents: 550, balances: { liabilityCents: 2000, holdCents: 0, paymentHoldCents: 0 } }),
    );
    expectWellFormed(p);
    const s = reversalSplit({ grossCents: 1099, taxCents: 99 }, DEFAULT_PLATFORM_CUT, 0, 550);
    expect(on(p, accounts.creator(CREATOR))).toBe(s.creatorCents);
    expect(on(p, accounts.platformCut())).toBe(s.coopCents);
    expect(on(p, accounts.taxPayable())).toBe(s.taxCents);
  });

  test("refund larger than every balance books a receivable", () => {
    const p = refund(reversalInput({ balances: { liabilityCents: 100, holdCents: 200, paymentHoldCents: 50 } }));
    expectWellFormed(p);
    expect(on(p, accounts.creatorHold(CREATOR))).toBe(200);
    expect(on(p, accounts.creator(CREATOR))).toBe(100);
    expect(on(p, accounts.creatorReceivable(CREATOR))).toBe(600);
  });

  test("property: random partial refunds balance and never over-draw a source", () => {
    const r = prng(99);
    for (let i = 0; i < 1000; i++) {
      const gross = 1 + int(r, 200_000);
      const tax = int(r, gross);
      const already = int(r, gross - 1);
      const amount = 1 + int(r, gross - already - 1);
      const balances = { liabilityCents: int(r, 50_000), holdCents: int(r, 50_000), paymentHoldCents: 0 };
      balances.paymentHoldCents = int(r, balances.holdCents);
      const p = refund(
        reversalInput({
          original: { grossCents: gross, taxCents: tax },
          alreadyReversedCents: already,
          amountCents: amount,
          balances,
        }),
      );
      expectWellFormed(p);
      expect(on(p, accounts.creatorHold(CREATOR))).toBeLessThanOrEqual(balances.holdCents);
      expect(on(p, accounts.creator(CREATOR))).toBeLessThanOrEqual(balances.liabilityCents);
      expect(on(p, accounts.creatorReceivable(CREATOR))).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("chargeback", () => {
  test("claws back from released earnings first, then hold, then a receivable; records the fee", () => {
    const p = chargeback({
      ...reversalInput({ balances: { liabilityCents: 300, holdCents: 400, paymentHoldCents: 400 } }),
      disputeFeeCents: 1500,
    });
    expectWellFormed(p);
    expect(on(p, accounts.creator(CREATOR))).toBe(300);
    expect(on(p, accounts.creatorHold(CREATOR))).toBe(400);
    expect(on(p, accounts.creatorReceivable(CREATOR))).toBe(200);
    expect(on(p, accounts.paymentFees())).toBe(1500);
    expect(on(p, accounts.cash("stripe"))).toBe(-1099 - 1500);
    expect(p.idempotencyKey).toMatch(/^chargeback:/);
  });

  test("with insufficient balance everything becomes a receivable", () => {
    const p = chargeback({
      ...reversalInput({ balances: { liabilityCents: 0, holdCents: 0, paymentHoldCents: 0 } }),
      disputeFeeCents: 0,
    });
    expectWellFormed(p);
    expect(on(p, accounts.creatorReceivable(CREATOR))).toBe(900);
    expect(on(p, accounts.paymentFees())).toBe(0);
  });

  test("negative balances are treated as nothing available", () => {
    const p = chargeback({
      ...reversalInput({ balances: { liabilityCents: -500, holdCents: 100, paymentHoldCents: 0 } }),
      disputeFeeCents: 0,
    });
    expectWellFormed(p);
    expect(on(p, accounts.creator(CREATOR))).toBe(0);
    expect(on(p, accounts.creatorHold(CREATOR))).toBe(100);
    expect(on(p, accounts.creatorReceivable(CREATOR))).toBe(800);
  });
});

describe("payout", () => {
  const base = {
    payoutId: "01890000-0000-7000-8000-0000000000b1",
    userId: CREATOR,
    provider: "stripe",
    currency: "usd",
    occurredAt: AT,
    minimumCents: 2500,
  };

  test("pays released earnings to cash", () => {
    const p = payout({ ...base, amountCents: 3000, balances: { liabilityCents: 3000, receivableCents: 0 } });
    expectWellFormed(p);
    expect(on(p, accounts.creator(CREATOR))).toBe(3000);
    expect(on(p, accounts.cash("stripe"))).toBe(-3000);
  });

  test("nets a clawback receivable against earnings", () => {
    const p = payout({ ...base, amountCents: 2600, balances: { liabilityCents: 3000, receivableCents: 400 } });
    expectWellFormed(p);
    expect(on(p, accounts.creator(CREATOR))).toBe(3000);
    expect(on(p, accounts.creatorReceivable(CREATOR))).toBe(-400);
    expect(on(p, accounts.cash("stripe"))).toBe(-2600);
  });

  test("refuses below the minimum unless closing the account", () => {
    const b = { liabilityCents: 2000, receivableCents: 0 };
    expect(() => payout({ ...base, amountCents: 2000, balances: b })).toThrow(PayoutBelowMinimumError);
    const p = payout({ ...base, amountCents: 2000, balances: b, closingAccount: true });
    expectWellFormed(p);
    expect(p.description).toMatch(/closed/);
  });

  test("refuses more than is available", () => {
    expect(() =>
      payout({ ...base, amountCents: 3000, balances: { liabilityCents: 3000, receivableCents: 1 } }),
    ).toThrow(InsufficientBalanceError);
    expect(() => payout({ ...base, amountCents: 0, balances: { liabilityCents: 3000, receivableCents: 0 } })).toThrow(
      RangeError,
    );
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
