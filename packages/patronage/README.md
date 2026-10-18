<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# @commonair/patronage

Versioned patronage formulas with line-by-line explanations, input aggregation from verified
facts, and the compute / approve run for a period.

## Formula 2026.1

Weights and caps come from the `patronage.formula` governance setting (seeded defaults below);
callers pass them in, nothing is hard-coded.

| Component        | Default weight | Member input                                                              |
| ---------------- | -------------- | ------------------------------------------------------------------------- |
| `revenue`        | 0.5            | Subscription + tip gross of their channel, net of refunds/chargebacks     |
| `streamingHours` | 0.2            | Eligible streaming hours, at most `dailyStreamingHourCap` (8) per UTC day |
| `relayBandwidth` | 0.2            | Verified bytes served by relays they own                                  |
| `viewerHours`    | 0.1            | Verified viewer-hours on their channel                                    |

1. **Pools.** The surplus is split into the four pools by weight (largest remainder, ties to
   the earlier component), so the pools sum to the surplus exactly.
2. **Shares.** Each member's share of a pool is proportional to their input. Inputs are
   compared exactly: cents, bytes, and hours as whole seconds.
3. **Viewer-hours channel cap.** No member may take more than `viewerHoursChannelCap` (10%) of
   the viewer-hours pool. Members above the cap are capped and the excess is shared among the
   others in proportion, repeating until nobody else crosses the cap (water-filling). If every
   contributor is capped, what is left is retained as surplus with an `adjustment` line.
4. **Empty pools.** A pool with no contributions is retained as surplus with an explanatory line.
5. **Rounding.** Integer cents per member per component by largest remainder, ties broken by user
   id, so each pool's allocations sum to the pool and allocations + retained = surplus exactly.
   Results do not depend on input order.

Eligibility: an active membership in any class at the period end (from `membership_history`).

### Worked example

Surplus $1,000.00 with the default weights → pools: revenue $500, streaming hours $200, relay
$200, viewer-hours $100 (cap $10 per member).

| Member | Revenue | Hours | Relay  | Viewer-h | Revenue | Hours   | Relay   | Viewer-h | Total   |
| ------ | ------- | ----- | ------ | -------- | ------- | ------- | ------- | -------- | ------- |
| a      | $4,000  | 40    | 0      | 500      | $400.00 | $114.29 | $0.00   | $10.00 ¹ | $524.29 |
| b      | $1,000  | 20    | 200 GB | 100      | $100.00 | $57.14  | $40.00  | $10.00 ¹ | $207.14 |
| c      | 0       | 0     | 600 GB | 0        | $0.00   | $0.00   | $120.00 | $0.00    | $120.00 |
| d      | 0       | 10    | 200 GB | 50       | $0.00   | $28.57  | $40.00  | $10.00 ¹ | $78.57  |
| e      | 0       | 0     | 0      | 0        | $0.00   | $0.00   | $0.00   | $0.00    | $0.00   |

¹ capped at 10% of the pool. With only three viewer-hours contributors all three are capped,
so $70.00 of that pool is retained: $930.00 allocated + $70.00 retained = $1,000.00. The
streaming-hours pool shows the rounding: 40/70 × $200 = $114.2857…, 20/70 = $57.1428…,
10/70 = $28.5714…; the floors sum to $199.99 and the leftover cent goes to the largest
remainder (a). This example is pinned by `tests/formula.test.ts`.

## Explanations

Every member gets one `PatronageLine` per component (`memberValue`, `poolTotal`, `share`,
`poolCents`, `amountCents`, `capApplied`, `explanation`), e.g.

> Revenue: $4,000.00 of $5,000.00 (80.00%) of the $500.00 pool = $400.00

`explainLine(line, formatter)` rebuilds the text from the numbers alone, so the web can render
stored lines in any language by passing its own `PatronageFormatter` (labels, money, units,
percent and sentence templates). `englishFormatter(currency)` produces the stored text.

## Inputs (`src/inputs.ts`)

Batch functions (`streamingHoursByMember`, `relayBytesByMember`, `viewerHoursByMember`,
`revenueByMember`, `collectInputs`) and single-member conveniences (`eligibleStreamingHours`,
`relayBytesVerified`, `viewerHours`, `revenueCents`). Periods are half-open `[start, end)` in UTC.

- Streaming hours: `stream_hours` rows that are `eligible` and have at least one verified
  viewer other than the streamer, summed per UTC day and capped per day.
- Relay bytes: `relay_receipts` with status `verified` (`bytes_verified`), by relay owner.
- Viewer-hours: `playback_sessions` with verdict `verified`, by channel owner; the owner's own
  sessions never count. Excluded sessions are reported (`viewerHoursExcluded`), never paid on.
- Revenue: ledger `payment`/`refund`/`chargeback` transactions attributed by their
  `creatorUserId` / `revenueGrossCents` metadata (written by the ledger posting rules).

## Run

- `computePeriod(db, { periodStart, periodEnd, surplusCents, currency })` snapshots the formula
  version and weights and writes `patronage_periods` (status `computed`), `patronage_inputs` and
  `patronage_allocations` in one transaction. A computed period may be recomputed; an approved
  one may not.
- `approvePeriod(db, { periodId, approvedById })` posts the allocation (retained surplus →
  patronage payable per member, keyed `patronage-allocation:<periodId>`) and marks the period
  approved, atomically and idempotently. A period with nothing allocated is approved without a
  ledger posting.

New formulas are new entries in `FORMULAS`; never edit a published version, because stored
periods must stay reproducible.
