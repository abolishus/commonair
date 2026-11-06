// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Follow-ups (unit money): looking a Connect transfer up at Stripe (`transferStatus`) and listing an
 * account's transfers in one payout run (`listTransfers`), on a fake fetch. A treasurer's "Stripe
 * sent it" or "Stripe has none" is checked against these before it is recorded, so the mapping, the
 * "no such transfer" answer and the pagination are pinned here. stripe-mock runs the same calls in
 * `stripe-transfers.int.test.ts`. Also the Stripe adapter's subscription cancel and fee paths.
 */
import { describe, expect, test } from "vite-plus/test";
import { StripeOutcomeUnknown, StripeRequestError } from "../src/index.ts";
import { stripeAdapter } from "../src/stripe.ts";
import { stripeClient } from "../src/stripe-client.ts";
import { stripeListTransfers, stripeTransferStatus, transferStatusOf } from "../src/stripe-transfers.ts";

const PAYOUT = "0195f0c2-6a4b-7c3d-8e9f-0a1b2c3d4e5f";
const ROW = "0195f0c2-6a4b-7c3d-8e9f-0a1b2c3d4e60";
const GROUP = "2026-10-01T00:00:00.000Z";

const transfer = (over: Record<string, unknown> = {}) => ({
  id: "tr_123",
  object: "transfer",
  amount: 5000,
  amount_reversed: 250,
  currency: "USD",
  destination: "acct_1Abc",
  reversed: false,
  metadata: { payout_id: PAYOUT, transfer_id: ROW, n: 7 },
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
const clientOn = (handler: (url: URL, init: RequestInit) => Response) => {
  const { f, calls } = fakeFetch(handler);
  return { client: stripeClient({ secretKey: "sk_test_x", fetch: f, retries: 0 }), calls };
};

describe("transferStatus", () => {
  test("maps Stripe's transfer: lowercased currency, reversed cents, string metadata only", async () => {
    const { client, calls } = clientOn(() => Response.json(transfer()));
    expect(await stripeTransferStatus(client, "tr_123")).toEqual({
      providerRef: "tr_123",
      amountCents: 5000,
      currency: "usd",
      destination: "acct_1Abc",
      reversedCents: 250,
      metadata: { payout_id: PAYOUT, transfer_id: ROW },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.pathname).toBe("/v1/transfers/tr_123");
    expect(calls[0]?.init.method).toBe("GET");
  });

  test("an expanded destination object reads as its id", async () => {
    const { client } = clientOn(() => Response.json(transfer({ destination: { id: "acct_9", object: "account" } })));
    expect((await stripeTransferStatus(client, "tr_123"))?.destination).toBe("acct_9");
  });

  test("an id that is not a transfer's is null without a request", async () => {
    const { client, calls } = clientOn(() => Response.json(transfer()));
    for (const ref of ["", "re_123", "tr_", "tr_a/b", "TR_123", `tr_${"x".repeat(251)}`])
      expect(await stripeTransferStatus(client, ref)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("Stripe's 404 is a definite null; any other refusal or no answer throws", async () => {
    const missing = clientOn(() =>
      Response.json({ error: { type: "invalid_request_error", code: "resource_missing" } }, { status: 404 }),
    );
    expect(await stripeTransferStatus(missing.client, "tr_gone")).toBeNull();
    const forbidden = clientOn(() => Response.json({ error: { type: "invalid_request_error" } }, { status: 403 }));
    expect(await stripeTransferStatus(forbidden.client, "tr_1").catch((e: unknown) => e)).toBeInstanceOf(
      StripeRequestError,
    );
    const down = clientOn(() => Response.json({ error: { type: "api_error" } }, { status: 503 }));
    expect(await stripeTransferStatus(down.client, "tr_1").catch((e: unknown) => e)).toBeInstanceOf(
      StripeOutcomeUnknown,
    );
    // A 200 without the fields a check needs is not "none": Stripe may hold the transfer.
    const odd = clientOn(() => Response.json({ id: "tr_1" }));
    expect(await stripeTransferStatus(odd.client, "tr_1").catch((e: unknown) => e)).toBeInstanceOf(
      StripeOutcomeUnknown,
    );
  });

  test("transferStatusOf keeps every field the settle check reads", () => {
    expect(
      transferStatusOf({
        id: "tr_1",
        amount: 1,
        currency: "eur",
        destination: "acct_1",
        reversed: true,
        amountReversed: 1,
        metadata: {},
      }),
    ).toEqual({
      providerRef: "tr_1",
      amountCents: 1,
      currency: "eur",
      destination: "acct_1",
      reversedCents: 1,
      metadata: {},
    });
  });
});

describe("listTransfers", () => {
  test("lists by destination and transfer group, following has_more with starting_after", async () => {
    const pages = [
      { data: [transfer({ id: "tr_a" }), transfer({ id: "tr_b" })], has_more: true },
      { data: [transfer({ id: "tr_c", metadata: {} })], has_more: false },
    ];
    const { client, calls } = clientOn(() => Response.json(pages[calls.length - 1]));
    const listed = await stripeListTransfers(client, { destination: "acct_1Abc", group: GROUP });
    expect(listed.map((t) => t.providerRef)).toEqual(["tr_a", "tr_b", "tr_c"]);
    expect(listed[2]?.metadata).toEqual({});
    expect(calls).toHaveLength(2);
    const [first, second] = calls.map((c) => c.url);
    expect(first?.pathname).toBe("/v1/transfers");
    expect(first?.searchParams.get("destination")).toBe("acct_1Abc");
    expect(first?.searchParams.get("transfer_group")).toBe(GROUP);
    expect(first?.searchParams.get("limit")).toBe("100");
    expect(first?.searchParams.has("starting_after")).toBe(false);
    expect(second?.searchParams.get("starting_after")).toBe("tr_b");
  });

  test("an empty page ends the list even when has_more says otherwise", async () => {
    const { client, calls } = clientOn(() => Response.json({ data: [], has_more: true }));
    expect(await stripeListTransfers(client, { destination: "acct_1", group: GROUP })).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test("a list without data, or longer than the client pages, is an unknown outcome, never 'none'", async () => {
    const bare = clientOn(() => Response.json({ object: "list" }));
    expect(
      await stripeListTransfers(bare.client, { destination: "acct_1", group: GROUP }).catch((e: unknown) => e),
    ).toBeInstanceOf(StripeOutcomeUnknown);
    let n = 0;
    const endless = clientOn(() => Response.json({ data: [transfer({ id: `tr_${++n}` })], has_more: true }));
    const err = await stripeListTransfers(endless.client, { destination: "acct_1", group: GROUP }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StripeOutcomeUnknown);
    expect(endless.calls).toHaveLength(10);
    // A malformed row in a list is as unknown as a malformed list.
    const junk = clientOn(() => Response.json({ data: ["tr_1"], has_more: false }));
    expect(
      await stripeListTransfers(junk.client, { destination: "acct_1", group: GROUP }).catch((e: unknown) => e),
    ).toBeInstanceOf(StripeOutcomeUnknown);
  });

  test("refuses a destination that is not an account and an empty group, before any request", async () => {
    const { client, calls } = clientOn(() => Response.json({ data: [], has_more: false }));
    for (const destination of ["", "cus_1", "acct_", "acct_1&x=y"])
      await expect(stripeListTransfers(client, { destination, group: GROUP })).rejects.toThrow(RangeError);
    await expect(client.listTransfers({ destination: "acct_1", transferGroup: "" })).rejects.toThrow(RangeError);
    expect(calls).toHaveLength(0);
  });
});

describe("the Stripe adapter", () => {
  test("transferStatus and listTransfers go through the client", async () => {
    const { f, calls } = fakeFetch((url) =>
      url.pathname === "/v1/transfers"
        ? Response.json({ data: [transfer()], has_more: false })
        : Response.json(transfer()),
    );
    const adapter = stripeAdapter({ client: { secretKey: "sk_test_x", fetch: f, retries: 0 } });
    expect((await adapter.transferStatus?.("tr_123"))?.amountCents).toBe(5000);
    expect(
      (await adapter.listTransfers?.({ destination: "acct_1Abc", group: GROUP }))?.map((t) => t.providerRef),
    ).toEqual(["tr_123"]);
    expect(calls.map((c) => c.url.pathname)).toEqual(["/v1/transfers/tr_123", "/v1/transfers"]);
  });

  test("cancelSubscription: at period end updates, otherwise deletes, under the caller's key", async () => {
    const { f, calls } = fakeFetch(() => Response.json({ id: "sub_1" }));
    const adapter = stripeAdapter({ client: { secretKey: "sk_test_x", fetch: f, retries: 0 } });
    await adapter.cancelSubscription?.("sub_1", { atPeriodEnd: true, idempotencyKey: "k1" });
    await adapter.cancelSubscription?.("sub_1", { atPeriodEnd: false, idempotencyKey: "k2" });
    expect(calls.map((c) => [c.init.method, c.url.pathname])).toEqual([
      ["POST", "/v1/subscriptions/sub_1"],
      ["DELETE", "/v1/subscriptions/sub_1"],
    ]);
    expect(calls.map((c) => (c.init.headers as Record<string, string>)["idempotency-key"])).toEqual(["k1", "k2"]);
  });

  test("paymentFee: only a PaymentIntent is asked; anything else has no fee yet", async () => {
    const { f, calls } = fakeFetch(() =>
      Response.json({ id: "pi_1", latest_charge: { balance_transaction: { fee: 59, currency: "USD" } } }),
    );
    const adapter = stripeAdapter({ client: { secretKey: "sk_test_x", fetch: f, retries: 0 } });
    expect(await adapter.paymentFee?.("CA-ABCDEFGH")).toBeNull();
    expect(calls).toHaveLength(0);
    expect(await adapter.paymentFee?.("pi_1")).toEqual({ feeCents: 59, currency: "usd" });
  });
});
