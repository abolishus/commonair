// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Automatic refund of money collected for an ended subscription (batch 8, M1-gifts-refunds; ADR
 * 0007 decision 2). Runs after the webhook's transaction commits, outside the row lock. A stub until
 * that unit fills it: it will ask the provider for the full unrefunded amount through
 * `requestProviderRefund` (system actor, under the one-outstanding-request guard), idempotently,
 * never reactivating the subscription. The posting still follows Stripe's `charge.refunded`.
 */
import type { Deps } from "../deps.ts";

export async function autoRefundAfterEnd(_deps: Deps, _paymentId: string): Promise<void> {}
