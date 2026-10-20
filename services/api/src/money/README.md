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
