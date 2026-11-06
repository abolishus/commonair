// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The card share chargeback rules (follow-ups, unit money), every branch: amounts, fees, currency,
 * settlement, keys and metadata; and `validatePosting`'s refusals, which every rule relies on.
 */
import { describe, expect, test } from "vite-plus/test";
import { accounts } from "../src/accounts.ts";
import { type Posting, UnbalancedPostingError, nonZero, validatePosting } from "../src/posting.ts";
import {
  periodClose,
  reversalSlices,
  reversalSplit,
  shareChargeback,
  shareChargebackReversal,
  sharePurchase,
  shareRefund,
  splitSuspenseRelease,
  DEFAULT_PLATFORM_CUT,
} from "../src/rules.ts";

const SHARE = "01890000-0000-7000-8000-0000000005a5";
const USER = "01890000-0000-7000-8000-00000000c0de";
const DISPUTE = "01890000-0000-7000-8000-0000000000dd";
const TXN = "01890000-0000-7000-8000-0000000000ee";
const AT = new Date("2026-11-06T12:00:00Z");
const base = { shareId: SHARE, userId: USER, provider: "stripe", amountCents: 500, currency: "usd", occurredAt: AT };

const on = (p: Posting, code: string) =>
  p.entries.filter((e) => e.code === code).reduce((s, e) => s + e.amountCents, 0);
const sum = (p: Posting) => p.entries.reduce((s, e) => s + e.amountCents, 0);
/** Net per account over several postings, zeros dropped. */
function net(ps: Posting[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of ps) for (const e of p.entries) out[e.code] = (out[e.code] ?? 0) + e.amountCents;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== 0));
}

describe("shareChargeback", () => {
  test("Dr the owner's member share, Cr Stripe cash; the fee is the co-op's expense from the same cash", () => {
    const p = shareChargeback({ ...base, disputeId: DISPUTE, disputeFeeCents: 1500 });
    expect(p).toMatchObject({
      kind: "share_chargeback",
      refType: "membership_share",
      refId: SHARE,
      idempotencyKey: `share-chargeback:${DISPUTE}`,
      currency: "usd",
      occurredAt: AT,
    });
    expect(sum(p)).toBe(0);
    expect(on(p, accounts.memberShare(USER))).toBe(500);
    expect(on(p, accounts.cash("stripe"))).toBe(-2000);
    expect(on(p, accounts.paymentFees())).toBe(1500);
    expect(p.entries.filter((e) => e.memo === "dispute fee")).toHaveLength(2);
    // Exactly one member share line: migration 0052 checks it against the dispute.
    expect(p.entries.filter((e) => e.code.startsWith("liability:member-share:"))).toHaveLength(1);
  });

  test("no fee, or a zero fee, posts two lines and records a zero fee", () => {
    for (const fee of [undefined, 0]) {
      const p = shareChargeback({ ...base, disputeId: DISPUTE, disputeFeeCents: fee });
      expect(p.entries).toHaveLength(2);
      expect(p.metadata).toEqual({ userId: USER, disputeId: DISPUTE, amountCents: 500, disputeFeeCents: 0 });
    }
  });

  test("the owner's account is the lower-case id, whatever case the caller passed", () => {
    const p = shareChargeback({ ...base, userId: USER.toUpperCase(), disputeId: DISPUTE });
    expect(on(p, `liability:member-share:${USER}`)).toBe(500);
  });

  test("a receivable settlement or another provider moves that account instead of Stripe cash", () => {
    const r = shareChargeback({ ...base, settlement: "receivable", disputeId: DISPUTE, disputeFeeCents: 10 });
    expect(on(r, accounts.providerReceivable("stripe"))).toBe(-510);
    expect(on(r, accounts.cash("stripe"))).toBe(0);
    const m = shareChargeback({ ...base, provider: "manual", disputeId: DISPUTE });
    expect(on(m, accounts.cash("manual"))).toBe(-500);
  });

  test("a one-cent share and the largest safe amount both post exactly", () => {
    expect(on(shareChargeback({ ...base, amountCents: 1, disputeId: DISPUTE }), accounts.memberShare(USER))).toBe(1);
    const big = Number.MAX_SAFE_INTEGER;
    expect(on(shareChargeback({ ...base, amountCents: big, disputeId: DISPUTE }), accounts.memberShare(USER))).toBe(
      big,
    );
  });

  test("refuses a zero, negative, fractional or unsafe amount, and a negative or fractional fee", () => {
    for (const amountCents of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])
      expect(() => shareChargeback({ ...base, amountCents, disputeId: DISPUTE }), String(amountCents)).toThrow(
        /amount must be a positive integer/,
      );
    for (const disputeFeeCents of [-1, 0.5, Number.POSITIVE_INFINITY])
      expect(() => shareChargeback({ ...base, disputeId: DISPUTE, disputeFeeCents }), String(disputeFeeCents)).toThrow(
        /disputeFee must be a non-negative integer/,
      );
  });

  test("refuses a currency that is not lower-case ISO 4217 and an invalid date", () => {
    for (const currency of ["USD", "us", "usdd", ""])
      expect(() => shareChargeback({ ...base, currency, disputeId: DISPUTE }), currency).toThrow(/currency must be/);
    expect(() => shareChargeback({ ...base, occurredAt: new Date(Number.NaN), disputeId: DISPUTE })).toThrow(
      /occurredAt/,
    );
  });

  test("a bad user id never reaches the chart (no member share account for it)", () => {
    expect(() => shareChargeback({ ...base, userId: "not-a-user", disputeId: DISPUTE })).toThrow(/invalid user id/);
  });
});

describe("shareChargebackReversal", () => {
  test("Cr the member share, Dr cash; a returned fee comes back out of the fee expense", () => {
    const p = shareChargebackReversal({
      ...base,
      disputeId: DISPUTE,
      feeRefundCents: 1500,
      chargebackTransactionId: TXN,
    });
    expect(p).toMatchObject({
      kind: "share_chargeback_reversal",
      refType: "membership_share",
      refId: SHARE,
      idempotencyKey: `share-chargeback-reversal:${DISPUTE}`,
      reversesId: TXN,
    });
    expect(sum(p)).toBe(0);
    expect(on(p, accounts.memberShare(USER))).toBe(-500);
    expect(on(p, accounts.cash("stripe"))).toBe(2000);
    expect(on(p, accounts.paymentFees())).toBe(-1500);
    expect(p.metadata).toEqual({ userId: USER, disputeId: DISPUTE, amountCents: 500, feeRefundCents: 1500 });
  });

  test("without the chargeback's id it reverses nothing in particular (null), and no fee returns two lines", () => {
    for (const chargebackTransactionId of [undefined, null]) {
      const p = shareChargebackReversal({ ...base, disputeId: DISPUTE, chargebackTransactionId });
      expect(p.reversesId).toBeNull();
      expect(p.entries).toHaveLength(2);
      expect(p.metadata.feeRefundCents).toBe(0);
    }
  });

  test("refuses a zero or negative amount and a negative or fractional fee refund", () => {
    for (const amountCents of [0, -500, 1.5])
      expect(() => shareChargebackReversal({ ...base, amountCents, disputeId: DISPUTE })).toThrow(/amount must be/);
    for (const feeRefundCents of [-1, 0.25])
      expect(() => shareChargebackReversal({ ...base, disputeId: DISPUTE, feeRefundCents })).toThrow(
        /feeRefund must be/,
      );
  });

  test("purchase, chargeback and a full win net to the purchase; a kept fee stays the co-op's expense", () => {
    const purchase = sharePurchase({ ...base, feeCents: 45 });
    const cb = shareChargeback({ ...base, disputeId: DISPUTE, disputeFeeCents: 1500 });
    expect(net([purchase, cb, shareChargebackReversal({ ...base, disputeId: DISPUTE, feeRefundCents: 1500 })])).toEqual(
      net([purchase]),
    );
    // Stripe kept 500 of the 1500 fee: that much stays an expense paid from cash.
    const partial = net([cb, shareChargebackReversal({ ...base, disputeId: DISPUTE, feeRefundCents: 1000 })]);
    expect(partial).toEqual({ [accounts.paymentFees()]: 500, [accounts.cash("stripe")]: -500 });
    // A lost dispute: the member share is back at zero, as after a refund, but the cash left once.
    expect(net([purchase, cb])[accounts.memberShare(USER)] ?? 0).toBe(0);
    expect(net([purchase, shareRefund(base)])[accounts.memberShare(USER)] ?? 0).toBe(0);
  });
});

describe("validatePosting's refusals", () => {
  const ok = (): Posting => shareRefund(base);
  test("accepts a rule's posting as is", () => {
    expect(() => validatePosting(ok())).not.toThrow();
  });
  test("key length 1-200, a description, a currency and a valid date", () => {
    expect(() => validatePosting({ ...ok(), idempotencyKey: "" })).toThrow(/idempotencyKey/);
    expect(() => validatePosting({ ...ok(), idempotencyKey: "k".repeat(201) })).toThrow(/idempotencyKey/);
    expect(() => validatePosting({ ...ok(), idempotencyKey: "k".repeat(200) })).not.toThrow();
    expect(() => validatePosting({ ...ok(), description: "" })).toThrow(/description/);
    expect(() => validatePosting({ ...ok(), currency: "EUR" })).toThrow(/currency/);
    expect(() => validatePosting({ ...ok(), occurredAt: new Date("nope") })).toThrow(/occurredAt/);
  });
  test("two or more lines, known accounts, non-zero safe integers, balanced", () => {
    const p = ok();
    expect(() => validatePosting({ ...p, entries: p.entries.slice(0, 1) })).toThrow(UnbalancedPostingError);
    expect(() => validatePosting({ ...p, entries: [...p.entries, { code: "asset:nope", amountCents: 0 }] })).toThrow(
      /unknown ledger account code/,
    );
    const [a, b] = p.entries as [Posting["entries"][number], Posting["entries"][number]];
    expect(() => validatePosting({ ...p, entries: [a, b, { ...a, amountCents: 0 }] })).toThrow(/non-zero integer/);
    expect(() =>
      validatePosting({
        ...p,
        entries: [
          { ...a, amountCents: 0.5 },
          { ...b, amountCents: -0.5 },
        ],
      }),
    ).toThrow(/non-zero integer/);
    expect(() => validatePosting({ ...p, entries: [a, { ...b, amountCents: b.amountCents + 1 }] })).toThrow(
      /unbalanced by 1 cents/,
    );
  });
  test("nonZero drops only zero lines", () => {
    const e = [
      { code: "a", amountCents: 0 },
      { code: "b", amountCents: -1 },
      { code: "c", amountCents: 1 },
    ];
    expect(nonZero(e).map((x) => x.code)).toEqual(["b", "c"]);
  });
});

describe("reversal and close edges the share rules sit beside", () => {
  test("reversalSplit refuses tax above gross", () => {
    expect(() => reversalSplit({ grossCents: 100, taxCents: 101 }, DEFAULT_PLATFORM_CUT, 0, 10)).toThrow(
      /tax cannot exceed gross/,
    );
  });

  test("reversalSlices: what the remainders cannot hold falls to the owner, or is refused without one", () => {
    const shares = [
      { userId: USER, role: "owner" as const, creatorCents: 50 },
      { userId: SHARE, role: "crew" as const, creatorCents: 50 },
    ];
    // The crew's 50 was already reversed out of order (a won chargeback gave back other slices).
    expect(reversalSlices(shares, 0, 60, { reversed: [0, 50], ownerIndex: 0 })).toEqual([60, 0]);
    expect(() => reversalSlices(shares, 0, 60, { reversed: [0, 50] })).toThrow(/exceeds what its recipients have left/);
    // A reversed vector shorter than the shares counts the missing ones as nothing reversed.
    expect(reversalSlices(shares, 0, 10, { reversed: [5], ownerIndex: 0 })).toEqual([5, 5]);
  });

  test("a split suspense release skips an owner with nothing withheld, and refuses when all are zero", () => {
    const i = {
      actionId: DISPUTE,
      recipientUserId: USER,
      byOwner: [
        { ownerUserId: SHARE, cents: 0 },
        { ownerUserId: TXN, cents: 30 },
      ],
      currency: "usd",
      occurredAt: AT,
    };
    const p = splitSuspenseRelease(i);
    expect(p.entries.filter((e) => e.code === accounts.splitSuspense(USER))).toHaveLength(1);
    expect(p.metadata.amountCents).toBe(30);
    expect(() => splitSuspenseRelease({ ...i, byOwner: [{ ownerUserId: SHARE, cents: 0 }] })).toThrow(
      /nothing is withheld/,
    );
  });

  test("periodClose refuses non-integer balances", () => {
    expect(() =>
      periodClose({
        periodStart: new Date("2026-01-01Z"),
        periodEnd: new Date("2026-02-01Z"),
        currency: "usd",
        occurredAt: AT,
        balances: [{ code: accounts.paymentFees(), rawCents: 1.5 }],
      }),
    ).toThrow(/integer cents/);
  });
});
