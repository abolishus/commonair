<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# @commonair/ledger

Double-entry ledger for every money movement on the platform: the chart of accounts, pure
posting rules, an idempotent poster, balance and statement queries, monthly transparency
aggregates and the creator payout batch.

The database is the final authority (ADR 0004, `packages/db/drizzle/0001_protections.sql` and
`0002_protections_hardening.sql`): ledger rows are append-only, every transaction must balance
to zero per currency at commit, entries can only be added in the database transaction that
created their ledger transaction, and the application role cannot update or delete ledger rows.
This package validates everything first so a bad posting never reaches the database.

## Conventions

- Amounts are signed integer cents: **debits positive, credits negative**. Assets and expenses
  are debit-normal; liabilities, equity and revenue are credit-normal. `accountBalance` returns
  the natural balance (e.g. a positive number for what the co-op owes a creator).
- Each chart code lives once per currency. The `ledger_accounts.code` column stores
  `<code>@<currency>`, e.g. `liability:creator:0190…@usd`.
- Descriptions and memos are fixed strings; users are referenced by id only. Never put names,
  emails or user-written text into the ledger.
- Fractions (`platform.cut`) are resolved to integer millionths and multiplied with BigInt, so
  no result depends on floating-point rounding.

## Chart of accounts

| Code                                   | Type      | Meaning                                                      |
| -------------------------------------- | --------- | ------------------------------------------------------------ |
| `asset:cash:<provider>`                | asset     | Money held at a payment provider (or the manual treasury)    |
| `asset:receivable:provider:<provider>` | asset     | Collected by a provider but not yet settled (manual adapter) |
| `asset:receivable:creator:<userId>`    | asset     | Clawback shortfall a creator owes the co-op                  |
| `liability:creator:<userId>`           | liability | Released creator earnings, not yet paid                      |
| `liability:creator-hold:<userId>`      | liability | Creator earnings still inside the chargeback hold window     |
| `liability:tax-payable`                | liability | Sales tax collected, owed to tax authorities                 |
| `liability:member-share:<userId>`      | liability | Refundable viewer member share                               |
| `liability:patronage-payable:<userId>` | liability | Approved patronage not yet paid                              |
| `revenue:platform-cut`                 | revenue   | The co-op's share of subscription and tip revenue            |
| `expense:payment-fees`                 | expense   | Processor and dispute fees                                   |
| `expense:infrastructure:<category>`    | expense   | Hosting, bandwidth, storage, … (category is a slug)          |
| `equity:retained-surplus`              | equity    | Surplus the co-op keeps or allocates as patronage            |

Build codes with `accounts.*` (validated), never by hand. `ensureAccounts` / `getOrCreateAccount`
create rows idempotently (`insert … on conflict do nothing`, then read back).

## Posting rules

Every rule is a pure function returning a `Posting` (`kind`, `description`, `refType`, `refId`,
`idempotencyKey`, `currency`, `occurredAt`, `metadata`, `entries`) that is already validated.

| Rule                  | Key                                    | Entries                                                                                                                                               |
| --------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paymentSucceeded`    | `payment:<paymentId>`                  | Dr cash (or provider receivable) gross; Cr tax-payable tax; Cr creator-hold creator share; Cr platform-cut co-op share; Dr payment-fees / Cr cash fee |
| `holdRelease`         | `hold-release:<paymentId>`             | Dr creator-hold; Cr creator                                                                                                                           |
| `refund`              | `refund:<disputeId>`                   | Cr cash amount; Dr tax-payable, platform-cut and creator accounts proportionally                                                                      |
| `chargeback`          | `chargeback:<disputeId>`               | As refund, plus Dr payment-fees / Cr cash for the dispute fee                                                                                         |
| `payout`              | `payout:<payoutId>`                    | Dr creator (amount + netted receivable); Cr creator receivable; Cr cash amount                                                                        |
| `sharePurchase`       | `share-purchase:<shareId>`             | Dr cash; Cr member-share                                                                                                                              |
| `shareRefund`         | `share-refund:<shareId>`               | Dr member-share; Cr cash                                                                                                                              |
| `infrastructureCost`  | `infra-cost:<infraCostId>`             | Dr expense:infrastructure:<category>; Cr cash                                                                                                         |
| `patronageAllocation` | `patronage-allocation:<periodId>`      | Dr retained-surplus total; Cr patronage-payable per member                                                                                            |
| `patronagePayout`     | `patronage-payout:<periodId>:<userId>` | Dr patronage-payable; Cr cash                                                                                                                         |
| `manualConfirmation`  | `manual-confirmation:<paymentId>`      | Dr cash:manual; Cr receivable:provider:manual                                                                                                         |

**The cut.** Net = gross − tax. The creator receives `floor(net × streamerShare)`, the co-op the
remainder, so the split is always exact. Example: $10.99 incl. $0.99 tax, 90/10 cut, $0.62 fee →
Dr cash 1099, Cr tax 99, Cr creator-hold 900, Cr platform-cut 100, Dr fees 62, Cr cash 62.

**Refunds and chargebacks** reverse `split(cumulative) − split(alreadyReversed)`, where `split`
is the original rounding rule applied to the first N cents of the gross (tax pro rata, floored).
However a payment is refunded in slices, the slices add up to exactly the original tax, creator
share and cut. Pass the cut recorded in the original posting's metadata, not today's setting.

**Where clawbacks come from.**

- Refund: this payment's own remaining hold → released earnings → any other hold → receivable.
- Chargeback: released earnings → hold → receivable (`asset:receivable:creator:<id>`).

A receivable is netted against the creator's next payout. `payout` refuses amounts above
`liability − receivable` (`InsufficientBalanceError`) and below `payout.rules.minimumCents`
unless `closingAccount` is set (`PayoutBelowMinimumError`).

**Hold release.** `releaseDueHolds(db, { asOf, holdDays, currency })` releases each payment
older than `payout.rules.holdDays`; the amount is that payment's remaining hold, capped by the
creator's total hold (a chargeback may have drawn on it).

## Poster

`post(db, posting)` validates, then in one database transaction (a savepoint when `db` is
already a transaction, so callers can post atomically with their own writes) inserts the
transaction with `on conflict (idempotency_key) do nothing returning id`, get-or-creates the
accounts and inserts the entries. A repeated key returns `{ transactionId, created: false }`;
the same key for a different kind or reference throws `IdempotencyConflictError`.

## Queries

- `accountBalance`, `rawBalance`, `creatorBalances` (liability, hold, receivable, available),
  `paymentHoldRemaining`.
- `statement(db, userId, { cursor, limit })`: lines on every account the user owns, newest
  first, keyset-paged by (occurredAt, entry id). Matches the `LedgerLine` DTO.
- `monthlyAggregates(db, { from, to, currency })`: per UTC month — revenue (creator + co-op
  shares, net of tax and reversals), platform cut, creator payouts, costs by category, surplus
  (cut − costs) and patronage distributed.

## Payout batch

`computePayoutBatch` (pure) pays every creator whose available balance is at least the minimum
and carries the rest over. `runPayoutBatch(db, { periodStart, periodEnd, currency, minimumCents })`
computes available as released earnings − receivable − payouts already scheduled but not
posted, and writes one `payouts` row per creator (status `pending`, or `held` with
`payout_account_not_ready` when the payout account is missing or not enabled), idempotent per
(user, periodStart). `postPayout` posts the ledger entry once the money is sent and marks the
row paid.

## Settings

`loadMoneySettings(db)` reads and validates `platform.cut` and `payout.rules`. Read settings per
operation and pass them into the rules; never cache them across governance decisions.
