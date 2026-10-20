<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0007: E4b money follow-ups

- Status: accepted (decisions 1–3 are not implemented yet)
- Date: 2026-10-20

## Context

The E4b reviews (session seven, units A, B, G and H) raised questions the spec in
`docs/testing/e4b-selectors.md` did not settle. The user decided them on 2026-10-20 and asked for
them to be recorded, not built yet. Until a unit implements 1–3, the code and the spec
still describe the current behaviour given under each item.

## Decisions

### To build (not implemented)

1. **Unpaid gifts cannot block viewers.** Today an unpaid gift checkout reserves each
   recipient's slot (`incomplete` subscription) for `PAYMENT_PENDING_DAYS`, so a gifter who never
   pays can lock up to `MONEY_LIMITS.giftMaxCount` viewers out of subscribing and out of other
   gifters' pools. Decision: at most **one open unpaid gift checkout per gifter per channel**
   (`CONFLICT` otherwise), and gift payments expire after **24 hours** instead of
   `PAYMENT_PENDING_DAYS`. Needs a `MONEY_LIMITS` field (or config) for the gift window, a spec
   row change (Gift subs, Expiry), an API check in `money.subscribe`, the worker expiry using the
   gift window, and tests.
2. **Money collected for an ended subscription is refunded automatically.** Today a Stripe
   charge after we ended the subscription (refund, chargeback, expired first payment) is booked
   as `paid_after_end`, the subscription stays ended, Stripe is told to cancel, and a treasurer
   must refund by hand. Decision: after booking, the webhook processing also requests a refund
   of that payment at Stripe (outside the row lock, like `requestProviderRefund`), so the creator
   is never credited for a period nobody received. Never reactivate the subscription (the end may
   come from a chargeback).
3. **A Stripe refund call whose outcome is unknown keeps blocking.** Today a timeout or network
   error on the refund request writes `payment.refund_request_failed`, which releases the guard
   although Stripe may have taken the refund. Decision: distinguish a definite refusal (4xx: mark
   failed, release) from an unknown outcome (timeout, network error, 5xx after retries: mark
   unknown, keep blocking until `charge.refunded`/`refund.failed` arrives or the 24-hour expiry).

### Recorded as is

4. **Revenue and tiers are owner-only.** `money.revenue`, `money.revenueLedger` (it shows payer
   usernames) and `money.setTiers` refuse channel editors, although the contract's `owner`
   access admits them.
5. **Hold releases are dated when they fell due** (payment time + hold days, capped at the run
   time). They touch only creator liability and hold accounts, so period close, monthly
   aggregates and transparency figures never change; a creator statement can gain a line in an
   earlier month (documented in `packages/ledger/README.md`).
6. **Stripe Connect transfers are out of scope for E4b.** Payout runs record `provider: stripe`
   payouts for Stripe creators, but no money is moved to their connected accounts. Tracked in
   PLAN.md as later work.
