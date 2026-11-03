// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The batch 8 client calls against stripe-mock (compose profile `stripe`, image pinned in
 * compose.yaml): `createTransfer`, `retrieveTransfer`, `retrieveRefund`, `listRefunds`, the
 * adapter's `refundStatus`, and a definite 4xx. stripe-mock is stateless: it validates the request
 * against Stripe's OpenAPI spec and answers a fixture, so these check the paths, the form encoding
 * and the answer mapping, not Stripe's behaviour. Skipped (with a note) when stripe-mock is not
 * running; `STRIPE_MOCK_URL` points at another one.
 */
import { describe, expect, test } from "vite-plus/test";
import { StripeRequestError } from "../src/index.ts";
import { stripeAdapter } from "../src/stripe.ts";
import { stripeClient } from "../src/stripe-client.ts";

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
// CI starts stripe-mock with the test infra (scripts/infra.ts TEST_SERVICES): a skip there would
// leave the client's Stripe calls untested, so it fails instead.
if (!up && process.env.CI) throw new Error(`stripe-mock is not reachable at ${BASE} (CI is set)`);
if (!up) console.warn(`stripe-mock is not reachable at ${BASE}; skipping its tests`);

describe.skipIf(!up)("StripeClient against stripe-mock", () => {
  const client = stripeClient({ secretKey: KEY, apiBase: BASE, retries: 0 });

  test("createTransfer and retrieveTransfer", async () => {
    const t = await client.createTransfer(
      {
        amount: 5000,
        currency: "usd",
        destination: "acct_1",
        transfer_group: "2026-10-01T00:00:00.000Z",
        metadata: { payout_id: "po_1", transfer_id: "pt_1" },
      },
      `payout-transfer:${crypto.randomUUID()}`,
    );
    expect(t.id).toMatch(/^tr_/);
    expect(t.amount).toBe(5000);
    expect(t.currency).toBe("usd");
    expect(t.destination).toBe("acct_1");
    expect(typeof t.reversed).toBe("boolean");
    expect(Number.isSafeInteger(t.amountReversed)).toBe(true);
    const again = await client.retrieveTransfer(t.id);
    expect(again.id).toBe(t.id);
    expect(again.amount).toBeGreaterThan(0);
  });

  test("retrieveRefund and listRefunds", async () => {
    const r = await client.retrieveRefund("re_123");
    expect(r.id).toBe("re_123");
    expect(r.amount).toBeGreaterThan(0);
    expect(r.currency).toMatch(/^[a-z]{3}$/);
    const list = await client.listRefunds({ paymentIntent: "pi_123" });
    expect(list.length).toBeGreaterThan(0);
    for (const x of list) expect(x.id).toMatch(/^re_/);
  });

  test("the adapter's refundStatus", async () => {
    const adapter = stripeAdapter({ client });
    const s = await adapter.refundStatus?.("re_123");
    expect(s?.providerRef).toBe("re_123");
    expect(["pending", "succeeded", "failed", "canceled"]).toContain(s?.status);
  });

  test("a request Stripe's spec refuses is a definite StripeRequestError", async () => {
    // A transfer needs a currency: stripe-mock answers 400 from the OpenAPI schema.
    const err = await client
      .createTransfer({ amount: 5000, destination: "acct_1" }, `bad-${crypto.randomUUID()}`)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StripeRequestError);
    expect((err as StripeRequestError).status).toBe(400);
  });
});
