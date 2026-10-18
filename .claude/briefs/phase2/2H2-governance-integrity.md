<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit 2H2: Governance and integrity libraries (`packages/governance`, `packages/integrity`)

## You own

- `packages/governance/**` (`@commonair/governance`), `packages/integrity/**` (`@commonair/integrity`)

## Contracts (read-only)

- `packages/db/drizzle/0001_protections.sql` (the authoritative governance rules: state machine, tally, electorate, application), ADR 0004, `packages/db/src/schema/coop.ts`, `packages/db/src/seed.ts` (settings), `packages/contracts/src/shapes.ts` (GovernanceRuleSnapshot, TallyBreakdown, GovernanceChange), `enums.ts`.
- Integrity: `packages/db/src/schema/delivery.ts` (playback_sessions, relay_receipts, relay_issuance), `safety.ts` (integrity_flags, appeals, audit_log), `channels.ts` (follows), `chat.ts`, `interactive.ts` (raids); `api/entities.ts` Heartbeat (fingerprint), `seed.ts` `integrity.thresholds`.

## Build — governance (pure TypeScript, mirrors the SQL exactly; the DB stays authoritative)

1. `tally(rules, electorate, votes)` → `{ passed, reason, breakdown: TallyBreakdown }` with the identical rule order and reasons as `commonair_governance_tally` (quorum member-wide, member-wide threshold ≥, streamer quorum, streamer majority strictly >). Per-class counts for all three classes in the breakdown plus `checks` entries.
2. `rulesFor(kind, settings)` builds a GovernanceRuleSnapshot from current settings (protected: from `governance.protections`; ordinary: `governance.ordinary`), `isProtectedKey(key, protections)`, `classifyChanges(changes, settings)` → kind + affectsCreators requirements, `allowedTransitions(status)` mirroring the SQL state machine, and `timeline(settings, now)` for UI previews (discussion end, council review end, min voting end).
3. **Creator council seating**: `seatCouncil(candidates, config)` — top `size` streamers by contribution score over `eligibilityWindowDays` with ≥ `minStreamingHours`; score = the same weighted blend as patronage (revenue, eligible hours, relay bandwidth, verified viewer-hours) normalized per component; deterministic tie-break; returns ranks + method record. Provide a DB function `recomputeCouncil(db, now)` writing `council_terms`/`council_members` (idempotent per term window).
4. **Board elections**: approval-ballot tally with seats, ties broken by earlier nomination then user id; eligibility (voter and candidate must hold the election's class) helpers.
5. **Membership eligibility**: `streamerEligible(hours, rules)`, `viewerEligible(share, activeSubscription, rules)` from `membership.classes`, and a DB job function `syncMemberships(db, now)` that activates/lapses streamer and viewer memberships per the rules (workers are board-appointed only), writing audit_log rows.
6. **Equivalence test** (integration): for randomized electorates and votes (≥ 200 cases incl. edge cases: zero votes, all abstain, exact thresholds 2/3 and 0.5, no streamers), the TS `tally` result equals the SQL function's result on the same data in a real DB (`createTestDatabase({ governance: FAST_GOVERNANCE })`; you must go through the real state machine to open votes — see protections.int.test.ts helpers for how).

## Build — integrity (pure scoring + DB jobs)

1. **Session scoring** `scoreSession(session, heartbeats, fetches, context)` → `{ verdict: "verified" | "excluded" | "pending", score 0..1, reasons: string[] }` combining signals (each a small pure function with its own tests and a stable reason code):
   - `datacenter_ip`: IP/ASN classified as hosting via a pluggable `NetworkClassifier` interface; default implementation matches CIDR lists loaded from an operator-provided file (`integrityEnv.INTEGRITY_DATACENTER_CIDRS_FILE`, optional) — ship a small sample list under `packages/integrity/data/sample-hosting-cidrs.txt` for the harness (documentation ranges + a few well-known public cloud ranges, with a note it is a sample).
   - `device_concurrency` / `account_concurrency`: more than `maxSessionsPerDevice` concurrent sessions per device hash / account.
   - `headless`: fingerprint flags (navigator.webdriver, HeadlessChrome UA, zero plugins with desktop UA, missing WebGL, 0×0 window, no audio context, automation globals) — weighted, not single-flag fatal.
   - `heartbeat_inconsistent`: playedSeconds vs wall clock, never visible and always muted, buffer never advancing, perfectly periodic timing jitter (< 5 ms stdev over ≥ 10 beats).
   - `fetch_pattern`: segments fetched vs expected for watch time (segment duration known), playlists without segments, or segments without playlists.
   - Verdict thresholds from `integrity.thresholds.sessionExcludeScore`. A session needs ≥ 3 heartbeats to be verified.
2. **Channel-level signals**: `chatToViewerAnomaly` (viewers ≫ chatters relative to channel baseline and platform distribution), `followBurst` (follows per minute above `followBurstPerMinute` with low account age / no prior viewing), `raidIntegrity` (raid viewer count must be ≤ verified viewers of the source).
3. **Relay receipt cross-check** `checkReceipt(receipt, issuance, tolerance)` → verified bytes = min(reported, issued) when within tolerance, else `rejected` with over-report ratio; `relayStanding(history)` → suspend when over-reporting beyond `relayOverReportTolerance` in ≥ 2 of the last 5 periods or any single period > 3× tolerance.
4. **DB jobs** (functions the worker will schedule): `scoreActiveSessions(db, valkey, now)` (reads sessions + Valkey heartbeat history + `stream:segments` aggregates you can query from `playback_sessions` counters), writes verdicts and `integrity_flags` with reasons (never deletes), `verifyReceipts(db, now)` (writes receipt status/bytesVerified/overReportRatio, suspends relays with audit_log + integrity_flags), `excludeFollowBursts(db, now)` (sets `follows.excludedAt`, flags), `markEligibleStreamHours(db, now)` (sets `stream_hours.verifiedOtherViewers` and `eligible` from verified sessions excluding the channel owner's own user id/device).
5. All exclusion decisions are explainable (reasons) and appealable (keep subject ids stable).

## Dependencies

workspace + catalog only.

## Tests

Exhaustive unit tests per signal and combination; governance tally/transition tests; council and election tallies; equivalence integration test; integrity DB job integration tests (verdicts written, flags created, nothing deleted, relay suspension path, stream-hour eligibility excluding self-views).

## Done means

Common rules. READMEs documenting every signal and threshold (these become the public integrity documentation).
