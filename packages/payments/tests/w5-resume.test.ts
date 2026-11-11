// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Overhaul wave 5 (ADR 0042): `resumeSubscription` turns renewal back on at Stripe
 * (`cancel_at_period_end=false`) under the caller's idempotency key, directly and through the lazy
 * factory adapter. The manual adapter has none: manual renewals are local rows.
 */
import { describe, expect, test } from "vite-plus/test";
import { createAdapter } from "../src/factory.ts";
import { manualAdapter } from "../src/manual.ts";
import { stripeAdapter } from "../src/stripe.ts";

function fakeFetch() {
  const calls: { url: URL; init: RequestInit }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init: init ?? {} });
    return Response.json({ id: "sub_1", object: "subscription" });
  }) as typeof fetch;
  return { f, calls };
}

describe("resumeSubscription", () => {
  test("posts cancel_at_period_end=false to the subscription with the key", async () => {
    const { f, calls } = fakeFetch();
    const adapter = stripeAdapter({ client: { secretKey: "sk_test_x", fetch: f, retries: 0 } });
    await adapter.resumeSubscription?.("sub_1", { idempotencyKey: "resume-k" });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.init.method).toBe("POST");
    expect(call.url.pathname).toBe("/v1/subscriptions/sub_1");
    expect(call.init.body).toBe("cancel_at_period_end=false");
    expect((call.init.headers as Record<string, string>)["idempotency-key"]).toBe("resume-k");
  });

  test("the factory's Stripe adapter offers it; the manual adapter does not", () => {
    const stripe = createAdapter({
      PAYMENTS_PROVIDER: "stripe",
      MANUAL_PAYMENT_INSTRUCTIONS: "x",
      STRIPE_SECRET_KEY: "sk_test_x",
    });
    expect("resumeSubscription" in stripe).toBe(true);
    expect("resumeSubscription" in manualAdapter({ instructions: "x" })).toBe(false);
  });
});
