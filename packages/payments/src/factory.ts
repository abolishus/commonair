// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PaymentAdapter, PaymentProvider } from "./adapter.ts";
import { manualAdapter } from "./manual.ts";

/** The `paymentsEnv` fields the factory reads (structural, so this package does not need config). */
export interface PaymentsEnvLike {
  PAYMENTS_PROVIDER: PaymentProvider;
  MANUAL_PAYMENT_INSTRUCTIONS: string;
  STRIPE_SECRET_KEY?: string | undefined;
  STRIPE_API_BASE?: string | undefined;
}

export class AdapterUnavailableError extends Error {
  override name = "AdapterUnavailableError";
}

/** Same rule as `stripeKeyProblem` (kept here so the manual path never loads Stripe code). */
function stripeKeyProblem(key: string | undefined): string | null {
  if (!key) return "STRIPE_SECRET_KEY is not set";
  if (/^(sk|rk)_live_/.test(key)) return "live Stripe keys are refused";
  if (!/^(sk|rk)_test_/.test(key)) return "STRIPE_SECRET_KEY must be a test key";
  return null;
}

/** The Stripe module, imported on first use only (AGENTS.md rule 3: manual never loads it). */
export const loadStripe = () => import("./stripe.ts");
export const loadStripeEvents = () => import("./stripe-events.ts");
export const loadStripeSignature = () => import("./stripe-signature.ts");

function lazyStripeAdapter(env: PaymentsEnvLike): PaymentAdapter {
  const problem = stripeKeyProblem(env.STRIPE_SECRET_KEY);
  if (problem) throw new AdapterUnavailableError(problem);
  const secretKey = env.STRIPE_SECRET_KEY ?? "";
  let adapter: Promise<PaymentAdapter> | null = null;
  const get = () =>
    (adapter ??= loadStripe().then((m) => m.stripeAdapter({ client: { secretKey, apiBase: env.STRIPE_API_BASE } })));
  return {
    provider: "stripe",
    startCheckout: async (r) => (await get()).startCheckout(r),
    cancelSubscription: async (ref, o) => (await get()).cancelSubscription?.(ref, o),
    refund: async (r) => {
      const a = await get();
      if (!a.refund) throw new AdapterUnavailableError("refunds are not supported");
      return a.refund(r);
    },
    payoutOnboarding: async (r) => {
      const a = await get();
      if (!a.payoutOnboarding) throw new AdapterUnavailableError("payout onboarding is not supported");
      return a.payoutOnboarding(r);
    },
    paymentFee: async (ref) => (await get()).paymentFee?.(ref) ?? null,
  };
}

/** The adapter for `PAYMENTS_PROVIDER`. */
export function createAdapter(env: PaymentsEnvLike): PaymentAdapter {
  switch (env.PAYMENTS_PROVIDER) {
    case "manual":
      return manualAdapter({ instructions: env.MANUAL_PAYMENT_INSTRUCTIONS });
    case "stripe":
      return lazyStripeAdapter(env);
  }
}
