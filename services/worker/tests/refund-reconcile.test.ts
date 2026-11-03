// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `refund-reconcile`'s pure parts (ADR 0007 decision 3): the decision table for an unknown request
 * against the provider's refunds, the request rules it shares with the API
 * (`services/api/tests/stripe-refunds.test.ts` has the same cases), and the error classification.
 */
import { describe, expect, test } from "vite-plus/test";
import { StripeOutcomeUnknown, StripeRequestError } from "@commonair/payments";
import {
  PAID_AFTER_END,
  type ProviderRefund,
  REFUND_OUTCOME_UNKNOWN,
  REFUND_REQUESTED,
  REFUND_REQUEST_FAILED,
  REFUND_REQUEST_RESOLVED,
  REFUND_REQUEST_TTL_MS,
  REFUND_SUBMITTED,
  type RefundMarker,
  type RefundPosting,
  classifyRefundError,
  decideReconcile,
  refundPortFromEnv,
  requestStates,
} from "../src/money/refund-reconcile.ts";

const refund = (over: Partial<ProviderRefund> = {}): ProviderRefund => ({
  id: "re_1",
  amountCents: 500,
  currency: "usd",
  status: "succeeded",
  metadata: {},
  ...over,
});
const req = { amountCents: 500, currency: "usd", idempotencyKey: "refund-p-0-500" };
const none = new Set<string>();

describe("decideReconcile", () => {
  test("a refund carrying the request's key decides by its status", () => {
    const keyed = (status: ProviderRefund["status"]) =>
      decideReconcile(req, [refund({ status, metadata: { refund_key: "refund-p-0-500" } })], none);
    expect(keyed("succeeded")).toEqual({ decision: "succeeded", refundRef: "re_1" });
    expect(keyed("pending")).toEqual({ decision: "pending", refundRef: "re_1" });
    expect(keyed("failed")).toEqual({ decision: "failed", refundRef: "re_1" });
    expect(keyed("canceled")).toEqual({ decision: "failed", refundRef: "re_1" });
    // Keyed wins even over an amount mismatch (the key is the request's own).
    expect(
      decideReconcile(req, [refund({ amountCents: 1, metadata: { idempotency_key: "refund-p-0-500" } })], none),
    ).toEqual({ decision: "succeeded", refundRef: "re_1" });
  });

  test("without a key, an unclaimed refund of the same amount and currency is the request's", () => {
    expect(decideReconcile(req, [refund()], none)).toEqual({ decision: "succeeded", refundRef: "re_1" });
    expect(decideReconcile({ ...req, idempotencyKey: null }, [refund({ status: "pending" })], none)).toEqual({
      decision: "pending",
      refundRef: "re_1",
    });
    // A failed attempt and its successful retry: the live one counts.
    expect(
      decideReconcile(req, [refund({ id: "re_a", status: "failed" }), refund({ id: "re_b" })], none).refundRef,
    ).toBe("re_b");
  });

  test("definitely none: no refunds, only claimed ones, or only other requests' keyed ones", () => {
    expect(decideReconcile(req, [], none)).toEqual({ decision: "none", refundRef: null });
    expect(decideReconcile(req, [refund()], new Set(["re_1"]))).toEqual({ decision: "none", refundRef: null });
    expect(decideReconcile(req, [refund({ metadata: { refund_key: "refund-p-0-100" } })], none)).toEqual({
      decision: "none",
      refundRef: null,
    });
  });

  test("only refunds of another amount or currency: a mismatch, left for the treasurer", () => {
    expect(decideReconcile(req, [refund({ amountCents: 300 })], none)).toEqual({
      decision: "mismatch",
      refundRef: null,
    });
    expect(decideReconcile(req, [refund({ currency: "eur" })], none).decision).toBe("mismatch");
  });
});

describe("requestStates (the API's rules)", () => {
  const T0 = new Date("2026-11-03T12:00:00Z");
  const at = (min: number) => new Date(T0.getTime() + min * 60_000);
  const mk = (action: string, details: Record<string, unknown>, min = 0): RefundMarker => ({
    action,
    createdAt: at(min),
    details,
  });
  const post = (providerRef: string | null, amountCents: number, min = 2): RefundPosting => ({
    providerRef,
    amountCents,
    createdAt: at(min),
  });
  const base = [
    mk(REFUND_REQUESTED, { requestId: "a", amountCents: 500, reason: PAID_AFTER_END }),
    mk(REFUND_OUTCOME_UNKNOWN, { requestId: "a", idempotencyKey: "k" }),
  ];
  const states = (ms: RefundMarker[], ps: RefundPosting[] = [], now = at(30)) =>
    requestStates(ms, ps, now).map((s) => [s.requestId, s.state, s.blocking]);

  test("unknown blocks, carries its key and reason", () => {
    expect(states(base)).toEqual([["a", "unknown", true]]);
    expect(requestStates(base, [], at(30))[0]).toMatchObject({ idempotencyKey: "k", reason: PAID_AFTER_END });
  });
  test("released by a posting of its amount, a failure, a resolve", () => {
    expect(states(base, [post("re_x", 500, 5)])).toEqual([["a", "resolved", false]]);
    expect(states([...base, mk(REFUND_REQUEST_FAILED, { requestId: "a" }, 3)])).toEqual([["a", "resolved", false]]);
    expect(states([...base, mk(REFUND_REQUEST_RESOLVED, { requestId: "a" }, 3)])).toEqual([["a", "resolved", false]]);
  });
  test("a known refund id: outstanding until posted or failed", () => {
    const ms = [...base, mk(REFUND_SUBMITTED, { requestId: "a", refundRef: "re_1" }, 1)];
    expect(states(ms)).toEqual([["a", "outstanding", true]]);
    expect(states([...ms, mk(REFUND_REQUEST_FAILED, { refundRef: "re_1" }, 2)])).toEqual([["a", "resolved", false]]);
  });
  test("past the TTL: not blocking, still listed unknown", () => {
    expect(states(base, [], new Date(T0.getTime() + REFUND_REQUEST_TTL_MS + 1))).toEqual([["a", "unknown", false]]);
  });
});

describe("classifyRefundError", () => {
  test("4xx and local refusals release; the rest is unknown", () => {
    expect(classifyRefundError(new StripeRequestError("no", 400, null, null))).toBe("failed");
    expect(classifyRefundError(new RangeError("x"))).toBe("failed");
    expect(classifyRefundError(new StripeOutcomeUnknown("t", 504, null, null))).toBe("unknown");
    expect(classifyRefundError(new Error("?"))).toBe("unknown");
  });
});

describe("refundPortFromEnv", () => {
  test("the manual adapter can neither list nor refund", () => {
    const port = refundPortFromEnv({ PAYMENTS_PROVIDER: "manual" });
    expect(port.provider).toBe("manual");
    expect(port.listRefunds).toBeNull();
    expect(port.refund).toBeNull();
  });
  test("a Stripe instance without a test key gets no port rather than a crash", () => {
    const port = refundPortFromEnv({ PAYMENTS_PROVIDER: "stripe" });
    expect(port).toMatchObject({ listRefunds: null, refund: null });
  });
});
