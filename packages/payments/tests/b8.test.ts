// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 8 payments seams (contract step §2.4): the error classification, the transfer and refund
 * calls on a fake fetch, the adapter's `transfer`/`refundStatus`, and the transfer and refund
 * webhook actions with their redaction. The same calls run against stripe-mock in
 * `stripe-mock.int.test.ts`.
 */
import { describe, expect, test } from "vite-plus/test";
import {
  StripeApiError,
  StripeOutcomeUnknown,
  StripeRequestError,
  type TransferRequest,
  createAdapter,
  isDefiniteRefusal,
  isOutcomeUnknown,
} from "../src/index.ts";
import { refundStatusOf, stripeAdapter } from "../src/stripe.ts";
import { refundOf, stripeClient, transferOf } from "../src/stripe-client.ts";
import { redactStripeEvent, stripeAction, stripeEnvelope } from "../src/stripe-events.ts";
import { stripeTransfer } from "../src/stripe-transfers.ts";

function fakeFetch(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { f, calls };
}

const transferJson = {
  id: "tr_1",
  object: "transfer",
  amount: 5000,
  amount_reversed: 1200,
  currency: "USD",
  destination: "acct_1",
  reversed: false,
  transfer_group: "2026-10-01T00:00:00.000Z",
  metadata: { payout_id: "po_1", transfer_id: "pt_1", note: "not ours" },
  description: "Ada's payout",
};

describe("error classification", () => {
  test("a 4xx is a definite refusal, never retried", async () => {
    let n = 0;
    const { f } = fakeFetch(() => {
      n++;
      return Response.json(
        { error: { type: "invalid_request_error", code: "resource_missing", message: "no" } },
        { status: 404 },
      );
    });
    const c = stripeClient({ secretKey: "sk_test_x", fetch: f, retries: 2 });
    const err = await c.retrieveTransfer("tr_1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeRequestError);
    expect(err).toBeInstanceOf(StripeApiError);
    expect(isDefiniteRefusal(err)).toBe(true);
    expect(isOutcomeUnknown(err)).toBe(false);
    expect((err as StripeRequestError).code).toBe("resource_missing");
    expect(n).toBe(1);
  });

  test("a 5xx after the retries is an unknown outcome", async () => {
    let n = 0;
    const { f } = fakeFetch(() => {
      n++;
      return new Response("busy", { status: 502 });
    });
    const c = stripeClient({ secretKey: "sk_test_x", fetch: f, retries: 1 });
    const err = await c.createTransfer({ amount: 1 }, "k").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeOutcomeUnknown);
    expect(isOutcomeUnknown(err)).toBe(true);
    expect((err as StripeOutcomeUnknown).status).toBe(502);
    expect(n).toBe(2);
  });

  test("a network error or timeout after the retries is an unknown outcome", async () => {
    const { f } = fakeFetch(() => {
      throw new TypeError("connection reset");
    });
    const c = stripeClient({ secretKey: "sk_test_x", fetch: f, retries: 0 });
    expect(await c.createRefund({ amount: 1 }, "k").catch((e: unknown) => e)).toBeInstanceOf(StripeOutcomeUnknown);
    const slow = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const c2 = stripeClient({ secretKey: "sk_test_x", fetch: slow.f, retries: 0, timeoutMs: 20 });
    expect(await c2.createTransfer({ amount: 1 }, "k").catch((e: unknown) => e)).toBeInstanceOf(StripeOutcomeUnknown);
  });

  test("a 5xx then a 200 inside the client is a success", async () => {
    let n = 0;
    const { f } = fakeFetch(() => (++n === 1 ? new Response("oops", { status: 500 }) : Response.json(transferJson)));
    const c = stripeClient({ secretKey: "sk_test_x", fetch: f, retries: 2 });
    expect((await c.createTransfer({ amount: 5000 }, "k")).id).toBe("tr_1");
  });

  test("409 (a request with the same key still running) is retried, then an unknown outcome", async () => {
    let n = 0;
    const { f } = fakeFetch(() => {
      n++;
      return Response.json(
        { error: { type: "invalid_request_error", code: "idempotency_key_in_use", message: "in use" } },
        { status: 409 },
      );
    });
    const c = stripeClient({ secretKey: "sk_test_x", fetch: f, retries: 1 });
    const err = await c.createTransfer({ amount: 1 }, "payout-transfer:po_1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeOutcomeUnknown);
    expect(isDefiniteRefusal(err)).toBe(false);
    expect((err as StripeOutcomeUnknown).status).toBe(409);
    expect(n).toBe(2);
    // ... and a 409 then a success is a success.
    let m = 0;
    const ok = fakeFetch(() =>
      ++m === 1 ? Response.json({ error: {} }, { status: 409 }) : Response.json(transferJson),
    );
    expect((await stripeClient({ secretKey: "sk_test_x", fetch: ok.f, retries: 1 }).createTransfer({}, "k")).id).toBe(
      "tr_1",
    );
  });

  test("an idempotency_error (the key went with other parameters) is unknown at once", async () => {
    for (const error of [
      { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters" },
      { type: "invalid_request_error", code: "idempotency_error" },
    ]) {
      let n = 0;
      const { f } = fakeFetch(() => {
        n++;
        return Response.json({ error }, { status: 400 });
      });
      const c = stripeClient({ secretKey: "sk_test_x", fetch: f, retries: 2 });
      const err = await c.createRefund({ amount: 1 }, "k").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StripeOutcomeUnknown);
      expect(isDefiniteRefusal(err)).toBe(false);
      expect(n).toBe(1);
    }
  });

  test("429 is retried, then an unknown outcome; a 429 then a success is a success", async () => {
    let n = 0;
    const { f } = fakeFetch(() => {
      n++;
      return Response.json({ error: { type: "invalid_request_error", code: "rate_limit" } }, { status: 429 });
    });
    const c = stripeClient({ secretKey: "sk_test_x", fetch: f, retries: 2 });
    const err = await c.createTransfer({ amount: 1 }, "k").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeOutcomeUnknown);
    expect((err as StripeOutcomeUnknown).status).toBe(429);
    expect(n).toBe(3);
    let m = 0;
    const ok = fakeFetch(() => (++m === 1 ? new Response("slow down", { status: 429 }) : Response.json(transferJson)));
    expect((await stripeClient({ secretKey: "sk_test_x", fetch: ok.f, retries: 1 }).createTransfer({}, "k")).id).toBe(
      "tr_1",
    );
  });

  test("a body that cannot be encoded is thrown as is, and nothing is sent", async () => {
    const { f, calls } = fakeFetch(() => Response.json(transferJson));
    const c = stripeClient({ secretKey: "sk_test_x", fetch: f, retries: 2 });
    const err = await c.createTransfer({ amount: Number.NaN }, "k").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(StripeApiError);
    expect(calls).toHaveLength(0);
  });

  test("a success answer without what the call needs is an unknown outcome", async () => {
    const { f } = fakeFetch(() => Response.json({ object: "transfer" }));
    const c = stripeClient({ secretKey: "sk_test_x", fetch: f });
    expect(await c.createTransfer({ amount: 1 }, "k").catch((e: unknown) => e)).toBeInstanceOf(StripeOutcomeUnknown);
    expect(await c.createRefund({ amount: 1 }, "k").catch((e: unknown) => e)).toBeInstanceOf(StripeOutcomeUnknown);
  });
});

describe("transfers and refunds on the client", () => {
  test("createTransfer posts the form under the key and maps the answer", async () => {
    const { f, calls } = fakeFetch(() => Response.json(transferJson));
    const c = stripeClient({ secretKey: "sk_test_x", fetch: f, apiBase: "http://m.test" });
    const t = await c.createTransfer(
      { amount: 5000, currency: "usd", destination: "acct_1", metadata: { payout_id: "po_1" } },
      "payout-transfer:po_1",
    );
    expect(t).toEqual({
      id: "tr_1",
      amount: 5000,
      currency: "usd",
      destination: "acct_1",
      reversed: false,
      amountReversed: 1200,
      metadata: { payout_id: "po_1", transfer_id: "pt_1", note: "not ours" },
    });
    expect(calls[0]?.url.href).toBe("http://m.test/v1/transfers");
    expect(calls[0]?.init.method).toBe("POST");
    expect((calls[0]?.init.headers as Record<string, string> | undefined)?.["idempotency-key"]).toBe(
      "payout-transfer:po_1",
    );
    expect(calls[0]?.init.body as string).toContain("destination=acct_1");
  });

  test("retrieveTransfer and retrieveRefund GET by id; ids are validated", async () => {
    const { f, calls } = fakeFetch((url) =>
      url.pathname.startsWith("/v1/transfers/")
        ? Response.json({ ...transferJson, destination: { id: "acct_1", object: "account" } })
        : Response.json({ id: "re_1", amount: 300, currency: "usd", status: "pending", payment_intent: "pi_1" }),
    );
    const c = stripeClient({ secretKey: "sk_test_x", fetch: f, apiBase: "http://m.test" });
    expect((await c.retrieveTransfer("tr_1")).destination).toBe("acct_1");
    expect(await c.retrieveRefund("re_1")).toEqual({
      id: "re_1",
      amount: 300,
      currency: "usd",
      status: "pending",
      paymentIntent: "pi_1",
      metadata: {},
    });
    expect(calls.map((x) => [x.init.method, x.url.pathname])).toEqual([
      ["GET", "/v1/transfers/tr_1"],
      ["GET", "/v1/refunds/re_1"],
    ]);
    await expect(c.retrieveRefund("../x")).rejects.toThrow(RangeError);
  });

  test("listRefunds follows the pages", async () => {
    const { f, calls } = fakeFetch((url) => {
      const after = url.searchParams.get("starting_after");
      if (!after)
        return Response.json({
          object: "list",
          has_more: true,
          data: [{ id: "re_2", amount: 100, currency: "usd", status: "succeeded", payment_intent: "pi_1" }],
        });
      return Response.json({
        object: "list",
        has_more: false,
        data: [{ id: "re_1", amount: 50, currency: "usd", status: "failed", payment_intent: "pi_1" }],
      });
    });
    const c = stripeClient({ secretKey: "sk_test_x", fetch: f, apiBase: "http://m.test" });
    const refunds = await c.listRefunds({ paymentIntent: "pi_1" });
    expect(refunds.map((r) => [r.id, r.status])).toEqual([
      ["re_2", "succeeded"],
      ["re_1", "failed"],
    ]);
    expect(calls[0]?.url.searchParams.get("payment_intent")).toBe("pi_1");
    expect(calls[0]?.url.searchParams.get("limit")).toBe("100");
    expect(calls[1]?.url.searchParams.get("starting_after")).toBe("re_2");
  });

  test("listRefunds never returns a cut-off list", async () => {
    let n = 0;
    const { f } = fakeFetch(() =>
      Response.json({
        object: "list",
        has_more: true,
        data: [{ id: `re_${++n}`, amount: 1, currency: "usd", status: "succeeded", payment_intent: "pi_1" }],
      }),
    );
    const c = stripeClient({ secretKey: "sk_test_x", fetch: f, apiBase: "http://m.test" });
    expect(await c.listRefunds({ paymentIntent: "pi_1" }).catch((e: unknown) => e)).toBeInstanceOf(
      StripeOutcomeUnknown,
    );
  });

  test("the mappers refuse a malformed object", () => {
    expect(() => transferOf({ id: "tr_1" })).toThrow(StripeOutcomeUnknown);
    expect(() => refundOf({ id: "re_1", amount: 1 })).toThrow(StripeOutcomeUnknown);
    expect(() => refundOf(null)).toThrow(StripeOutcomeUnknown);
  });
});

describe("the adapter seams", () => {
  const request: TransferRequest = {
    payoutId: "po_1",
    transferId: "pt_1",
    destination: "acct_1",
    amountCents: 5000,
    currency: "usd",
    group: "2026-10-01T00:00:00.000Z",
    idempotencyKey: "payout-transfer:po_1",
  };

  test("the manual adapter moves nothing: no transfer, no refund status", () => {
    const manual = createAdapter({ PAYMENTS_PROVIDER: "manual", MANUAL_PAYMENT_INSTRUCTIONS: "Pay by bank" });
    expect("transfer" in manual).toBe(false);
    expect("refundStatus" in manual).toBe(false);
  });

  test("the stripe adapter's transfer goes through stripeTransfer", async () => {
    const { f, calls } = fakeFetch(() => Response.json(transferJson));
    const adapter = stripeAdapter({ client: { secretKey: "sk_test_x", fetch: f } });
    const r = { ...request, destination: "acct_1", amountCents: 5000 };
    expect(await adapter.transfer?.(r)).toEqual({ providerRef: "tr_1", amountCents: 5000, currency: "usd" });
    const client = stripeClient({ secretKey: "sk_test_x", fetch: f });
    expect((await stripeTransfer(client, r)).providerRef).toBe("tr_1");
    expect(calls).toHaveLength(2);
  });

  test("refundStatus normalizes Stripe's status; a missing refund is null", async () => {
    const { f } = fakeFetch((url) =>
      url.pathname.endsWith("re_gone")
        ? Response.json({ error: { type: "invalid_request_error", code: "resource_missing" } }, { status: 404 })
        : Response.json({ id: "re_1", amount: 300, currency: "usd", status: "requires_action" }),
    );
    const adapter = stripeAdapter({ client: { secretKey: "sk_test_x", fetch: f } });
    expect(await adapter.refundStatus?.("re_1")).toEqual({
      providerRef: "re_1",
      status: "pending",
      amountCents: 300,
      currency: "usd",
    });
    expect(await adapter.refundStatus?.("re_gone")).toBeNull();
    expect(await adapter.refundStatus?.("CA-REF")).toBeNull();
    // Some payment methods' refunds are `pyr_`.
    expect((await adapter.refundStatus?.("pyr_1"))?.providerRef).toBe("re_1");
    expect(["succeeded", "failed", "canceled", "pending", null, "weird"].map(refundStatusOf)).toEqual([
      "succeeded",
      "failed",
      "canceled",
      "pending",
      "pending",
      "pending",
    ]);
  });

  test("listRefunds lists a PaymentIntent's refunds with our metadata; refunds carry the refund key", async () => {
    const { f, calls } = fakeFetch((_url, init) =>
      init.method === "GET"
        ? Response.json({
            data: [
              {
                id: "re_1",
                amount: 300,
                currency: "usd",
                status: "succeeded",
                payment_intent: "pi_1",
                metadata: { payment_id: "p1", refund_key: "k1", other: 1 },
              },
            ],
            has_more: false,
          })
        : Response.json({ id: "re_2", object: "refund", status: "pending" }),
    );
    const adapter = stripeAdapter({ client: { secretKey: "sk_test_x", fetch: f } });
    expect(await adapter.listRefunds?.("pi_1")).toEqual([
      {
        id: "re_1",
        amount: 300,
        currency: "usd",
        status: "succeeded",
        metadata: { payment_id: "p1", refund_key: "k1" },
      },
    ]);
    expect(calls[0]?.url.searchParams.get("payment_intent")).toBe("pi_1");
    await adapter.refund?.({
      paymentId: "p1",
      providerRef: "pi_1",
      amountCents: 300,
      idempotencyKey: "k1",
    });
    const body = new URLSearchParams(calls[1]?.init.body as string);
    expect(body.get("metadata[payment_id]")).toBe("p1");
    expect(body.get("metadata[refund_key]")).toBe("k1");
  });

  test("refundStatus passes an unknown outcome on", async () => {
    const { f } = fakeFetch(() => new Response("down", { status: 503 }));
    const adapter = stripeAdapter({ client: { secretKey: "sk_test_x", fetch: f, retries: 0 } });
    expect(await adapter.refundStatus?.("re_1").catch((e: unknown) => e)).toBeInstanceOf(StripeOutcomeUnknown);
  });
});

describe("transfer and refund webhook actions", () => {
  const body = (type: string, object: Record<string, unknown>) => ({
    id: "evt_1",
    object: "event",
    type,
    created: 1_760_000_000,
    livemode: false,
    data: { object },
  });
  const act = (type: string, object: Record<string, unknown>) => {
    const e = stripeEnvelope(body(type, object));
    if (!e) throw new Error("bad envelope");
    return stripeAction(e);
  };

  test("transfer.reversed and transfer.updated carry ids, amounts and our metadata", () => {
    for (const type of ["transfer.reversed", "transfer.updated"] as const)
      expect(act(type, transferJson)).toEqual({
        type,
        transferRef: "tr_1",
        destination: "acct_1",
        amountCents: 5000,
        amountReversed: 1200,
        currency: "usd",
        payoutId: "po_1",
        transferId: "pt_1",
      });
    expect(() => act("transfer.reversed", { ...transferJson, amount: undefined })).toThrow(/amount/);
  });

  test("redaction keeps what the actions read and drops the rest", () => {
    const stored = redactStripeEvent(body("transfer.reversed", transferJson));
    const object = (stored.data as { object: Record<string, unknown> }).object;
    expect(object).toEqual({
      id: "tr_1",
      object: "transfer",
      amount: 5000,
      currency: "USD",
      amount_reversed: 1200,
      reversed: false,
      transfer_group: "2026-10-01T00:00:00.000Z",
      destination: "acct_1",
      metadata: { payout_id: "po_1", transfer_id: "pt_1" },
    });
    const e = stripeEnvelope(stored);
    expect(e && stripeAction(e)).toEqual(act("transfer.reversed", transferJson));
    const refund = {
      id: "re_1",
      object: "refund",
      amount: 100,
      currency: "usd",
      status: "pending",
      payment_intent: "pi_1",
      metadata: { payment_id: "pay_1", request_id: "rq_1", email: "a@example.test" },
    };
    const r = redactStripeEvent(body("refund.updated", refund));
    expect((r.data as { object: Record<string, unknown> }).object.metadata).toEqual({
      payment_id: "pay_1",
      request_id: "rq_1",
    });
  });
});
