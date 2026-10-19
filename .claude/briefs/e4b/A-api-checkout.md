<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E4b unit A, api-checkout** for CommonAir (repo: /Users/joshe/Repos/bcon).
Read AGENTS.md, PLAN.md, docs/architecture.md and `.claude/briefs/e4b/_common.md` first, then
`docs/testing/e4b-selectors.md` in full. Do not look outside the repository.

## You own (write only these)

- `packages/payments/**` (the adapter interface in `src/adapter.ts` is a head-agent draft: refine
  it if you need to and say so in your final message; keep `src/reference.ts` as is)
- `services/api/src/money/checkout*.ts` (one file or several with that prefix) and
  `services/api/src/money/README.md`
- `services/api/tests/money-checkout*.test.ts` and `services/api/tests/money-checkout*.int.test.ts`
- the "Money" section of `services/api/README.md` (add one; touch nothing else in that file)

Unit B owns `services/api/src/money/reports*.ts` in parallel; unit C the worker. Do not edit
`src/routes/money.ts` (it spreads your `checkoutHandlers` and `treasurerCheckoutHandlers`) or
`src/routes/coop.ts`.

## Contracts you must honor (read-only for you)

- `money.support`, `tiers`, `setTiers`, `subscribe` (with `gift`), `mySubscriptions`,
  `cancelSubscription`, `tip`, `subscribers`, `tips`, and `money.treasurer.payments`, `confirm`,
  `refund`, `chargeback`, `setPayoutAccount` (`packages/contracts/src/api/router.ts`); their DTOs.
- Tables `subscriptions`, `tips`, `payments`, `disputes`, `payout_accounts`, `payouts`,
  `channel_sub_tiers`, `follows`, `chat_messages`, `chat_bans`, `users`, `channels`, `events`,
  `audit_log`; migration `0013`.
- Events `channel.subscribe`, `channel.subscription.gift`, `channel.subscription.end`,
  `channel.tip` (payload shapes in `packages/contracts/src/events.ts`; tiers are `"1000"`/`"2000"`/
  `"3000"`). Use `emit` from `src/events/outbox.ts` and `audit` from `src/events/audit.ts`.
- `paymentsEnv` (`PAYMENTS_PROVIDER`, `CURRENCY`, `MANUAL_PAYMENT_INSTRUCTIONS`,
  `PAYMENT_PENDING_DAYS`); `@commonair/ledger` (`loadMoneySettings`, `paymentSucceeded`, `post`,
  `postReversal`, `postChargebackReversal`); `MONEY_LIMITS`, `manualReference`,
  `normalizeManualReference`.
- Chat invalidation after commit: the pattern the API already uses for follows/bans
  (`BUS.chatControl` `invalidate` with `scope: "user"`), so subscriber badges update.

## Build

Everything in the spec's payment-flow table rows **Tiers, Checkout, Gift subs, Confirm, Refund,
Chargeback, Payout account**, plus:

1. **`packages/payments`**: the `manual` adapter (`startCheckout` returns
   `{ kind: "instructions", providerRef: manualReference(), instructions }` with
   `MANUAL_PAYMENT_INSTRUCTIONS` filled with `{reference}` and the formatted `{amount}`), and
   `createAdapter(env)` choosing by `PAYMENTS_PROVIDER` (a `stripe` value throws "not built yet"
   for now; unit G adds it). Retry `manualReference` on a `payments_provider_ref_uq` conflict.
2. **`money.support`** (public): tiers (empty unless all three are set), `split` from
   `platform.cut`, `MONEY_LIMITS`, `provider`, `currency`, and `viewer` (caller's own
   subscription to the channel in `active`/`past_due`/`incomplete`, `isOwner`).
3. **`tiers` / `setTiers`**: exactly tiers 1, 2, 3 once each, strictly increasing prices, the
   instance currency only (`BAD_REQUEST` otherwise). Price changes apply to new checkouts and
   renewals; existing subscriptions keep their `price_cents` until renewal.
4. **`subscribe`**: self and gift per the spec. Gift pool query: distinct users with a
   `chat_messages` row in the channel in the last 30 days or a `follows` row, minus the
   exclusions in the spec; pick at random in SQL (`order by random() limit count`) inside the
   checkout transaction. All rows (`payments`, `subscriptions`) in one transaction with the
   adapter's reference. `returnPath` is stored nowhere for manual (Stripe uses it later).
   Self-subscribe while `incomplete`: return the existing pending checkout (same reference).
   A user may not gift to themselves.
5. **`tip`**: `tips` (`pending`) + `payments` (`kind: tip`, `tip_id`); message ≤
   `MONEY_LIMITS.tipMessageMaxLength`, trimmed. Anonymous tips keep `from_user_id` (needed for
   refunds) but never expose it to the channel (DTO `from: null`, event `user_*: null`,
   `is_anonymous: true`).
6. **`mySubscriptions`**, **`cancelSubscription`** (own subscription only, `active` or `past_due`;
   sets `cancel_at_period_end`; gifts cannot be cancelled by the recipient — they simply expire;
   idempotent), **`subscribers`** and **`tips`** (owner pages, keyset cursors like the other paged
   procedures in the API, newest first, anonymous tippers hidden).
7. **Treasurer**: `payments` (spec), `confirm`, `refund`, `chargeback` (amount ≤ refundable rest;
   reasons ≤ 500 chars to `disputes.reason` + audit `reason`), `setPayoutAccount` (upsert
   `payout_accounts` with `provider: manual`, `provider_account_id = reference`; enabling moves the
   creator's `held` payouts whose `hold_reason` is `payout_account_not_ready` back to `pending`).
   Pass the cut recorded in the original posting's metadata to reversals (see the ledger README).
   Each in one transaction; CAS on status so concurrent calls cannot double-apply; audit action
   names as in the spec.
8. Errors: `ORPCError` codes from the contract (`FORBIDDEN`, `CONFLICT`, `PRECONDITION_FAILED`,
   `BAD_REQUEST`, `NOT_FOUND`); never leak SQL.
9. `services/api/src/money/README.md`: state machines for payments, subscriptions and tips
   (manual), which calls post what, and the gift-pool rule. Short "Money" section in the service
   README pointing at it.

## Tests you must add

- Unit (`money-checkout*.test.ts`): instruction templating, tier validation, gift input rules,
  any pure helpers (status transitions, period arithmetic: one calendar month in UTC, including
  Jan 31 → Feb 28/29 clamping).
- Integration (`money-checkout*.int.test.ts`, `createTestDatabase()`, through the oRPC router as
  the other API int tests do — see `tests/harness.ts`): set tiers; self subscribe → instructions
  → confirm → `active`, ledger balanced with `creator-hold` = floor(net × streamerShare), events
  and audit rows written; second subscribe `CONFLICT`; re-subscribe while `incomplete` returns the
  same reference; owner cannot subscribe or tip own channel; gift 2 random with a pool of 3 (only
  eligible users drawn; banned/subscribed/owner/gifter excluded) and `PRECONDITION_FAILED` with a
  pool too small; named gift; tip anonymous (DTO and event hide the user); double confirm →
  exactly one posting; refund partial then rest (sums exact; full refund cancels the sub);
  refund exceeding the rest → `BAD_REQUEST`; chargeback after hold release (use the ledger's
  `releaseDueHolds` with a future `asOf` in the test) creates a receivable; non-treasurer →
  `FORBIDDEN`; `setPayoutAccount` re-pends held payouts; `treasurer.payments` by reference in any
  status and by status with paging.

## Done means

See `_common.md` "Done means". Your package checks: `packages/payments` (`bun run test`,
`tsc`), `services/api` (`bun run test`, `bun run test:int` — only your files are new, but run the
package's suite once at the end), lint/fmt on changed paths.
