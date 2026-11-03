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
import { StripeRequestError, type TransferRequest } from "../src/index.ts";
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
