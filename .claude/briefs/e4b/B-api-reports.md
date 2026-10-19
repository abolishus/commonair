<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E4b unit B, api-reports** for CommonAir (repo: /Users/joshe/Repos/bcon).
Read AGENTS.md, PLAN.md, docs/architecture.md and `.claude/briefs/e4b/_common.md` first, then
`docs/testing/e4b-selectors.md` in full. Do not look outside the repository.

## You own (write only these)

- `services/api/src/money/reports*.ts` (one file or several with that prefix)
- `services/api/tests/money-reports*.test.ts` and `services/api/tests/money-reports*.int.test.ts`

Unit A owns `services/api/src/money/checkout*.ts`, `packages/payments/**` and the service README's
Money section in parallel. Do not edit `src/routes/money.ts` or `src/routes/coop.ts` (they already
use your `reportHandlers`, `treasurerReportHandlers` and `transparencyHandler`). README text you
want goes in your final message as a contract request for unit A's section.

## Contracts you must honor (read-only for you)

- `money.revenue` (`RevenueSummary`), `money.revenueLedger` (`RevenueLine`,
  `REVENUE_LINE_TYPES`), `money.payouts`, `money.payoutAccount`, `money.statement`
  (`LedgerLine`), `money.treasurer.runPayouts`, `payouts` (`TreasurerPayout`), `markPaid`,
  `recordCost`, `coop.transparency` (`TransparencyMonth`).
- Tables `ledger_*`, `payments`, `subscriptions`, `tips`, `disputes`, `payouts`,
  `payout_accounts`, `infra_costs`, `users`, `channels`, `governance_settings`, plus what
  `TransparencyMonth` needs for `egressBySource`, `governance` and `members` (find the tables in
  `packages/db/src/schema/{delivery,coop}.ts`).
- `@commonair/ledger`: `creatorBalances`, `statement`, `monthlyAggregates`, `releaseDueHolds`,
  `runPayoutBatch`, `postPayout`, `infrastructureCost` + `post`, `loadMoneySettings`, `accounts`.
- `paymentsEnv` (`PAYMENTS_PROVIDER`, `CURRENCY`, `MANUAL_PAYOUT_INSTRUCTIONS`). `audit` from
  `src/events/audit.ts`.

## Build

Spec rows **Payout run** and **Mark paid**, plus:

1. **`revenue`** (owner): period = `[from, to)`, default the current UTC month. `gross`,
   `coopCut`, `refundsAndChargebacks`, `net` (creator share net of reversals), `pendingPayout`
   (scheduled payouts not yet paid), `activeSubscriptions` and `tiers` (active + past_due per
   tier, `monthlyShare` = Σ over those subscriptions of the creator split of `price_cents` with
   today's cut and the ledger's rounding rule — use the ledger's split helper, never floats),
   `tips` (count of succeeded tips in the period), `split`, `daily` (UTC dates, gross and net in
   cents), `balance` (from `creatorBalances`: available, held, owed = receivable,
   `minimumPayout` and `holdDays` from `payout.rules`), `bySource` (creator share by
   subscriptions / gifts (payments with `quantity` > 1 or gift subscriptions) / tips, net of
   reversals), `previousNet` (same-length period just before). Every figure comes from ledger
   entries on the owner's creator accounts joined to the `payments` row the transaction refers to
   (`ref_type`/`ref_id`, metadata), not from `payments` amounts.
2. **`revenueLedger`** (owner): one row per ledger transaction that changed the owner's creator
   accounts (`liability:creator`, `liability:creator-hold`, `asset:receivable:creator`), newest
   first, keyset-paged by (occurred_at, transaction id); hold releases are internal moves and are
   **not** rows. `type` from the posting kind and payment (`subscription`, `gift`, `tip`,
   `refund`, `chargeback`, `payout`); `gross` (payment gross, negative for reversals), `deductions`
   (tax + co-op share + fees, opposite sign), `net` (change to what is owed to the creator),
   `from` (the payer from `payments.user_id` joined to `users` at read time; null for anonymous
   tips and payouts), `reference` (payment reference or payout reference). Filter by `from`/`to`.
3. **`statement`**, **`payouts`**: the caller's own, paged / listed newest first.
4. **`payoutAccount`**: manual → `{ provider: "manual", payoutsEnabled, onboardingUrl: null,
   instructions: MANUAL_PAYOUT_INSTRUCTIONS unless enabled }` from `payout_accounts`; with no row,
   `payoutsEnabled: false`. Stripe comes later (unit G).
5. **Treasurer**: `runPayouts` (spec: refuse a future `periodEnd`; `releaseDueHolds` as of now
   first; the UTC month of `periodEnd`; result counts and total), `payouts` (filter by status,
   paged, with the user), `markPaid` (`pending` only, CAS, `postPayout`, reference ≤ 200 chars
   stored as `provider_ref`, audit), `recordCost` (`infra_costs` + `infrastructureCost` posting in
   one transaction, category slug-validated, the free-text description stays in `infra_costs` and
   never in the ledger, audit). Audit actions `payout.run`, `payout.paid`, `cost.record`.
6. **`coop.transparency`** (public): the last `months` UTC months from `monthlyAggregates`
   (months with no ledger activity are omitted), `costs` by category, `egressBySource` from the
   egress accounting tables (integers; zeros when absent), `governance` (proposals decided in
   that month; `[]` if none), `members` (counts per class at month end; zeros if the co-op tables
   are empty). Cache-friendly: no per-viewer data.

## Tests you must add

- Unit: period parsing and defaults (month boundaries in UTC), previous-period arithmetic,
  revenue-line type mapping, CSV-safe values (no free text in `reference`).
- Integration (`createTestDatabase()`; build fixtures by inserting `payments`/`tips`/
  `subscriptions` rows and posting with `@commonair/ledger` rules directly — do not depend on
  unit A's handlers): a month with two subs (one gift payment of 3), a tip and an anonymous tip,
  a partial refund and a chargeback after hold release → `revenue` figures exact to the cent
  (bySource sums to `net`; `balance` matches `creatorBalances`); `revenueLedger` rows and paging
  (no hold-release rows; anonymous tip `from: null`); `previousNet`; `runPayouts` below the
  minimum → nothing created and balances unchanged; above the minimum without a payout account
  → `held`; with one → `pending`; second run in the same month is idempotent; future
  `periodEnd` → `BAD_REQUEST`; `markPaid` posts once (double call → `CONFLICT`) and nets a
  receivable; `recordCost` shows in `transparency` costs and surplus; non-owner → `FORBIDDEN`;
  non-treasurer → `FORBIDDEN`; `transparency` public with months omitted when empty.

## Done means

See `_common.md` "Done means". Your package: `services/api` (`bun run test`, `bun run test:int`
once at the end, `tsc`), lint/fmt on changed paths.
