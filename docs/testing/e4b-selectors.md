<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E4b web ↔ harness contract (money)

Milestone E4b: money on the platform, the manual adapter first, then Stripe against stripe-mock.
A viewer subscribes (three tiers), gifts subs and tips. The treasurer confirms the offline
payment. Every movement is posted to the append-only ledger. The creator sees it on the revenue
dashboard. A refund and a chargeback claw the creator share back, a payout honors the minimum
threshold, and the public transparency page shows the month. This file extends
[e1-selectors.md](e1-selectors.md), [e2-selectors.md](e2-selectors.md) and
[e3-selectors.md](e3-selectors.md), and everything in those still holds.

Changing anything here is a contract change: update this file, `apps/web`, `services/api`,
`services/worker` and the `e4b-money` scenario together. Tests select elements by `data-testid`,
never by visible text. Every amount in a `data-*` attribute is integer cents of the instance
currency (`CURRENCY`, default `usd`), signed where the doc says so; the visible text is formatted
with `<MoneyAmount>`.

## Rules every unit honors

- **Stripe is optional (AGENTS.md rule 3).** With `PAYMENTS_PROVIDER=manual` (the default) no
  request ever leaves the instance. Nothing in the UI or API assumes a card or a redirect.
- **The ledger is the authority.** Balances, revenue and transparency figures are read from
  `ledger_entries` (via `@commonair/ledger`), never recomputed from `payments`. Every posting goes
  through `post` / `postReversal` / `postChargebackReversal` / `postPayout` in the same database
  transaction as the state change it records. The DB triggers (ADR 0004) are the backstop.
- **Integer cents with a currency.** No floats anywhere money is stored or summed. The cut is the
  `platform.cut` governance setting read per operation (`loadMoneySettings`); the minimum
  payout, schedule and hold period are `payout.rules`. Neither comes from env.
- **No personal data in append-only columns.** Ledger descriptions, memos and metadata, and audit
  `details`, hold ids and enums only. The treasurer's free-text `reason`/`note` goes to
  `disputes.reason` (mutable) and the audit `reason` (the treasurer's own words), never into the
  ledger. Names on the revenue ledger are joined from `users` at read time.
- **Lock order.** Money code locks the payment row before its subscription rows (API and worker
  alike), so concurrent confirm, cancel and expiry cannot deadlock.
- **Outbox and audit.** Every state change other systems see writes an `events` row in the same
  transaction (`channel.subscribe`, `channel.subscription.gift`, `channel.subscription.end`,
  `channel.tip`). Every treasurer action writes an `audit_log` row (actor type `admin`; there is no treasurer actor type).

## Payment flow (manual adapter)

| Step           | Who                                     | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tiers          | owner, `money.setTiers`                 | Exactly three tiers 1–3 with names and prices `MONEY_LIMITS.tierMinCents`–`tierMaxCents`, strictly increasing in price, in the instance currency. Until set, the channel takes tips but not subscriptions or gifts (`money.support` returns `tiers: []`)                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Checkout       | viewer, `money.subscribe` / `money.tip` | Creates `payments` (`pending`, `provider_ref` = a fresh `CA-XXXXXXXX` reference, `tier`, `quantity`, `expires_at` = now + `PAYMENT_PENDING_DAYS`) and the `subscriptions` row(s) (`incomplete`) or `tips` row (`pending`), and returns `{ kind: "instructions", reference, instructions, amount }`. Nothing is posted to the ledger yet. The owner cannot pay their own channel (`FORBIDDEN`). A second self-subscribe while one is `active`/`past_due` is `CONFLICT`; while one is `incomplete` it returns the same pending checkout again (same reference)                                                                                                                                 |
| Gift subs      | viewer, `money.subscribe` with `gift`   | One payment for `count` × the tier price, `quantity = count`. Recipients are fixed at checkout: `gift.to`, or `count` users drawn at random from the channel's community (chatted in the channel in the last 30 days, or follow it), excluding the gifter, the owner, bots, suspended users, users banned in the channel and anyone with an `active`/`past_due`/`incomplete` subscription to it. Fewer eligible than `count` → `PRECONDITION_FAILED` saying how many can receive one. Each recipient gets an `incomplete` subscription with `gifted_by_id` and `gift_payment_id`. A named recipient who is not eligible → `PRECONDITION_FAILED`                                              |
| Confirm        | treasurer, `treasurer.confirm`          | `pending` only (else `CONFLICT`); `receivedAt` not in the future. One transaction: payment `succeeded` (`succeeded_at = receivedAt`); `paymentSucceeded` posted (settlement `cash`, fee 0, tax 0, today's cut); subscriptions `active` for one month from `receivedAt` (a renewal continues from the previous `current_period_end` and copies the payment's amount and currency into the subscription's price); tip `succeeded`; events (`channel.subscribe` per subscription with `is_gift`, plus one `channel.subscription.gift` with `total` for a gift payment; `channel.tip`); audit `payment.confirm`. After commit the API publishes a chat `invalidate` for each subscriber (badges) |
| Expiry         | worker                                  | A `pending` payment past `expires_at` becomes `failed`; its `incomplete` subscriptions become `expired` (a `past_due` renewal's subscription too, with `channel.subscription.end`); its tip `failed`. Nothing to reverse: nothing was posted                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Renewal        | worker                                  | At `current_period_end`: `cancel_at_period_end` → `canceled`; gift subscriptions → `expired` (gifts never renew); both emit `channel.subscription.end` (gifts end this way under every provider: a gift is a one-off payment). A manual self subscription otherwise gets a renewal payment (`pending`, same tier at today's price, new reference, `expires_at` = period end + `PAYMENT_PENDING_DAYS`) and turns `past_due`; chat keeps the badge while `past_due`. Stripe self subscriptions follow Stripe's events instead                                                                                                                                                                  |
| Cancel         | subscriber, `money.cancelSubscription`  | `active`: sets `cancel_at_period_end` (idempotent). `past_due`: ends now (`canceled`, `channel.subscription.end`) and fails its pending renewal payment in the same transaction, so a late confirm returns `CONFLICT`. Gifts cannot be cancelled by the recipient; they expire                                                                                                                                                                                                                                                                                                                                                                                                               |
| Hold release   | worker                                  | Hourly `releaseDueHolds(asOf now, holdDays from payout.rules)`: creator shares older than the hold move from `creator-hold` to `creator` (available)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Refund         | treasurer, `treasurer.refund`           | `succeeded`/`partially_refunded` only; `amountCents` ≤ amount − refunded. One transaction: `disputes` row (`refund`, `closed`, `resolved_at`), `postReversal`, `refunded_cents` += amount, status `refunded` or `partially_refunded`, audit `payment.refund`. A full refund ends the payment's subscriptions now (`canceled`, `channel.subscription.end`)                                                                                                                                                                                                                                                                                                                                    |
| Chargeback     | treasurer, `treasurer.chargeback`       | As refund, with `disputes` (`chargeback`, `lost`) and `postChargebackReversal`: the creator share comes back from released earnings, then the hold, and the rest becomes a receivable the next payout nets (the clawback). Status `charged_back`; the subscriptions end; audit `payment.chargeback`                                                                                                                                                                                                                                                                                                                                                                                          |
| Payout run     | treasurer, `treasurer.runPayouts`       | `periodEnd` not in the future. Releases due holds first, then `runPayoutBatch` for the UTC month containing `periodEnd` (idempotent per creator and month): creators whose available balance (released − receivable − already scheduled) reaches `payout.rules.minimumCents` get a `pending` payout, or `held` (`payout_account_not_ready`) without an enabled payout account; the rest carry over. Audit `payout.run`                                                                                                                                                                                                                                                                       |
| Payout account | treasurer, `treasurer.setPayoutAccount` | Manual adapter: records the treasurer's reference for how the creator is paid (never bank details) and `payoutsEnabled`. Enabling it moves that creator's `held` payouts for the open month back to `pending`. Audit `payout_account.set`                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Mark paid      | treasurer, `treasurer.markPaid`         | `pending` payouts only: `postPayout` (nets any receivable), status `paid`, `provider_ref = reference`, audit `payout.paid`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

`treasurer.payments` lists by `status` (default `pending`), newest first; with `reference` it
finds that payment in any status. Platform roles come from `admin.setRole`, or for the first
admin/treasurer from the operator CLI: `bun run --filter @commonair/db role -- <username> treasurer`
(audited as `system`; sign in again afterwards).

## Stripe adapter (phase two of E4b)

`PAYMENTS_PROVIDER=stripe` with a test key (`sk_test_…`; live keys are refused by config) and
`STRIPE_API_BASE` pointing at stripe-mock in the harness. Checkout returns
`{ kind: "redirect", url }` (Stripe Checkout: `mode=subscription` for self subscriptions, `payment`
for gifts and tips); the web app navigates to it. Stripe events arrive at
`POST /api/webhooks/stripe` (signature checked with `STRIPE_WEBHOOK_SECRET`, stored in
`payment_events` before processing, idempotent per event id) and drive the same transitions as the
manual table: `checkout.session.completed` / `invoice.paid` → confirm (with Stripe's fee and tax),
`invoice.payment_failed` → `past_due`, `customer.subscription.deleted` → `canceled`,
`charge.refunded` → refund, `charge.dispute.created` / `charge.dispute.closed` → chargeback (lost)
or reinstatement (won). Payout accounts are Connect Express (`payoutAccount.onboardingUrl`). The
harness signs events locally with Stripe's documented scheme (ADR 0003 §7). The details are in
the Stripe unit's brief; the test ids below do not change.

## Routes

| Route                     | Change in E4b                                                                                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/$channel`               | A Support button opens the Support dialog (subscribe / gift subs / tip). Chat shows sub, gift and tip events inline                                                       |
| `/settings/subscriptions` | New, signed-in only: your subscriptions, cancel at period end                                                                                                             |
| `/revenue`                | New, studio, signed-in only: balances, by source, subscribers by tier, revenue ledger, CSV statement, payout account, tier editor                                         |
| `/treasury`               | New, signed-in treasurers only (others get a not-found page): payments to confirm, refund and chargeback, payout run and mark paid, payout accounts, infrastructure costs |
| `/transparency`           | New, public: monthly revenue, creator payouts, costs, surplus and patronage from the ledger                                                                               |
| `/dashboard`              | Adds a link to `/revenue`                                                                                                                                                 |

## Test ids

### Navigation

| Test id                      | Element / meaning                                               |
| ---------------------------- | --------------------------------------------------------------- |
| `revenue-link`               | On `/dashboard` and in the studio sidebar, a link to `/revenue` |
| `account-subscriptions-link` | In the account menu, a link to `/settings/subscriptions`        |
| `account-treasury-link`      | In the account menu, a link to `/treasury`, for treasurers only |
| `footer-transparency-link`   | In the site footer, a link to `/transparency`                   |

### Support dialog (`/$channel`)

| Test id                                                  | Element / meaning                                                                                                                                                                                                           |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `support-open`                                           | Opens the dialog. Rendered for everyone except the owner; signed out, it links to `/signin`                                                                                                                                 |
| `support-dialog`                                         | The dialog. `data-provider` = `manual` \| `stripe`                                                                                                                                                                          |
| `support-tab-sub`, `support-tab-gift`, `support-tab-tip` | The three tabs. Sub and gift are disabled (with the reason shown) while the channel has no tiers, and sub while you already hold an `active`/`past_due` subscription                                                        |
| `support-tier`                                           | One tier option (sub and gift tabs), `data-tier` = 1–3, `data-cents` = price, `aria-checked` when chosen                                                                                                                    |
| `support-current`                                        | On the sub tab when you hold a subscription: `data-status`, `data-tier`                                                                                                                                                     |
| `support-gift-count`                                     | The count input, 1–`MONEY_LIMITS.giftMaxCount` (the presets fill it)                                                                                                                                                        |
| `support-gift-recipient`                                 | Recipient mode toggle: items `support-gift-recipient-random` and `support-gift-recipient-viewer`                                                                                                                            |
| `support-gift-to`                                        | Username input, shown for a specific viewer (count is then 1)                                                                                                                                                               |
| `support-tip-amount`                                     | The `<AmountField>` input, in currency units as typed (e.g. `5.00`); `data-cents` is the parsed value                                                                                                                       |
| `support-tip-message`                                    | Tip message, up to `MONEY_LIMITS.tipMessageMaxLength`                                                                                                                                                                       |
| `support-tip-anonymous`                                  | Checkbox: hide your name on the tip                                                                                                                                                                                         |
| `support-split`                                          | The "where your money goes" `<BreakdownBar>`; `data-streamer-share` and `data-coop-share` are the `platform.cut` fractions                                                                                                  |
| `support-total`                                          | The amount the button will charge, `data-cents`                                                                                                                                                                             |
| `support-submit`                                         | Starts the checkout; disabled while invalid or in flight                                                                                                                                                                    |
| `support-error`                                          | The API's message when checkout is refused (e.g. not enough gift recipients)                                                                                                                                                |
| `support-instructions`                                   | Manual adapter result panel, replacing the form: `data-payment-id`; contains `support-reference` (text and `data-reference` = the `CA-…` reference, with a copy `<IconButton tooltip>`) and `support-amount` (`data-cents`) |

### Chat (`/$channel`)

| Test id        | Element / meaning                                                                                                                                                                                                                                  |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat-message` | (E1) It now also carries `data-badges`: the sender's badge types, space-separated (`broadcaster`, `moderator`, `subscriber`, …; empty when none)                                                                                                   |
| `chat-event`   | One inline platform event in the chat log: `data-type` = the event type (`channel.subscribe`, `channel.subscription.gift`, `channel.tip`); `data-user` = the login or empty when anonymous; `data-tier`; `data-cents` (tips); `data-total` (gifts) |

### `/settings/subscriptions`

| Test id               | Element / meaning                                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `subscriptions`       | Page wrapper                                                                                                                            |
| `subscriptions-empty` | `<EmptyState>` when you have none                                                                                                       |
| `subscription-row`    | One subscription: `data-subscription-id`, `data-channel` (slug), `data-tier`, `data-status`, `data-gifted`, `data-cancel-at-period-end` |
| `subscription-cancel` | Inside an `active` row not already cancelling: cancel at period end through a `ConfirmDialog` (`confirm-dialog-confirm`)                |

### `/revenue`

| Test id                                                                        | Element / meaning                                                                                                                                                                                               |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `revenue`                                                                      | Page wrapper                                                                                                                                                                                                    |
| `revenue-month`                                                                | Month filter (`RevenueSummary` period); items are `YYYY-MM`                                                                                                                                                     |
| `revenue-available`                                                            | `<StatCard>`: `data-cents` = `balance.available`; `data-minimum` = `balance.minimumPayout`                                                                                                                      |
| `revenue-held`                                                                 | `data-cents` = `balance.held` (inside the chargeback hold)                                                                                                                                                      |
| `revenue-owed`                                                                 | `data-cents` = `balance.owed` (receivable from clawbacks; rendered only when > 0)                                                                                                                               |
| `revenue-earned`                                                               | `<StatCard>`: `data-cents` = `net` for the period; `data-previous` = `previousNet`                                                                                                                              |
| `revenue-source`                                                               | One `<BreakdownBar>` segment row (legend item): `data-source` = `subscriptions` \| `gifts` \| `tips`, `data-cents`                                                                                              |
| `revenue-tier-row`                                                             | Subscribers table row: `data-tier`, `data-active`, `data-cents` = monthly share                                                                                                                                 |
| `revenue-ledger-row`                                                           | Revenue ledger row (`money.revenueLedger`): `data-transaction-id`, `data-type` (`REVENUE_LINE_TYPES`), `data-tier`, `data-quantity`, `data-gross`, `data-deductions`, `data-net` (signed cents; empty for null) |
| `revenue-ledger-more`                                                          | Loads the next page of the ledger                                                                                                                                                                               |
| `revenue-statement-csv`                                                        | Downloads the period's ledger as CSV (built in the browser from `money.revenueLedger`)                                                                                                                          |
| `revenue-payout-account`                                                       | Payout account card: `data-provider`, `data-enabled`; shows `instructions` (manual) or an onboarding link (Stripe)                                                                                              |
| `revenue-tiers`                                                                | Tier editor form (`money.setTiers`)                                                                                                                                                                             |
| `revenue-tier-name-<n>`, `revenue-tier-price-<n>`, `revenue-tier-benefits-<n>` | Inputs for tier `n` = 1–3; price in currency units as typed                                                                                                                                                     |
| `revenue-tiers-save`                                                           | Saves the tiers; disabled while invalid or in flight. Success is a toast                                                                                                                                        |

### `/treasury`

| Test id                                                                                                          | Element / meaning                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `treasury`                                                                                                       | Page wrapper (treasurers only; anyone else gets the not-found page and no `treasury`)                                                                                                          |
| `treasury-tab-payments`, `treasury-tab-payouts`, `treasury-tab-accounts`, `treasury-tab-costs`                   | Tabs                                                                                                                                                                                           |
| `treasury-search`                                                                                                | Reference search input (any status); empty = the `pending` list                                                                                                                                |
| `treasury-payment-row`                                                                                           | `data-payment-id`, `data-reference`, `data-status`, `data-kind`, `data-cents`, `data-refunded`                                                                                                 |
| `treasury-confirm`                                                                                               | In a `pending` row: confirm receipt through a `ConfirmDialog` (received now)                                                                                                                   |
| `treasury-refund`, `treasury-chargeback`                                                                         | In a succeeded or partly refunded row: open a dialog with `treasury-dispute-amount` (currency units, defaults to the refundable rest), `treasury-dispute-reason` and `treasury-dispute-submit` |
| `treasury-run-payouts`                                                                                           | Runs the payout batch for this month (`periodEnd` = now) at once, no confirmation (a run is idempotent per creator and month)                                                                  |
| `treasury-payouts-result`                                                                                        | After a run: `data-created`, `data-held`, `data-cents`                                                                                                                                         |
| `treasury-payout-row`                                                                                            | `data-payout-id`, `data-username`, `data-status`, `data-cents`, `data-hold-reason`                                                                                                             |
| `treasury-mark-paid`                                                                                             | In a `pending` payout row: a dialog with `treasury-mark-paid-reference` and `treasury-mark-paid-submit`                                                                                        |
| `treasury-account-username`, `treasury-account-reference`, `treasury-account-enabled`, `treasury-account-submit` | Payout account form (`treasurer.setPayoutAccount`)                                                                                                                                             |
| `treasury-cost-category`, `treasury-cost-description`, `treasury-cost-amount`, `treasury-cost-submit`            | Infrastructure cost form (`treasurer.recordCost`, the current UTC month)                                                                                                                       |

### `/transparency`

| Test id                  | Element / meaning                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transparency`           | Page wrapper (public)                                                                                                                             |
| `transparency-stat`      | `<StatCard>`: `data-stat` = `revenue` \| `payouts` \| `costs` \| `surplus`, `data-cents`, summed over the months shown                            |
| `transparency-flow`      | "Where every dollar went" `<BreakdownBar>` for the months shown                                                                                   |
| `transparency-month-row` | One month (`TransparencyMonth`): `data-month` (`YYYY-MM`), `data-revenue`, `data-payouts`, `data-costs`, `data-surplus`, `data-patronage` (cents) |
| `transparency-empty`     | `<EmptyState>` when the ledger has no months yet                                                                                                  |

## The `e4b-money` scenario

Runs against the stack with `PAYMENTS_PROVIDER=manual`; `--set via=api` drives the same steps
through the API only. It needs `DATABASE_URL` (from `.env`) for one step: granting the
treasurer role with the operator CLI.

1. **Setup.** Sign up a streamer, a treasurer, three viewers (A, B, C). Grant the treasurer role
   (CLI) and sign the treasurer in. The streamer sets three tiers on `/revenue`. B and C follow the
   channel and chat once (the gift pool).
2. **Subscribe.** A opens Support, picks tier 2 and gets `support-reference`. The treasurer finds
   it with `treasury-search` and confirms. A's `/settings/subscriptions` row is `active` tier 2;
   chat shows a `channel.subscribe` `chat-event`; the subscriber badge appears on A's messages.
3. **Gift.** A gifts 2 tier-1 subs to random recipients; the treasurer confirms; B and C each hold
   an `active` gifted subscription; chat shows one `channel.subscription.gift` with `data-total="2"`.
4. **Tip.** A tips 5.00 with a message, anonymously; confirmed; chat shows `channel.tip` with an
   empty `data-user` and `data-cents="500"`.
5. **Dashboard.** `/revenue` shows `revenue-held` = the creator shares (cut applied, integer
   floors), `revenue-available` = 0 (inside the hold), sources split subs / gifts / tips, the tier
   rows count tier 1: 2 active (the gifts), tier 2: 1, tier 3: 0, and there is one ledger row per
   payment whose `data-net` values sum to `revenue-earned`.
6. **Refund and chargeback.** The treasurer refunds the tip in full and charges back the tier-2
   payment. The ledger gains `refund` and `chargeback` rows with negative `data-net`; A's
   subscription is `canceled`; `revenue-held` drops by exactly the reversed creator shares.
7. **Payout threshold.** `treasury-run-payouts`: with every creator share still inside the hold,
   the streamer gets no payout (below the minimum: `data-created="0"`), and nothing is lost: the
   sum of held, available and owed is unchanged. Integration tests cover release, clawback
   netting and paid payouts, which need the hold period to pass.
8. **Transparency.** `/transparency` shows this month with `data-revenue` equal to the creator
   plus co-op shares net of the reversals.
9. **Ledger integrity.** With `DATABASE_URL`, every ledger transaction referencing the scenario's
   payments sums to zero per currency (the DB triggers enforce it; this proves the postings
   reached the ledger at all).
