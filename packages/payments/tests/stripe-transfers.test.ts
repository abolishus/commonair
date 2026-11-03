// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * M1-connect: the Connect transfer form, its idempotency key, the answer mapping and the error
 * classification the payout-transfer job turns on, on a fake fetch. The same call runs against
 * stripe-mock in `stripe-transfers.int.test.ts`.
 */
import { describe, expect, test } from "vite-plus/test";
import { StripeOutcomeUnknown, StripeRequestError, type TransferRequest, createAdapter } from "../src/index.ts";
import { stripeAdapter } from "../src/stripe.ts";
import { StripeKeyError, stripeClient } from "../src/stripe-client.ts";
import { payoutTransferKey, stripeTransfer, transferParams, transferResultOf } from "../src/stripe-transfers.ts";

const PAYOUT = "0195f0c2-6a4b-7c3d-8e9f-0a1b2c3d4e5f";
const ROW = "0195f0c2-6a4b-7c3d-8e9f-0a1b2c3d4e60";

const request: TransferRequest = {
  payoutId: PAYOUT,
  transferId: ROW,
  destination: "acct_1Abc",
  amountCents: 5000,
  currency: "usd",
  group: "2026-10-01T00:00:00.000Z",
  idempotencyKey: payoutTransferKey(PAYOUT),
};

const answer = (over: Record<string, unknown> = {}) => ({
  id: "tr_123",
  object: "transfer",
  amount: 5000,
  amount_reversed: 0,
  currency: "usd",
  destination: "acct_1Abc",
  reversed: false,
  metadata: { payout_id: PAYOUT, transfer_id: ROW },
  ...over,
});

function fakeFetch(handler: (url: URL, init: RequestInit) => Response) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { f, calls };
}

const bodyOf = (init: RequestInit) => new URLSearchParams(typeof init.body === "string" ? init.body : "");
const headerOf = (init: RequestInit, name: string) => (init.headers as Record<string, string>)[name];

describe("transferParams", () => {
  test("amount, currency, destination, the run as transfer_group, and ids-only metadata", () => {
    expect(transferParams(request)).toEqual({
      amount: 5000,
      currency: "usd",
      destination: "acct_1Abc",
      transfer_group: "2026-10-01T00:00:00.000Z",
      metadata: { payout_id: PAYOUT, transfer_id: ROW },
    });
  });

  test("the metadata carries no other key: never a name or an email", () => {
    const meta = transferParams(request).metadata as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(["payout_id", "transfer_id"]);
    expect(JSON.stringify(transferParams(request))).not.toContain("@");
  });

  test("zero, negative and fractional amounts are refused", () => {
    for (const amountCents of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(() => transferParams({ ...request, amountCents })).toThrow(RangeError);
  });

  test("a currency that is not lowercase ISO 4217 is refused", () => {
    for (const currency of ["USD", "us", "usdd", ""])
      expect(() => transferParams({ ...request, currency })).toThrow(/currency/);
  });

  test("only a connected account is a destination", () => {
    for (const destination of ["", "cus_1", "acct_", "acct_1 x", "ba_1"])
      expect(() => transferParams({ ...request, destination })).toThrow(/connected account/);
  });

  test("the key is the payout's own: payout-transfer:<payoutId>", () => {
    expect(payoutTransferKey(PAYOUT)).toBe(`payout-transfer:${PAYOUT}`);
    expect(() => transferParams({ ...request, idempotencyKey: "payout-transfer:other" })).toThrow(/payout-transfer/);
    expect(() => transferParams({ ...request, group: "" })).toThrow(/names its payout/);
  });
});

describe("transferResultOf", () => {
  const t = {
    id: "tr_9",
    amount: 5000,
    currency: "usd",
    destination: "acct_1Abc",
    reversed: false,
    amountReversed: 0,
    metadata: {},
  };

  test("maps Stripe's transfer to the provider ref, amount and currency", () => {
    expect(transferResultOf(request, t)).toEqual({ providerRef: "tr_9", amountCents: 5000, currency: "usd" });
  });

  test("an answer for another amount, currency or account is an unknown outcome, never a success", () => {
    for (const over of [{ amount: 4999 }, { currency: "eur" }, { destination: "acct_other" }]) {
      expect(() => transferResultOf(request, { ...t, ...over })).toThrow(StripeOutcomeUnknown);
    }
  });
});

describe("stripeTransfer on a fake Stripe", () => {
  test("posts the form under the payout's key and maps the answer", async () => {
    const { f, calls } = fakeFetch(() => Response.json(answer()));
    const client = stripeClient({ secretKey: "sk_test_x", fetch: f, retries: 0 });
    expect(await stripeTransfer(client, request)).toEqual({
      providerRef: "tr_123",
      amountCents: 5000,
      currency: "usd",
    });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (!call) throw new Error("no call");
    expect(call.url.pathname).toBe("/v1/transfers");
    expect(call.init.method).toBe("POST");
    expect(headerOf(call.init, "idempotency-key")).toBe(`payout-transfer:${PAYOUT}`);
    const body = bodyOf(call.init);
    expect(body.get("amount")).toBe("5000");
    expect(body.get("currency")).toBe("usd");
    expect(body.get("destination")).toBe("acct_1Abc");
    expect(body.get("transfer_group")).toBe("2026-10-01T00:00:00.000Z");
    expect(body.get("metadata[payout_id]")).toBe(PAYOUT);
    expect(body.get("metadata[transfer_id]")).toBe(ROW);
    expect([...body.keys()].sort()).toEqual(
      ["amount", "currency", "destination", "metadata[payout_id]", "metadata[transfer_id]", "transfer_group"].sort(),
    );
  });

  test("retries reuse the same key, so Stripe answers with the same transfer", async () => {
    let n = 0;
    const { f, calls } = fakeFetch(() =>
      ++n === 1 ? Response.json({ error: { type: "api_error" } }, { status: 503 }) : Response.json(answer()),
    );
    const client = stripeClient({ secretKey: "sk_test_x", fetch: f, retries: 1 });
    expect((await stripeTransfer(client, request)).providerRef).toBe("tr_123");
    expect(calls.map((c) => headerOf(c.init, "idempotency-key"))).toEqual([
      `payout-transfer:${PAYOUT}`,
      `payout-transfer:${PAYOUT}`,
    ]);
  });

  test("a 4xx (a deleted account, another currency) is a definite StripeRequestError with its code", async () => {
    for (const code of ["resource_missing", "transfers_not_allowed"]) {
      const { f } = fakeFetch(() =>
        Response.json(
          { error: { type: "invalid_request_error", code, message: "No such destination" } },
          { status: 400 },
        ),
      );
      const client = stripeClient({ secretKey: "sk_test_x", fetch: f, retries: 2 });
      const err = await stripeTransfer(client, request).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StripeRequestError);
      expect((err as StripeRequestError).code).toBe(code);
    }
  });

  test("a timeout, a network error or a 5xx after the retries is StripeOutcomeUnknown", async () => {
    const cases: (() => Response)[] = [
      () => {
        throw new DOMException("timed out", "TimeoutError");
      },
      () => {
        throw new TypeError("fetch failed");
      },
      () => Response.json({ error: { type: "api_error" } }, { status: 500 }),
      () => Response.json({ error: { type: "idempotency_error" } }, { status: 400 }),
    ];
    for (const handler of cases) {
      const { f } = fakeFetch(handler);
      const client = stripeClient({ secretKey: "sk_test_x", fetch: f, retries: 0 });
      expect(await stripeTransfer(client, request).catch((e: unknown) => e)).toBeInstanceOf(StripeOutcomeUnknown);
    }
  });

  test("nothing is sent for a refused request", async () => {
    const { f, calls } = fakeFetch(() => Response.json(answer()));
    const client = stripeClient({ secretKey: "sk_test_x", fetch: f });
    await expect(stripeTransfer(client, { ...request, amountCents: 0 })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe("the adapter's transfer", () => {
  test("the stripe adapter sends through stripeTransfer", async () => {
    const { f, calls } = fakeFetch(() => Response.json(answer()));
    const adapter = stripeAdapter({ client: { secretKey: "sk_test_x", fetch: f } });
    expect(await adapter.transfer?.(request)).toEqual({ providerRef: "tr_123", amountCents: 5000, currency: "usd" });
    expect(calls).toHaveLength(1);
  });

  test("no live key path: a live key is refused before any transfer can be made", () => {
    for (const secretKey of ["sk_live_x", "rk_live_x"]) {
      expect(() => stripeAdapter({ client: { secretKey } })).toThrow(StripeKeyError);
      expect(() =>
        createAdapter({ PAYMENTS_PROVIDER: "stripe", MANUAL_PAYMENT_INSTRUCTIONS: "", STRIPE_SECRET_KEY: secretKey }),
      ).toThrow(/live Stripe keys are refused/);
    }
  });

  test("the manual adapter has no transfer: nothing moves", () => {
    const manual = createAdapter({ PAYMENTS_PROVIDER: "manual", MANUAL_PAYMENT_INSTRUCTIONS: "Pay by bank" });
    expect("transfer" in manual).toBe(false);
  });
});
