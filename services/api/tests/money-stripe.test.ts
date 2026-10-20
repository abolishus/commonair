// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vite-plus/test";
import {
  REFUND_REQUESTED,
  REFUND_REQUEST_FAILED,
  REFUND_REQUEST_TTL_MS,
  REFUND_SUBMITTED,
  type RefundMarker,
  type RefundPosting,
  outstandingRefundRequests,
} from "../src/money/stripe-refunds.ts";

const T0 = new Date("2026-10-20T12:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const requested = (id: string, amountCents: number, minutes = 0): RefundMarker => ({
  action: REFUND_REQUESTED,
  createdAt: at(minutes),
  details: { requestId: id, amountCents },
});
const submitted = (id: string, refundRef: string, minutes = 0): RefundMarker => ({
  action: REFUND_SUBMITTED,
  createdAt: at(minutes),
  details: { requestId: id, refundRef },
});
const failed = (details: Record<string, unknown>, minutes = 1): RefundMarker => ({
  action: REFUND_REQUEST_FAILED,
  createdAt: at(minutes),
  details,
});
const posting = (providerRef: string | null, amountCents: number, minutes = 2): RefundPosting => ({
  providerRef,
  amountCents,
  createdAt: at(minutes),
});
const now = at(5);

describe("outstandingRefundRequests", () => {
  test("nothing asked, nothing outstanding", () => {
    expect(outstandingRefundRequests([], [posting("re_dash", 100)], now)).toEqual([]);
  });

  test("a request waits until something settles it", () => {
    expect(outstandingRefundRequests([requested("a", 100), submitted("a", "re_1")], [], now)).toEqual(["a"]);
  });

  test("our call failed: released", () => {
    expect(outstandingRefundRequests([requested("a", 100), failed({ requestId: "a" })], [], now)).toEqual([]);
  });

  test("Stripe's refund.failed for its refund id: released", () => {
    const m = [requested("a", 100), submitted("a", "re_1"), failed({ refundRef: "re_1" })];
    expect(outstandingRefundRequests(m, [], now)).toEqual([]);
    // Another refund's failure does not release it.
    expect(
      outstandingRefundRequests([requested("a", 100), submitted("a", "re_1"), failed({ refundRef: "re_2" })], [], now),
    ).toEqual(["a"]);
  });

  test("posted by its refund id: released, whatever the amount", () => {
    const m = [requested("a", 100), submitted("a", "re_1")];
    expect(outstandingRefundRequests(m, [posting("re_1", 100)], now)).toEqual([]);
  });

  test("the cumulative path (no refund id) settles a request of exactly that amount, after it", () => {
    const m = [requested("a", 100), submitted("a", "re_1")];
    expect(outstandingRefundRequests(m, [posting("ch_1:100", 100)], now)).toEqual([]);
    expect(outstandingRefundRequests(m, [posting("ch_1:100", 100, -1)], now)).toEqual(["a"]);
  });

  test("a dashboard refund of another amount does not release it", () => {
    const m = [requested("a", 100), submitted("a", "re_1")];
    expect(outstandingRefundRequests(m, [posting("re_dash", 50)], now)).toEqual(["a"]);
  });

  test("one anonymous posting settles one request only", () => {
    const m = [requested("a", 100, 0), requested("b", 100, 1)];
    expect(outstandingRefundRequests(m, [posting(null, 100, 3)], now)).toEqual(["b"]);
  });

  test("requests stop blocking after the TTL", () => {
    const later = new Date(T0.getTime() + REFUND_REQUEST_TTL_MS + 1);
    expect(outstandingRefundRequests([requested("a", 100)], [], later)).toEqual([]);
    expect(
      outstandingRefundRequests([requested("a", 100)], [], new Date(T0.getTime() + REFUND_REQUEST_TTL_MS)),
    ).toEqual(["a"]);
  });

  test("markers without a request id are ignored", () => {
    expect(outstandingRefundRequests([{ action: REFUND_REQUESTED, createdAt: T0, details: {} }], [], now)).toEqual([]);
  });
});
