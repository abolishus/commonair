<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W1-fraud-floor: payment fraud signals that hold payouts, with four-eyes release

You are implementing unit W1-fraud-floor for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, PLAN.md and docs/architecture.md first, then `.claude/briefs/next/W1-quick-wins.md`,
`.claude/briefs/w1/contract-step.md` (all of it; §0, §1.1 `PAYMENT_FRAUD_*` and `FRAUD_REVIEW_HOLD`,
§1.3 `money.treasurer.fraudFlags` and `PaymentFraudFlag`, §1.5 `money.fraud.flag`, §2.2, §2.3
(migration 0038's two triggers), §4.1, §6.1, §10 `fraud-hold`, §13 items 4, 5 and 11 especially),
`docs/decisions/0036-payment-fraud-floor.md` (the ADR you implement),
`docs/product/feature-wins.md` §4.10 "Prerequisite: W1-fraud-floor" and §8 review items (T&S:
"blocks payouts, with a four-eyes flag and trigger or job enforcement"),
`docs/decisions/0013-ledger-splits.md` (what W2-splits expects of you), `docs/decisions/0020-coop-policies.md`
(the two-person rule you mirror), `docs/testing/w1-selectors.md` and `.claude/briefs/_done-means.md`.
Do not look outside the repository. Work in your own git worktree on a branch named
`w1/fraud-floor`, created from the commit the orchestrator gives you (after the W1 and N1 contract
steps; run `git merge main` first if main moved). Wave 1. Checked against `a43aa6b`; recheck line
numbers against your base.

**ADR 0036 (Payment fraud floor) was accepted on 2026-10-30.** The kinds, thresholds, four-eyes
rule and payout hold in the contract step are its decisions. The user also decided that a
**`confirmed` flag keeps holding** the payee's payouts, including later batches; a cleared flag
releases; only an admin's audited account action (`money.treasurer.fraudFlags.release`) releases a
confirmed one. Build to the contract step; if a threshold changes the constant changes, not your
code.

## Why

Ledger Splits (W2) turns every channel into a possible mule cash-out path: stolen cards pay a
channel, the split pays accomplices. Feature-wins makes a fraud floor a prerequisite that **blocks
payout release**, not one that merely flags. This unit adds cheap, explainable signals (payer
velocity, payer concentration and new payers, a first large payout), holds the affected payee's
payouts with `hold_reason = 'fraud_review'`, and lets money move again only after two different
people agree. The database refuses a release while a flag is open (migration 0038), so a bug in
application code cannot pay out early.

## You own (write only these)

- `packages/integrity/src/payments/**` (the contract step created `payments/index.ts` as a stub
  and already re-exports it from the package barrel: put pure signal functions and their SQL inputs
  here) and `packages/integrity/tests/payments*.test.ts`
- `packages/ledger/src/payouts.ts` (the release-eligibility hook: handed to W2-splits after you
  merge) and `packages/ledger/tests/payouts*.test.ts` you add
- `services/api/src/money/fraud.ts` (stub: `treasurerFraudHandlers`) and
  `services/api/tests/money-fraud*.test.ts`
- `services/worker/src/jobs/money-fraud-scan.ts` (stub), `services/worker/src/money/fraud.ts` (new)
  and `services/worker/tests/money-fraud*.test.ts`
- Web: `apps/web/src/components/money/treasury.tsx` (a new "Fraud review" tab and `data-hold-reason`
  on payout rows), `apps/web/src/routes/_admin/treasury.tsx` (content only: the tab wiring; never
  rename or remove it), `apps/web/src/components/money/fraud-*.tsx` (new)
- i18n: `apps/web/src/i18n/locales/en/w1-fraud.json`, `keys/w1-fraud.gen.ts` (prefix `fraud.`)
- Tests: `apps/web/tests/fraud*.test.tsx`, `apps/web/tests/treasury*.test.tsx` where your tab changes them
- Harness: `harness/src/w1/fraud.ts` (`stepFraudHold`), `harness/tests/w1/fraud.test.ts`
- Docs: `docs/operators/payment-fraud-review.md` (new: what each flag means, the four-eyes
  procedure, what confirming does and does not do, how an admin releases a confirmed flag with the
  API call, since W1 has no admin web page for it)

Read-only, in particular: `packages/ledger/src/{rules,reversals,queries,locks,accounts,meta,settings}.ts`,
`packages/integrity/src/{index,thresholds}.ts`, `packages/contracts/**`, `packages/db/**` (the
`payment_fraud_flags` table from migration 0037 and its triggers in 0038), `services/api/src/money/{checkout-treasurer,stripe-events,reports}.ts`
(the account-ready release paths at `checkout-treasurer.ts:449-454` and `stripe-events.ts:554-559`
must keep working: they release `payout_account_not_ready` holds only), `services/api/src/routes/money.ts`,
`services/worker/src/moderation/records.ts` (`emit`, `audit`), `harness/src/w1/{steps,kit,selectors}.ts`,
`harness/scenarios/e4b-money.ts`, `harness/src/money*.ts`. Anything else is a **contract request**
with the exact diff.

## Contracts you must honor (read-only for you)

- Enums and rules: `PAYMENT_FRAUD_KINDS` (`payer_velocity`, `payer_concentration`, `new_payee`,
  `manual`), `PAYMENT_FRAUD_STATUSES` (`open → reviewed → cleared | confirmed`),
  `PAYMENT_FRAUD_DECISIONS`, `PAYMENT_FRAUD_RULES` (thresholds), `FRAUD_REVIEW_HOLD` (`fraud_review`).
- Table `payment_fraud_flags` (one undecided flag per payee and kind, partial unique index;
  `evidence` ids, counts and cents only; `note` treasurers' text on the mutable row, never in audit
  details; `released_by_id`/`released_at` set once by an admin on a confirmed flag).
  Migration 0038: the guard trigger (review by a treasurer or admin, decision by a **different**
  treasurer or admin, nobody acting on a flag about their own payouts, frozen once decided except
  one admin release of a confirmed flag, never deleted) and `payouts_fraud_guard` (no payout
  inserted or moved into `pending`/`scheduled`/`paid` while the payee has a **holding** flag: open,
  reviewed, or confirmed and not released).
- `money.treasurer.fraudFlags.{list, raise, review, decide, release}` (`decide` is `finance` access
  and declares `SECOND_APPROVER`; `release` is `admin` access), `PaymentFraudFlag` (with
  `releasedBy`, `releasedAt`, `heldPayouts`).
- Internal event `money.fraud.flag` (`flag_id, payee_user_id, kind, status, released,
  held_payouts`) and audit actions `money.fraud.raise`, `money.fraud.review`, `money.fraud.decide`,
  `money.fraud.release` in the same transaction as the change.
- Job `money-fraud-scan` on `QUEUES.payments`, every 15 minutes, ops-tickable.

## What is there today (verified at `a43aa6b`; recheck against your base)

- `runPayoutBatch` (`packages/ledger/src/payouts.ts:167-252`) creates one payout per eligible
  creator, `status` `pending` or `held` with `holdReason = PAYOUT_ACCOUNT_NOT_READY` (:56, :229-231),
  and reserves it in the ledger in the same transaction. `postPayout` (:281-…) marks paid;
  `cancelPayout` (:3xx, re-find) moves a payout to `failed` with a reason.
- Held payouts are released (`held → pending`) only for `payout_account_not_ready` when the account
  becomes ready (`services/api/src/money/checkout-treasurer.ts:449-454`,
  `stripe-events.ts:554-559`).
- Payments: `payments` (`payer user id`, `channel`, `kind`, `status`, `amount`, `succeeded_at`,
  `anonymous`), `users.created_at` for account age; the ledger's `payment:` transactions for gross.
- Treasury UI: `apps/web/src/components/money/treasury.tsx` with tabs `payments | payouts | accounts
  | costs` (:60-72) composed in `apps/web/src/routes/_admin/treasury.tsx`.
- ADR 0020's patronage approval is the four-eyes model (`packages/db/drizzle/0021_coop_protections.sql:250-300`).

## Build

1. **Signals (`packages/integrity/src/payments/**`, pure + inputs).** `payerVelocity(payments, rules)`:
   payers with more than `velocityMaxPayments` succeeded payments in any `velocityWindowMinutes`
   window → the payees they paid in that window, with evidence `{ payerUserId, payments,
   windowStart }`. `payerConcentration(payeeGross, rules)`: per payee over `concentrationWindowDays`
   with gross ≥ `concentrationMinGrossCents`: the top-`concentrationTopN` share ≥
   `concentrationShare`, or the share from payers whose accounts were younger than
   `newPayerAccountDays` at payment ≥ `newPayerShare`; evidence `{ grossCents, topShareBps,
   newPayerShareBps, payers }`. `newPayee(firstPayoutCents, rules)`. Exact integer arithmetic
   (basis points), no floats in evidence. SQL readers return only ids, counts and cents.
2. **Scan job (`money-fraud-scan` + `services/worker/src/money/fraud.ts`).** Under a run lock: run
   the signals over the recent window; for each hit, insert a flag (`on conflict do nothing` on the
   open-flag index), move that payee's `pending`/`scheduled` payouts **and its `held` payouts with
   `hold_reason = 'payout_account_not_ready'`** to `held` with `hold_reason = 'fraud_review'` (a
   payout already `paid` or `failed` is untouched; the re-tag matters because the account-ready
   release paths in `checkout-treasurer.ts`/`stripe-events.ts` would otherwise hit
   `payouts_fraud_guard` and fail the whole treasurer call or Stripe webhook), emit `money.fraud.flag`
   and audit `money.fraud.raise` (actor `system`, details `{ flagId, kind }`), one transaction per
   payee. **No re-raise after a decision:** skip a (payee, kind) whose latest flag was cleared or
   confirmed at or after the start of the hit's evidence window, and count only evidence newer than
   that decision (otherwise the next 15-minute scan re-flags the same 30-day concentration and undoes
   every clear). Return `{ flagged, held }`. Add your counters in `services/worker/src/money/fraud.ts`
   (payouts held for review, flags by kind and outcome), not in the shared metrics file.
3. **Release hook (`payouts.ts`).** One predicate, exported for the API and worker: a flag
   **holds** when it is `open` or `reviewed`, or `confirmed` with `released_at` null (the same rule
   as `payouts_fraud_guard`). `runPayoutBatch`: a creator with a holding flag gets
   the payout created `held` with `holdReason: FRAUD_REVIEW_HOLD` (account readiness checked after:
   fraud wins), counted in `held`; `new_payee`: before inserting a creator's **first** payout at or
   above `newPayeeFirstPayoutCents`, raise a `new_payee` flag in the same transaction and create it
   held. `runPayoutBatch`'s caller (`services/api/src/money/reports.ts`, read-only for you) audits
   only `payout.run`, so write the flag's `money.fraud.flag` outbox row and its `money.fraud.raise`
   audit row (actor `system`, details `{ flagId, kind }`) from `payouts.ts` itself, in the batch's
   transaction (insert into `schema.events`/`schema.auditLog` directly, as
   `packages/governance/src/outbox.ts` does for events). `postPayout` refuses (`PayoutStateError`) a payout whose payee has a holding flag, before the
   trigger would. Keep the lock order (payout batch → payment → creator).
4. **API (`money/fraud.ts`).** `list` (keyset by `raised_at` desc, filter by status, with
   `heldPayouts` per payee); `raise` (`manual`, by username; holds payouts as the job does; an
   existing undecided `manual` flag → `CONFLICT`); `review` (open → reviewed; refused on any other
   status); `raise` re-tags `payout_account_not_ready` holds exactly as the scan does;
   `decide` (reviewed → cleared/confirmed; the database refuses the reviewer, the raiser or the payee:
   map SQLSTATE `42501` from the guard to the contract's `SECOND_APPROVER` error, `23514` to
   `BAD_REQUEST`); on **clear**, when the payee has no other holding flag, move their
   `fraud_review` held payouts to `pending`, **after** the flag update in the same transaction (the
   trigger reads the flag's new status) (account readiness still applies: a payout whose account
   is not ready becomes `held` / `payout_account_not_ready` instead); on **confirm**, payouts stay
   held, later batches keep creating them held, and the treasurer may use the existing cancel path;
   `release` (admin only; a confirmed flag with `released_at` null, else `CONFLICT`; set
   `released_by_id`/`released_at`, map the guard's `42501` to `FORBIDDEN`), then release the
   payee's `fraud_review` holds exactly as a clear does when no other flag holds. Every change: audit
   (`details: { flagId, kind, status }`; the note goes in neither `details` nor `reason`) and
   `money.fraud.flag` (`released` true only after a release) in the same transaction.
5. **Web.** A "Fraud review" tab in the treasury: flags with kind, payee, evidence in plain words
   (amounts with `<MoneyAmount>`, times with `<RelativeTime>`), held payout count, review and decide
   actions (`ConfirmDialog`), a raise form; the decide button explains it needs a second person;
   payout rows show `data-hold-reason` and a readable hold reason. A confirmed flag reads "held until
   an admin releases it" (or "released by …" with `data-released="true"`); no release button in W1
   (no admin web path). House primitives, dark-first,
   320 px, logical CSS.
6. **Harness `stepFraudHold(run: MoneyExtension)`.** As `docs/testing/w1-selectors.md`: a fresh
   streamer receives tips from new accounts (created just before) above
   `concentrationMinGrossCents`; `money-fraud-scan` ops tick → a flag; the payout run (the period
   the scenario uses) holds the payout with `fraud_review`; a direct SQL `held → pending` update
   fails with `23514`; the treasurer reviews, the same treasurer's decide fails with the second-
   approver error, a second treasurer (granted with `grantRole`; W1 has no admin web path) clears;
   the payout is `pending`.

## Tests you must add

- Unit (`packages/integrity`): velocity window edges (exactly N vs N+1 payments, sliding windows),
  concentration (top-N share at the boundary, new-payer share, below the gross floor), basis-point
  rounding, anonymous payments still count by payer id, refunds excluded.
- Ledger integration: `runPayoutBatch` holds a flagged payee and pays an unflagged one in the same
  run; a payee whose only flag is confirmed is still held in the next batch, and one whose
  confirmed flag was released is not; a payee whose only flag was cleared is paid; a first large
  payout raises `new_payee` and holds; `postPayout` refuses a payee with a holding flag; the
  trigger refuses `held → pending` while a flag holds, including a confirmed unreleased one (belt
  and braces with the application check).
- Worker integration: the scan flags once (idempotent on the second run), holds `pending` payouts,
  re-tags `payout_account_not_ready` holds, leaves `paid` ones, writes the event and audit rows; after
  a clear, a scan over the same evidence raises nothing, and new evidence after the clear does.
- API integration (account-ready path): `money.treasurer.setPayoutAccount` with `payoutsEnabled`
  for a flagged payee succeeds and releases nothing (the re-tagged holds stay `fraud_review`).
- API integration: the five procedures, the four-eyes refusal mapped to `SECOND_APPROVER`, a
  treasurer acting on a flag about their own payouts refused, clear releases holds only when no
  other flag holds, confirm keeps them (and a payout batch after the confirm creates the payout
  held), `release` by an admin releases them and writes `money.fraud.release` and the event with
  `released: true`, `release` by a treasurer is refused, a second release or a release of an
  unconfirmed flag is `CONFLICT`, audit details carry no note text, `treasurer`/`finance`/`admin`
  access enforced.
- Web: the tab renders flags per status and the actions; `i18n:check` and `logical-css` pass.

## Done means

Follow `.claude/briefs/_done-means.md`. CI on main is the gate: run only targeted checks
(`bun --bun vp test run` and `bun run test:int` in `packages/integrity`, `packages/ledger`,
`services/api`, `services/worker`, one package's `test:int` at a time; `bunx tsc -p` for each and
`apps/web`; `vp lint --deny-warnings` and `vp fmt` on your paths; `vp build`, `bun run i18n:check`
in `apps/web`; `bun --bun vp test run` in `harness`; `reuse lint`). Never run `bun run verify`,
`verify:full`, a harness scenario against a stack, `podman compose` or `scripts/infra.ts`.
`git status` shows only your paths. Commit in your worktree (`git commit -s`, Conventional Commits,
ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Final message: what you
built, test counts per package, branch and sha, contract requests (exact diffs), proposed PROGRESS
text and any correction ADR 0036 needs (where the code had to differ from it), anything
left undone, and the commands the user runs live: `bun harness/src/cli.ts run e4b-money --set
w1=fraud-hold` on the harness stack.
