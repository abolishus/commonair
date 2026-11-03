// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stripe Connect transfers (batch 8, M1-connect; ADR 0007 Amendment 1, decision (f)). The stripe
 * adapter's `transfer` calls this. A stub until M1-connect fills it: it builds the form (amount,
 * currency, destination, `transfer_group`, ids-only metadata) and maps Stripe's answer with
 * `StripeClient.createTransfer`, under the request's idempotency key.
 */
import type { TransferRequest, TransferResult } from "./adapter.ts";
import { AdapterUnavailableError } from "./factory.ts";
import type { StripeClient } from "./stripe-client.ts";

export function stripeTransfer(_client: StripeClient, _request: TransferRequest): Promise<TransferResult> {
  return Promise.reject(new AdapterUnavailableError("Connect transfers are not implemented yet"));
}
