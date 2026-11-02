<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# M1-gifts-refunds: the gift window, auto-refunds, "outcome unknown" and the receipt email

You are implementing unit M1-gifts-refunds for CommonAir (repo: /Users/joshe/Repos/bcon). Before
you start, read:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch8/README.md`. Decisions U1, (b), (c), (d) and (r), the path ownership, the
  shared rules and the money rules are binding.
- `.claude/briefs/b8/contract-step.md`: §0 (refund markers, the gift window), §2.1–§2.2
  (`payments.gift` and its index), §2.4 (`StripeOutcomeUnknown`, `retrieveRefund`, `listRefunds`,
  `refundStatus?`), §2.5–§2.7 (your stub files, the treasurer procedures, `GIFT_PAYMENT_HOURS`, the
  `paymentReceipt` template), and §4.3–§4.4 (your harness steps and test ids).
- ADR 0007 decisions 1–3 (`docs/decisions/0007-e4b-money-follow-ups.md:22-41`) and its Amendment 1
  (written by the contract step). ADR 0003 D1 (stripe-mock is stateless).
- `services/api/src/money/stripe-refunds.ts`, all of it. You extend its marker model and do not
  replace it.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 1**: work in your own git worktree, on branch
`m1/gifts-refunds`, cut from the contract step's sha. M1-connect runs beside you in other money
files.

## Why

ADR 0007 recorded three decisions that were never built:

1. An unpaid gift checkout can lock up to `MONEY_LIMITS.giftMaxCount` viewers out of subscribing
   for `PAYMENT_PENDING_DAYS` (7, `packages/config/src/env.ts:234`).
2. Money collected for an ended subscription waits for a treasurer to refund it by hand.
3. A refund call that timed out writes `payment.refund_request_failed`. That releases the guard,
   although Stripe may have refunded.

Batch 4 also deferred a payment receipt that shows the `PaymentBreakdown` lines. **stripe-mock
only. No live key, ever** (decision (b)).

## You own (write only these)

- `services/api/src/money/checkout.ts`: the gift lines, and the receipt call sites the contract
  step placed there.
- `services/api/src/money/{stripe-refunds,auto-refund,receipt,refund-requests}.ts`.
- `services/api/src/money/stripe-events/refunds.ts`.
- `services/worker/src/money/refund-reconcile.ts` (new) and `services/worker/src/jobs/refund-reconcile.ts`.
- `services/worker/src/money/expire.ts`, only if gift expiry needs a change there.
- `packages/email/src/templates/receipt.tsx` and `packages/email/src/messages/locales/{en,es}/receipt.json`.
- `apps/web/src/components/treasury/refund-requests*`.
- `apps/web/src/i18n/locales/{en,es}/m1-money.json` and `keys/m1-money.gen.ts`.
- `harness/src/b8/money-refunds.ts`.
- Tests named after these files.

**Read-only:**

- `services/api/src/money/{stripe-events,stripe-webhook,checkout-treasurer,checkout-shared}.ts`;
- `packages/{payments,ledger,contracts,db,config}/**`;
- the other `stripe-events/*.ts` files (M1-connect's, M1-coop-money's).

Anything else is a **contract request**. That includes the terms wording on auto-refunds: send the
draft text, marked "not reviewed by counsel (none retained)".

## Contracts you must honor

- **The index** on `payments (user_id, channel_id) where gift and status = 'pending'` (`0049`).
- **`GIFT_PAYMENT_HOURS`** (default 24), read through `loadEnv`.
- **The marker actions:** `payment.refund_requested`, `payment.refund_submitted`,
  `payment.refund_request_failed` and the new `payment.refund_outcome_unknown`.
- **The client and adapter:**
  - `StripeOutcomeUnknown` against a definite `StripeRequestError`;
  - `StripeClient.retrieveRefund` and `listRefunds`;
  - `PaymentAdapter.refundStatus?`.
- **The hooks:** `AppliedAction.followUp {kind:"auto_refund"}`, `autoRefundAfterEnd`,
  `sendPaymentReceipt`.
- **The procedures:** `money.treasurer.refundRequests` and `refundRequests.resolve`.
- **The template:** `paymentReceipt`, with its data shape (contract §2.7).
- **The test ids:** `refund-requests`, `refund-request-unknown`, `refund-request-resolve`.

## Build

1. **The gift window (ADR 0007 decision 1).**
   - In `money.subscribe` with `gift`, refuse with `CONFLICT` (i18n code `gift_pending`) when the
     gifter already has a pending gift payment for the channel. The check comes before the draw,
     inside the same transaction, so the 23505 from the index maps to the same `CONFLICT`.
   - Set `expires_at = now + GIFT_PAYMENT_HOURS` on gift payments only. Every other payment keeps
     `PAYMENT_PENDING_DAYS`.
   - `money-expire-pending` already fails them every 5 minutes and frees the recipients' slots. Add
     a test that it does so for a gift at 24 h and not at 23 h.
2. **Auto-refund after an end (decision 2).**
   - When a webhook books a payment `paid_after_end`, the handler returns
     `followUp: {kind: "auto_refund", paymentId}`.
   - `autoRefundAfterEnd` runs after commit. It calls `requestProviderRefund` with the
     system as actor, for the full unrefunded amount, under the usual one-outstanding guard.
   - The posting still follows Stripe's `charge.refunded`, as for any refund.
   - Never reactivate the subscription.
   - It is idempotent: a redelivered webhook finds the outstanding request, or the posted refund,
     and does nothing.
   - A manual-adapter payment is never auto-refunded through a provider. The treasurer sees it in
     the list with reason `paid_after_end`.
3. **"Outcome unknown" (decision 3).**
   - `requestProviderRefund`'s catch splits the two cases:
     - a `StripeRequestError` (4xx) writes `payment.refund_request_failed` and releases the guard;
     - a `StripeOutcomeUnknown` writes `payment.refund_outcome_unknown` with the idempotency key it
       used, and keeps blocking.
   - Extend `outstandingRefundRequests` so an unknown request blocks until one of these:
     - a `charge.refunded` posting with its refund id, or of its amount;
     - a `refund.failed` or `refund.updated` with status `failed`;
     - a treasurer `resolve`;
     - the 24 h TTL.
   - At the TTL, the request stays **listed** as unknown for the treasurer even after it stops
     blocking.
4. **Reconciliation** (`refund-reconcile`, every 15 minutes).
   - For each unknown request younger than 7 days, ask the adapter `refundStatus`, or
     `listRefunds({paymentIntent})` filtered by the idempotency key's metadata.
   - A refund that exists and succeeded: do nothing, because the webhook posts it. If the webhook
     was lost, log at warn with the payment id. Never post from the reconciler: the ledger follows
     the provider's events only.
   - Definitely none: write `payment.refund_request_failed` with `details.reason = "reconciled_none"`.
   - Still unknown: leave it.
   - Metrics: counts per outcome.
5. **Treasurer view.**
   - `money.treasurer.refundRequests` lists the requests with their markers, the state
     (outstanding, unknown or resolved), the payment, its amount and age.
   - `resolve` is audited and refused while Stripe's state is still being reconciled within its
     first 15 minutes.
   - Web: `components/treasury/refund-requests.tsx` in the treasury tabs: a list with
     `<MoneyAmount>`, `<RelativeTime>` and `<EmptyState>`, and resolve through `<ConfirmDialog>`.
     Strings go in `m1-money`, in `en` and `es`.
6. **The receipt email** (`paymentReceipt`).
   - `sendPaymentReceipt` loads the payment and its `PaymentBreakdown` lines (the same function
     `money.breakdown` uses), renders the template in the payer's locale, and sends through the
     existing mailer after commit.
   - It sends once per payment: dedupe on a `payment.receipt_sent` audit marker.
   - It skips users without a verified email, and deleted users.
   - The template shows the amount, each breakdown line, the time, the reference, the channel name
     (or the co-op for shares), and a link to `/settings/payments`.
   - Logs carry the payment id only: no email address and no username.

## Edge cases

- **Two gift checkouts racing** from two tabs: exactly one wins. Test the index path and the
  application path.
- **A gift paid at 23 h 59 m** confirms, and one at 24 h 01 m is already failed. The late Stripe
  charge for it then goes down the existing `paid_after_end`-style path. Check which one applies,
  and test that it is refunded, not credited.
- **A `paid_after_end` charge already partly refunded by a treasurer:** refund the rest only.
- **A refund call that returns a 5xx and then a 200 on retry inside the client** is a success, not
  unknown.
- **Unknown, then the webhook arrives during reconciliation:** no double failure marker. Use the
  payment row lock, as `stripe-refunds.ts` does.
- **Reconciling a refund for a different amount** than the request (a treasurer refunded by hand at
  Stripe): no marker change, and a warn log.
- **Integer cents and an explicit currency everywhere.** The receipt formats with
  `formatMoney`.

## Tests you must add

- **Unit:**
  - `outstandingRefundRequests` with unknown markers: each release path, the TTL, a resolve, and
    unknown followed by failed;
  - the error classification;
  - the reconciler's decision table (pure);
  - the receipt template rendering in `en` and `es`, with a snapshot of the lines.
- **API integration (stripe-mock):**
  - the second gift gets `CONFLICT`;
  - the index refuses a direct insert;
  - the gift `expires_at` is 24 h, and other payments keep 7 days;
  - `paid_after_end` produces one refund request, and a redelivery adds none;
  - an injected adapter timeout writes `outcome_unknown` and keeps blocking a second refund;
  - an injected 4xx releases;
  - `resolve` is audited;
  - a receipt is sent once, with no PII in logs. Capture the logger.
- **Worker integration:**
  - reconcile on each outcome, driven by an injected adapter, because stripe-mock is stateless;
  - expiry at 24 h.
- **Web unit:** the list states, the resolve confirm, and axe.
- **Harness** `harness/src/b8/money-refunds.ts`, steps in `e4b-money`:
  - `gift-window`: a second gift inside the window is refused;
  - `auto-refund`: a signed local `invoice.paid` for an ended subscription produces a refund
    request, then `charge.refunded` posts it;
  - `refund-unknown`: the harness fault hook makes the adapter time out; the treasurer list shows
    "unknown"; a signed `charge.refunded` reconciles it;
  - `receipt-email`: the receipt lands in Mailpit, with the breakdown lines.
  - The ledger balances after each step: check through the existing harness ledger check.
    Use signed local webhook events and injected faults, as E4b did (decision (b)). If you need a
    fault-injection hook in the API, send it as a contract request against
    `INTERNAL_ROUTES`/`harness/src/platform.ts`.

## Reviewer focus

- The partial unique index holds against direct inserts, and the API's `CONFLICT` is in addition to
  it.
- The 24 h window applies to gifts only.
- Auto-refunds are idempotent and never reactivate a subscription.
- "Outcome unknown" never double-refunds, and the reconciler never posts to the ledger.
- The ledger balances after every step.
- Treasurer actions are audited.
- The receipt has no PII in logs and sends once.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun run test` and `test:int` in `services/api`, `services/worker` and `packages/email`, one at a
  time;
- `bunx tsc -p` for each;
- `bun --bun vp test run` in `apps/web` and `harness`, and `vp build` in `apps/web`;
- `vp lint --deny-warnings` and `vp fmt`;
- the i18n check;
- `reuse lint`.

`git status` shows only your paths. Commit with `git commit -s`.

Then tell the user to run:

```bash
bun harness/src/cli.ts run e4b-money --set b8=gift-window,auto-refund,refund-unknown,receipt-email
```

They should also check the treasurer list by hand under `en`, `es` and `en-XA`, at 320 px, in
dark and light themes, keyboard only.
