// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Payment-provider adapters: `manual` (default) and the optional `stripe`. See README.md.
 * Stripe modules are only reachable through `createAdapter` and the `loadStripe*` loaders (dynamic
 * imports), so the manual path never loads them; their types are re-exported type-only.
 */
export * from "./adapter.ts";
export * from "./factory.ts";
export * from "./format.ts";
export * from "./manual.ts";
export * from "./reference.ts";
export type { StripeAction, StripeEventEnvelope, StripeRefundItem } from "./stripe-events.ts";
export type { SignatureCheck } from "./stripe-signature.ts";
export type { StripeClient, StripeClientOptions } from "./stripe-client.ts";
