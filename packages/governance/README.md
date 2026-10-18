<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# @commonair/governance

Governance rules of the co-op in TypeScript: tallies, the proposal state machine, creator
council seating, board elections and membership eligibility.

**The database is authoritative.** Protected settings, the proposal state machine, the
electorate and vote windows are enforced by Postgres triggers
(`packages/db/drizzle/0001_protections.sql`, hardened by `0002_protections_hardening.sql`;
see ADR 0004). This package mirrors those rules so the API can build requests the database
will accept and the web app can explain outcomes. When the two disagree, the database wins
and this package has a bug; `tests/tally-equivalence.int.test.ts` checks them against each other.

## Tally (`tally(rules, electorate, votes, opts)`)

Mirrors `commonair_governance_tally`. Checks run in this order and the first failure is the
`reason` (the exact SQL strings):

| #   | Rule (`checks[].rule`)    | Passes when                                                                     | Failure reason                    |
| --- | ------------------------- | ------------------------------------------------------------------------------- | --------------------------------- |
| –   | timeline                  | voting opened (`votingEndsAt` set)                                              | `voting never opened`             |
| –   | snapshot                  | frozen rules carry typed values                                                 | `malformed rules`                 |
| –   | timeline                  | `votingEndsAt` has passed                                                       | `voting has not ended`            |
| 1   | `member_wide_quorum`      | eligible > 0 and (yes + no + abstain) / eligible **≥** `quorum`                 | `member-wide quorum not met`      |
| 2   | `member_wide_threshold`   | yes + no > 0 and yes / (yes + no) **≥** `memberWideThreshold`                   | `member-wide threshold not met`   |
| 3   | `streamer_class_quorum`   | (protected only) streamer turnout / streamers **≥** quorum                      | `streamer-class quorum not met`   |
| 4   | `streamer_class_majority` | (protected only) s_yes / (s_yes + s_no) **>** `streamerClassThreshold` (strict) | `streamer-class majority not met` |

- Abstentions count toward quorum, never toward thresholds.
- Members holding several classes count once member-wide and once in each class they hold.
- Votes from outside the frozen electorate, or cast after `votingEndsAt`, are ignored.
- Ratios are compared with exact Postgres `numeric` semantics (`numeric.ts`), so boundary
  cases such as exactly 2/3 or exactly 1/2 come out the same as in SQL.
- `breakdown.checks` lists every applicable rule with a human-readable detail; `byClass`
  has counts for all three classes.

## Rules, transitions and timeline

- `rulesFor(kind, settings)`: the snapshot to freeze when voting opens. Protected:
  `governance.protections` (`memberWideThreshold` 2/3, `streamerClassThreshold` 0.5,
  `quorum` 0.2, `streamerClassQuorum` 0.2, council review required). Ordinary:
  `governance.ordinary` (`threshold` 0.5, `quorum` 0.1). `rulesAcceptable` mirrors the
  database's "at least as strict as current settings" check.
- `isProtectedKey`, `classifyChanges`: a proposal is protected iff any change touches a key in
  `governance.protections.protectedKeys` (which always includes itself); protected proposals
  must affect creators and therefore go through creator-council review.
- `allowedTransitions(status)`: `draft → discussion | withdrawn`, `discussion → council_review |
  voting | withdrawn`, `council_review → voting | withdrawn`, `voting → passed | rejected`,
  `passed → applied`. Creator-affecting proposals must complete council review before voting.
  Content may change only in `draft`/`discussion`, never in the same update as a transition;
  an edit during discussion restarts the discussion period.
- `timeline(settings, now, { kind, affectsCreators })`: earliest discussion end, council review
  end and minimum/default voting end, for UI previews. The database sets the real timestamps.
- Settings shapes (`settings.ts`) mirror the database's range checks: periods 0–90 days,
  quorums 0–0.5, thresholds 0.5–1 (streamer threshold and ordinary threshold below 1).

## Creator council (`seatCouncil`, `recomputeCouncil(db, now)`)

`council.config`: `size` 7, `eligibilityWindowDays` 90, `minStreamingHours` 10.

1. Candidates: active streamer-class members (not banned or deleted).
2. Eligible: at least `minStreamingHours` eligible streaming hours in the window (hours with
   ≥ 1 verified viewer other than the streamer, each UTC day capped at
   `patronage.formula.weights.dailyStreamingHourCap`, 8 h).
3. Score = Σ weight × (member's value / total of eligible candidates) over revenue (subs + tips
   net of tax and refunds), eligible hours, verified relay bytes and verified viewer-hours, with
   the `patronage.formula` weights (0.5 / 0.2 / 0.2 / 0.1).
4. Ranked by score, then eligible hours, then user id; the top `size` are seated.

`recomputeCouncil` seats the council for the UTC calendar month containing `now`, once: later
calls in the same month return the existing term. The method (inputs, weights, totals, window)
is stored in `council_terms.method` and an `audit_log` row is written.

## Board elections (`tallyElection`)

Approval voting per class. A ballot approving more candidates than there are seats, a second
ballot from the same voter, or a ballot from someone outside the class is spoiled. The seats
go to the most-approved candidates with at least one approval; ties go to the earlier
nomination, then the lower user id. `canVoteInElection` / `canStandInElection` /
`eligibleVoters` implement "voter and candidate must hold the election's class".

## Membership (`streamerEligible`, `viewerEligible`, `syncMemberships(db, now)`)

`membership.classes`:

- **Streamer**: ≥ `minStreamingHours` (10) eligible streaming hours over `windowDays` (90),
  measured as for the council (daily cap applied).
- **Viewer**: a held member share of at least `shareCents` (500), or an active subscription
  when `activeSubscriptionQualifies`.
- **Worker**: appointed by the board; never changed by the sync job.

`syncMemberships` activates newly eligible members (new `memberships` row), lapses members who
no longer qualify (`status = lapsed`, `lapsedAt`), and refreshes `lastEligibilityCheckAt`. Only
memberships with a basis the job manages are touched (`streaming_hours`; `share`/`subscription`).
Banned or deleted users are never activated, and a member whose latest membership in a class is
`exited` left voluntarily and is not re-enrolled. Every change writes an `audit_log` row (ids
and numbers only). Membership history is kept by the database trigger.
