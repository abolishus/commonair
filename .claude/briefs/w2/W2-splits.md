<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W2-splits: per-recipient revenue splits, clawback policy and shortfall suspense

You are implementing unit W2-splits for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/batch6/README.md` (decisions (a), (i),
(o), (p), path ownership and shared rules are binding), `.claude/briefs/w2/contract-step.md` (§0,
§1.1 `SPLIT_*`, §1.2 payout rules, §1.3 `money.splits.*`, §2.1 splits tables and ledger kinds, §2.2,
§3 ledger chart, §6), `docs/decisions/0013-ledger-splits.md` (**decisions 1–8 are your spec**),
`docs/decisions/0036-payment-fraud-floor.md`, `docs/product/feature-wins.md` §4.10,
`docs/testing/w2-selectors.md` (crew) and `.claude/briefs/_done-means.md`. Do not look outside the
repository. Work in your own git worktree on branch `w2/splits`, created from the contract step's
sha (run `git merge main` first if main moved). **Wave 1.** Checked against `8fc2c974`; recheck
every line number against your base.

**Decision (a): splits ship enabled, no feature flag.** Live money stays gated by M1, so on our
instance splits move stripe-mock money only. Counsel on recipient status is open and not yours.

## Why

Every money path assumes one creator per payment. With N recipients under one memo,
`releaseDueHolds` sums every lot, releases to the one metadata creator and strands the rest for
good. This unit makes the lot, the release key, the locks and the reversals per recipient, so a
channel can pay crew from the ledger, a crew member never becomes a co-op debtor over someone
else's dispute, and every movement still balances to zero.

## You own (write only these)

- `packages/ledger/src/{rules,reversals,math,holds,queries,locks,payouts,breakdown}.ts` and
  `packages/ledger/tests/*` you add or extend for them
- `services/api/src/money/{stripe-events,checkout-treasurer,splits,reports-lib}.ts` and
  `services/api/tests/money-splits*.test.ts` (plus the existing money tests your changes break)
- `services/worker/src/money/holds.ts` and `services/worker/tests/money-holds*.test.ts`
- Web: `apps/web/src/routes/_studio/crew.tsx` (content only), `apps/web/src/components/money/{crew*,transparency}.tsx`
- i18n: `apps/web/src/i18n/locales/{en,es}/w2-splits.json` and the regenerated
  `apps/web/src/i18n/keys/w2-splits.gen.ts` (prefix `splits.`)
- Harness: `harness/src/w2/splits.ts` and `harness/tests/w2/splits.test.ts`

Read-only, in particular: `packages/ledger/src/{accounts,meta,poster,posting,settings,close}.ts`,
`packages/contracts/**`, `packages/db/**` (0042/0043), `services/api/src/money/{reports,fraud,breakdown}.ts`,
`services/api/src/routes/money.ts`, `packages/patronage/**`, `harness/src/w2/steps.ts`,
`harness/scenarios/e4b-money.ts`. Anything else is a **contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- `PaymentMetaV2` / `ReversalMetaV2` (`packages/ledger/src/meta.ts:16-73`): `shares` sorted by user
  id, `creatorCents` summing to the creator share; `creatorUserId` stays the owner (patronage reads it).
- Chart entries from the contract step: `asset:receivable:split-shortfall:<owner>`,
  `liability:split-suspense:<recipient>`, `expense:split-shortfall-writeoff`; transaction kinds
  `split_shortfall_writeoff`, `split_suspense_release`, `split_suspense_forfeit`.
- `revenue_splits`, `revenue_split_shares`, `revenue_split_acceptances`, `revenue_split_postings`
  and the 0043 triggers (immutable once linked, frozen accepted shares, bps ≤ 10,000 per basis, link
  must match `splitVersionId`, suspense debits only by the two kinds with an `audit_log` row, two
  distinct write-off approvers). Let the triggers refuse; map their errors, never pre-empt them only.
- `money.splits.{list, propose, accept, reject, end}`, scope `channel:manage:splits`, event
  `channel.split.update`; `PayoutRulesSetting.{splitShortfallWriteOffDays, splitNewRecipientHoldDays,
  splitRecipientMinAccountAgeDays}`.

## Build

1. **Math.** `splitNetN(creatorCents, shares)` in `math.ts` with `largestRemainder` (`math.ts:54`):
   crew by bps, owner by the remaining bps, items ordered by lowercased user id. Reversals divide
   each reversed amount as the difference of cumulative splits over the recorded `creatorCents`
   vector, so any sequence of partial reversals returns exactly each slice.
2. **Posting.** `paymentSucceeded` (`rules.ts:135-178`) takes the share vector and writes one hold
   entry per recipient with `holdMemo(paymentId, userId)` = `hold:<paymentId>:<userId>` (decision (i);
   today `rules.ts:36`). Resolve the active version for the payment's kind at `succeededAt` inside
   the posting transaction at both sites (`stripe-events.ts:268-280`, `checkout-treasurer.ts:112-124`)
   and insert the `revenue_split_postings` link in the same transaction. No split: one owner share.
3. **Holds.** `releaseDueHolds` (`packages/ledger/src/holds.ts:48-56`, not the worker) groups by
   (account, memo), takes the recipient from the memo and checks it against the account owner,
   skips a lot whose `hold-release:<paymentId>:<userId>` exists (`rules.ts:202`), one transaction
   and one `lockCreator` per lot. A crew lot for a recipient with no earlier released crew lot is
   due `holdDays + splitNewRecipientHoldDays` after the payment. A recipient who is suspended,
   terminated or under an unreleased legal hold (`packages/db/src/schema/safety.ts` `legal_holds`)
   is released into `liability:split-suspense:<recipient>` instead. `holdLots` /
   `paymentHoldRemaining` (`queries.ts:70-95`) take (payment, recipient).
4. **Locks.** `lockCreators(tx, userIds)` in `locks.ts`: dedupe, sort by lowercased id with `<`,
   lock in order. `computePayoutBatch` (`payouts.ts:48`) and the carried-over sort (`:546`) use the
   same exported comparator. Update the lock-order comment.
5. **Reversals** (`rules.ts:300-470`, `reversals.ts:71-160`): lock payment, then `lockCreators` over
   every recipient. Each slice: own still-held lot first; crew nothing else and never a receivable;
   the owner covers the rest in today's source order (refund: own lot, released, other lots;
   chargeback: released, own lot, other lots); any remaining shortfall to the owner's split-shortfall
   receivable. `ReversalMetaV2` records `fromOwnLotCents` / `ownerCoveredCents` per recipient. A
   won chargeback credits each own-lot part to that recipient's released earnings and the owner-covered
   part first to cancel outstanding split-shortfall, then to the owner's released earnings.
6. **Netting.** `availableToPay`, `payoutReserve`, `payableAsOf`, `reservableAt`,
   `lowestAvailableAfter`, `creatorBalances`, `cancelPayout` count both receivables, creator
   receivable first (decision 6).
7. **Fraud floor** (decision (i)): a crew recipient's first payout raises `new_payee` regardless of
   the threshold (extend the `hadPayout` branch, `payouts.ts:486-500`); the split-graph signal is
   deferred. A recipient needs a payout profile (manual adapter counts) and an account at least
   `splitRecipientMinAccountAgeDays` old at propose and accept; the owner is never a crew recipient.
8. **Write-off and suspense.** Rules `splitShortfallWriteOff`, `splitSuspenseRelease`,
   `splitSuspenseForfeit` (forfeit goes to the owner, never the co-op); write-off only after
   `splitShortfallWriteOffDays` with no owner credit, or the owner's deletion or termination;
   proposer ≠ approver; `audit_log` on every step. Handlers in `money/splits.ts` against the
   procedures the contract step landed (if none exist for these three, **contract request**).
9. **API** (`money/splits.ts`): the five procedures, versioning (a change is a new version; future
   revenue only; `end` cannot be backdated and notifies the recipient), `audit_log` and
   `channel.split.update` in the same transaction.
10. **Breakdown** (`breakdown.ts:188-193`): one `hold_released` line per recipient release; the
    payer view keeps one creator total.
11. **Transparency**: add `split-shortfall-writeoff` to `RESERVED_COST_CATEGORIES`
    (`reports-lib.ts:191`) so the write-off shows as its own cost line via `monthlyAggregates`
    (`queries.ts:246`); `components/money/transparency.tsx` labels it. Suspense counts need a
    `TransparencyMonth` field (contract request if absent).
12. **Web.** Crew page: propose (recipient, basis, bps, optional window), the plain-language
    preview ("a $10 tip gives each of you …" via `formatMoney`), accept/reject for recipients, end
    with `<ConfirmDialog>`, a note that crew are paid by the treasurer through the manual adapter.
    House primitives, 320 px, en + es (decision (p)), test ids from `w2-selectors.md`.

## Tests you must add

- Unit/property (`packages/ledger`): sums preserved per recipient; 1¢ payments; 3- and 7-way splits;
  any slicing of partial reversals; partial refund after a split ended; single-owner and split
  payments mixed; comparator agreement between `lockCreators` and `computePayoutBatch`.
- Ledger integration (`createTestDatabase()`): per-recipient release (one key each, rerun idempotent,
  one recipient's ban does not touch another's lot); clawback cases (own lot first, owner absorbs,
  suspense, crew receivable never created); won chargeback restores each slice and cancels suspense
  first; new-recipient extra hold; the four triggers refusing bad rows; **lock-ordering**: a reversal
  racing `runPayoutBatch` finishes without deadlock; every test asserts the ledger sums to zero.
- API integration: the five procedures, account-age and payout-profile gates, owner-as-crew refused,
  version freeze, audit + event rows; both posting sites link the version.
- Worker integration: `releaseHolds` releases both recipients and routes a suspended one to suspense.
- Harness `harness/src/w2/splits.ts` (the `e4b-money` steps `harness/src/w2/steps.ts` lists for
  you; only the orchestrator removes them from `PENDING_W2_*` at merge) plus its unit test: 2-way propose/accept; a tip releases holds to both; chargeback
  per the policy; won chargeback restores slices; fresh recipient + chargeback + payout blocked by
  `new_payee`; transparency write-off/suspense lines; ledger sums to zero.

## Done means

Follow `.claude/briefs/_done-means.md`: targeted checks only (`bun --bun vp test run` and
`bun run test:int` one package at a time in `packages/ledger`, `services/api`, `services/worker`;
`bunx tsc -p` for each and `apps/web`; `vp lint --deny-warnings` and `vp fmt` on your paths;
`vp build` and `bun run i18n:check` in `apps/web`; `bun --bun vp test run` in `harness`;
`reuse lint`). `git status` shows only your paths. Commit with `git commit -s`. Final message as
`_done-means.md`, plus contract requests and the live command (`bun harness/src/cli.ts run
e4b-money --set w2=<your step names from steps.ts>`).

**Reviewer focus:** the ledger invariants (every posting balances; no crew receivable; per-recipient
idempotency keys; lock order payment → sorted recipients; triggers, not only app checks).
