<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0036: Payment fraud floor

- Status: accepted (2026-10-30)
- Date: 2026-10-30 (code checked at `a43aa6b`)
- Gates: W1-fraud-floor ([W1 contract step](../../.claude/briefs/w1/contract-step.md) §1.1, §1.3,
  §1.5, §2.2, §2.3; [brief](../../.claude/briefs/w1/W1-fraud-floor.md)), and through it W2-splits

## Context

Ledger Splits (W2, ADR 0013) lets a channel's income be paid on to other accounts. That turns every
channel into a possible mule cash-out path: stolen cards pay a channel, the split pays
accomplices, the chargebacks arrive after the money is gone. `docs/product/feature-wins.md` §4.10
makes a payment fraud floor a prerequisite of splits and asks that it **block payout release**, not
merely flag; its T&S review item asks for "a four-eyes flag and trigger or job enforcement".

What exists at `a43aa6b`: `runPayoutBatch` (`packages/ledger/src/payouts.ts`) creates one payout
per eligible creator, `pending` or `held` with `hold_reason = 'payout_account_not_ready'`; the
account-ready paths (`services/api/src/money/checkout-treasurer.ts`, `stripe-events.ts`) move those
holds to `pending`. There is no fraud signal, no flag and no way to stop a payout short of a
treasurer cancelling it by hand. ADR 0020 decision 2 already has a two-person rule (patronage)
enforced by a trigger, and ADR 0004 puts integrity rules at the lowest layer that can enforce them.
Feature-wins names the signals only loosely ("velocity, payer diversity, split graph, four eyes");
the split graph cannot be judged until splits exist.

## Decision

### 1. Flag kinds and thresholds

Four kinds (`PAYMENT_FRAUD_KINDS`): `payer_velocity`, `payer_concentration`, `new_payee` and
`manual` (raised by a treasurer). The thresholds are one constant, `PAYMENT_FRAUD_RULES` in
`packages/contracts/src/enums.ts`, so changing a number changes no code:

| Kind                  | Fires when                                                                                                                                                                                                                                                                                         | Defaults                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `payer_velocity`      | one payer has more than `velocityMaxPayments` succeeded payments (to any channel) in any `velocityWindowMinutes` window; every payee of that window is flagged                                                                                                                                     | 10 payments in 60 minutes                                   |
| `payer_concentration` | over `concentrationWindowDays`, a payee's gross is at least `concentrationMinGrossCents` and either the top `concentrationTopN` payers bring at least `concentrationShare` of it, or payers whose accounts were younger than `newPayerAccountDays` at payment bring at least `newPayerShare` of it | 30 days, 500.00, top 3 at 80 %, new payers (7 days) at 50 % |
| `new_payee`           | a payee's first payout ever is at or above `newPayeeFirstPayoutCents`                                                                                                                                                                                                                              | 500.00                                                      |
| `manual`              | a treasurer raises it for a payee by username                                                                                                                                                                                                                                                      | —                                                           |

The signals are pure functions in `packages/integrity/src/payments/**` with exact integer
arithmetic (shares in basis points). Anonymous payments still count by payer id; refunded payments
do not count. The `money-fraud-scan` job (`QUEUES.payments`, every 15 minutes, ops-tickable) runs
the first two; `runPayoutBatch` raises `new_payee` in the batch's transaction before inserting such
a payout. At most one undecided flag exists per payee and kind (a partial unique index), so a
re-scan adds nothing; a (payee, kind) decided at or after the start of a hit's evidence window is
not re-raised, and only evidence newer than that decision counts, so the next scan cannot undo a
clear.

### 2. Four eyes, enforced by a trigger

A flag moves `open → reviewed → cleared | confirmed` (`PAYMENT_FRAUD_STATUSES`). A treasurer or an
admin reviews it and records a recommendation; a **different** treasurer or admin decides it. The
trigger `payment_fraud_flags_guard` (migration 0038) enforces all of it: a flag is inserted open
and undecided; the reviewer and the decider must hold the treasurer or admin role and not be
banned; the decider may be neither the reviewer nor the person who raised it; neither may be the
payee; a decision must match the new status; the evidence and the raiser never change; a decided
flag is frozen (except the one release step in decision 3); flags are never deleted or truncated,
and the app role loses DELETE and TRUNCATE on the table. The API maps the trigger's refusal
(SQLSTATE `42501`) to the contract's `SECOND_APPROVER` error, as ADR 0020's patronage approval
does.

### 3. The database holds the payouts

While a payee has a **holding** flag, no payout of theirs is inserted as, or moved into,
`pending`, `scheduled` or `paid`: the trigger `payouts_fraud_guard` (migration 0038) refuses it, so
a bug in application code cannot pay out early. A flag holds when it is `open` or `reviewed`, or
when it is `confirmed` and no admin has released it. A held payout is `held` with
`hold_reason = 'fraud_review'` (`FRAUD_REVIEW_HOLD`); `PAYOUT_STATUSES` do not change.

- **Raising** a flag (scan, `raise`, or `new_payee` in the batch) moves the payee's `pending` and
  `scheduled` payouts, and their `held` / `payout_account_not_ready` payouts, to `held` /
  `fraud_review` in the same transaction. The re-tag keeps the account-ready release paths from
  hitting the trigger and failing a whole treasurer call or Stripe webhook; a missed re-tag fails
  loudly instead of paying out. `paid` and `failed` payouts are untouched.
- **Clearing** a flag releases: when the payee has no other holding flag, their `fraud_review`
  payouts move to `pending` (or to `held` / `payout_account_not_ready` when the account is not
  ready) in the decision's transaction, after the flag update.
- **Confirming** a flag keeps holding the payee's payouts, including payouts created by later
  batches. The treasurer may cancel held payouts through the existing cancel path. The only way
  back is an admin's audited account action, `money.treasurer.fraudFlags.release` (`admin` access):
  it sets `released_by_id` and `released_at` on the confirmed flag, once, and the trigger allows
  that change only on a confirmed, unreleased flag, only by a non-banned admin who is not the
  payee. The release then moves the payee's `fraud_review` payouts as a clear does. There is no
  admin web page for it in W1; the operator guide (`docs/operators/payment-fraud-review.md`)
  documents the call.

### 4. Audit and outbox

Every raise, review, decision and release writes an `audit_log` row (`money.fraud.raise`,
`money.fraud.review`, `money.fraud.decide`, `money.fraud.release`; actor `system` for the scan and
the batch) and an internal `money.fraud.flag` outbox event (`flag_id, payee_user_id, kind, status,
released, held_payouts`; never offered to apps) **in the same transaction** as the change.
`runPayoutBatch`'s caller audits only `payout.run`, so `payouts.ts` writes the `new_payee` flag's
audit and outbox rows itself, in the batch's transaction.

### 5. No personal data in flags

`evidence` holds ids, counts and cents only. Audit `details` are `{ flagId, kind, status }`. The
treasurers' `note` is free text on the mutable flag row (editable only while the flag is open or
reviewed) and is copied into neither the audit `details` nor its `reason`, nor the event (AGENTS.md,
ADR 0004). Flags reference users by id and survive account deletion (`restrict`; deletion
pseudonymizes the user row).

## Consequences

- A flagged payee is paid nothing until two people clear the flag or an admin releases a confirmed
  one; a false positive costs that payee a delay, which the operator guide asks treasurers to keep
  short.
- Every threshold change is a one-line constant change with tests at the boundaries; a change to
  the four-eyes rule itself is a new migration.
- A confirmed flag with no release holds forever: the backlog of confirmed flags is visible in the
  treasury's Fraud review tab (filter by status).
- W2-splits builds on the hook in `packages/ledger/src/payouts.ts` and adds its split-graph signal
  as a new kind, with its own ADR amendment.

## Alternatives considered

- **Flag only, release by hand.** Rejected: feature-wins asks for a floor that blocks release, and
  an application-only hold can be bypassed by any code path that writes `payouts`.
- **A confirmed flag stops holding.** Rejected (2026-10-30): the payee's next monthly payout would
  be created `pending` after a confirmed fraud finding.
- **Confirm suspends the account.** Rejected for W1: suspension is a moderation action with its own
  notices and appeals (ADR 0019); conflating it with a payment hold mixes two processes.
- **One treasurer decides.** Rejected: a single compromised or mistaken treasurer could release
  mule payouts; ADR 0020 already sets the two-person precedent for money.
- **An ML or vendor risk score.** Rejected for now: not explainable to the payee, and a
  proprietary vendor would have to be an optional adapter (AGENTS.md rule 3).
