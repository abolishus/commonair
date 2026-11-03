// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/** The pure checks of M1-gifts-refunds' `e4b-money` steps (src/b8/money-refunds.ts). */
import { describe, expect, test } from "vite-plus/test";
import {
  GIFT_WINDOW_HOURS,
  RECEIPT_LINE_LABELS,
  expiresAfterHours,
  receiptProblems,
  refundFaultKey,
  requestOf,
} from "../../src/b8/money-refunds.ts";

const HOUR = 3_600_000;

describe("expiresAfterHours", () => {
  const t0 = new Date("2026-11-03T12:00:00Z");
  test("24 h after checkout, within a minute either way", () => {
    expect(expiresAfterHours(t0, new Date(t0.getTime() + GIFT_WINDOW_HOURS * HOUR), 24)).toBe(true);
    expect(expiresAfterHours(t0, new Date(t0.getTime() + 24 * HOUR + 59_000), 24)).toBe(true);
    expect(expiresAfterHours(t0, new Date(t0.getTime() + 24 * HOUR + 61_000), 24)).toBe(false);
  });
  test("PAYMENT_PENDING_DAYS (7 days) is not the gift window", () => {
    expect(expiresAfterHours(t0, new Date(t0.getTime() + 7 * 24 * HOUR), 24)).toBe(false);
  });
});

describe("requestOf", () => {
  test("finds the payment's request, or null", () => {
    const item = { paymentId: "p1", id: "r1" } as never;
    const page = { items: [item], nextCursor: null } as never;
    expect(requestOf(page, "p1")).toBe(item);
    expect(requestOf(page, "p2")).toBeNull();
  });
});

describe("receiptProblems", () => {
  const text = `Your receipt\nAmount $6.50\nReference pi_x\n${RECEIPT_LINE_LABELS.join("\n")}\nhttps://air.example/settings/subscriptions`;
  test("a complete receipt has none", () => {
    expect(receiptProblems(text, { amount: "$6.50", reference: "pi_x" })).toEqual([]);
  });
  test("each missing part is named", () => {
    expect(receiptProblems("nothing", { amount: "$6.50", reference: "pi_x" })).toEqual([
      "amount $6.50 missing",
      "reference pi_x missing",
      'line "To the creator" missing',
      'line "To the co-op" missing',
      "payments link missing",
    ]);
  });
});

test("the fault key is the API's", () => {
  expect(refundFaultKey("abc")).toBe("test:fault:refund-unknown:abc");
});
