// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PaymentAdapter, PaymentProvider } from "./adapter.ts";
import { manualAdapter } from "./manual.ts";

/** The `paymentsEnv` fields the factory reads (structural, so this package does not need config). */
export interface PaymentsEnvLike {
  PAYMENTS_PROVIDER: PaymentProvider;
  MANUAL_PAYMENT_INSTRUCTIONS: string;
}

export class AdapterUnavailableError extends Error {
  override name = "AdapterUnavailableError";
}

/** The adapter for `PAYMENTS_PROVIDER`. Stripe is optional and lands with its own unit. */
export function createAdapter(env: PaymentsEnvLike): PaymentAdapter {
  switch (env.PAYMENTS_PROVIDER) {
    case "manual":
      return manualAdapter({ instructions: env.MANUAL_PAYMENT_INSTRUCTIONS });
    case "stripe":
      throw new AdapterUnavailableError("the stripe payment adapter is not built yet");
  }
}
