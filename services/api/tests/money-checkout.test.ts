// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import { manualInstructions } from "@commonair/payments";
import {
  addOneMonthUtc,
  cancelProblem,
  confirmedPeriod,
  disputeOutcome,
  giftInputProblem,
  giftTotalCents,
  tierCode,
  validateTiers,
} from "../src/money/checkout-rules.ts";
import { violatesConstraint } from "../src/money/checkout-shared.ts";

const d = (s: string) => new Date(s);
const tier = (n: number, cents: number, extra: Partial<{ name: string; currency: string; benefits: string }> = {}) => ({
  tier: n,
  name: extra.name ?? `Tier ${n}`,
  price: { cents, currency: extra.currency ?? "usd" },
  benefits: extra.benefits ?? "",
});

describe("addOneMonthUtc", () => {
  test("same day next month, time kept", () => {
    expect(addOneMonthUtc(d("2026-03-15T10:20:30.456Z")).toISOString()).toBe("2026-04-15T10:20:30.456Z");
  });
  test("Jan 31 clamps to Feb 28, or Feb 29 in a leap year", () => {
    expect(addOneMonthUtc(d("2026-01-31T00:00:00Z")).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(addOneMonthUtc(d("2028-01-31T23:59:59Z")).toISOString()).toBe("2028-02-29T23:59:59.000Z");
    expect(addOneMonthUtc(d("2028-01-29T12:00:00Z")).toISOString()).toBe("2028-02-29T12:00:00.000Z");
  });
  test("31st into a 30-day month", () => {
    expect(addOneMonthUtc(d("2026-03-31T08:00:00Z")).toISOString()).toBe("2026-04-30T08:00:00.000Z");
    expect(addOneMonthUtc(d("2026-08-31T08:00:00Z")).toISOString()).toBe("2026-09-30T08:00:00.000Z");
  });
  test("December rolls into January of the next year", () => {
    expect(addOneMonthUtc(d("2026-12-31T05:00:00Z")).toISOString()).toBe("2027-01-31T05:00:00.000Z");
    expect(addOneMonthUtc(d("2026-12-01T00:00:00Z")).toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });
  test("UTC, not local: a late-evening offset input stays on its UTC day", () => {
    expect(addOneMonthUtc(d("2026-01-31T23:30:00-05:00")).toISOString()).toBe("2026-03-01T04:30:00.000Z");
  });
});

describe("validateTiers", () => {
  test("accepts three increasing tiers in any order, sorted and trimmed", () => {
    const r = validateTiers(
      [tier(3, 2499), tier(1, 499, { name: "  Fan  " }), tier(2, 999, { benefits: " emotes " })],
      "usd",
    );
    expect(r).toEqual({
      ok: true,
      rows: [
        { tier: 1, name: "Fan", priceCents: 499, benefits: "" },
        { tier: 2, name: "Tier 2", priceCents: 999, benefits: "emotes" },
        { tier: 3, name: "Tier 3", priceCents: 2499, benefits: "" },
      ],
    });
  });
  test("currency compares case-insensitively", () => {
    expect(validateTiers([tier(1, 100, { currency: "USD" }), tier(2, 200), tier(3, 300)], "usd").ok).toBe(true);
  });
  test("refuses missing, duplicate or out-of-range tiers", () => {
    expect(validateTiers([tier(1, 100), tier(2, 200)], "usd").ok).toBe(false);
    expect(validateTiers([tier(1, 100), tier(1, 200), tier(3, 300)], "usd").ok).toBe(false);
    expect(validateTiers([tier(1, 100), tier(2, 200), tier(4, 300)], "usd").ok).toBe(false);
    expect(validateTiers([tier(0, 100), tier(1, 200), tier(2, 300)], "usd").ok).toBe(false);
    expect(validateTiers([tier(1, 100), tier(2, 200), tier(3, 300), tier(3, 400)], "usd").ok).toBe(false);
  });
  test("prices must strictly increase", () => {
    expect(validateTiers([tier(1, 500), tier(2, 500), tier(3, 900)], "usd")).toMatchObject({ ok: false });
    expect(validateTiers([tier(1, 500), tier(2, 900), tier(3, 800)], "usd")).toMatchObject({ ok: false });
    expect(validateTiers([tier(1, 500), tier(2, 501), tier(3, 502)], "usd").ok).toBe(true);
  });
  test("instance currency only", () => {
    const r = validateTiers([tier(1, 100), tier(2, 200, { currency: "eur" }), tier(3, 300)], "usd");
    expect(r).toEqual({ ok: false, reason: "Tier prices must be in USD" });
  });
  test("names and benefits are bounded", () => {
    expect(validateTiers([tier(1, 100, { name: "   " }), tier(2, 200), tier(3, 300)], "usd").ok).toBe(false);
    expect(validateTiers([tier(1, 100, { name: "x".repeat(51) }), tier(2, 200), tier(3, 300)], "usd").ok).toBe(false);
    expect(validateTiers([tier(1, 100, { name: "x".repeat(50) }), tier(2, 200), tier(3, 300)], "usd").ok).toBe(true);
    expect(validateTiers([tier(1, 100, { benefits: "b".repeat(501) }), tier(2, 200), tier(3, 300)], "usd").ok).toBe(
      false,
    );
  });
  test("fractional cents are refused", () => {
    expect(validateTiers([tier(1, 100.5), tier(2, 200), tier(3, 300)], "usd").ok).toBe(false);
  });
});

describe("gift input", () => {
  test("cannot gift to yourself, in any case", () => {
    expect(giftInputProblem({ count: 1, to: "alice" }, "alice")).toMatch(/yourself/);
    expect(giftInputProblem({ count: 1, to: "ALICE" }, "alice")).toMatch(/yourself/);
  });
  test("a named recipient gets exactly one", () => {
    expect(giftInputProblem({ count: 2, to: "bob" }, "alice")).toMatch(/exactly one/);
  });
  test("random gifts and a named other user pass", () => {
    expect(giftInputProblem({ count: 5 }, "alice")).toBeNull();
    expect(giftInputProblem({ count: 1, to: "bob" }, "alice")).toBeNull();
  });
  test("gift totals are exact integers", () => {
    expect(giftTotalCents(499, 3)).toBe(1497);
    expect(giftTotalCents(100_000, 100)).toBe(10_000_000);
    expect(() => giftTotalCents(499, 0)).toThrow(RangeError);
  });
});

describe("tierCode", () => {
  test("EventSub tier strings", () => {
    expect([1, 2, 3].map(tierCode)).toEqual(["1000", "2000", "3000"]);
    expect(() => tierCode(4)).toThrow(RangeError);
  });
});

describe("disputeOutcome", () => {
  const paid = { status: "succeeded" as const, amountCents: 1000, refundedCents: 0 };
  test("partial refund, then the rest", () => {
    const a = disputeOutcome("refund", paid, 300);
    expect(a).toEqual({ ok: true, refundedCents: 300, status: "partially_refunded", endsSubscriptions: false });
    const b = disputeOutcome("refund", { ...paid, status: "partially_refunded", refundedCents: 300 }, 700);
    expect(b).toEqual({ ok: true, refundedCents: 1000, status: "refunded", endsSubscriptions: true });
  });
  test("more than the rest is a bad request", () => {
    expect(disputeOutcome("refund", { ...paid, status: "partially_refunded", refundedCents: 300 }, 701)).toMatchObject({
      ok: false,
      code: "BAD_REQUEST",
    });
  });
  test("only succeeded or partly refunded payments", () => {
    for (const status of ["pending", "failed", "refunded", "charged_back"] as const)
      expect(disputeOutcome("refund", { ...paid, status }, 1)).toMatchObject({ ok: false, code: "CONFLICT" });
  });
  test("a chargeback always ends the subscriptions", () => {
    expect(disputeOutcome("chargeback", paid, 400)).toEqual({
      ok: true,
      refundedCents: 400,
      status: "charged_back",
      endsSubscriptions: true,
    });
  });
  test("non-positive or fractional amounts", () => {
    expect(disputeOutcome("refund", paid, 0)).toMatchObject({ ok: false, code: "BAD_REQUEST" });
    expect(disputeOutcome("refund", paid, 1.5)).toMatchObject({ ok: false, code: "BAD_REQUEST" });
  });
});

describe("confirmedPeriod", () => {
  const receivedAt = d("2026-05-10T12:00:00Z");
  test("a new subscription starts when the money arrived", () => {
    expect(confirmedPeriod({ status: "incomplete", currentPeriodEnd: null }, receivedAt)).toEqual({
      start: receivedAt,
      end: d("2026-06-10T12:00:00Z"),
      renewal: false,
    });
  });
  test("a renewal continues from the previous period end", () => {
    const prev = d("2026-05-01T09:00:00Z");
    expect(confirmedPeriod({ status: "past_due", currentPeriodEnd: prev }, receivedAt)).toEqual({
      start: prev,
      end: d("2026-06-01T09:00:00Z"),
      renewal: true,
    });
  });
});

describe("cancelProblem", () => {
  test("active or past due, not a gift", () => {
    expect(cancelProblem({ status: "active", gifted: false, cancelAtPeriodEnd: false })).toBeNull();
    expect(cancelProblem({ status: "past_due", gifted: false, cancelAtPeriodEnd: true })).toBeNull();
    expect(cancelProblem({ status: "active", gifted: true, cancelAtPeriodEnd: false })?.code).toBe(
      "PRECONDITION_FAILED",
    );
    for (const status of ["incomplete", "canceled", "expired"] as const)
      expect(cancelProblem({ status, gifted: false, cancelAtPeriodEnd: false })?.code).toBe("CONFLICT");
  });
});

describe("manual instructions", () => {
  test("the default template with reference and amount", () => {
    expect(
      manualInstructions(
        "Send {amount} to the co-op treasurer and quote the reference {reference}.",
        "CA-7K3Q9P2M",
        499,
        "usd",
      ),
    ).toBe("Send 4.99 USD to the co-op treasurer and quote the reference CA-7K3Q9P2M.");
  });
});

describe("violatesConstraint", () => {
  test("finds the constraint anywhere in the cause chain", () => {
    const pg = { code: "23505", constraint_name: "payments_provider_ref_uq" };
    expect(violatesConstraint(pg, "payments_provider_ref_uq")).toBe(true);
    expect(violatesConstraint({ message: "wrapped", cause: pg }, "payments_provider_ref_uq")).toBe(true);
    expect(violatesConstraint(pg, "subscriptions_active_uq")).toBe(false);
    expect(
      violatesConstraint({ code: "23503", constraint_name: "payments_provider_ref_uq" }, "payments_provider_ref_uq"),
    ).toBe(false);
    expect(violatesConstraint(new Error("x"), "payments_provider_ref_uq")).toBe(false);
  });
});
