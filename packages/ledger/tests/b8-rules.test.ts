// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Batch 8 reversal rules (contract step §2.3): Connect transfers and patronage payouts. */
import { describe, expect, test } from "vite-plus/test";
import { accounts } from "../src/accounts.ts";
import { POSTING_KINDS, type Posting, validatePosting } from "../src/posting.ts";
import {
  type PatronagePayoutReversedInput,
  type PayoutTransferReversedInput,
  patronagePayout,
  patronagePayoutReversed,
  payoutReserve,
  payoutSent,
  payoutTransferReversed,
} from "../src/rules.ts";

const USER = "01890000-0000-7000-8000-00000000c0de";
const PAYOUT = "01890000-0000-7000-8000-0000000000b0";
const TRANSFER = "01890000-0000-7000-8000-0000000000b1";
const PERIOD = "01890000-0000-7000-8000-0000000000b2";
const PATRONAGE_PAYOUT = "01890000-0000-7000-8000-0000000000b3";
const AT = new Date("2026-11-03T12:00:00Z");

const sum = (p: Posting) => p.entries.reduce((s, e) => s + e.amountCents, 0);
const on = (p: Posting, code: string) =>
  p.entries.filter((e) => e.code === code).reduce((s, e) => s + e.amountCents, 0);

const transferInput = (over: Partial<PayoutTransferReversedInput> = {}): PayoutTransferReversedInput => ({
  payoutId: PAYOUT,
  transferId: TRANSFER,
  userId: USER,
  amountCents: 1_500,
  cumulativeCents: 1_500,
  currency: "usd",
  occurredAt: AT,
  ...over,
});
const patronageInput = (over: Partial<PatronagePayoutReversedInput> = {}): PatronagePayoutReversedInput => ({
  payoutId: PATRONAGE_PAYOUT,
  periodId: PERIOD,
  userId: USER,
  provider: "manual",
  amountCents: 700,
  cumulativeCents: 700,
  currency: "usd",
  occurredAt: AT,
  ...over,
});

describe("payoutTransferReversed", () => {
  test("Dr cash:stripe, Cr the creator's earnings payable; balanced", () => {
    const p = payoutTransferReversed(transferInput());
    expect(() => validatePosting(p)).not.toThrow();
    expect(sum(p)).toBe(0);
    expect(p.kind).toBe("payout_transfer_reversal");
    expect(POSTING_KINDS).toContain(p.kind);
    expect(on(p, accounts.cash("stripe"))).toBe(1_500);
    expect(on(p, accounts.creator(USER))).toBe(-1_500);
    expect(p.entries).toHaveLength(2);
    expect(p.refType).toBe("payout");
    expect(p.refId).toBe(PAYOUT);
    expect(p.metadata).toEqual({ userId: USER, transferId: TRANSFER, cumulativeCents: 1_500 });
  });

  test("the key carries the cumulative total: two partial reversals are two postings", () => {
    const first = payoutTransferReversed(transferInput({ amountCents: 1_000, cumulativeCents: 1_000 }));
    const second = payoutTransferReversed(transferInput({ amountCents: 500, cumulativeCents: 1_500 }));
    expect(first.idempotencyKey).toBe(`payout-transfer-reversed:${TRANSFER}:1000`);
    expect(second.idempotencyKey).toBe(`payout-transfer-reversed:${TRANSFER}:1500`);
    // A redelivery of the same event computes the same key, so the poster posts it once.
    expect(payoutTransferReversed(transferInput({ amountCents: 1_000, cumulativeCents: 1_000 })).idempotencyKey).toBe(
      first.idempotencyKey,
    );
  });

  test("reserve, send and a full reversal return the amount to the payable", () => {
    const reserve = payoutReserve({
      payoutId: PAYOUT,
      userId: USER,
      amountCents: 5_000,
      currency: "usd",
      occurredAt: AT,
      balances: { liabilityCents: 5_000, receivableCents: 0 },
      minimumCents: 1_000,
    });
    const sent = payoutSent({
      payoutId: PAYOUT,
      userId: USER,
      provider: "stripe",
      amountCents: 5_000,
      currency: "usd",
      occurredAt: AT,
    });
    const back = payoutTransferReversed(transferInput({ amountCents: 5_000, cumulativeCents: 5_000 }));
    const all = [reserve, sent, back];
    const total = (code: string) => all.reduce((s, p) => s + on(p, code), 0);
    expect(total(accounts.creator(USER))).toBe(0);
    expect(total(accounts.payoutClearing(USER))).toBe(0);
    expect(total(accounts.cash("stripe"))).toBe(0);
  });

  test("refuses zero, negative, fractional and over-cumulative amounts", () => {
    for (const amountCents of [0, -1, 1.5, Number.NaN])
      expect(() => payoutTransferReversed(transferInput({ amountCents }))).toThrow(RangeError);
    for (const cumulativeCents of [0, -5])
      expect(() => payoutTransferReversed(transferInput({ cumulativeCents }))).toThrow(RangeError);
    expect(() => payoutTransferReversed(transferInput({ amountCents: 2_000, cumulativeCents: 1_500 }))).toThrow(
      /cannot exceed/,
    );
    expect(() => payoutTransferReversed(transferInput({ currency: "USD" }))).toThrow(/currency/);
  });
});

describe("patronagePayoutReversed", () => {
  test("Dr cash:<provider>, Cr the member's patronage payable; undoes patronagePayout", () => {
    const paid = patronagePayout({
      payoutId: PATRONAGE_PAYOUT,
      periodId: PERIOD,
      userId: USER,
      provider: "stripe",
      amountCents: 700,
      currency: "usd",
      occurredAt: AT,
    });
    const back = patronagePayoutReversed(patronageInput({ provider: "stripe" }));
    expect(() => validatePosting(back)).not.toThrow();
    expect(sum(back)).toBe(0);
    expect(back.kind).toBe("patronage_payout_reversal");
    expect(POSTING_KINDS).toContain(back.kind);
    expect(on(back, accounts.cash("stripe"))).toBe(700);
    expect(on(back, accounts.patronagePayable(USER))).toBe(-700);
    expect(on(paid, accounts.patronagePayable(USER)) + on(back, accounts.patronagePayable(USER))).toBe(0);
    expect(on(paid, accounts.cash("stripe")) + on(back, accounts.cash("stripe"))).toBe(0);
    expect(back.refType).toBe("patronage_period");
    expect(back.refId).toBe(PERIOD);
  });

  test("the keys carry the payout row (a member may be paid again after a failure) and the cumulative total", () => {
    expect(patronagePayoutReversed(patronageInput()).idempotencyKey).toBe(
      `patronage-payout-reversed:${PATRONAGE_PAYOUT}:700`,
    );
    const pay = (payoutId: string) =>
      patronagePayout({
        payoutId,
        periodId: PERIOD,
        userId: USER,
        provider: "manual",
        amountCents: 700,
        currency: "usd",
        occurredAt: AT,
      });
    expect(pay(PATRONAGE_PAYOUT).idempotencyKey).toBe(`patronage-payout:${PATRONAGE_PAYOUT}`);
    expect(pay(TRANSFER).idempotencyKey).not.toBe(pay(PATRONAGE_PAYOUT).idempotencyKey);
    expect(patronagePayoutReversed(patronageInput({ amountCents: 100, cumulativeCents: 800 })).idempotencyKey).not.toBe(
      patronagePayoutReversed(patronageInput()).idempotencyKey,
    );
  });

  test("refuses zero, negative and over-cumulative amounts", () => {
    for (const amountCents of [0, -700])
      expect(() => patronagePayoutReversed(patronageInput({ amountCents }))).toThrow(RangeError);
    expect(() => patronagePayoutReversed(patronageInput({ cumulativeCents: 0 }))).toThrow(RangeError);
    expect(() => patronagePayoutReversed(patronageInput({ amountCents: 701 }))).toThrow(/cannot exceed/);
  });
});
