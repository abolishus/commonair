// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Batch 8 money seams (contract step §2.5-§2.7): the new treasurer and patronage procedures are
 * routed, access-checked and answer 501 until their units fill them; the new Stripe webhook
 * actions reach their stub handlers and answer `ignored`; a gift checkout marks its payment.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";
import { schema } from "@commonair/db";
import { loadStripeSignature } from "@commonair/payments";
import { signUpAndSignIn, startApi, type TestApi } from "./harness.ts";

type Account = Awaited<ReturnType<typeof signUpAndSignIn>>;

const SECRET = "whsec_b8_seams";
let api: TestApi;
let treasurer: Account;
let viewer: Account;

beforeAll(async () => {
  api = await startApi();
  [treasurer, viewer] = await Promise.all([signUpAndSignIn(api), signUpAndSignIn(api)]);
  await api.db.db.update(schema.users).set({ role: "treasurer" }).where(eq(schema.users.id, treasurer.userId));
}, 180_000);
afterAll(async () => {
  await api?.stop();
});

const ID = "01890000-0000-7000-8000-0000000000b8";

describe("the new procedures are stubs behind their access levels", () => {
  const routes: [method: string, path: string, body?: unknown][] = [
    ["GET", "/api/treasurer/refund-requests?state=unknown"],
    ["POST", `/api/treasurer/refund-requests/${ID}/resolve`, { outcome: "failed" }],
    ["GET", "/api/treasurer/payout-transfers"],
    ["GET", `/api/coop/patronage/${ID}/payouts`],
    ["POST", `/api/coop/patronage/${ID}/pay`, {}],
  ];

  test("a treasurer gets 501", async () => {
    for (const [method, path, body] of routes) {
      const r = await treasurer.client.call(method, path, body);
      expect([path, r.status]).toEqual([path, 501]);
    }
  });

  test("anyone else is refused before the stub", async () => {
    for (const [method, path, body] of routes) {
      const r = await viewer.client.call(method, path, body);
      expect([path, r.status]).toEqual([path, 403]);
    }
  });
});

describe("the new webhook actions reach their handlers", () => {
  beforeAll(() => {
    Object.assign(api.deps.env, {
      PAYMENTS_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_test_b8",
      STRIPE_WEBHOOK_SECRET: SECRET,
      STRIPE_API_BASE: "http://127.0.0.1:9",
    });
  });
  afterAll(() => {
    Object.assign(api.deps.env, { PAYMENTS_PROVIDER: "manual" });
  });

  async function deliver(type: string, object: Record<string, unknown>) {
    const { signStripePayload } = await loadStripeSignature();
    const evt = {
      id: `evt_${crypto.randomUUID().replace(/-/g, "")}`,
      object: "event",
      type,
      api_version: "2024-06-20",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: { object },
    };
    const body = JSON.stringify(evt);
    const header = await signStripePayload(SECRET, body, Math.floor(Date.now() / 1000));
    const res = await fetch(`${api.url}/api/webhooks/stripe`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": header },
      body,
    });
    return { status: res.status, body: (await res.json()) as { outcome?: string } };
  }

  test("transfer.reversed, transfer.updated and refund.updated answer ignored", async () => {
    const transfer = {
      id: "tr_b8",
      object: "transfer",
      amount: 5000,
      amount_reversed: 5000,
      currency: "usd",
      destination: "acct_b8",
      reversed: true,
      metadata: { payout_id: ID, transfer_id: ID },
    };
    expect(await deliver("transfer.reversed", transfer)).toEqual({
      status: 200,
      body: { received: true, outcome: "ignored" },
    });
    expect((await deliver("transfer.updated", transfer)).body.outcome).toBe("ignored");
    const refund = {
      id: "re_b8",
      object: "refund",
      amount: 100,
      currency: "usd",
      status: "succeeded",
      payment_intent: "pi_b8",
    };
    expect((await deliver("refund.updated", refund)).body.outcome).toBe("ignored");
    // A failure is still the existing refund.failed path.
    expect((await deliver("refund.updated", { ...refund, status: "failed" })).body.outcome).toBe("unknown_payment");
  });
});
