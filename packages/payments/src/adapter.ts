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

/**
 * One payout's transfer to the payee's provider account (batch 8, M1-connect). Metadata carries
 * ids only, never a name or an email.
 */
export interface TransferRequest {
  /** Our `payouts.id`. */
  payoutId: string;
  /** Our `payout_transfers.id`. */
  transferId: string;
  /** The payee's provider account (Stripe: the Express account, `acct_…`). */
  destination: string;
  amountCents: number;
  currency: string;
  /** Groups a payout run's transfers at the provider (the run's period start, ISO). */
  group: string;
  /** Stable across retries (`payout-transfer:<payoutId>`), so a retry returns the same transfer. */
  idempotencyKey: string;
}

export interface TransferResult {
  /** The provider's transfer id (Stripe `tr_…`). */
  providerRef: string;
  amountCents: number;
  currency: string;
}

/**
 * A transfer as the provider holds it (follow-ups, unit money): what a treasurer's "Stripe sent
 * it" is checked against before it is recorded. Metadata is ours (`payout_id`, `transfer_id`).
 */
export interface TransferStatus {
  providerRef: string;
  amountCents: number;
  currency: string;
  /** The connected account paid (Stripe `acct_…`). */
  destination: string;
  /** Every reversal so far (integer minor units). */
  reversedCents: number;
  metadata: Record<string, string>;
}

/** What the provider says became of a refund (batch 8, M1-gifts-refunds' reconciliation). */
export interface RefundStatus {
  providerRef: string;
  /** Normalized: `pending` covers Stripe's `pending` and `requires_action`. */
  status: "pending" | "succeeded" | "failed" | "canceled";
  amountCents: number;
  currency: string;
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
  /**
   * Batch 8 (M1-connect): pay one payout to the payee's provider account. Throws
   * `StripeRequestError` on a definite refusal and `StripeOutcomeUnknown` when the provider may
   * have acted (retry with the same idempotency key). The manual adapter has none: nothing moves.
   */
  transfer?(request: TransferRequest): Promise<TransferResult>;
  /**
   * Batch 8 (M1-gifts-refunds): a refund's state at the provider, by its id, or null when the
   * provider has no such refund.
   */
  refundStatus?(providerRef: string): Promise<RefundStatus | null>;
  /**
   * Batch 8 (M1-gifts-refunds' reconciler): every refund of a PaymentIntent as the provider lists
   * it, with our metadata (`payment_id`, `refund_key`), to settle a refund whose outcome is unknown.
   */
  listRefunds?(paymentIntent: string): Promise<ListedRefund[]>;
  /**
   * Follow-ups (unit money): one transfer by the provider's id, or null when the provider has no
   * such transfer (a definite answer; anything the provider did not answer throws).
   */
  transferStatus?(transferRef: string): Promise<TransferStatus | null>;
  /**
   * Follow-ups (unit money): every transfer to one connected account in one payout run. Stripe
   * lists by `destination` and `transfer_group` and cannot search transfers by metadata or by
   * idempotency key, so a caller looks through these for one carrying its payout's metadata.
   */
  listTransfers?(query: { destination: string; group: string }): Promise<TransferStatus[]>;
}

/** A refund as the provider lists it (`listRefunds`). */
export interface ListedRefund {
  id: string;
  amount: number;
  currency: string;
  /** The provider's status, or null when it sent none. */
  status: string | null;
  metadata: Record<string, string>;
}
