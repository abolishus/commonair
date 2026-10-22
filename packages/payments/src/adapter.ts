// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The payment-provider adapter interface (ADR 0003, AGENTS.md rule 3): `manual` is the default
 * and needs no vendor; `stripe` is optional. Adapters talk to the provider only. Ledger postings,
 * subscription state, events and audit rows are the caller's, written in the caller's transaction
 * from the normalized results returned here.
 *
 * Draft by the head agent; the E4b payments unit owns and may refine it (report changes).
 */
import type { PAYMENT_KINDS, PAYMENT_PROVIDERS } from "@commonair/contracts/enums";

export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

export interface CheckoutRequest {
  /** Our `payments.id`, minted before the call so the provider can carry it as metadata. */
  paymentId: string;
  kind: PaymentKind;
  /** Total in integer minor units (gift subs: quantity × price). */
  amountCents: number;
  currency: string;
  /** Subscriptions and gifts. */
  tier?: 1 | 2 | 3;
  quantity: number;
  /** Self subscriptions renew; gifts and tips are one-off. */
  recurring: boolean;
  payerUserId: string;
  /** The channel owner paid; null for a `membership_share` (paid to the co-op, not a creator). */
  creatorUserId: string | null;
  /** Absolute URLs on this instance the provider may send the payer back to. */
  successUrl: string;
  cancelUrl: string;
  /** Our `subscriptions.id` for a self subscription (the provider carries it as metadata). */
  subscriptionId?: string;
  /**
   * Show a pending checkout again: the reference minted the first time. Providers with
   * idempotent checkout (Stripe) then return the same session.
   */
  reference?: string;
}

export type CheckoutStart =
  | { kind: "redirect"; url: string; providerRef: string }
  | { kind: "instructions"; providerRef: string; instructions: string };

export interface RefundRequest {
  paymentId: string;
  /** The payment's `provider_ref` once it succeeded (Stripe: the PaymentIntent id). */
  providerRef: string;
  amountCents: number;
  idempotencyKey: string;
}

export interface PayoutOnboardingRequest {
  userId: string;
  /** The creator's existing provider account, or null to create one. */
  accountId: string | null;
  returnUrl: string;
  refreshUrl: string;
}

/**
 * Provider-managed adapters (Stripe) implement the optional methods; the manual adapter has
 * none (the treasurer does those things by hand). Callers check for a method before using it.
 */
export interface PaymentAdapter {
  readonly provider: PaymentProvider;
  startCheckout(request: CheckoutRequest): Promise<CheckoutStart>;
  /** Stop a provider subscription renewing (at period end) or end it now. */
  cancelSubscription?(
    providerSubscriptionRef: string,
    opts: { atPeriodEnd: boolean; idempotencyKey: string },
  ): Promise<void>;
  /** Ask the provider to refund; the posting follows the provider's refund event. */
  refund?(request: RefundRequest): Promise<{ providerRef: string }>;
  /** Create the creator's payout account if needed and return an onboarding link. */
  payoutOnboarding?(request: PayoutOnboardingRequest): Promise<{ accountId: string; url: string }>;
  /** Whether the creator's provider account can receive payouts now. */
  payoutAccountStatus?(accountId: string): Promise<{ payoutsEnabled: boolean }>;
  /**
   * The processor fee of a succeeded payment (Stripe: its charge's balance transaction), or null
   * while the provider has not attached it yet (callers retry; they never book a fee of 0).
   */
  paymentFee?(providerPaymentRef: string): Promise<{ feeCents: number; currency: string } | null>;
}
