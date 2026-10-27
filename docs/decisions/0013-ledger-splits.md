<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0013: Ledger splits

- Status: accepted (2026-10-27; the maintainer accepted the recommended answers, see
  [Decisions at acceptance](#decisions-at-acceptance-2026-10-27))
- Date: 2026-10-27 (code checked at `ccf9c17`)

**Counsel has not reviewed whether split recipients are payees, contractors or something else**
(tax reporting, who issues forms, money transmission), and acceptance does not change that: the
maintainer accepted the ledger mechanism, not its legal sufficiency. That question must be
settled before any split moves live money, which is milestone M1 (live keys need counsel and a
legal entity, `.claude/briefs/next/M1-money-follow-ups.md`). It does not block building and
testing splits against the manual adapter and stripe-mock. This is not legal advice.

## Context

Ledger Splits (`docs/product/feature-wins.md` §4.10, line 570) lets a channel owner send a fixed
share of future tips or subscriptions to collaborators and crew. The review moved it to Wave 2
because every money path below assumes one creator per payment (debate log item 18,
`feature-wins.md:968`). Re-checked at `ccf9c17`:

- **Hold release is per payment, not per recipient.** `releaseDueHolds` groups hold entries by
  memo alone across every `liability:creator-hold:%` account (`packages/ledger/src/holds.ts:47-50`),
  reads one `metadata->>'creatorUserId'` (`:52`), and skips a payment once any
  `hold-release:<paymentId>` exists (`:55`). With two recipients under one memo, the release goes
  to the one metadata creator, for that creator's lot only (`paymentHoldRemaining`,
  `packages/ledger/src/queries.ts:84-96`); the release key then blocks every other recipient's
  lot, which stays held for good.
- **Posting rules carry one creator.** The hold memo is `hold:<paymentId>`
  (`packages/ledger/src/rules.ts:35`); `paymentSucceeded` writes a scalar `creatorUserId` and
  one hold entry (`:148-164`); `holdRelease` keys on `hold-release:<paymentId>` (`:188-201`).
- **Reversals carry one creator.** `refund`, `chargeback` and `chargebackReversal`
  (`rules.ts:333`, `:343`, `:382`) draw from one creator's own lot, released earnings and other
  lots (`holdSources`/`liabilitySource`, `:265-280`), and book any shortfall to that creator's
  clawback receivable (`drawFrom`, `:250-260`). `PaymentMeta` and `ChargebackMeta` are scalar Zod
  schemas (`packages/ledger/src/reversals.ts:28-47`); `postReversal` takes the payment lock, then
  one creator lock (`:97`, `:115`). `paymentHoldRemaining` and `holdLots` read one creator's hold
  account (`packages/ledger/src/queries.ts:70-97`).
- **Lock order exists and is documented.** Payout batch → payment → creator
  (`packages/ledger/src/locks.ts:6-7`). `runPayoutBatch` takes creator locks one at a time in
  user-id order (`packages/ledger/src/payouts.ts:35`, `:202-204`).
- **Clawback netting exists for one creator.** A shortfall becomes
  `asset:receivable:creator:<user>` (`packages/ledger/src/accounts.ts:37-41`), netted when a
  payout is reserved (`availableToPay` and `payoutReserve`, `rules.ts:439`, `:471`) and in the
  payout run (`payableAsOf`, `reservableAt`, `payouts.ts:69-97`, `:137-155`). Nothing writes a
  receivable off if it is never repaid.
- **Payments are posted in the API** with `creatorUserId: c.ownerId`
  (`services/api/src/money/stripe-events.ts:271-276`,
  `services/api/src/money/checkout-treasurer.ts:115-120`). The worker releases holds
  (`services/worker/src/money/holds.ts:40`).
- **Patronage reads the scalar too.** `revenueByMember` attributes gross revenue by
  `metadata->>'creatorUserId'` (`packages/patronage/src/inputs.ts:128-132`).
- **The database already refuses bad ledger writes.** Ledger tables are append-only and every
  transaction must balance per currency (`packages/db/drizzle/0001_protections.sql:99-102`,
  `:199-225`); entries may only be added in the database transaction that created their ledger
  transaction (`:184-195`).
- **Legal holds exist** (`legal_holds`, `packages/db/src/schema/safety.ts:500-520`), and so does
  account suspension (`services/api/src/lib/access.ts:82-84`).

Two project facts make this simpler than feature-wins assumed. No real money has moved (Stripe
runs against stripe-mock only), and there are no self-hosters or public instance: the only
deployment is our rc staging droplet. So there are no in-flight payments to migrate and no
metadata format to keep reading.

## Decisions

### 1. Per-recipient hold lots, memos and idempotency keys

Every hold entry's memo becomes `hold:<paymentId>:<userId>`, and every release is keyed
`hold-release:<paymentId>:<userId>`. A single-creator payment is the one-recipient case of the
same format; there is no second format.

The due-holds query groups by (account, memo), takes the recipient from the memo (and checks it
against the account's owner), and skips a lot when its own per-recipient release key exists. Each
lot is released in its own transaction under that recipient's creator lock, as today.
`paymentHoldRemaining` and `holdLots` take (payment, recipient).

**Why.** The lot is the unit the hold protects, and it already belongs to one account. Keying the
memo and the release by recipient makes each lot independent, so one recipient's release, ban or
reversal can never strand or release another's money.

### 2. `PaymentMeta` v2 replaces v1 outright

`PaymentMeta` becomes a versioned schema, `{ v: 2, … }`, with:

- `creatorUserId`: the channel owner, the payee of record. The name is kept so patronage
  (`inputs.ts:128`) and the breakdown keep attributing gross revenue to the owner, not the crew.
- `provider`, `settlement`, `revenueGrossCents`, `taxCents`, the cut used
  (`streamerShare`, `coopShare`) and `cutHistoryId` (new in W1-breakdown);
- `splitVersionId` (null when no split applied);
- `shares`: a vector of `{ userId, role: "owner" | "crew", bps, creatorCents }`, sorted by user id,
  whose `creatorCents` sum to the payment's creator share. A payment with no split has one entry,
  the owner at 10,000 bps.

`ChargebackMeta` becomes v2 with the same vector, recording per recipient what came from that
recipient's own lot and what the owner absorbed (decision 5), so a won chargeback can restore each
slice exactly. It keeps `creatorUserId` (the owner) too, because patronage reads it on refunds and
chargebacks as well as payments (`inputs.ts:130`).

The schema is frozen in the **Wave 1 contract step** (batch 4), so W1-breakdown reads only v2,
and `paymentSucceeded` writes v2 from then on. There is **no v1 reader and no migration plan for
in-flight payments**. Staging ledger data on our droplet is discarded: the ledger tables refuse
`DELETE` and `TRUNCATE`, so the reset is a recreated Postgres volume, as ADR 0020 did once for
E5. This replaces feature-wins' "v1 is still read" dual format (`feature-wins.md:598`). Test
fixtures that post payments (`services/worker/tests/e6-fixtures.ts:74` and the ledger
and api tests) move to v2 in the same step.

**Why.** Dual-format reading exists to protect live data, and there is none. One format halves the
property-test matrix and removes a reversal path that would only ever run on test data.
`reversalSplit` (`rules.ts:74`) stays: it is the first step of every reversal (gross to tax,
creator pool and cut on the original's rounding), not a legacy path.

### 3. One split computation, after the co-op cut

The co-op cut is taken once, from net-of-tax revenue, exactly as `splitNet` does today
(`rules.ts:48`). The creator share is then divided by `splitNetN` (new, `math.ts`) over the active
split version's basis points with `largestRemainder` (`math.ts:54`): crew weighted by their bps,
the owner by the remaining bps, items ordered by user id so ties are deterministic. Reversals
divide each reversed creator amount the same way, as the difference of cumulative splits (the method
`reversalSplit` already uses), over the payment's recorded `creatorCents` vector. So any sequence
of partial reversals returns exactly each recipient's original share.

The split version is resolved where the payment is posted (`stripe-events.ts`,
`checkout-treasurer.ts`), inside the same transaction, from the version active at the payment's
`succeededAt` for its kind (tips, subs, or all).

### 4. Lock order: payment, then every recipient in sorted user-id order

The documented order stays payout batch → payment → creator, with "creator" widened to "every
recipient of the payment, owner included, sorted by lowercased user id". A new
`lockCreators(tx, userIds)` in `locks.ts` sorts and locks; `runPayoutBatch` switches to the same
comparator (today `localeCompare`, `payouts.ts:35`) so the two can never disagree on order.
Reversals and won chargebacks lock the payment, then all recipients, then read balances. Hold
releases still take one creator lock per transaction.

**Why.** A reversal now reads and draws on several recipients' balances in one transaction. A
payout batch holds creator locks in sorted order for its whole transaction. If both take them in
the same total order, no cycle can form; a lock-ordering integration test runs a reversal against
a concurrent payout batch.

### 5. Clawback: the owner absorbs every shortfall

When a split payment is refunded or charged back, each recipient's reversed slice is drawn as
follows:

1. **From that recipient's own lot for this payment** (`hold:<paymentId>:<userId>`), if anything
   is still held. Held money was never released to anyone, so taking it back is not a clawback.
2. **For crew, nothing else.** A crew recipient's released earnings and other lots are never
   touched, and a crew recipient never gets a clawback receivable.
3. **The owner covers the rest**, for the owner's own slice and for every crew remainder: from the
   owner's sources in today's order (refund: own lot, released earnings, other lots; chargeback:
   released earnings, own lot, other lots).
4. **Any remaining shortfall goes to a suspense account** (decision 6), never to a crew recipient.

A won chargeback restores each slice to where it came from: the part taken from a recipient's own
lot is credited to that recipient as released earnings (as `chargebackReversal` does today, since
lots are never reopened); the part the owner absorbed first cancels the owner's outstanding
suspense balance, then credits the owner's released earnings.

Crew slices use the instance's normal hold period; there is no extended hold for crew (see
Alternatives). The W1 fraud floor's extra hold for new split recipients still applies.

**Why.** Crew recipients do not control chargebacks; the owner chose to split and chose the
audience the money came from. A 5% moderator should never become a co-op debtor over a dispute on
someone else's channel. Taking back a recipient's own still-held slice first is fair (the money
never reached them) and keeps the owner's exposure to what has already been released.

### 6. Shortfall suspense and the write-off destination

A new chart entry, `asset:receivable:split-shortfall:<ownerUserId>` ("split shortfall suspense"),
holds what the owner absorbed but could not cover. It is netted against the owner's future payouts
exactly like the creator clawback receivable: `availableToPay`, `payoutReserve`, `payableAsOf`,
`reservableAt`, `lowestAvailableAfter`, `creatorBalances` and `cancelPayout` count both
receivables, netting the creator receivable first.

**If the owner never earns again**, the balance cannot be collected. After the owner has had no
credit to `liability:creator:<owner>` for `payout.rules.splitShortfallWriteOffDays` (a new field,
default 365), or when the owner's account is deleted or permanently terminated, a treasurer may
propose a write-off and a different treasurer or an admin approves it (the two-person rule of
ADR 0020 decision 2), and as for patronage a protections trigger refuses an approval by the
proposer or by someone who holds neither role. The posting, `splitShortfallWriteOff`, debits a new
`expense:split-shortfall-writeoff` account and credits the suspense account. So the forfeit
destination for an uncollectable shortfall is **the co-op's own expense line**, shown on the
transparency page as its own line, never hidden inside payment fees. Every proposal and approval
writes `audit_log`. A write-off is final; the owner's later earnings are not netted against it.

The separate account is what makes the write-off scoped: it can only ever write off money the
owner absorbed for a split, never an ordinary creator clawback, and the transparency line says so.

### 7. Withheld shares: banned or legal-hold recipients

When a recipient's lot falls due and that recipient is suspended, terminated or under an
unreleased legal hold, the release moves the lot into `liability:split-suspense:<recipientUserId>`
(new) instead of `liability:creator:<recipient>`. From there only two postings can move it:

- `splitSuspenseRelease`: to the recipient's released earnings, when the restriction is lifted;
- `splitSuspenseForfeit`: to the **owner's** released earnings, when the recipient's account is
  deleted or permanently terminated with appeals exhausted. Forfeits return to the owner channel,
  never silently to the co-op.

Both need a treasurer or admin, write `audit_log`, and appear as counts on the transparency page.
Enforcement is at the lowest layer (AGENTS.md rule 9): the hold-release job decides the
destination, and a protections trigger refuses any posting that debits a `split-suspense` account
unless its kind is one of the two above and an `audit_log` row for it is written in the same
database transaction.

### 8. Split tables, the postings link table and the protections trigger

The Wave 2 contract step adds:

- `revenue_splits` (owner channel, recipient, basis `tips | subs | all`, bps, optional
  `broadcast_id` or time window, optional cap, version) and `revenue_split_acceptances`.
  Recipients must accept and must have a payout account; the owner can never be a crew recipient.
  Changes create a new version and apply to future revenue only. Ending a split takes effect for
  payments after the end time, cannot be backdated and notifies the recipient; there is no notice
  period in v1.
- `revenue_split_postings(split_version_id, ledger_transaction_id)`, written in the payment's
  transaction. `splitVersionId` in the metadata is for readers; the link table is a real foreign
  key the trigger can rely on, which a `jsonb` field is not.
- A protections trigger: a version is immutable once any linked posting exists; accepted shares
  freeze; for each payment kind, the bps of active versions whose basis covers it total at most
  10,000; the link row's ledger transaction must be a `payment` whose `splitVersionId` matches.
- `money.splits.{list, propose, accept, end}`, event `channel.split.update`, scope
  `channel:manage:splits`, and `audit_log` on every change.

Metadata, memos and account codes carry user ids only, never names or emails (ADR 0004).

## Consequences

- The staging droplet's Postgres volume is recreated once when the Wave 1 contract step lands
  (decision 2). The harness scenarios that post money (`e4b-money`, `e5-coop`) are re-run on it.
- W2-splits touches the payout netting (decision 6), so it needs `packages/ledger/src/payouts.ts`
  after W1-fraud-floor merges, and the two payment-posting call sites in `services/api/src/money/`
  (decision 3). Neither is in its owner list today (see the corrections reported with this ADR).
- Patronage keeps crediting gross revenue to the owner. Crew shares are the owner's cost, not
  co-op revenue attribution.
- The transparency page gains a split-shortfall write-off line and suspense counts.
- Payouts to crew use the existing rules. Connect is deferred (ADR 0007 decision 6), so the
  treasurer pays crew through the manual adapter, and the UI says so. M1-connect does per-recipient
  transfers after this lands.
- Tests: property tests (sums preserved per recipient, 1¢ payments, 3- and 7-way splits, partial
  refund after a split ended, any slicing of partial reversals); trigger integration tests;
  the lock-ordering test; `e4b-money` steps for a 2-way release, an owner-absorbed chargeback, a
  won chargeback restoring each slice, and a fresh-recipient payout blocked by the fraud floor.

## Alternatives considered

- **Recipients bear their own clawbacks.** Rejected: crew would carry dispute risk on revenue they
  do not control, and a small share could leave them owing the co-op.
- **Hold crew slices for the full dispute window** (feature-wins' proposal (b)). Rejected: with
  the owner absorbing shortfalls, the co-op is covered by the owner's balance and the suspense
  netting; a 120-day hold would make splits useless for paying moderators.
- **A co-op mutual pool for shortfalls** (fin-4). Parked, as in feature-wins.
- **Book shortfalls to the owner's existing clawback receivable.** Simpler, but a write-off could
  then not be scoped to split shortfalls, and the transparency page could not show them apart.
- **Keep reading v1 metadata.** Rejected: no live data needs it (decision 2).
- **Store the split only in `jsonb` metadata.** Rejected: a trigger cannot rely on it as it can on
  a foreign key.

## Decisions at acceptance (2026-10-27)

The maintainer accepted this ADR with the recommended answers:

1. **Clawback.** The channel owner absorbs any shortfall when a split payment is refunded or
   charged back. Crew recipients do not control chargebacks; the owner chose to split. A shortfall
   goes to a suspense account netted against the owner's future payouts; if the owner never earns
   again it is written off, with two-person approval and audit, to a co-op expense line shown on
   the transparency page (decisions 5 and 6).
2. **No back-compat.** No real money has moved and there are no outside deployments, so
   `PaymentMeta` switches to v2 outright, with no v1 reader and no in-flight migration plan.
   Staging data on our droplet can be reset (decision 2).
3. **Counsel.** The payee or contractor status of split recipients must be settled before live
   money (M1), not before building on stripe-mock.

Decided within these answers (recorded so reviewers can check them):

- A recipient's own still-held slice is taken back first; only released money is absorbed by the
  owner (decision 5).
- Crew slices use the normal hold period, plus the fraud floor's new-recipient hold.
- The write-off waits for 365 days without owner earnings, or for account deletion or permanent
  termination, as a `payout.rules` field.
- Withheld shares of banned or legal-hold recipients forfeit to the owner, never to the co-op
  (decision 7).
- Ending a standing split takes effect for payments after the end time; there is no notice period
  in v1, the recipient is notified, and an end cannot be backdated.
