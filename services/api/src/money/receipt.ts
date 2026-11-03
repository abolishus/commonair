// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The payment receipt email (batch 8, M1-gifts-refunds; template `paymentReceipt`). Called after
 * commit wherever a payment becomes `succeeded`: the Stripe `checkout.completed` and `invoice.paid`
 * paths (`stripe-webhook.ts`) and the treasurer's manual confirm (`checkout-treasurer.ts`). A stub
 * until that unit fills it: it does nothing. Filled, it sends once per payment, in the payer's
 * locale, with the `PaymentBreakdown` lines, and logs the payment id only.
 */
import type { Deps } from "../deps.ts";

export async function sendPaymentReceipt(_deps: Deps, _paymentId: string): Promise<void> {}
