// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  MAX_PERIOD_DAYS,
  PeriodError,
  REVENUE_KINDS,
  REVENUE_LEDGER_KINDS,
  addMonths,
  costCategory,
  csvSafeReference,
  isCategorySlug,
  monthKey,
  monthStart,
  parsePeriod,
  payoutMonth,
  previousPeriod,
  revenueLineType,
  revenueSource,
  utcDays,
} from "../src/money/reports-lib.ts";

const d = (s: string) => new Date(s);
const iso = (p: { from: Date; to: Date }) => [p.from.toISOString(), p.to.toISOString()];

describe("parsePeriod", () => {
  test("defaults to the current UTC month", () => {
    expect(iso(parsePeriod(undefined, undefined, d("2026-10-19T12:00:00Z")))).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
    ]);
  });

  test("uses UTC, not the offset of the instant", () => {
    // 23:30 on Oct 31 at UTC−2 is already Nov 1 in UTC.
    expect(iso(parsePeriod(undefined, undefined, d("2026-10-31T23:30:00-02:00")))).toEqual([
      "2026-11-01T00:00:00.000Z",
      "2026-12-01T00:00:00.000Z",
    ]);
  });

  test("first and last instant of a month", () => {
    const now = d("2026-02-01T00:00:00Z");
    expect(iso(parsePeriod(undefined, undefined, now))[0]).toBe("2026-02-01T00:00:00.000Z");
    const last = d("2026-02-28T23:59:59.999Z");
    expect(iso(parsePeriod(undefined, undefined, last))).toEqual([
      "2026-02-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
    ]);
  });

  test("December rolls into the next year", () => {
    expect(iso(parsePeriod(undefined, undefined, d("2026-12-15T00:00:00Z")))[1]).toBe("2027-01-01T00:00:00.000Z");
  });

  test("explicit bounds are kept as given", () => {
    expect(iso(parsePeriod("2026-08-01T00:00:00Z", "2026-08-15T00:00:00Z", new Date()))).toEqual([
      "2026-08-01T00:00:00.000Z",
      "2026-08-15T00:00:00.000Z",
    ]);
  });

  test("offsets in the bounds are honored", () => {
    expect(iso(parsePeriod("2026-08-01T02:00:00+02:00", "2026-09-01T00:00:00Z", new Date()))[0]).toBe(
      "2026-08-01T00:00:00.000Z",
    );
  });

  test("only from: to the start of the next month", () => {
    expect(iso(parsePeriod("2026-08-10T00:00:00Z", undefined, new Date()))).toEqual([
      "2026-08-10T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    ]);
  });

  test("only to: from the start of the month just before it", () => {
    expect(iso(parsePeriod(undefined, "2026-09-01T00:00:00Z", new Date()))).toEqual([
      "2026-08-01T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    ]);
    expect(iso(parsePeriod(undefined, "2026-09-10T00:00:00Z", new Date()))[0]).toBe("2026-09-01T00:00:00.000Z");
  });

  test("refuses empty, inverted, invalid and overlong periods", () => {
    expect(() => parsePeriod("2026-08-01T00:00:00Z", "2026-08-01T00:00:00Z", new Date())).toThrow(PeriodError);
    expect(() => parsePeriod("2026-09-01T00:00:00Z", "2026-08-01T00:00:00Z", new Date())).toThrow(PeriodError);
    expect(() => parsePeriod("not a date", undefined, new Date())).toThrow(PeriodError);
    expect(() => parsePeriod("2024-01-01T00:00:00Z", "2026-01-01T00:00:00Z", new Date())).toThrow(PeriodError);
    const max = new Date(Date.UTC(2026, 0, 1) + MAX_PERIOD_DAYS * 86_400_000).toISOString();
    expect(() => parsePeriod("2026-01-01T00:00:00Z", max, new Date())).not.toThrow();
  });
});

describe("previousPeriod", () => {
  test("same length, ending where the period starts", () => {
    const p = previousPeriod({ from: d("2026-08-01T00:00:00Z"), to: d("2026-09-01T00:00:00Z") });
    // August has 31 days, so the previous period starts on July 1.
    expect(iso(p)).toEqual(["2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"]);
  });

  test("a short month looks back by its own length, not a calendar month", () => {
    const p = previousPeriod({ from: d("2026-03-01T00:00:00Z"), to: d("2026-04-01T00:00:00Z") });
    expect(iso(p)).toEqual(["2026-01-29T00:00:00.000Z", "2026-03-01T00:00:00.000Z"]);
  });

  test("arbitrary spans", () => {
    const p = previousPeriod({ from: d("2026-08-10T12:00:00Z"), to: d("2026-08-11T00:00:00Z") });
    expect(iso(p)).toEqual(["2026-08-10T00:00:00.000Z", "2026-08-10T12:00:00.000Z"]);
  });
});

describe("month helpers", () => {
  test("monthStart, addMonths and monthKey are UTC", () => {
    expect(monthStart(d("2026-10-19T23:59:00-05:00")).toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(addMonths(d("2026-01-31T00:00:00Z"), 1).toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(addMonths(d("2026-01-15T00:00:00Z"), -1).toISOString()).toBe("2025-12-01T00:00:00.000Z");
    expect(monthKey(d("2026-03-01T00:00:00Z"))).toBe("2026-03");
  });

  test("utcDays lists every overlapping UTC date", () => {
    expect(utcDays({ from: d("2026-02-27T00:00:00Z"), to: d("2026-03-02T00:00:00Z") })).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
    ]);
    expect(utcDays({ from: d("2026-08-01T00:00:00Z"), to: d("2026-09-01T00:00:00Z") })).toHaveLength(31);
    expect(utcDays({ from: d("2026-08-01T18:00:00Z"), to: d("2026-08-02T06:00:00Z") })).toEqual([
      "2026-08-01",
      "2026-08-02",
    ]);
  });

  test("payoutMonth: the month containing the instant before periodEnd", () => {
    expect(iso(payoutMonth(d("2026-10-19T12:00:00Z")))).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-10-19T12:00:00.000Z",
    ]);
    // Exactly midnight on the 1st closes the month before.
    expect(iso(payoutMonth(d("2026-10-01T00:00:00Z")))[0]).toBe("2026-09-01T00:00:00.000Z");
    expect(iso(payoutMonth(d("2026-10-01T00:00:00.001Z")))[0]).toBe("2026-10-01T00:00:00.000Z");
  });
});

describe("revenue line types", () => {
  const sub = { kind: "subscription" as const, quantity: 1, giftSubscription: false };
  test("payments by source", () => {
    expect(revenueLineType("payment", sub)).toBe("subscription");
    expect(revenueLineType("payment", { ...sub, quantity: 3 })).toBe("gift");
    expect(revenueLineType("payment", { ...sub, giftSubscription: true })).toBe("gift");
    expect(revenueLineType("payment", { kind: "tip", quantity: 1, giftSubscription: false })).toBe("tip");
    expect(revenueLineType("payment", null)).toBe("subscription");
  });

  test("reversals and payouts", () => {
    expect(revenueLineType("refund", sub)).toBe("refund");
    expect(revenueLineType("chargeback", sub)).toBe("chargeback");
    expect(revenueLineType("chargeback_reversal", sub)).toBe("chargeback");
    expect(revenueLineType("payout_reserve", null)).toBe("payout");
    expect(revenueLineType("payout_cancel", null)).toBe("payout");
  });

  test("hold releases and payout sends are never rows; revenue kinds are the payment ones", () => {
    expect(REVENUE_LEDGER_KINDS).not.toContain("hold_release");
    expect(REVENUE_LEDGER_KINDS).not.toContain("payout");
    expect([...REVENUE_KINDS]).toEqual(["payment", "refund", "chargeback", "chargeback_reversal"]);
  });

  test("sources", () => {
    expect(revenueSource(sub)).toBe("subscriptions");
    expect(revenueSource({ ...sub, quantity: 2 })).toBe("gifts");
    expect(revenueSource({ kind: "tip", quantity: 5, giftSubscription: true })).toBe("tips");
  });
});

describe("CSV-safe values", () => {
  test("provider tokens pass", () => {
    expect(csvSafeReference("CA-7K2M9QXD")).toBe("CA-7K2M9QXD");
    expect(csvSafeReference("pi_3NxAbC123")).toBe("pi_3NxAbC123");
  });

  test("free text, formulas and empty values become null", () => {
    expect(csvSafeReference("Bank transfer to Alice")).toBeNull();
    expect(csvSafeReference('=HYPERLINK("x")')).toBeNull();
    expect(csvSafeReference("+1")).toBeNull();
    expect(csvSafeReference("-1")).toBeNull();
    expect(csvSafeReference("@sum")).toBeNull();
    expect(csvSafeReference("a,b")).toBeNull();
    expect(csvSafeReference('a"b')).toBeNull();
    expect(csvSafeReference("line\nbreak")).toBeNull();
    expect(csvSafeReference("x".repeat(65))).toBeNull();
    expect(csvSafeReference("")).toBeNull();
    expect(csvSafeReference(null)).toBeNull();
    expect(csvSafeReference(undefined)).toBeNull();
  });
});

describe("cost categories", () => {
  test("slugs only", () => {
    expect(isCategorySlug("hosting")).toBe(true);
    expect(isCategorySlug("object-storage")).toBe(true);
    expect(isCategorySlug("cdn2")).toBe(true);
    expect(isCategorySlug("Hosting")).toBe(false);
    expect(isCategorySlug("-hosting")).toBe(false);
    expect(isCategorySlug("web hosting")).toBe(false);
    expect(isCategorySlug("")).toBe(false);
    expect(isCategorySlug("a".repeat(41))).toBe(false);
  });

  test("transparency names", () => {
    expect(costCategory("infrastructure:hosting")).toBe("hosting");
    expect(costCategory("payment-fees")).toBe("payment-fees");
  });
});
