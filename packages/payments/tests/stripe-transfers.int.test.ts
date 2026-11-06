// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * M1-connect: `stripeTransfer` against stripe-mock (compose profile `stripe`). stripe-mock is
 * stateless: it checks the form against Stripe's OpenAPI spec and echoes the amount, currency and
 * destination into a fixture with a fresh id, so this checks the path, the encoding and the
 * mapping, not Stripe's idempotency. Skipped (with a note) when stripe-mock is not running, except
 * in CI; `STRIPE_MOCK_URL` points at another one.
 */
import { describe, expect, test } from "vite-plus/test";
import { StripeRequestError, type TransferRequest, createAdapter } from "../src/index.ts";
import { stripeAdapter } from "../src/stripe.ts";
import { stripeClient } from "../src/stripe-client.ts";
import { payoutTransferKey, stripeTransfer } from "../src/stripe-transfers.ts";

const BASE = process.env.STRIPE_MOCK_URL ?? "http://127.0.0.1:12111";
const KEY = "sk_test_123";

async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/v1/customers`, {
      headers: { authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(1_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
const up = await reachable();
if (!up && process.env.CI) throw new Error(`stripe-mock is not reachable at ${BASE} (CI is set)`);
if (!up) console.warn(`stripe-mock is not reachable at ${BASE}; skipping its tests`);

const requestFor = (payoutId: string, over: Partial<TransferRequest> = {}): TransferRequest => ({
  payoutId,
  transferId: crypto.randomUUID(),
  destination: "acct_1Harness",
  amountCents: 4321,
  currency: "usd",
  group: "2026-10-01T00:00:00.000Z",
  idempotencyKey: payoutTransferKey(payoutId),
  ...over,
});

describe.skipIf(!up)("stripeTransfer against stripe-mock", () => {
  const client = stripeClient({ secretKey: KEY, apiBase: BASE, retries: 0 });

  test("creates a transfer and maps it", async () => {
    const r = await stripeTransfer(client, requestFor(crypto.randomUUID()));
    expect(r.providerRef).toMatch(/^tr_/);
    expect(r).toMatchObject({ amountCents: 4321, currency: "usd" });
    expect((await client.retrieveTransfer(r.providerRef)).id).toBe(r.providerRef);
  });

  test("two payouts are two transfers", async () => {
    const adapter = stripeAdapter({ client });
    const a = await adapter.transfer?.(requestFor(crypto.randomUUID()));
    const b = await adapter.transfer?.(requestFor(crypto.randomUUID()));
    expect(a?.providerRef).toMatch(/^tr_/);
    expect(b?.providerRef).toMatch(/^tr_/);
    expect(a?.providerRef).not.toBe(b?.providerRef);
  });

  test("a form Stripe's spec refuses is a definite refusal", async () => {
    // stripe-mock validates types, not values: an amount that is not an integer is a 400.
    const err = await client
      .createTransfer({ amount: "lots", currency: "usd", destination: "acct_1" }, `bad-${crypto.randomUUID()}`)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeRequestError);
  });
});

describe.skipIf(!up)("transfer lookups against stripe-mock", () => {
  const client = stripeClient({ secretKey: KEY, apiBase: BASE, retries: 0 });

  test("transferStatus maps a transfer Stripe holds (stripe-mock answers its fixture for any id)", async () => {
    const adapter = stripeAdapter({ client });
    const s = await adapter.transferStatus?.("tr_1Lookup");
    expect(s).toMatchObject({ providerRef: "tr_1Lookup", currency: "usd", metadata: {} });
    expect(s?.destination).toMatch(/^acct_/);
    expect(Number.isSafeInteger(s?.amountCents)).toBe(true);
    expect(Number.isSafeInteger(s?.reversedCents)).toBe(true);
    // Not a transfer id: no request, no answer.
    expect(await adapter.transferStatus?.("re_1Lookup")).toBeNull();
  });

  test("listTransfers sends destination and transfer_group as Stripe's spec takes them", async () => {
    const listed = await stripeAdapter({ client }).listTransfers?.({
      destination: "acct_1Harness",
      group: "2026-10-01T00:00:00.000Z",
    });
    expect(Array.isArray(listed)).toBe(true);
    for (const t of listed ?? []) expect(t.providerRef).toMatch(/^tr_/);
  });

  test("the env adapter (lazy Stripe) looks transfers up too", async () => {
    const adapter = createAdapter({
      PAYMENTS_PROVIDER: "stripe",
      MANUAL_PAYMENT_INSTRUCTIONS: "",
      STRIPE_SECRET_KEY: KEY,
      STRIPE_API_BASE: BASE,
    });
    expect((await adapter.transferStatus?.("tr_1Env"))?.providerRef).toBe("tr_1Env");
    expect(Array.isArray(await adapter.listTransfers?.({ destination: "acct_1Env", group: "g" }))).toBe(true);
  });

  test("every lazy Stripe method reaches the Stripe module (one request each)", async () => {
    const a = createAdapter({
      PAYMENTS_PROVIDER: "stripe",
      MANUAL_PAYMENT_INSTRUCTIONS: "",
      STRIPE_SECRET_KEY: KEY,
      STRIPE_API_BASE: BASE,
    });
    const paymentId = crypto.randomUUID();
    const start = await a.startCheckout({
      paymentId,
      kind: "tip",
      amountCents: 500,
      currency: "usd",
      quantity: 1,
      recurring: false,
      payerUserId: crypto.randomUUID(),
      creatorUserId: crypto.randomUUID(),
      successUrl: "https://example.test/ok",
      cancelUrl: "https://example.test/no",
    });
    expect(start.kind).toBe("redirect");
    await a.cancelSubscription?.("sub_1Env", { atPeriodEnd: true, idempotencyKey: `c-${paymentId}` });
    expect(
      (await a.refund?.({ paymentId, providerRef: "pi_1Env", amountCents: 100, idempotencyKey: `r-${paymentId}` }))
        ?.providerRef,
    ).toMatch(/^re_/);
    expect(
      (
        await a.payoutOnboarding?.({
          userId: paymentId,
          accountId: "acct_1Env",
          returnUrl: "https://example.test/r",
          refreshUrl: "https://example.test/f",
        })
      )?.accountId,
    ).toBe("acct_1Env");
    expect(typeof (await a.payoutAccountStatus?.("acct_1Env"))?.payoutsEnabled).toBe("boolean");
    expect(await a.paymentFee?.("CA-NOTSTRIPE")).toBeNull();
    expect((await a.refundStatus?.("re_1Env"))?.providerRef).toBe("re_1Env");
    expect(Array.isArray(await a.listRefunds?.("pi_1Env"))).toBe(true);
  });
});
