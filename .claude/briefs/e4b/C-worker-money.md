<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E4b unit C, worker-money** for CommonAir (repo: /Users/joshe/Repos/bcon).
Read AGENTS.md, PLAN.md, docs/architecture.md and `.claude/briefs/e4b/_common.md` first, then
`docs/testing/e4b-selectors.md` in full and `services/worker/README.md`. Do not look outside the
repository.

## You own (write only these)

- `services/worker/src/money/**` (new), `services/worker/src/jobs/money-*.ts`,
  `services/worker/src/jobs/index.ts` (add your jobs to `JOBS`), `services/worker/src/env.ts`
  (only to add `paymentsEnv` from `@commonair/config` to the worker's env), the worker README's
  new "Money jobs" section
- `services/worker/tests/money*.test.ts`, `services/worker/tests/money*.int.test.ts`

## Contracts you must honor (read-only for you)

- `QUEUES.payments` (new, `packages/contracts/src/internal.ts`), `defineJob` and the scheduling
  and run-lock patterns of the existing jobs (`src/runtime/registry.ts`, `src/integrity/lock.ts`,
  `src/jobs/vod-retention.ts`).
- Tables `payments`, `subscriptions`, `tips`, `channels`, `users`, `channel_sub_tiers`, `events`;
  migration `0013` (`payments.expires_at`, `tier`, `quantity`, `subscriptions.gift_payment_id`).
- Events `channel.subscription.end` (payload in `packages/contracts/src/events.ts`; validate
  with `EVENTS[type].payload` before insert, as the API's `emit` does) — you write `events` rows,
  the existing outbox relay publishes them.
- `@commonair/ledger` (`releaseDueHolds`, `loadMoneySettings`), `@commonair/payments`
  (`manualReference`), `paymentsEnv` (`PAYMENT_PENDING_DAYS`, `CURRENCY`).
- Chat badges: after a subscription leaves `active`/`past_due`, publish the same chat
  `invalidate` (`BUS.chatControl(channelId)`, `scope: "user"`) the API uses, after commit.

## Build

Spec rows **Expiry**, **Renewal** and **Hold release**, as three scheduled jobs on
`QUEUES.payments`, each under a Valkey run lock so two worker replicas never run one at once:

1. `money-expire-pending` (every 5 minutes): `pending` payments with `expires_at <= now` →
   `failed` (CAS on status), with their `incomplete` subscriptions → `expired`, a `past_due`
   renewal's subscription → `expired` + `channel.subscription.end`, tip → `failed`. Batches of
   ≤ 500 rows per transaction; loop until done or a time budget (30 s) is spent.
2. `money-renew` (every 5 minutes): subscriptions `active` with `current_period_end <= now`.
   `cancel_at_period_end` → `canceled`; gifts (`gift_payment_id` not null) → `expired`; both emit
   `channel.subscription.end` (`is_gift` set for gifts). Manual self subscriptions → one renewal
   payment (`pending`, `provider: manual`, `provider_ref = manualReference()` with retry on
   conflict, `kind: subscription`, `subscription_id`, `tier`, `quantity: 1`, amount = today's
   tier price from `channel_sub_tiers`, `expires_at = current_period_end + PAYMENT_PENDING_DAYS`)
   and status `past_due`, in one transaction, idempotent: never a second pending renewal for the
   same subscription and period (check inside the transaction with the subscription row locked).
   A channel with no tiers anymore → the subscription ends (`expired` + end event). Stripe
   subscriptions (`provider: stripe`) are skipped: Stripe's events drive them.
3. `money-release-holds` (hourly): `releaseDueHolds(db, { asOf: now, holdDays, currency })`
   with `holdDays`/`currency` from `loadMoneySettings` (read per run). Log counts, never ids of
   users at info level.
4. Metrics like the other jobs (counters for expired, renewed, ended, released cents) and the
   README section (schedules, idempotency, what the treasurer sees).

## Tests you must add

- Unit: period/expiry arithmetic, batching and time-budget loop with a fake clock.
- Integration (`createTestDatabase()` + the real Valkey; call the job handlers directly with a
  fixed `now`, as the existing worker int tests do): expiry flips payment/subscriptions/tip and
  emits end only for `past_due`; expiry leaves `succeeded` payments alone; renewal creates one
  pending payment and `past_due` (second run creates none); price change applies to the renewal;
  cancel-at-period-end → `canceled` + event; gift → `expired` + event with `is_gift`; Stripe
  subscriptions untouched; hold release moves a 7-day-old creator share from hold to available
  and a 6-day-old one not (post the payments with `@commonair/ledger` `paymentSucceeded` + `post`
  directly); run lock prevents a concurrent second run.

## Done means

See `_common.md` "Done means". Your package: `services/worker` (`bun run test`, `bun run
test:int` once at the end, `tsc`), lint/fmt on changed paths.
