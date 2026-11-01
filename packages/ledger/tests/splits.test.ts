// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Ledger splits (ADR 0013): the N-way creator split, the per-recipient reversal slices, the
 * clawback policy (own lot first, the owner absorbs, crew never owe), the won-chargeback restore,
 * double netting, the write-off and suspense rules, and the one user-id order shared by the
 * locks and the payout batch. Pure: no database.
 */
import fc from "fast-check";
import { describe, expect, test } from "vite-plus/test";
import { accounts } from "../src/accounts.ts";
import {
  type BreakdownTransaction,
  breakdownSettlement,
  buildBreakdown,
  coopNet,
  payerLines,
  reconciles,
  settlementMovement,
} from "../src/breakdown.ts";
import { creatorLockOrder } from "../src/locks.ts";
import { BPS_TOTAL, apportionCumulative, compareUserIds, largestRemainder, splitNetN } from "../src/math.ts";
import { PaymentMetaV2, ReversalMetaV2 } from "../src/meta.ts";
import { computePayoutBatch } from "../src/payouts.ts";
import { type Posting, validatePosting } from "../src/posting.ts";
import {
  DEFAULT_PLATFORM_CUT,
  type PlatformCut,
  type RecipientShare,
  availableToPay,
  chargeback,
  chargebackReversal,
  holdMemo,
  holdRelease,
  parseHoldMemo,
  paymentSucceeded,
  payoutCancel,
  payoutReserve,
  refund,
  reversalSlices,
  reversalSplit,
  splitAt,
  splitShortfallWriteOff,
  splitSuspenseForfeit,
  splitSuspenseRelease,
  suspenseMemo,
} from "../src/rules.ts";

const OWNER = "01890000-0000-7000-8000-00000000000a";
const CREW_A = "01890000-0000-7000-8000-0000000000a1";
const CREW_B = "01890000-0000-7000-8000-0000000000b2";
const PAYMENT = "01890000-0000-7000-8000-0000000000aa";
const VERSION = "01890000-0000-7000-8000-0000000000f0";
const DISPUTE = "01890000-0000-7000-8000-0000000000d1";
const AT = new Date("2026-03-15T12:00:00Z");

const on = (p: Posting, code: string, memo?: string) =>
  p.entries
    .filter((e) => e.code === code && (memo === undefined || e.memo === memo))
    .reduce((s, e) => s + e.amountCents, 0);
const sum = (p: Posting) => p.entries.reduce((s, e) => s + e.amountCents, 0);
function wellFormed(p: Posting): void {
  expect(sum(p)).toBe(0);
  expect(() => validatePosting(p)).not.toThrow();
}
/** A uuid whose last 12 hex digits are `n`, so the order of the ids is the order of `n`. */
const uid = (n: number) => `01890000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

function pay(gross: number, crew: { userId: string; bps: number }[], cut: PlatformCut = DEFAULT_PLATFORM_CUT) {
  return paymentSucceeded({
    paymentId: PAYMENT,
    paymentKind: "tip",
    provider: "stripe",
    creatorUserId: OWNER,
    grossCents: gross,
    taxCents: 0,
    feeCents: 0,
    currency: "usd",
    cut,
    cutHistoryId: null,
    occurredAt: AT,
    split: crew.length > 0 ? { versionId: VERSION, crew } : null,
  });
}

describe("compareUserIds and the lock order", () => {
  test("lowercased byte order, deduplicated by lockCreators", () => {
    expect(compareUserIds("B", "a")).toBe(1);
    expect(compareUserIds("a", "B")).toBe(-1);
    expect(compareUserIds("ABC", "abc")).toBe(0);
    expect(creatorLockOrder([CREW_B, OWNER, CREW_A, CREW_B.toUpperCase()])).toEqual([OWNER, CREW_A, CREW_B]);
  });

  test("property: lockCreators and computePayoutBatch agree on the order", () => {
    const id = fc.uuid().map((u) => (Math.random() < 0.5 ? u.toUpperCase() : u));
    fc.assert(
      fc.property(fc.uniqueArray(id, { minLength: 1, maxLength: 30, selector: (u) => u.toLowerCase() }), (ids) => {
        const batch = computePayoutBatch(
          ids.map((userId) => ({ userId, availableCents: 100 })),
          0,
        );
        expect(batch.payouts.map((p) => p.userId.toLowerCase())).toEqual(creatorLockOrder(ids));
      }),
    );
  });
});

describe("splitNetN", () => {
  test("crew by bps, owner by the rest, sorted by user id", () => {
    const shares = splitNetN(900, OWNER, [
      { userId: CREW_B, bps: 1000 },
      { userId: CREW_A, bps: 2500 },
    ]);
    expect(shares).toEqual([
      { userId: OWNER, role: "owner", bps: 6500, creatorCents: 585 },
      { userId: CREW_A, role: "crew", bps: 2500, creatorCents: 225 },
      { userId: CREW_B, role: "crew", bps: 1000, creatorCents: 90 },
    ]);
  });

  test("no crew: the owner alone at 10,000 bps", () => {
    expect(splitNetN(900, OWNER.toUpperCase())).toEqual([
      { userId: OWNER, role: "owner", bps: BPS_TOTAL, creatorCents: 900 },
    ]);
  });

  test("1¢: exactly one recipient gets the cent", () => {
    const shares = splitNetN(1, OWNER, [{ userId: CREW_A, bps: 5000 }]);
    expect(shares.reduce((s, x) => s + x.creatorCents, 0)).toBe(1);
    // A tie goes to the earlier user id.
    expect(shares.find((s) => s.creatorCents === 1)?.userId).toBe(OWNER);
  });

  test("refuses the owner as crew, duplicates and impossible bps", () => {
    expect(() => splitNetN(100, OWNER, [{ userId: OWNER.toUpperCase(), bps: 10 }])).toThrow(/owner/);
    expect(() =>
      splitNetN(100, OWNER, [
        { userId: CREW_A, bps: 10 },
        { userId: CREW_A, bps: 20 },
      ]),
    ).toThrow(/once/);
    expect(() => splitNetN(100, OWNER, [{ userId: CREW_A, bps: 0 }])).toThrow(RangeError);
    expect(() => splitNetN(100, OWNER, [{ userId: CREW_A, bps: BPS_TOTAL }])).toThrow(RangeError);
    expect(() =>
      splitNetN(100, OWNER, [
        { userId: CREW_A, bps: 6000 },
        { userId: CREW_B, bps: 6000 },
      ]),
    ).toThrow(/more than/);
  });

  const crewOf = (n: number) =>
    fc
      .array(fc.integer({ min: 1, max: 1500 }), { minLength: n, maxLength: n })
      .map((bps) => bps.map((b, k) => ({ userId: uid(1000 - k), bps: b })));

  for (const ways of [3, 7]) {
    test(`property: a ${ways}-way split preserves the creator share and stays within a cent of exact`, () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 50_000_000 }), crewOf(ways - 1), (cents, crew) => {
          const shares = splitNetN(cents, uid(1), crew);
          expect(shares).toHaveLength(ways);
          expect(shares.reduce((s, x) => s + x.creatorCents, 0)).toBe(cents);
          expect(shares.reduce((s, x) => s + x.bps, 0)).toBe(BPS_TOTAL);
          expect([...shares].sort((a, b) => compareUserIds(a.userId, b.userId))).toEqual(shares);
          for (const s of shares) {
            const exact = (cents * s.bps) / BPS_TOTAL;
            expect(Math.abs(s.creatorCents - exact)).toBeLessThan(1);
          }
        }),
      );
    });
  }

  test("the payment posting holds one lot per recipient and the metadata names the version", () => {
    const p = pay(1000, [{ userId: CREW_A, bps: 1000 }]);
    wellFormed(p);
    const meta = PaymentMetaV2.parse(p.metadata);
    expect(meta.splitVersionId).toBe(VERSION);
    expect(meta.creatorUserId).toBe(OWNER);
    expect(meta.shares.map((s) => [s.userId, s.role, s.creatorCents])).toEqual([
      [OWNER, "owner", 810],
      [CREW_A, "crew", 90],
    ]);
    expect(on(p, accounts.creatorHold(OWNER), holdMemo(PAYMENT, OWNER))).toBe(-810);
    expect(on(p, accounts.creatorHold(CREW_A), holdMemo(PAYMENT, CREW_A))).toBe(-90);
    expect(parseHoldMemo(holdMemo(PAYMENT, CREW_A.toUpperCase()))).toEqual({ paymentId: PAYMENT, userId: CREW_A });
    expect(parseHoldMemo(`hold:${PAYMENT}`)).toBeNull();
  });

  test("a 1¢ split payment posts a balanced lot for whoever got the cent", () => {
    const p = pay(2, [{ userId: CREW_A, bps: 9999 }], { streamerShare: 0.5, coopShare: 0.5 });
    wellFormed(p);
    expect(on(p, accounts.creatorHold(CREW_A)) + on(p, accounts.creatorHold(OWNER))).toBe(-1);
  });
});

describe("apportionCumulative", () => {
  const weights = fc.array(fc.integer({ min: 0, max: 100_000 }), { minLength: 1, maxLength: 11 });

  test("property: monotone in the total, exact at the full total, sums to the total", () => {
    fc.assert(
      fc.property(weights, fc.integer({ min: 0, max: 1_000_000 }), (ws, seed) => {
        const total = ws.reduce((s, w) => s + w, 0);
        const x = total === 0 ? 0 : seed % (total + 1);
        const a = apportionCumulative(x, ws);
        expect(a.reduce((s, v) => s + v, 0)).toBe(x);
        const next = apportionCumulative(Math.min(x + 1, total), ws);
        next.forEach((v, k) => expect(v).toBeGreaterThanOrEqual(a[k] ?? 0));
        expect(apportionCumulative(total, ws)).toEqual(ws);
        expect(a.filter((_, k) => ws[k] === 0).every((v) => v === 0)).toBe(true);
      }),
    );
  });

  test("largestRemainder is not monotone (the Alabama paradox the reversals avoid)", () => {
    // Weights from the classic example: growing the total from 10 to 11 takes a cent from item 2.
    const ws = [6n, 6n, 2n];
    const at = (t: number) =>
      largestRemainder(
        t,
        ws.map((weight, key) => ({ key, weight })),
      ).map((p) => p.cents);
    expect(at(10)[2]).toBe(2);
    expect(at(11)[2]).toBe(1);
    const monotone = [6, 6, 2];
    expect(apportionCumulative(11, monotone)[2]).toBeGreaterThanOrEqual(apportionCumulative(10, monotone)[2] ?? 0);
  });

  test("refuses a total above the weights", () => {
    expect(() => apportionCumulative(3, [1, 1])).toThrow(RangeError);
    expect(apportionCumulative(0, [0, 0])).toEqual([0, 0]);
  });
});

/** Three recipients' recorded shares of a payment with the default cut. */
function sharesOf(p: Posting): RecipientShare[] {
  return PaymentMetaV2.parse(p.metadata).shares;
}

function reversalBase(gross: number, shares: RecipientShare[]) {
  return {
    disputeId: DISPUTE,
    paymentId: PAYMENT,
    provider: "stripe",
    creatorUserId: OWNER,
    currency: "usd",
    occurredAt: AT,
    original: { grossCents: gross, taxCents: 0 },
    cut: DEFAULT_PLATFORM_CUT,
    shares,
  };
}

describe("reversal slices", () => {
  test("property: any slicing of partial reversals returns exactly each recipient's share", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 200_000 }),
        fc.array(fc.integer({ min: 1, max: 1600 }), { minLength: 0, maxLength: 6 }),
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 12 }),
        (gross, bps, cuts) => {
          const crew = bps.map((b, k) => ({ userId: uid(2000 + k), bps: b }));
          const shares = sharesOf(pay(gross, crew));
          const got = new Map<string, number>();
          let done = 0;
          for (const c of [...cuts, null]) {
            if (done >= gross) break;
            const amount = c === null ? gross - done : Math.min(gross - done, 1 + (c % gross));
            const split = reversalSplit({ grossCents: gross, taxCents: 0 }, DEFAULT_PLATFORM_CUT, done, amount);
            const before = splitAt(done, gross, 0, DEFAULT_PLATFORM_CUT).creatorCents;
            const slices = reversalSlices(shares, before, split.creatorCents);
            expect(slices.reduce((s, v) => s + v, 0)).toBe(split.creatorCents);
            slices.forEach((v, k) => {
              expect(v).toBeGreaterThanOrEqual(0);
              const id = shares[k]?.userId ?? "";
              got.set(id, (got.get(id) ?? 0) + v);
            });
            done += amount;
          }
          for (const s of shares) expect(got.get(s.userId) ?? 0).toBe(s.creatorCents);
        },
      ),
    );
  });
});

describe("reversal slices after a won chargeback", () => {
  const owner = { userId: uid(2), role: "owner" as const, creatorCents: 1 };
  const crewShare = { userId: uid(1), role: "crew" as const, creatorCents: 1 };
  const two = [crewShare, owner];

  test("chargeback, refund, win, refund: each recipient is reversed exactly its share", () => {
    const cb = reversalSlices(two, 0, 1); // the crew cent (tie to the earlier item)
    expect(cb).toEqual([1, 0]);
    const r1 = reversalSlices(two, 1, 1, { reversed: cb, ownerIndex: 1 });
    expect(r1).toEqual([0, 1]);
    // The chargeback is won: its own slice [1, 0] comes back, so the net is [0, 1] at position 1.
    const r2 = reversalSlices(two, 1, 1, { reversed: [0, 1], ownerIndex: 1 });
    expect(r2).toEqual([1, 0]);
  });

  test("property: with won chargebacks interleaved, no slice is negative and crew are never over-reversed", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50_000 }),
        fc.array(fc.integer({ min: 1, max: 1600 }), { minLength: 1, maxLength: 5 }),
        fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 1, max: 1_000_000 })), { minLength: 1, maxLength: 12 }),
        (gross, bps, ops) => {
          const crew = bps.map((b, k) => ({ userId: uid(3000 + k), bps: b }));
          const shares = sharesOf(pay(gross, crew));
          const ownerIndex = shares.findIndex((x) => x.role === "owner");
          const net = shares.map(() => 0);
          const won: { amount: number; slices: number[] }[] = [];
          let done = 0;
          const reverse = (amount: number) => {
            const split = reversalSplit({ grossCents: gross, taxCents: 0 }, DEFAULT_PLATFORM_CUT, done, amount);
            const before = splitAt(done, gross, 0, DEFAULT_PLATFORM_CUT).creatorCents;
            const slices = reversalSlices(shares, before, split.creatorCents, { reversed: net, ownerIndex });
            expect(slices.reduce((x, v) => x + v, 0)).toBe(split.creatorCents);
            slices.forEach((v, k) => {
              expect(v).toBeGreaterThanOrEqual(0);
              net[k] = (net[k] ?? 0) + v;
            });
            done += amount;
            return slices;
          };
          for (const [win, c] of ops) {
            const last = won.pop();
            if (win && last) {
              // A won chargeback restores exactly its own recorded slices.
              last.slices.forEach((v, k) => (net[k] = (net[k] ?? 0) - v));
              done -= last.amount;
              continue;
            }
            if (last) won.push(last);
            if (done >= gross) continue;
            const amount = Math.min(gross - done, 1 + (c % gross));
            won.push({ amount, slices: reverse(amount) });
          }
          if (done < gross) reverse(gross - done);
          shares.forEach((x, k) => {
            // The owner may absorb a cent; a crew recipient is never reversed beyond its share.
            expect(x.role === "owner" || (net[k] ?? 0) <= x.creatorCents).toBe(true);
            expect(Math.abs((net[k] ?? 0) - x.creatorCents)).toBeLessThanOrEqual(1);
          });
        },
      ),
    );
  });
});

describe("split clawback (ADR 0013 decision 5)", () => {
  const crew = [
    { userId: CREW_A, bps: 2000 },
    { userId: CREW_B, bps: 1000 },
  ];
  // 1000 gross: creator 900 = owner 630, A 180, B 90.
  const shares = sharesOf(pay(1000, crew));

  test("a refund inside the hold takes every slice from its own lot", () => {
    const p = refund({
      ...reversalBase(1000, shares),
      alreadyReversedCents: 0,
      amountCents: 1000,
      balances: { liabilityCents: 5000, holdLots: [{ paymentId: PAYMENT, cents: 630 }] },
      crewLots: { [CREW_A]: 180, [CREW_B]: 90 },
    });
    wellFormed(p);
    expect(on(p, accounts.creatorHold(OWNER), holdMemo(PAYMENT, OWNER))).toBe(630);
    expect(on(p, accounts.creatorHold(CREW_A), holdMemo(PAYMENT, CREW_A))).toBe(180);
    expect(on(p, accounts.creatorHold(CREW_B), holdMemo(PAYMENT, CREW_B))).toBe(90);
    expect(on(p, accounts.creator(OWNER))).toBe(0);
    const meta = ReversalMetaV2.parse(p.metadata);
    expect(meta.shares.map((s) => [s.userId, s.creatorCents, s.fromOwnLotCents, s.ownerCoveredCents])).toEqual([
      [OWNER, -630, 630, 0],
      [CREW_A, -180, 180, 0],
      [CREW_B, -90, 90, 0],
    ]);
  });

  test("released crew slices are absorbed by the owner, never drawn from the crew", () => {
    const p = chargeback({
      ...reversalBase(1000, shares),
      alreadyReversedCents: 0,
      amountCents: 1000,
      disputeFeeCents: 0,
      balances: { liabilityCents: 700, holdLots: [{ paymentId: PAYMENT, cents: 0 }] },
      crewLots: { [CREW_A]: 0, [CREW_B]: 40 },
    });
    wellFormed(p);
    for (const c of [CREW_A, CREW_B]) {
      expect(on(p, accounts.creator(c))).toBe(0);
      expect(on(p, accounts.creatorReceivable(c))).toBe(0);
      expect(on(p, accounts.splitShortfall(c))).toBe(0);
    }
    expect(on(p, accounts.creatorHold(CREW_B))).toBe(40);
    // Owner: 630 own slice + 180 (A) + 50 (B) = 860 from 700 released; 630 is the owner's own,
    // then 70 of the crew's 230, so 160 goes to split shortfall and nothing to its receivable.
    expect(on(p, accounts.creator(OWNER))).toBe(700);
    expect(on(p, accounts.creatorReceivable(OWNER))).toBe(0);
    expect(on(p, accounts.splitShortfall(OWNER))).toBe(160);
    const meta = ReversalMetaV2.parse(p.metadata);
    expect(meta.shares.find((s) => s.userId === CREW_B)).toMatchObject({ fromOwnLotCents: 40, ownerCoveredCents: 50 });
    expect(meta.receivableCents).toBe(0);
  });

  test("an owner with nothing books its own slice as a receivable and the crew's as split shortfall", () => {
    const p = refund({
      ...reversalBase(1000, shares),
      alreadyReversedCents: 0,
      amountCents: 1000,
      balances: { liabilityCents: 0, holdLots: [] },
      crewLots: {},
    });
    wellFormed(p);
    expect(on(p, accounts.creatorReceivable(OWNER))).toBe(630);
    expect(on(p, accounts.splitShortfall(OWNER))).toBe(270);
  });

  test("property: crew are never drawn beyond their own lot, and every posting balances", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 0, max: 99_999 }),
        fc.integer({ min: 0, max: 50_000 }),
        fc.array(fc.integer({ min: 0, max: 20_000 }), { minLength: 4, maxLength: 4 }),
        fc.boolean(),
        (gross, alreadySeed, liability, lots, isChargeback) => {
          const s = sharesOf(pay(gross, crew));
          const already = alreadySeed % gross;
          const amount = gross - already;
          const input = {
            ...reversalBase(gross, s),
            alreadyReversedCents: already,
            amountCents: amount,
            balances: {
              liabilityCents: liability,
              holdLots: [
                { paymentId: PAYMENT, cents: lots[0] ?? 0 },
                { paymentId: DISPUTE, cents: lots[1] ?? 0 },
              ],
            },
            crewLots: { [CREW_A]: lots[2] ?? 0, [CREW_B]: lots[3] ?? 0 },
          };
          const p = isChargeback ? chargeback({ ...input, disputeFeeCents: 0 }) : refund(input);
          wellFormed(p);
          expect(on(p, accounts.creatorHold(CREW_A))).toBeLessThanOrEqual(lots[2] ?? 0);
          expect(on(p, accounts.creatorHold(CREW_B))).toBeLessThanOrEqual(lots[3] ?? 0);
          for (const c of [CREW_A, CREW_B]) {
            expect(p.entries.some((e) => e.code === accounts.creator(c))).toBe(false);
            expect(p.entries.some((e) => e.code === accounts.creatorReceivable(c))).toBe(false);
          }
          const meta = ReversalMetaV2.parse(p.metadata);
          expect(meta.shares.reduce((a, x) => a + x.creatorCents, 0)).toBe(meta.creatorCents);
          for (const x of meta.shares) expect(x.fromOwnLotCents + x.ownerCoveredCents).toBe(0 - x.creatorCents);
        },
      ),
    );
  });

  test("a partial refund after the split ended still uses the payment's recorded shares", () => {
    // The version's end changes nothing for a payment already posted under it.
    const p = refund({
      ...reversalBase(1000, shares),
      alreadyReversedCents: 0,
      amountCents: 500,
      balances: { liabilityCents: 0, holdLots: [{ paymentId: PAYMENT, cents: 630 }] },
      crewLots: { [CREW_A]: 180, [CREW_B]: 90 },
    });
    wellFormed(p);
    const meta = ReversalMetaV2.parse(p.metadata);
    expect(meta.shares.map((s) => -s.creatorCents)).toEqual([315, 90, 45]);
  });

  test("a single-owner refund draws only the owner's own lots, also when it holds split lots elsewhere", () => {
    const p = refund({
      ...reversalBase(1000, [{ userId: OWNER, role: "owner", creatorCents: 900 }]),
      alreadyReversedCents: 0,
      amountCents: 1000,
      balances: {
        liabilityCents: 100,
        holdLots: [
          { paymentId: PAYMENT, cents: 500 },
          { paymentId: DISPUTE, cents: 400 },
        ],
      },
    });
    wellFormed(p);
    expect(on(p, accounts.creatorHold(OWNER), holdMemo(PAYMENT, OWNER))).toBe(500);
    expect(on(p, accounts.creator(OWNER))).toBe(100);
    expect(on(p, accounts.creatorHold(OWNER), holdMemo(DISPUTE, OWNER))).toBe(300);
    expect(on(p, accounts.splitShortfall(OWNER))).toBe(0);
  });

  test("refuses shares that do not match the payment", () => {
    const base = {
      ...reversalBase(1000, [{ userId: OWNER, role: "owner" as const, creatorCents: 899 }]),
      alreadyReversedCents: 0,
      amountCents: 1000,
      balances: { liabilityCents: 0, holdLots: [] },
    };
    expect(() => refund(base)).toThrow(/sum/);
    expect(() => refund({ ...base, shares: [{ userId: CREW_A, role: "owner", creatorCents: 900 }] })).toThrow(/owner/);
  });
});

describe("won chargeback restores each slice (ADR 0013 decision 5)", () => {
  const cb = { amountCents: 1000, taxCents: 0, creatorCents: 900, coopCents: 100 };
  const slices = [
    { userId: OWNER, role: "owner" as const, fromOwnLotCents: 100, ownerCoveredCents: 530 },
    { userId: CREW_A, role: "crew" as const, fromOwnLotCents: 80, ownerCoveredCents: 100 },
    { userId: CREW_B, role: "crew" as const, fromOwnLotCents: 0, ownerCoveredCents: 90 },
  ];
  const base = {
    disputeId: DISPUTE,
    paymentId: PAYMENT,
    creatorUserId: OWNER,
    provider: "stripe",
    currency: "usd",
    occurredAt: AT,
    chargeback: cb,
    slices,
  };

  test("own-lot parts to each recipient, the covered part cancels split shortfall, then the receivable", () => {
    const p = chargebackReversal({ ...base, receivableCents: 200, splitShortfallCents: 300 });
    wellFormed(p);
    expect(on(p, accounts.creator(CREW_A))).toBe(-80);
    expect(on(p, accounts.creator(CREW_B))).toBe(0);
    // Covered 720: 300 cancels split shortfall, 200 the receivable, 220 + own 100 to the owner.
    expect(on(p, accounts.splitShortfall(OWNER))).toBe(-300);
    expect(on(p, accounts.creatorReceivable(OWNER))).toBe(-200);
    expect(on(p, accounts.creator(OWNER))).toBe(-320);
    const meta = ReversalMetaV2.parse(p.metadata);
    expect(meta.shares.find((s) => s.userId === CREW_A)).toMatchObject({
      creatorCents: 180,
      fromOwnLotCents: -80,
      ownerCoveredCents: -100,
    });
  });

  test("never cancels more than the covered part", () => {
    const p = chargebackReversal({ ...base, receivableCents: 5000, splitShortfallCents: 5000 });
    wellFormed(p);
    expect(on(p, accounts.splitShortfall(OWNER))).toBe(-720);
    expect(on(p, accounts.creatorReceivable(OWNER))).toBe(0);
    expect(on(p, accounts.creator(OWNER))).toBe(-100);
  });

  test("refuses slices that do not sum to the creator portion", () => {
    expect(() =>
      chargebackReversal({ ...base, slices: slices.slice(1), receivableCents: 0, splitShortfallCents: 0 }),
    ).toThrow(RangeError);
  });
});

describe("hold release per recipient", () => {
  test("keys and memos name the recipient; a withheld crew lot goes to split suspense", () => {
    const p = holdRelease({
      paymentId: PAYMENT,
      creatorUserId: CREW_A,
      ownerUserId: OWNER,
      amountCents: 90,
      currency: "usd",
      occurredAt: AT,
      withheld: true,
    });
    wellFormed(p);
    expect(p.idempotencyKey).toBe(`hold-release:${PAYMENT}:${CREW_A}`);
    expect(on(p, accounts.creatorHold(CREW_A), holdMemo(PAYMENT, CREW_A))).toBe(90);
    expect(on(p, accounts.splitSuspense(CREW_A), suspenseMemo(OWNER))).toBe(-90);
    expect(on(p, accounts.creator(CREW_A))).toBe(0);
    expect(p.metadata).toMatchObject({ recipientUserId: CREW_A, ownerUserId: OWNER, role: "crew", withheld: true });
  });

  test("an owner is never withheld into split suspense", () => {
    expect(() =>
      holdRelease({
        paymentId: PAYMENT,
        creatorUserId: OWNER,
        amountCents: 1,
        currency: "usd",
        occurredAt: AT,
        withheld: true,
      }),
    ).toThrow(RangeError);
  });
});

describe("netting both receivables (ADR 0013 decision 6)", () => {
  test("availableToPay counts the split shortfall", () => {
    expect(availableToPay({ liabilityCents: 1000, receivableCents: 100, splitShortfallCents: 200 })).toBe(700);
    expect(availableToPay({ liabilityCents: 1000, receivableCents: 100 })).toBe(900);
  });

  test("a reservation nets the creator receivable first, then split shortfall, and a cancel restores both", () => {
    const balances = { liabilityCents: 1000, receivableCents: 100, splitShortfallCents: 200 };
    const r = payoutReserve({
      payoutId: PAYMENT,
      userId: OWNER,
      amountCents: 700,
      currency: "usd",
      occurredAt: AT,
      balances,
      minimumCents: 0,
    });
    wellFormed(r);
    expect(on(r, accounts.creator(OWNER))).toBe(1000);
    expect(on(r, accounts.creatorReceivable(OWNER))).toBe(-100);
    expect(on(r, accounts.splitShortfall(OWNER))).toBe(-200);
    expect(r.metadata).toMatchObject({ receivableNettedCents: 100, splitShortfallNettedCents: 200 });
    expect(() =>
      payoutReserve({
        payoutId: PAYMENT,
        userId: OWNER,
        currency: "usd",
        occurredAt: AT,
        amountCents: 701,
        balances,
        minimumCents: 0,
      }),
    ).toThrow(/exceeds/);
    const c = payoutCancel({
      payoutId: PAYMENT,
      userId: OWNER,
      amountCents: 700,
      receivableNettedCents: 100,
      splitShortfallNettedCents: 200,
      currency: "usd",
      occurredAt: AT,
    });
    wellFormed(c);
    expect(on(c, accounts.splitShortfall(OWNER))).toBe(200);
    expect(on(c, accounts.creator(OWNER))).toBe(-1000);
  });
});

describe("write-off and suspense postings (ADR 0013 decisions 6, 7)", () => {
  test("a write-off debits the co-op's own expense line and credits the owner's shortfall", () => {
    const p = splitShortfallWriteOff({
      proposalId: VERSION,
      ownerUserId: OWNER,
      amountCents: 160,
      currency: "usd",
      occurredAt: AT,
    });
    wellFormed(p);
    expect(p.kind).toBe("split_shortfall_writeoff");
    expect(p.entries).toHaveLength(2);
    expect(on(p, accounts.splitShortfallWriteOff())).toBe(160);
    expect(on(p, accounts.splitShortfall(OWNER))).toBe(-160);
  });

  const byOwner = [
    { ownerUserId: CREW_B, cents: 40 },
    { ownerUserId: OWNER, cents: 60 },
  ];
  const base = { actionId: DISPUTE, recipientUserId: CREW_A, byOwner, currency: "usd", occurredAt: AT };

  test("a release moves every owner's withheld share to the recipient's released earnings", () => {
    const p = splitSuspenseRelease(base);
    wellFormed(p);
    expect(p.kind).toBe("split_suspense_release");
    expect(on(p, accounts.splitSuspense(CREW_A))).toBe(100);
    expect(on(p, accounts.creator(CREW_A))).toBe(-100);
  });

  test("a forfeit goes back to the owners it came from, never the co-op", () => {
    const p = splitSuspenseForfeit(base);
    wellFormed(p);
    expect(on(p, accounts.splitSuspense(CREW_A), suspenseMemo(OWNER))).toBe(60);
    expect(on(p, accounts.creator(OWNER))).toBe(-60);
    expect(on(p, accounts.creator(CREW_B))).toBe(-40);
    expect(on(p, accounts.platformCut())).toBe(0);
  });

  test("nothing withheld posts nothing", () => {
    expect(() => splitSuspenseRelease({ ...base, byOwner: [] })).toThrow(RangeError);
  });
});

describe("breakdown of a split payment", () => {
  let n = 0;
  const asTx = (p: Posting): BreakdownTransaction => ({
    id: `01890000-0000-7000-8000-${String(++n).padStart(12, "0")}`,
    kind: p.kind,
    occurredAt: p.occurredAt,
    metadata: JSON.parse(JSON.stringify(p.metadata)) as unknown,
    entries: p.entries.map((e) => ({ code: `${e.code}@${p.currency}`, amountCents: e.amountCents, memo: e.memo })),
  });
  const facts = { id: PAYMENT, kind: "tip" as const, currency: "usd", succeededAt: AT };
  const crew = [{ userId: CREW_A, bps: 1000 }];
  const rel = (userId: string, cents: number, days: number) =>
    asTx(
      holdRelease({
        paymentId: PAYMENT,
        creatorUserId: userId,
        ownerUserId: OWNER,
        amountCents: cents,
        currency: "usd",
        occurredAt: new Date(AT.getTime() + days * 86_400_000),
      }),
    );

  test("one creator line and one hold_released event per recipient; released once all are", () => {
    const paid = asTx(pay(1000, crew));
    const half = buildBreakdown(facts, [paid, rel(OWNER, 810, 7)], 7);
    expect(half.lines.filter((l) => l.kind === "creator").map((l) => [l.recipientUserId, l.amount.cents])).toEqual([
      [OWNER, 810],
      [CREW_A, 90],
    ]);
    expect(half.holdReleasedAt).toBeNull();
    expect(half.holdReleasesAt).not.toBeNull();
    const all = buildBreakdown(facts, [paid, rel(OWNER, 810, 7), rel(CREW_A, 90, 14)], 7);
    expect(all.timeline.filter((e) => e.kind === "hold_released").map((e) => e.amount?.cents)).toEqual([810, 90]);
    expect(all.holdReleasesAt).toBeNull();
    expect(all.holdReleasedAt).toBe(new Date(AT.getTime() + 14 * 86_400_000).toISOString());
    expect(reconciles(all, settlementMovement([paid]))).toBe(true);
  });

  test("the payer view keeps one creator total per posting", () => {
    const paid = asTx(pay(1000, crew));
    const b = buildBreakdown(facts, [paid], 7);
    const payer = payerLines(b.lines, OWNER);
    expect(payer.filter((l) => l.kind === "creator")).toEqual([
      {
        kind: "creator",
        amount: { cents: 900, currency: "usd" },
        recipientUserId: OWNER,
        component: null,
        transactionId: paid.id,
      },
    ]);
    expect(coopNet(payer)).toBe(coopNet(b.lines));
    expect(breakdownSettlement({ lines: payer })).toBe(breakdownSettlement(b));
  });
});
