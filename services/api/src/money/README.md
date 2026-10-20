<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Money in the API

Checkout and the treasurer's payment actions (`checkout*.ts`) and reports (`reports.ts`). The
contract is `money.*` in `@commonair/contracts`; the behaviour is the payment-flow table in
[docs/testing/e4b-selectors.md](../../../../docs/testing/e4b-selectors.md). The ledger
(`@commonair/ledger`) is the only record of money; `payments` only classifies a posting.

| File                    | What                                                                                     |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `checkout.ts`           | `support`, `tiers`, `setTiers`, `subscribe` (self and gift), `tip`, `mySubscriptions`, … |
| `checkout-treasurer.ts` | `treasurer.payments`, `confirm`, `refund`, `chargeback`, `setPayoutAccount`              |
| `checkout-rules.ts`     | Pure rules: tier validation, period arithmetic, refund outcomes (unit-tested)            |
| `checkout-shared.ts`    | DTO mapping, subscription endings with their events, chat invalidation                   |

## Rows a checkout writes

Nothing is posted until the treasurer confirms. Each checkout is one transaction.

- **Self subscription**: `subscriptions` (`incomplete`, today's tier price) and `payments`
  (`kind: subscription`, `subscription_id` set, `quantity: 1`).
- **Gift**: one `payments` row (`kind: subscription`, `subscription_id` **null**, `quantity` =
  count, amount = count × price) and one `incomplete` subscription per recipient with
  `gifted_by_id` and `gift_payment_id`. A payment is a gift exactly when its subscriptions point
  back through `gift_payment_id`.
- **Tip**: `tips` (`pending`, `payment_id`) and `payments` (`kind: tip`, `tip_id`). Anonymous tips
  keep `from_user_id` for refunds; DTOs and events show no tipper.

Every manual payment gets a fresh `CA-XXXXXXXX` reference (`provider_ref`) and `expires_at` = now

- `PAYMENT_PENDING_DAYS`. A collision on `payments_provider_ref_uq`, or a slot taken concurrently
  (`subscriptions_active_uq`), reruns the transaction (up to three times).

## State machines (manual adapter)

**Payment**

```
pending ──confirm──▶ succeeded ──refund (part)──▶ partially_refunded ──refund (rest)──▶ refunded
   │                    │                                │
   │                    └───────chargeback──────────────┴──────────▶ charged_back
   └──expiry (worker) / past-due cancel──▶ failed
```

**Subscription**

```
incomplete ──confirm──▶ active ──period end (worker)──▶ past_due ──confirm renewal──▶ active
     │                    │  └─ cancel_at_period_end / gift ─▶ canceled / expired (worker)
     │                    └─ full refund, chargeback ─▶ canceled
     └──payment expired (worker)──▶ expired          past_due ──cancel / refund / expiry──▶ canceled / expired
```

`cancelSubscription` on `active` sets `cancel_at_period_end` (idempotent); on `past_due` it ends
the subscription now and fails its pending renewal payment, so a later confirm is a `CONFLICT`.
Gifts cannot be cancelled by the recipient; they expire.

**Tip**: mirrors its payment (`pending` → `succeeded` → `refunded` / `partially_refunded` /
`charged_back`, or `failed`).

## What posts what

| Action                 | Ledger                                                             | Events                                                                                       | Audit                |
| ---------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------- |
| `treasurer.confirm`    | `paymentSucceeded` (cash, fee 0, tax 0, today's `platform.cut`)    | `channel.subscription.gift` (gifts), `channel.subscribe` per new subscription, `channel.tip` | `payment.confirm`    |
| `treasurer.refund`     | `postReversal` `refund` (the cut recorded on the original posting) | `channel.subscription.end` when fully refunded                                               | `payment.refund`     |
| `treasurer.chargeback` | `postReversal` `chargeback` (released → hold → creator receivable) | `channel.subscription.end`                                                                   | `payment.chargeback` |
| `setPayoutAccount`     | none (re-pends `held` payouts with `payout_account_not_ready`)     | none                                                                                         | `payout_account.set` |
| past-due cancel        | none                                                               | `channel.subscription.end`                                                                   | none                 |

A confirmed subscription runs one calendar month in UTC from `receivedAt` (Jan 31 → Feb 28/29);
a renewal continues from the previous `current_period_end` and copies the payment's
`amount_cents` and `currency` into the subscription (the worker charges today's tier price).
Renewals emit no `channel.subscribe`. Treasurer audit rows use `actorType: "admin"`; the free-text
reason goes to `disputes.reason` and the audit `reason`, never into ledger or audit `details`.
After commit the API publishes a chat `invalidate` (`scope: "user"`) for every subscriber whose
status changed, so badges follow.

## Locks

Lock order everywhere in money code (API and worker): **payout batch → payment row →
subscription rows → ledger creator lock**. `confirm`, `refund` and `chargeback` take the payment
row (`select … for update`) first, then update its subscriptions; the past-due cancel locks its
pending renewal payments before the subscription; `setPayoutAccount` takes the ledger's payout
batch lock. Status changes are compare-and-set on the expected status, and the ledger's
idempotency keys are the second line of defence against a double posting.

## Gift pool

Random recipients are drawn in SQL (`order by random() limit count`) inside the checkout
transaction from the channel's community: users with a chat message in the channel in the last
30 days, or a follow that integrity has not excluded. Never drawn (and refused as a named
recipient): the gifter, the owner, bots, deleted or suspended accounts, users banned or timed out
in the channel, and anyone with an `active`, `past_due` or `incomplete` subscription to it.
Fewer eligible users than `count` is `PRECONDITION_FAILED` with how many can receive one. A named
recipient need not be in the community.

## Stripe

`PAYMENTS_PROVIDER=stripe` (test keys only). Checkout writes the same rows as the manual adapter
(provider `stripe`, `provider_ref` = a `CA-…` reference while pending) and returns
`{ kind: "redirect", url }` to Stripe Checkout. Nothing is posted until Stripe says the money
arrived. The treasurer cannot confirm or charge back a Stripe payment (`CONFLICT`); a refund is
asked of Stripe (audit `payment.refund_requested`) and posted when its event arrives.

| File                | What                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------- |
| `stripe-webhook.ts` | `POST /api/webhooks/stripe` (loaded lazily by `http.ts` only under Stripe)              |
| `stripe-events.ts`  | Normalized events applied in one transaction, via `confirmPaymentTx`/`reversePaymentTx` |
| `stripe-connect.ts` | Connect Express accounts and onboarding links for `money.payoutAccount`                 |

**Webhook.** Raw body capped at 512 KiB (413), its own rate-limit bucket (`rl:stripe-webhook:<ip>`,
600/min), `Stripe-Signature` checked (400), live-mode events refused (400). The event is stored in
`payment_events` before anything else (unique per event id); a processed duplicate answers 200
untouched. The fee is fetched from Stripe first (outside the transaction), then the action runs in
one transaction with the row lock on the event and marks it processed. A failure records `error`
and `attempts` and answers 500 so Stripe retries. After commit: chat badge invalidation, and
Stripe subscriptions whose payment was clawed back are ended at Stripe (best effort).

**How an event finds its payment.** Sessions and first invoices carry our payment id in
metadata. Once paid, `provider_ref` becomes the PaymentIntent id (or the invoice id for an invoice
paid without one), which charges, refunds and disputes name. A self subscription's
`subscriptions.provider_ref` is the Stripe subscription id.

| Event                                   | Effect                                                                                                                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `checkout.session.completed` (payment)  | Confirm (gifts, tips): as `treasurer.confirm`, with Stripe's tax and fee, `succeeded_at` = Stripe's time (never before checkout); amount and currency must match                                 |
| `checkout.session.completed` (subscr.)  | Links the Stripe subscription; the first `invoice.paid` confirms (it carries the PaymentIntent, amount and period). Either order works                                                           |
| `invoice.paid`                          | First invoice: confirm the checkout's payment. Renewal: a new `succeeded` payment (`provider_ref` = PaymentIntent, idempotent), `paymentSucceeded`, the period continues; no `channel.subscribe` |
| `invoice.payment_failed`                | `active` → `past_due` (the badge stays)                                                                                                                                                          |
| `customer.subscription.deleted`         | Ends the subscription now (`canceled`, `channel.subscription.end`)                                                                                                                               |
| `checkout.session.expired` / async fail | Payment `failed`, its `incomplete` subscriptions `expired`, tip `failed`                                                                                                                         |
| `charge.refunded`                       | `reversePaymentTx` refund per refund id not seen before (or the cumulative difference when the event lists none)                                                                                 |
| `charge.dispute.created`                | Chargeback now (`disputes` `open`, `postReversal` `chargeback` with Stripe's dispute fee, subscriptions end). Inquiries (`warning_*`) claw back nothing                                          |
| `charge.dispute.closed`                 | Won: `postChargebackReversal` (fee refund included), payment back to `succeeded`/`partially_refunded`, dispute `won`. Lost: dispute `lost`. Closed before created: recorded, never clawed back   |
| `account.updated`                       | `payout_accounts.payouts_enabled` follows `payouts_enabled`; enabling re-pends `held` payouts (`payout_account_not_ready`); audit `payout_account.set` (system)                                  |
| anything else                           | Stored, processed as a no-op                                                                                                                                                                     |

**Connect.** `money.payoutAccount` for a Stripe instance creates the creator's Express account
on first call (idempotent per creator at Stripe), records it (`provider: stripe`, disabled) and
returns a fresh account link as `onboardingUrl`. The treasurer's `setPayoutAccount` never
overwrites it. Payout runs record `provider: stripe` payouts for these creators; actual transfers
to Connect accounts are out of scope (the treasurer marks them paid).

**Cancel.** `cancelSubscription` on a Stripe subscription asks Stripe first
(`cancel_at_period_end`, or an immediate cancel when `past_due`), then applies the local change.
