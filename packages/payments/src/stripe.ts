// SPDX-FileCopyrightText: 2026 CommonAir contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The Stripe adapter (optional, test mode only; AGENTS.md rule 3). Loaded lazily by
 * `createAdapter`, so nothing here is imported while `PAYMENTS_PROVIDER=manual`.
 *
 * Checkout is Stripe Checkout: `mode=subscription` (inline `price_data` with a monthly
 * `recurring`) for self subscriptions, `mode=payment` for gifts and tips. Every session carries our
 * payment id (`client_reference_id`, `metadata.payment_id`, and on the PaymentIntent or the
 * subscription), so webhook events find the payment without Stripe's ids. While pending the
 * payment's `provider_ref` is our `CA-…` reference; the webhook replaces it with Stripe's
 * PaymentIntent id when the money arrives.
 */
import type {
  CheckoutRequest,
  CheckoutStart,
  PaymentAdapter,
  PayoutOnboardingRequest,
  RefundRequest,
  RefundStatus,
  TransferRequest,
} from "./adapter.ts";
import { StripeRequestError } from "./errors.ts";
import { manualReference } from "./reference.ts";
import type { FormObject } from "./stripe-form.ts";
import { type StripeClient, type StripeClientOptions, stripeClient } from "./stripe-client.ts";
import { stripeTransfer } from "./stripe-transfers.ts";

export interface StripeAdapterOptions {
  client: StripeClient | StripeClientOptions;
  /** Injectable for tests. */
  reference?: () => string;
}

const productName = (r: CheckoutRequest): string => {
  if (r.kind === "tip") return "Tip";
  if (r.recurring) return `Tier ${r.tier ?? 1} subscription`;
  return `Tier ${r.tier ?? 1} gift subscription`;
};

/** The Checkout Session parameters for a request (exported for tests). */
export function checkoutSessionParams(r: CheckoutRequest, reference: string): FormObject {
  // Member shares are manual-only in E5 (ADR 0020): a Stripe share needs refunds and webhooks first.
  if (r.kind === "membership_share") throw new RangeError("member shares are not sold through Stripe");
  if (!Number.isSafeInteger(r.amountCents) || r.amountCents <= 0) throw new RangeError("amount must be positive cents");
  if (!Number.isSafeInteger(r.quantity) || r.quantity < 1) throw new RangeError("quantity must be at least 1");
  // Integer cents only: a gift total is quantity × the tier price.
  if (r.amountCents % r.quantity !== 0) throw new RangeError("amount must divide evenly by quantity");
  const metadata = {
    payment_id: r.paymentId,
    reference,
    kind: r.kind,
    ...(r.subscriptionId ? { subscription_id: r.subscriptionId } : {}),
  };
  const priceData: FormObject = {
    currency: r.currency,
    unit_amount: r.amountCents / r.quantity,
    product_data: { name: productName(r) },
    ...(r.recurring ? { recurring: { interval: "month" } } : {}),
  };
  return {
    mode: r.recurring ? "subscription" : "payment",
    client_reference_id: r.paymentId,
    success_url: r.successUrl,
    cancel_url: r.cancelUrl,
    line_items: [{ price_data: priceData, quantity: r.quantity }],
    metadata,
    ...(r.recurring ? { subscription_data: { metadata } } : { payment_intent_data: { metadata } }),
  };
}

export function stripeAdapter(opts: StripeAdapterOptions): PaymentAdapter {
  const client = "createCheckoutSession" in opts.client ? opts.client : stripeClient(opts.client);
  const mint = opts.reference ?? (() => manualReference());
  return {
    provider: "stripe",
    async startCheckout(request: CheckoutRequest): Promise<CheckoutStart> {
      const reference = request.reference ?? mint();
      const session = await client.createCheckoutSession(
        checkoutSessionParams(request, reference),
        `checkout-${request.paymentId}`,
      );
      return { kind: "redirect", url: session.url, providerRef: reference };
    },
    async cancelSubscription(ref, o) {
      if (o.atPeriodEnd) await client.cancelSubscriptionAtPeriodEnd(ref, o.idempotencyKey);
      else await client.cancelSubscriptionNow(ref, o.idempotencyKey);
    },
    async refund(r: RefundRequest) {
      if (!r.providerRef.startsWith("pi_")) throw new RangeError("this payment has no Stripe PaymentIntent to refund");
      const refund = await client.createRefund(
        {
          payment_intent: r.providerRef,
          amount: r.amountCents,
          // refund_key lets the reconciler match a refund whose create answer was lost.
          metadata: { payment_id: r.paymentId, refund_key: r.idempotencyKey },
        },
        r.idempotencyKey,
      );
      return { providerRef: refund.id };
    },
    async listRefunds(pi: string) {
      return (await client.listRefunds({ paymentIntent: pi })).map((r) => ({
        id: r.id,
        amount: r.amount,
        currency: r.currency,
        status: r.status,
        metadata: r.metadata,
      }));
    },
    async payoutOnboarding(r: PayoutOnboardingRequest) {
      const accountId =
        r.accountId ??
        (
          await client.createExpressAccount(
            {
              type: "express",
              capabilities: { transfers: { requested: true } },
              metadata: { user_id: r.userId },
            },
            `connect-account-${r.userId}`,
          )
        ).id;
      const link = await client.createAccountLink(
        { account: accountId, refresh_url: r.refreshUrl, return_url: r.returnUrl, type: "account_onboarding" },
        `account-link-${accountId}-${crypto.randomUUID()}`,
      );
      return { accountId, url: link.url };
    },
    async payoutAccountStatus(accountId) {
      return { payoutsEnabled: (await client.retrieveAccount(accountId)).payoutsEnabled };
    },
    async paymentFee(ref) {
      if (!ref.startsWith("pi_")) return null;
      return client.paymentIntentFee(ref);
    },
    transfer(r: TransferRequest) {
      return stripeTransfer(client, r);
    },
    async refundStatus(ref) {
      // `pyr_` refunds come from some payment methods; any other id is not a refund of ours.
      if (!/^(re|pyr)_/.test(ref)) return null;
      let refund: Awaited<ReturnType<StripeClient["retrieveRefund"]>>;
      try {
        refund = await client.retrieveRefund(ref);
      } catch (err) {
        // A definite "no such refund"; anything else (unknown outcome) is the caller's to retry.
        if (err instanceof StripeRequestError && err.status === 404) return null;
        throw err;
      }
      return {
        providerRef: refund.id,
        status: refundStatusOf(refund.status),
        amountCents: refund.amount,
        currency: refund.currency,
      };
    },
  };
}

/** Stripe's refund statuses, normalized (`requires_action` waits like `pending`). */
export function refundStatusOf(status: string | null): RefundStatus["status"] {
  switch (status) {
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    default:
      return "pending";
  }
}
