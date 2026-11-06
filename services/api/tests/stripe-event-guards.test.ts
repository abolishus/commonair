// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The webhook's pure guards (money/stripe-events.ts, stripe-events/shares.ts): which actions need
 * the processor fee, the fee rules (never a fee of 0 for a charge that has one, never a fee in
 * another currency), when a share's money arrived, and the refusals a share checkout makes before
 * it books anything (another mode, unpaid, another amount or currency, no PaymentIntent, a share
 * already given up on). None of these touches the database, so no transaction is passed.
 */
import { describe, expect, test } from "vite-plus/test";
import type { Executor, schema } from "@commonair/db";
import type { PaymentAdapter, StripeAction } from "@commonair/payments";
import {
  type PreparedAction,
  StripeProcessingError,
  feeFor,
  feeLookupRef,
  prepareStripeAction,
} from "../src/money/stripe-events.ts";
import { shareArrival, shareCheckoutCompleted, shareCheckoutFailed } from "../src/money/stripe-events/shares.ts";

type Completed = Extract<StripeAction, { type: "checkout.completed" }>;
type Payment = typeof schema.payments.$inferSelect;

const at = new Date("2026-11-01T12:00:00.000Z");
const completed = (over: Partial<Completed> = {}): Completed => ({
  type: "checkout.completed",
  paymentId: "0195f0c2-6a4b-7c3d-8e9f-0a1b2c3d4e5f",
  mode: "payment",
  paid: true,
  paymentIntent: "pi_1",
  subscription: null,
  amountTotal: 2500,
  taxCents: 0,
  currency: "usd",
  at,
  ...over,
});
const invoice = (amountPaid: number): StripeAction => ({
  type: "invoice.paid",
  invoiceId: "in_1",
  subscription: "sub_1",
  billingReason: "subscription_cycle",
  paymentId: null,
  paymentIntent: "pi_inv",
  amountPaid,
  taxCents: 0,
  currency: "usd",
  paidAt: at,
  periodEnd: null,
});
const payment = (over: Partial<Payment> = {}) =>
  ({
    id: "0195f0c2-6a4b-7c3d-8e9f-0a1b2c3d4e5f",
    status: "pending",
    currency: "usd",
    amountCents: 2500,
    createdAt: new Date(at.getTime() - 60_000),
    ...over,
  }) as Payment;
/** A guard must refuse before any query: a transaction that throws on use proves it. */
const noTx = new Proxy(
  {},
  {
    get() {
      throw new Error("the guard touched the database");
    },
  },
) as unknown as Executor;
const generic = () => Promise.reject(new Error("not the generic path"));

describe("feeLookupRef", () => {
  test("only a paid one-off checkout or an invoice that took money needs the fee", () => {
    expect(feeLookupRef(completed())).toBe("pi_1");
    expect(feeLookupRef(completed({ paid: false }))).toBeNull();
    expect(feeLookupRef(completed({ mode: "subscription" }))).toBeNull();
    expect(feeLookupRef(invoice(500))).toBe("pi_inv");
    expect(feeLookupRef(invoice(0))).toBeNull();
    expect(feeLookupRef({ type: "checkout.failed", paymentId: "p" })).toBeNull();
  });
});

describe("prepareStripeAction", () => {
  test("asks the adapter for the fee only when the action needs one and the adapter can", async () => {
    const asked: string[] = [];
    const adapter = {
      provider: "stripe",
      startCheckout: () => Promise.reject(new Error("no")),
      paymentFee: async (ref: string) => {
        asked.push(ref);
        return { feeCents: 103, currency: "usd" };
      },
    } satisfies PaymentAdapter;
    expect(await prepareStripeAction(adapter, completed())).toEqual({
      feeRef: "pi_1",
      fee: { feeCents: 103, currency: "usd" },
    });
    expect(await prepareStripeAction(adapter, completed({ paid: false }))).toEqual({ feeRef: null, fee: null });
    const { paymentFee: _drop, ...noFee } = adapter;
    expect(await prepareStripeAction(noFee, completed())).toEqual({ feeRef: null, fee: null });
    expect(asked).toEqual(["pi_1"]);
  });
});

describe("feeFor", () => {
  test("nothing to look up books 0; the fee in the payment's currency books its cents", () => {
    expect(feeFor({ feeRef: null, fee: null }, "usd")).toBe(0);
    expect(feeFor({ feeRef: "pi_1", fee: { feeCents: 0, currency: "usd" } }, "usd")).toBe(0);
    expect(feeFor({ feeRef: "pi_1", fee: { feeCents: 87, currency: "usd" } }, "usd")).toBe(87);
  });
  test("a charge whose fee is not attached yet, or in another currency, is retried, never booked as 0", () => {
    expect(() => feeFor({ feeRef: "pi_1", fee: null }, "usd")).toThrow(StripeProcessingError);
    expect(() => feeFor({ feeRef: "pi_1", fee: { feeCents: 87, currency: "eur" } }, "usd")).toThrow(/eur.*usd/);
  });
});

describe("shareArrival", () => {
  const created = new Date("2026-11-01T11:00:00.000Z");
  const now = new Date("2026-11-01T13:00:00.000Z");
  test("Stripe's time, clamped to the checkout start and to now", () => {
    expect(shareArrival(at, created, now)).toEqual(at);
    expect(shareArrival(new Date("2026-11-01T10:00:00.000Z"), created, now)).toEqual(created);
    expect(shareArrival(new Date("2026-11-02T00:00:00.000Z"), created, now)).toEqual(now);
    // A clock skew inside the minute still never goes before the checkout started.
    expect(shareArrival(new Date(created.getTime() - 30_000), created, now)).toEqual(created);
  });
});

describe("share checkout guards", () => {
  const fee: PreparedAction = { feeRef: "pi_1", fee: { feeCents: 50, currency: "usd" } };
  const run = (p: Payment, a: Completed) => shareCheckoutCompleted(noTx, p, a, fee, at, generic);

  test("another mode is ignored and an unpaid session waits, with nothing booked", async () => {
    expect((await run(payment(), completed({ mode: "subscription" }))).outcome).toBe("ignored");
    expect((await run(payment(), completed({ paid: false }))).outcome).toBe("awaiting_payment");
  });

  test("a redelivery is already processed; money for a share given up on must be refunded at Stripe", async () => {
    expect((await run(payment({ status: "succeeded" }), completed())).outcome).toBe("already_processed");
    await expect(run(payment({ status: "failed" }), completed())).rejects.toThrow(/refund it in Stripe/);
  });

  test("a paid session without a PaymentIntent, or for another amount or currency, is refused", async () => {
    await expect(run(payment(), completed({ paymentIntent: null }))).rejects.toThrow(StripeProcessingError);
    await expect(run(payment(), completed({ currency: "eur" }))).rejects.toThrow(/eur/);
    await expect(run(payment(), completed({ amountTotal: 2499 }))).rejects.toThrow(/2499/);
  });

  test("a failed checkout for a share no longer pending changes nothing", async () => {
    expect((await shareCheckoutFailed(noTx, payment({ status: "succeeded" }), at)).outcome).toBe("not_pending");
  });
});
