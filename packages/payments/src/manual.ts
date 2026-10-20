// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The manual adapter (the default): no vendor and no network. The payer gets a `CA-XXXXXXXX`
 * reference and the operator's instructions; the treasurer confirms receipt later.
 */
import type { CheckoutRequest, CheckoutStart, PaymentAdapter } from "./adapter.ts";
import { fillInstructions, formatPlainAmount } from "./format.ts";
import { manualReference } from "./reference.ts";

export interface ManualAdapterOptions {
  /** `MANUAL_PAYMENT_INSTRUCTIONS`: `{reference}` and `{amount}` are filled in. */
  instructions: string;
  /** Injectable for tests. */
  reference?: () => string;
}

/** The payer's instructions for a reference and amount (also used to show a pending checkout again). */
export function manualInstructions(template: string, reference: string, amountCents: number, currency: string): string {
  return fillInstructions(template, { reference, amount: formatPlainAmount(amountCents, currency) });
}

export function manualAdapter(opts: ManualAdapterOptions): PaymentAdapter {
  const mint = opts.reference ?? (() => manualReference());
  return {
    provider: "manual",
    async startCheckout(request: CheckoutRequest): Promise<CheckoutStart> {
      const providerRef = mint();
      const instructions = manualInstructions(opts.instructions, providerRef, request.amountCents, request.currency);
      return { kind: "instructions", providerRef, instructions };
    },
  };
}
