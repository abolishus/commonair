<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# @commonair/payments

Payment-provider adapters behind one interface (`src/adapter.ts`): `manual` (the default, no vendor)
and the optional `stripe` (test mode only). Adapters talk to the provider; callers own ledger
postings, subscription state, events and audit rows. `manualReference()` mints the `CA-XXXXXXXX`
references payers quote to the treasurer.

## Stripe (optional)

No SDK: a small `fetch` client (`stripe-client.ts`) with form-encoded bodies (`stripe-form.ts`),
bearer auth, `Stripe-Version: 2024-06-20` pinned, an idempotency key on every POST, a timeout per
attempt, retries on network errors and 5xx only. Live keys (`sk_live_`, `rk_live_`) are refused
before any request (and by `paymentsEnv`).

| File                  | What                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------- |
| `stripe.ts`           | The adapter: Checkout Sessions, subscription cancel, refunds, Connect onboarding, fees |
| `stripe-client.ts`    | The HTTP client for exactly those calls                                                |
| `stripe-signature.ts` | `Stripe-Signature` signing and verification (5-minute tolerance, several `v1` allowed) |
| `stripe-events.ts`    | Webhook events → normalized actions (pure)                                             |
| `stripe-form.ts`      | Nested params → `a[b][0][c]=v`                                                         |

**Nothing Stripe loads on the manual path** (AGENTS.md rule 3): `index.ts` re-exports Stripe
types only; `createAdapter` returns a lazy wrapper that imports `stripe.ts` on first use, and the
API loads its webhook module (and `loadStripeEvents` / `loadStripeSignature`) only when
`PAYMENTS_PROVIDER=stripe`.

Checkout: `mode=subscription` with inline `price_data` and a monthly `recurring` for self
subscriptions, `mode=payment` for gifts (quantity × the tier price) and tips. Every session
carries our payment id (`client_reference_id`, `metadata.payment_id`, and on the subscription or
the PaymentIntent), plus the `CA-…` reference the payment keeps while pending. The idempotency key
is `checkout-<paymentId>`, so showing a pending checkout again returns the same session.

Operators create **two** webhook endpoints in Stripe, both at `/api/webhooks/stripe` with API
version 2024-06-20 (the route accepts a signature from either secret):

1. **Account endpoint** (events on the platform account), secret `STRIPE_WEBHOOK_SECRET`:
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`, `invoice.paid`,
   `invoice.payment_failed`, `customer.subscription.deleted`, `charge.refunded`,
   `charge.dispute.created`, `charge.dispute.closed`, `refund.failed`.
2. **Connect endpoint** ("events on connected accounts"), secret `STRIPE_CONNECT_WEBHOOK_SECRET`:
   `account.updated` (only this type is acted on when this secret signs). Each visit to a creator's payout card also reads the account's
   `payouts_enabled` from Stripe, so a missed event heals.

Settle Stripe in the instance `CURRENCY` (fees in another currency cannot be posted and are
refused). A fee is never booked as 0 for a charge: until Stripe attaches the balance transaction
the event answers 500 and Stripe retries. `payment_events.payload` keeps a redacted copy of each
event (`redactStripeEvent`: the envelope and the ids, amounts, statuses and our metadata keys the
processor reads), never payer details.
