<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W1-breakdown: glass-box payment breakdown, fee schedule and the reconciliation invariant

You are implementing unit W1-breakdown for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, PLAN.md and docs/architecture.md first, then `.claude/briefs/next/W1-quick-wins.md`,
`.claude/briefs/w1/contract-step.md` (all of it; §0, §1.1, §1.3, §3.1, §4.1, §8.2, §10 especially),
`docs/product/feature-wins.md` §4.1, `docs/decisions/0013-ledger-splits.md` (decisions 2 and 5:
`PaymentMeta` v2 and the reversal vector), `docs/testing/w1-selectors.md` (Breakdown ids,
`e4b-money` extensions), `apps/web/src/i18n/README.md` and `.claude/briefs/_done-means.md`. Do not
look outside the repository. Work in your own git worktree on a branch named `w1/breakdown`,
created from the commit the orchestrator gives you (after the W1 and N1 contract steps; run `git
merge main` first if main moved). Wave 1. Checked against `a43aa6b`; recheck line numbers against
your base.

**Decided (2026-10-30):** the Support dialog's fee estimate is Stripe 1.5–3.9 % + 30 ¢
(`PROCESSOR_FEE_ESTIMATE`, labelled an estimate; `manual` none); no patronage estimate on the
breakdown in W1; the breakdown receipt email is deferred to M1 (this unit sends no email).

## Why

Viewers cannot see how much of a payment reaches the creator, and creators see only aggregated
net (feature-wins §4.1). CommonAir's ledger already holds every cent of every split; this unit
shows it per payment, shows the co-op's processor fee and net honestly (co-op net can be negative
on small tips at the 10 % cut), dates the cut that applied, and proves nightly that the breakdown
and the ledger agree.

## You own (write only these)

- `packages/ledger/src/breakdown.ts` (stub from the contract step, already exported from
  `packages/ledger/src/index.ts`) and `packages/ledger/tests/breakdown*.test.ts`
- `services/api/src/money/breakdown.ts` (stub from the contract step: `breakdownHandlers`) and
  `services/api/src/money/fee-schedule.ts` (stub: `feeScheduleHandler`)
- `services/worker/src/jobs/money-reconcile.ts` (stub) and `services/worker/src/money/reconcile.ts` (new)
- Web: `apps/web/src/components/money/breakdown-*.tsx` (new: the dialog, table, timeline, estimate),
  `apps/web/src/components/money/fee-schedule.tsx` (stub), `apps/web/src/components/money/revenue.tsx`,
  `apps/web/src/components/money/transparency.tsx` (only around the `<FeeSchedule />` mount the step
  added), `apps/web/src/routes/_studio/revenue.tsx`, `apps/web/src/routes/_app/settings.subscriptions.tsx`,
  `apps/web/src/components/support/support-dialog.tsx` (the estimate only)
- i18n: `apps/web/src/i18n/locales/en/w1-breakdown.json` and `keys/w1-breakdown.gen.ts` (prefixes
  `breakdown.`, `feeSchedule.`)
- Tests: `services/api/tests/breakdown*.test.ts`, `services/api/tests/fee-schedule*.test.ts`,
  `services/worker/tests/money-reconcile*.test.ts`, `apps/web/tests/breakdown*.test.ts(x)`
- Harness: `harness/src/w1/breakdown.ts` (`stepBreakdown`, `stepReconciliation`) and
  `harness/tests/w1/breakdown.test.ts`
- Docs: `docs/viewers/payment-breakdown.md` (new: what each line means, why co-op net can be
  negative, what "estimate" means)

Read-only, in particular: `packages/ledger/src/{meta,rules,reversals,settings,queries,accounts,math}.ts`
(the contract step froze `PaymentMetaV2`/`ReversalMetaV2`; **you never edit `rules.ts`**, it goes
to W2-splits), `packages/contracts/**`, `packages/db/**`, `services/api/src/money/{reports,reports-lib,checkout*,stripe-*}.ts`,
`services/api/src/metrics.ts` (`apiMetrics.breakdownViews`), `services/api/src/routes/{money,coop}.ts`,
`apps/web/src/i18n/**` outside your namespace, `harness/src/w1/{steps,kit,selectors}.ts`,
`harness/scenarios/e4b-money.ts`, `harness/src/money*.ts`. Anything else is a **contract request**
with the exact diff.

## Contracts you must honor (read-only for you)

- `money.paymentBreakdown({ paymentId })` → `PaymentBreakdown`; `money.paymentBreakdowns({ role,
  cursor, limit })` → page; `coop.feeSchedule()` → `FeeScheduleEntry[]` (contract step §1.3).
- `BreakdownLine.kind` ∈ `BREAKDOWN_LINE_KINDS`; `component` on `reversal` lines;
  `BREAKDOWN_EVENT_KINDS`; `FEE_SCHEDULE_KEYS`; `PROCESSOR_FEE_ESTIMATE` and
  `SupportInfo.feeEstimate`; `RevenueLine.paymentId`.
- `PaymentMetaV2` (`creatorCents`, `coopCents`, `feeCents`, `taxCents`, `streamerShare`,
  `coopShare`, `cutHistoryId`, `shares[]`) and `ReversalMetaV2` (`revenueGrossCents` negative for
  refunds and chargebacks, `disputeFeeCents`, `feeRefundCents`, `shares[]`).
- Job `money-reconcile` on `QUEUES.payments`, daily, tickable through the ops hook.
- Test ids and the `e4b-money` `breakdown` / `reconciliation` extensions in `docs/testing/w1-selectors.md`.

## What is there today (verified at `a43aa6b`; recheck against your base)

- `paymentSucceeded` posts gross to settlement, tax payable, the creator hold (memo
  `hold:<paymentId>`), the co-op cut (`accounts.platformCut()`), and the fee as a `paymentFees`
  debit against settlement (`packages/ledger/src/rules.ts:132-170`). Reversals post the reversed
  tax, creator share (from lots, liability, then a receivable) and cut; a chargeback adds the dispute
  fee as `paymentFees` against settlement (`:283-370`); a won chargeback restores them and returns
  the fee (`:388-440`). All transactions of a payment have `ref_type = 'payment'`, `ref_id = paymentId`
  and idempotency keys `payment:`, `hold-release:`, `refund:`, `chargeback:`, `chargeback-reversal:`.
- `holdReleaseDueAt(succeededAt, holdDays)` (`rules.ts:173`); `holdDays` from `loadMoneySettings`
  (`packages/ledger/src/settings.ts`), readable by the API and the worker.
- `payments.anonymous` (`packages/db/src/schema/money.ts:85`); `visiblePayer` in
  `services/api/src/money/reports-lib.ts:109` already masks payers for the creator's revenue rows.
- `governance_settings_history (id, key, old_value, new_value, proposal_id, changed_at)`
  (`packages/db/src/schema/coop.ts:124-135`), written only by the settings trigger; the seed writes
  no history row.
- Revenue UI: `apps/web/src/components/money/revenue.tsx` (ledger table at :230-…), studio page
  `apps/web/src/routes/_studio/revenue.tsx`; support dialog
  `apps/web/src/components/support/support-dialog.tsx`; transparency
  `apps/web/src/components/money/transparency.tsx`.

## Build

1. **Builder (`packages/ledger/src/breakdown.ts`, pure).** Input: the payment row facts (id, kind,
   gross, currency, `succeededAt`, `anonymous`, payer id, channel), its ledger transactions (kind,
   `occurredAt`, metadata, entries) and `holdDays`. Output: `PaymentBreakdown` minus the DTO-only
   fields. Lines: `tax`, one `creator` per `shares[]` entry (`recipientUserId`), `coop_share`
   (gross side, sum = gross exactly); `processor_fee` (`feeCents`, positive, outside gross);
   per reversal transaction, `reversal` lines per component (negative, summing to its
   `revenueGrossCents`), plus a `dispute_fee` line for a chargeback and a negative `dispute_fee` for
   a returned fee; one derived `coop_net` = co-op share − its reversals − processor fee − dispute
   fees + returned fees (signed; null `transactionId`). Timeline: one item per transaction
   (`paid`, `hold_released`, `refunded`, `charged_back`, `chargeback_won`). `holdReleasesAt` =
   `holdReleaseDueAt` unless a `hold_release` exists (then `holdReleasedAt`). Throw on v1 or
   unparsable metadata (there is no v1 reader). N creator lines work unchanged when Ledger Splits
   adds crew shares.
2. **Settlement invariant (same file):** `settlementMovement(transactions)` sums every entry on the
   payment's settlement account (`settlementAccount(provider, settlement)` from `rules.ts`, read-only)
   across its transactions; `reconciles(b, movement)` checks gross-side lines + reversal lines −
   fee lines (processor and dispute, net of returns) = movement. Export both for the job and tests.
3. **API (`services/api/src/money/breakdown.ts`).** `paymentBreakdown`: load the payment; the caller
   must be its payer or the payee channel's owner, else `NOT_FOUND` (never `FORBIDDEN`: ids are
   time-ordered, authorization is the guard); a payment not yet `succeeded` → `NOT_FOUND`. Load its
   transactions and entries, `holdDays`, and for `cutSource` the history row of
   `metadata.cutHistoryId` (null id → seed: `changedAt`, `proposalId` null, the shares from metadata).
   Payee view of an anonymous payment (including gift breakdowns): `payer` null. Record
   `apiMetrics.breakdownViews.add(1, { role })`. `paymentBreakdowns`: keyset page by
   (`succeeded_at` desc, id) of the caller's payments (`role: "payer"`) or of payments to channels
   the caller owns (`"payee"`), each built the same way; batch the transaction reads (one query per
   page, not per payment).
4. **Fee schedule (`money/fee-schedule.ts`).** `coop.feeSchedule`: history rows for
   `FEE_SCHEDULE_KEYS`, newest first, plus one synthetic seed entry per key at the end (the oldest
   history row's `old_value`, or the current value when no history exists; `id`/`changedAt` null).
   Public, cached 60 s in-process (no personal data).
5. **Reconciliation job.** `money-reconcile` (run lock, as `vod-retention.ts`): for payments whose
   transactions changed since the last run (cursor in Valkey, or the last 35 days on first run),
   build the breakdown and compare with `settlementMovement`; count mismatches in a worker money
   metric (add your counter in `services/worker/src/money/reconcile.ts`, not in the shared
   `metrics.ts`) and log each mismatch with the payment id and the two totals only. Return
   `{ payments, mismatches }`.
6. **Web.** A breakdown dialog (`Dialog`, semantic `<table>`, `<MoneyAmount>` for every amount, a
   negative co-op net announced in words, not colour alone; the cut source linking to
   `/transparency#fee-schedule`), opened from each payment row of the creator's revenue ledger
   (`RevenueLine.paymentId`) and from a "Your payments" list on `/settings/subscriptions`
   (`paymentBreakdowns({ role: "payer" })`); the fee schedule on `/transparency` (`<FeeSchedule/>`,
   anchor `fee-schedule`); the support dialog's "estimated split" for the chosen amount: creator and
   co-op share from `split`, fee range from `feeEstimate` (labelled "estimate", hidden when null).
   House primitives only (`<MoneyAmount>`, `<RelativeTime>`, `<EmptyState>`, `<Skeleton*>`),
   dark-first, 320 px, logical CSS.
7. **Harness.** `stepBreakdown(run: MoneyExtension)` and `stepReconciliation(run)` as
   `docs/testing/w1-selectors.md` "e4b-money extensions" says, in both `via` modes and with
   `provider=stripe` (the won chargeback).

## Tests you must add

- Unit (`packages/ledger`): a **property test** over random gross, tax, cut and sequences of partial
  refunds and chargebacks (and a won chargeback): gross-side lines sum to gross, each reversal's
  lines sum to its amount, fee lines stay outside, `coop_net` equals its definition,
  `reconciles` holds against postings built by the real rules (`paymentSucceeded`, `refund`,
  `chargeback`, `chargebackReversal`); a two-share vector (hand-built `PaymentMetaV2`) yields two
  creator lines; v1 metadata throws; the hold date falls back to `holdReleaseDueAt`.
- API integration (`createTestDatabase()`): manual payment confirmed by the treasurer and a
  stripe-mock payment (the existing money test helpers); payer and owner see it, a stranger and the
  channel's moderator get `NOT_FOUND`; anonymous tip hides the payer from the owner only;
  `cutSource` seed vs a history row after a `platform.cut` change; paging both roles; fee schedule
  with and without history.
- Worker integration: `money-reconcile` reports 0 mismatches on real postings and 1 on a payment
  whose settlement entries were tampered with in a fixture database built for it (insert an extra
  balanced transaction with the payment's `ref_id` that moves settlement).
- Web: the dialog renders every line kind with the right sign and the negative co-op net text;
  the estimate hides with `feeEstimate: null`; `i18n:check` and `logical-css` pass.

## Done means

Follow `.claude/briefs/_done-means.md`. CI on main is the gate: run only targeted checks
(`bun --bun vp test run` and `bun run test:int` in `packages/ledger`, `services/api`,
`services/worker`, one package's `test:int` at a time; `bunx tsc -p` for each and `apps/web`;
`vp lint --deny-warnings` and `vp fmt` on your paths; `vp build`, `bun run i18n:check` in
`apps/web`; `bun --bun vp test run` in `harness`; `reuse lint`). Never run `bun run verify`,
`verify:full`, a harness scenario against a stack, `podman compose` or `scripts/infra.ts`.
`git status` shows only your paths. Commit in your worktree (`git commit -s`, Conventional Commits,
ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Final message: what you
built, test counts per package, branch and sha, contract requests (exact diffs), proposed PROGRESS text, anything left undone, and the commands the user runs
live: `bun harness/src/cli.ts run e4b-money --set w1=breakdown,reconciliation` (and with
`--set via=api --set provider=stripe`) on the harness stack.
