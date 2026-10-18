<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit 2H1: Ledger and patronage libraries (`packages/ledger`, `packages/patronage`)

## You own

- `packages/ledger/**` (`@commonair/ledger`), `packages/patronage/**` (`@commonair/patronage`)

## Contracts (read-only)

- DB: `ledger_accounts`, `ledger_transactions`, `ledger_entries` and the protections in `packages/db/drizzle/0001_protections.sql` (append-only, balanced at commit, entries only in the creating DB transaction, non-zero amounts, owner may only be cleared). Money tables in `packages/db/src/schema/money.ts`, patronage tables in `coop.ts`, `stream_hours` in `media.ts`, `relay_receipts` in `delivery.ts`, `playback_sessions`.
- `packages/contracts/src/shapes.ts` (PatronageWeights, PatronageLine, PATRONAGE_COMPONENTS), `packages/db/src/seed.ts` (setting keys `platform.cut`, `patronage.formula`, `payout.rules`).
- ADR 0004: never put personal data into ledger text; reference users by id.

## Build — ledger

1. **Chart of accounts** (`src/accounts.ts`): stable codes and types, per currency, e.g. `asset:cash:<provider>`, `asset:receivable:provider:<provider>`, `asset:receivable:creator:<userId>` (clawback shortfall), `liability:creator:<userId>` (earned, unpaid), `liability:creator-hold:<userId>` (within chargeback hold window), `liability:tax-payable`, `liability:member-share:<userId>` (refundable viewer shares), `liability:patronage-payable:<userId>`, `revenue:platform-cut`, `expense:payment-fees`, `expense:infrastructure:<category>`, `equity:retained-surplus`. A function to get-or-create an account row idempotently.
2. **Posting rules** — pure functions returning balanced entry sets (`{ kind, description, refType, refId, idempotencyKey, entries: {code, amountCents}[] }`), each fully unit-tested: subscription or tip payment succeeded (gross incl. tax: cash/receivable debit; tax-payable credit; split the net-of-tax amount by `platform.cut` (streamerShare/coopShare, default 0.9/0.1) between creator-hold liability and platform-cut revenue — the cut is computed on net-of-tax, with **deterministic rounding** (creator gets floor; co-op gets the remainder so the sum is exact); processor fee as expense against cash); hold release after `payout.rules.holdDays` (creator-hold → creator liability); refund (full/partial, reverses proportionally, including tax and cut, rounding consistent with the original); **chargeback** with clawback (reverse like a refund; debit the creator's liability first, the hold second, and any shortfall to `asset:receivable:creator:<id>`; record dispute fees as expense); payout (creator liability → cash; refuses below `payout.rules.minimumCents` unless closing an account); membership share purchase and refund on exit; infrastructure cost; patronage allocation (retained surplus equity → patronage-payable per member) and patronage payout; manual-adapter confirmation (receivable → cash).
3. **Poster** (`post(db, posting)`): inserts the transaction and entries in one DB transaction; idempotent by `idempotencyKey` (a repeated post returns the existing transaction id and does not double-post — use `insert ... on conflict (idempotency_key) do nothing returning` then lookup); validates balance before hitting the DB.
4. **Queries**: account balance; a creator's available-to-pay balance (creator liability minus receivable); statement lines for a user (paged); monthly aggregates for the transparency page (revenue, platform cut, payouts, costs, surplus, patronage distributed).
5. **Payout batch computation** (pure + DB function): for a period end, every creator with available ≥ minimum gets a payout row (`payouts` table) amount = available; others carry over; idempotent per (user, periodStart).

## Build — patronage

1. **Formula registry** `FORMULAS["2026.1"]` implementing the default blend: component pools = surplus × weight (revenue 0.5, streaming hours 0.2, relay bandwidth 0.2, viewer-hours 0.1, from the `patronage.formula` setting — weights passed in, never hard-coded in callers); each member's share of a pool ∝ their input; **viewer-hours channel cap**: no single member may take more than `viewerHoursChannelCap` of the viewer-hours pool — cap and redistribute the excess proportionally among the uncapped, iterating until stable (water-filling); if everyone is capped, the remainder goes to retained surplus as an `adjustment` line; empty pools (no inputs) roll into retained surplus with an explanatory line.
2. **Rounding**: integer cents per member per component via largest-remainder so each pool's allocations sum exactly to the pool; total allocations + retained remainder = surplus exactly. Deterministic tie-break by user id.
3. **Explanations**: one `PatronageLine` per member per component with a human-readable `explanation` (built from a template function that takes a formatter so the web can localize), memberValue, poolTotal, share, poolCents, amountCents, capApplied.
4. **Input aggregation helpers** (DB-backed, tested with integration tests): `eligibleStreamingHours(userId, period)` from `stream_hours` rows where `eligible` (≥1 verified viewer other than the streamer), summing `liveSeconds/3600` per UTC day capped at `dailyStreamingHourCap` (8); `relayBytesVerified` from `relay_receipts` with status `verified` (sum `bytesVerified`) for relays owned by the member; `viewerHoursVerified` from `playback_sessions` verdict `verified` per channel owner (watchSeconds/3600), plus `viewerHoursExcluded` for the statement; `revenueCents` from ledger (subs + tips gross net of refunds/chargebacks) per channel owner. Membership eligibility (who receives patronage) is "active member in any class at period end".
5. **Run**: `computePeriod(db, {periodStart, periodEnd, surplusCents, currency})` → writes `patronage_periods` (status computed, weights + formula version snapshot), `patronage_inputs`, `patronage_allocations`; `approvePeriod` posts the ledger allocation transaction (idempotent) and sets status approved.

## Dependencies

Only workspace packages + drizzle/zod (catalog). Add `@commonair/db`, `@commonair/contracts` workspace deps.

## Tests

- Ledger unit: every posting balances (property-style: random amounts, cuts, tax, partial refunds → sum zero, no zero entries, rounding exact); refund after cut; chargeback with insufficient balance → receivable; payout threshold.
- Ledger integration (`createTestDatabase()`): post → balances; idempotency; DB rejects an unbalanced posting if one sneaks through (simulate by calling the raw insert); statement paging; transparency aggregates.
- Patronage unit: worked example with 5 members proving the default weights; cap redistribution (incl. all-capped, single member, zero inputs); rounding sums exactly; explanation lines present for every component; determinism.
- Patronage integration: inputs from seeded stream_hours (incl. 8 h/day cap and the "≥1 other verified viewer" rule), receipts, sessions; computePeriod + approvePeriod → ledger entries sum to surplus.

## Done means

Common rules. READMEs in both packages documenting the chart of accounts, posting rules and the formula with a worked example.
