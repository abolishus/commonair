// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The refund request rules with "outcome unknown" (ADR 0007 decision 3): every way an unknown
 * request is released, the TTL (it stops blocking but stays listed as unknown), a treasurer's
 * resolve, unknown followed by failed, and the error classification.
 */
import { describe, expect, test } from "vite-plus/test";
import { AdapterUnavailableError, StripeOutcomeUnknown, StripeRequestError } from "@commonair/payments";
import {
  PAID_AFTER_END,
  REFUND_OUTCOME_UNKNOWN,
  REFUND_REQUESTED,
  REFUND_REQUEST_FAILED,
  REFUND_REQUEST_RESOLVED,
  REFUND_REQUEST_TTL_MS,
  REFUND_SUBMITTED,
  type RefundMarker,
  type RefundPosting,
  classifyRefundError,
  outstandingRefundRequests,
  refundRequestStates,
} from "../src/money/stripe-refunds.ts";

const T0 = new Date("2026-11-03T12:00:00Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);
const m = (action: string, details: Record<string, unknown>, minutes: number): RefundMarker => ({
  action,
  createdAt: at(minutes),
  details,
});
const requested = (id: string, amountCents: number, minutes = 0, extra: Record<string, unknown> = {}) =>
  m(REFUND_REQUESTED, { requestId: id, amountCents, ...extra }, minutes);
const unknown = (id: string, minutes = 0) =>
  m(REFUND_OUTCOME_UNKNOWN, { requestId: id, idempotencyKey: `refund-p-0-${id}` }, minutes);
const posting = (providerRef: string | null, amountCents: number, minutes = 2): RefundPosting => ({
  providerRef,
  amountCents,
  createdAt: at(minutes),
});
const now = at(30);
const stateOf = (markers: RefundMarker[], postings: RefundPosting[] = [], when = now) =>
  refundRequestStates(markers, postings, when).map((s) => [s.requestId, s.state, s.blocking]);

describe("an unknown request", () => {
  const base = [requested("a", 500), unknown("a")];

  test("blocks and is listed as unknown, with the key it used", () => {
    expect(stateOf(base)).toEqual([["a", "unknown", true]]);
    expect(outstandingRefundRequests(base, [], now)).toEqual(["a"]);
    const [s] = refundRequestStates(base, [], now);
    expect(s).toMatchObject({ idempotencyKey: "refund-p-0-a", unknownAt: at(0), refundRef: null, reason: null });
  });

  test("a charge.refunded posting of its amount, after it, settles it", () => {
    expect(stateOf(base, [posting("re_unknown", 500, 5)])).toEqual([["a", "resolved", false]]);
    // The cumulative path (no refund list) too.
    expect(stateOf(base, [posting("ch_1:500", 500, 5)])).toEqual([["a", "resolved", false]]);
  });

  test("a posting of another amount, or before it, does not", () => {
    expect(stateOf(base, [posting("re_dash", 200, 5)])).toEqual([["a", "unknown", true]]);
    expect(stateOf([requested("a", 500, 10), unknown("a", 10)], [posting("re_old", 500, 5)])).toEqual([
      ["a", "unknown", true],
    ]);
  });

  test("its refund id, once known (refund.updated), settles it when posted, whatever the amount", () => {
    const attached = [...base, m(REFUND_SUBMITTED, { requestId: "a", refundRef: "re_1" }, 3)];
    expect(stateOf(attached)).toEqual([["a", "outstanding", true]]);
    expect(stateOf(attached, [posting("re_1", 499, 5)])).toEqual([["a", "resolved", false]]);
  });

  test("refund.failed (or refund.updated failed/canceled) tied to it releases it", () => {
    const failed = [...base, m(REFUND_REQUEST_FAILED, { refundRef: "re_9", requestId: "a" }, 4)];
    expect(stateOf(failed)).toEqual([["a", "resolved", false]]);
  });

  test("the reconciler finding none (unknown followed by failed) releases it", () => {
    const none = [...base, m(REFUND_REQUEST_FAILED, { requestId: "a", reason: "reconciled_none" }, 15)];
    expect(stateOf(none)).toEqual([["a", "resolved", false]]);
  });

  test("a treasurer's resolve releases it, either way", () => {
    for (const outcome of ["refunded", "failed"])
      expect(stateOf([...base, m(REFUND_REQUEST_RESOLVED, { requestId: "a", outcome }, 20)])).toEqual([
        ["a", "resolved", false],
      ]);
  });

  test("a resolve of another request does not", () => {
    expect(stateOf([...base, m(REFUND_REQUEST_RESOLVED, { requestId: "b", outcome: "failed" }, 20)])).toEqual([
      ["a", "unknown", true],
    ]);
  });

  test("past the TTL it stops blocking but stays listed as unknown", () => {
    const later = new Date(T0.getTime() + REFUND_REQUEST_TTL_MS + 1);
    expect(stateOf(base, [], later)).toEqual([["a", "unknown", false]]);
    expect(outstandingRefundRequests(base, [], later)).toEqual([]);
    // A plain request past the TTL is simply over.
    expect(stateOf([requested("b", 100)], [], later)).toEqual([["b", "resolved", false]]);
  });

  test("a refund posted while it blocked keeps it settled after the TTL", () => {
    const later = new Date(T0.getTime() + REFUND_REQUEST_TTL_MS + 1);
    expect(stateOf(base, [posting("re_x", 500, 5)], later)).toEqual([["a", "resolved", false]]);
  });

  test("a later request after a released unknown one is independent", () => {
    const ms = [
      ...base,
      m(REFUND_REQUEST_FAILED, { requestId: "a", reason: "reconciled_none" }, 15),
      requested("b", 500, 16),
    ];
    expect(stateOf(ms)).toEqual([
      ["a", "resolved", false],
      ["b", "outstanding", true],
    ]);
  });

  test("an expired request never takes a posting made after its TTL, so a newer one gets it", () => {
    const day = REFUND_REQUEST_TTL_MS / 60_000;
    const ms = [requested("a", 500, 0), unknown("a", 0), requested("b", 500, day + 10), unknown("b", day + 10)];
    const later = at(day + 30);
    expect(stateOf(ms, [posting("ch_1:500", 500, day + 20)], later)).toEqual([
      ["a", "unknown", false],
      ["b", "resolved", false],
    ]);
  });

  test("one posting settles the oldest matching request only", () => {
    const ms = [requested("a", 500, 0), unknown("a", 0), requested("b", 500, 1), unknown("b", 1)];
    expect(stateOf(ms, [posting("re_1", 500, 5)])).toEqual([
      ["a", "resolved", false],
      ["b", "unknown", true],
    ]);
  });
});

describe("automatic requests", () => {
  test("carry their reason", () => {
    const [s] = refundRequestStates([requested("a", 500, 0, { reason: PAID_AFTER_END })], [], now);
    expect(s?.reason).toBe(PAID_AFTER_END);
    const [t] = refundRequestStates([requested("a", 500, 0, { reason: "other" })], [], now);
    expect(t?.reason).toBeNull();
  });

  test("one listed for the treasurer (nothing sent) stays outstanding past the TTL, without blocking", () => {
    const later = new Date(T0.getTime() + REFUND_REQUEST_TTL_MS + 1);
    const listed = [requested("a", 500, 0, { reason: PAID_AFTER_END })];
    expect(stateOf(listed, [], later)).toEqual([["a", "outstanding", false]]);
    // A manual refund of the amount, or a resolve, settles it.
    expect(stateOf(listed, [posting(null, 500, 60)], later)).toEqual([["a", "resolved", false]]);
    expect(stateOf([...listed, m(REFUND_REQUEST_RESOLVED, { requestId: "a" }, 60)], [], later)).toEqual([
      ["a", "resolved", false],
    ]);
    // One Stripe accepted is over at the TTL like any other.
    const sent = [...listed, m(REFUND_SUBMITTED, { requestId: "a", refundRef: "re_1" }, 1)];
    expect(stateOf(sent, [], later)).toEqual([["a", "resolved", false]]);
  });
});

describe("classifyRefundError", () => {
  test("a definite refusal releases; anything that may have reached Stripe is unknown", () => {
    expect(classifyRefundError(new StripeRequestError("card", 400, "invalid_request_error", null))).toBe("failed");
    expect(classifyRefundError(new RangeError("no PaymentIntent"))).toBe("failed");
    expect(classifyRefundError(new AdapterUnavailableError("no key"))).toBe("failed");
    expect(classifyRefundError(new StripeOutcomeUnknown("timeout", 504, null, null))).toBe("unknown");
    expect(classifyRefundError(new StripeOutcomeUnknown("5xx", 500, "api_error", null))).toBe("unknown");
    expect(classifyRefundError(new Error("socket hang up"))).toBe("unknown");
    expect(classifyRefundError("weird")).toBe("unknown");
  });
});
