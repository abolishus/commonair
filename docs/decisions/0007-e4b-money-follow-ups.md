<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0007: E4b money follow-ups

- Status: accepted (decisions 1–3 and item 6 are not implemented yet: batch 8 builds them, see
  [Amendment 1](#amendment-1-gift-window-refund-outcomes-and-connect-transfers-batch-8), accepted
  2026-11-02)
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

## Amendment 1: gift window, refund outcomes and Connect transfers (batch 8)

- Status: accepted (2026-11-02, with batch 8: orchestrator decisions (b), (d) and (f) of
  [batch 8](../../.claude/briefs/batch8/README.md#decisions), which the maintainer may reopen; see
  [Amendment 1 decisions at acceptance](#amendment-1-decisions-at-acceptance-2026-11-02)).
  Decisions 1–3 and item 6 are **scheduled for batch 8, not built yet**; the orchestrator marks
  each "built in batch 8" here when M1-gifts-refunds (1–3) and M1-connect (6) merge.
- Date: 2026-11-02 (code checked at `21b44584`)
- Gates: M1-gifts-refunds and M1-connect
  ([batch 8 contract step](../../.claude/briefs/b8/contract-step.md) §0, §2;
  [M1-gifts-refunds](../../.claude/briefs/m1/M1-gifts-refunds.md),
  [M1-connect](../../.claude/briefs/m1/M1-connect.md))

**No counsel retained; listed for post-launch review** (batch 7 decision (h)). Two calls here are
counsel-like: no tax-form collection for Connect recipients (A1.5), and refund wording in the terms
draft for automatic refunds (A1.2). Each takes the conservative default, and none of it can move
real money in batch 8: money runs on stripe-mock only, with no live key (decision (b)). Both are on
the batch 8 README's [Post-launch review](../../.claude/briefs/batch8/README.md#post-launch-review)
list and must be settled before any live key.

This amendment fixes how decisions 1–3 are built, which the code they land on settles differently
from the 2026-10-20 wording in two places (A1.1, A1.3), and replaces item 6 with Connect transfers
(A1.4, A1.5).

### A1.1 Decision 1: the gift window is config, enforced by an index

- **The window.** A new env value `GIFT_PAYMENT_HOURS` (integer 1–168, default 24; read by the API
  and the worker) sits beside `PAYMENT_PENDING_DAYS` in `packages/config`. It replaces the
  "`MONEY_LIMITS` field (or config)" of decision 1: an operator may need to widen it without a
  release. Gift checkouts set `payments.expires_at` from it; every other pending payment keeps
  `PAYMENT_PENDING_DAYS` (`services/api/src/money/checkout.ts:216`, `:522`).
- **No new job.** `money-expire-pending` already runs every 5 minutes and fails pending payments
  past `expires_at`, with what hangs off them (`services/worker/src/jobs/money-expire-pending.ts:8-14`),
  so a lapsed gift releases its recipients' slots within 5 minutes of the window.
- **Marking a gift.** No column said which payment is a gift: a gift is a `subscription` payment
  that subscriptions point to through `gift_payment_id`. `0048_b8.sql` adds
  `payments.gift boolean not null default false`, backfilled from `subscriptions.gift_payment_id`
  and set by the gift checkout.
- **One open unpaid gift per gifter per channel** is a partial unique index in
  `0049_b8_protections.sql`: `payments (user_id, channel_id) where gift and status = 'pending'`.
  `money.subscribe` answers `CONFLICT` first, in addition to the index (AGENTS.md rule 9), so a race
  between two connections ends in the index, never in two open gifts.

### A1.2 Decision 2: automatic refunds after the end, outside the row lock

As decided on 2026-10-20. The seam: the webhook's applied action carries
`followUp: {kind: "auto_refund", paymentId}`, and `stripe-webhook.ts` runs
`autoRefundAfterEnd` after the transaction commits, outside the row lock, through the same refund
guard and markers as a treasurer's refund (A1.3). It is idempotent per payment and never
reactivates the subscription. The refund's wording for the payer belongs in the terms draft
(post-launch review).

### A1.3 Decision 3: a definite refusal releases, an unknown outcome keeps blocking

Refund requests are append-only `audit_log` markers, not a column
(`services/api/src/money/stripe-refunds.ts:4-20`, `:32-36`): `payment.refund_requested`, then
`payment.refund_submitted` or `payment.refund_request_failed`. A request stops blocking after
`REFUND_REQUEST_TTL_MS` (24 h, `:36`). Decision 3 is built on those markers:

- **Two error classes** in `packages/payments`: `StripeRequestError` for a definite 4xx, and
  `StripeOutcomeUnknown` for a timeout, a network error or a 5xx after the client's retries.
- **A definite refusal** writes `payment.refund_request_failed` and releases the guard, as today.
- **An unknown outcome** writes a fourth marker, `payment.refund_outcome_unknown`, which keeps the
  request outstanding (`outstandingRefundRequests`, `:55`, is the pure rule extended): no second
  refund can start for that payment.
- **It is settled by Stripe's answer, never by a guess:** a `charge.refunded`, `refund.updated` or
  `refund.failed` event; the `refund-reconcile` job (every 15 minutes, `retrieveRefund` and
  `listRefunds({paymentIntent})`), which writes markers but never posts to the ledger (only the
  `charge.refunded` path posts); or the 24 h expiry, as for every request.
- **A treasurer** sees the requests and their state (`outstanding`, `unknown`, `resolved`) in
  `money.treasurer.refundRequests`, and may resolve one Stripe never answers as `refunded` or
  `failed` (`money.treasurer.refundRequests.resolve`). Resolving is audited, and refused within
  the first 15 minutes while reconciliation is still running.

### A1.4 Item 6 replaced: Connect transfers, one per payout row

Item 6 recorded that payout runs book `provider: stripe` payouts and move no money. Decision (f)
replaces it:

- **At payout-run time,** each `stripe` payout row (one per split recipient, W2-splits) gets one
  Stripe Connect transfer to that recipient's Express account, enqueued as the `payout-transfers`
  job with a stable job id per payout. Held payees are never transferred to.
- **`payout_transfers`** (`0048_b8.sql`): one row per payout (`payout_id` unique), the Stripe
  transfer id (`provider_ref`, unique when set), the destination account, amount and currency,
  `status` (`pending`, `created`, `failed`, `reversed`), `reversed_cents`, an `idempotency_key`
  (unique, stable across retries, also sent to Stripe) and an opaque `failure_code` (never Stripe's
  message).
- **The database enforces it** (`0049_b8_protections.sql`, AGENTS.md rule 9): status moves only
  `pending → created | failed` and `created → reversed`; `reversed_cents` only rises and never
  passes `amount_cents`; `provider_ref` is set once; and a transfer for a payout whose provider is
  not `stripe`, or whose status is not `scheduled`, is refused.
- **The ledger:** a created transfer posts the existing `payoutSent` (clearing to cash,
  `packages/ledger/src/rules.ts:874`) at transfer time; the payout batch already reserved the
  amount (`packages/ledger/src/payouts.ts:4-9`).
- **No personal data** goes to Stripe metadata or logs: ids only (ADR 0004).
- **The manual adapter** has no `transfer`, so nothing moves with it.

### A1.5 Failed and reversed transfers return to the payable; no tax forms

- **A transfer refused at create time** posts nothing new: the payout is cancelled through the
  existing `payoutCancel` (`rules.ts:905`), which returns the reservation to the creator's payable,
  and the transfer row is `failed` with its code.
- **A reversal** (a signed `transfer.reversed` webhook, partial or full) posts the new
  `payoutTransferReversed`: Dr `cash:stripe`, Cr the creator's earnings payable, keyed
  `payout-transfer-reversed:<transferId>:<cumulative reversed cents>`, so two partial reversals
  are two postings and a redelivered event changes nothing.
- **The treasurer sees both** in `money.treasurer.transfers` and the treasury's payout transfers
  tab, and each writes an `audit_log` row and its internal event
  (`money.payout_transfer.{created,failed,reversed}`, never offered to apps) in the same
  transaction.
- **No tax-form collection is built** (counsel-like). Whether recipients are payees or contractors,
  which forms to collect and which thresholds to report must be decided before any live payout.
  Until then no live key exists (decision (b)).

### A1.6 Consequences of the amendment

- The spec rows for gift subs and expiry in `docs/testing/e4b-selectors.md` change with
  M1-gifts-refunds.
- A gift that lapses frees its recipients within `GIFT_PAYMENT_HOURS` plus 5 minutes.
- A refund whose outcome is unknown can block a second refund for up to 24 h, never longer, and
  is visible to treasurers the whole time.
- Creators on Stripe are paid by Connect at payout-run time; a reversal shows as money owed again,
  never as a silent loss.
- Every failure path is tested against stripe-mock with signed local events and injected adapter
  faults (ADR 0003 D1), since stripe-mock is stateless.

### Amendment 1 decisions at acceptance (2026-11-02)

Accepted with batch 8 as the orchestrator's defaults. The maintainer may reopen any of them.

1. **Gift window (d):** `GIFT_PAYMENT_HOURS`, default 24, for gifts only; one open unpaid gift per
   gifter per channel, by partial unique index plus the API's `CONFLICT`.
2. **Refund outcomes (decision 3):** a definite 4xx releases; an unknown outcome writes
   `payment.refund_outcome_unknown` and keeps blocking until Stripe answers, the reconciler finds
   the refund, a treasurer resolves it, or 24 h pass.
3. **Connect (f):** one transfer per payout row to Express accounts at payout-run time; failed and
   reversed transfers return to the payable through the ledger.
4. **No tax-form collection** (counsel-like, post-launch review).
5. **stripe-mock only (b):** no live keys in batch 8.
