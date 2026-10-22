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

## Proposal lifecycle (`advanceProposals(db, opts)`, `lifecycle.ts`)

Every transition after submit is made here, by the worker's `proposals-advance` job (the API
never moves a proposal past `discussion`). One transaction per step, each locking the proposal
row first and writing its audit row (actor `system`) and `coop.proposal.update` event:

| From             | When                            | To                                       | Audit                     |
| ---------------- | ------------------------------- | ---------------------------------------- | ------------------------- |
| `discussion`     | `discussion_ends_at` passed     | `council_review` if affects creators     | `proposal.council_review` |
| `discussion`     | `discussion_ends_at` passed     | `voting` otherwise                       | `proposal.open_vote`      |
| `council_review` | `council_review_ends_at` passed | `voting` (responded or not)              | `proposal.open_vote`      |
| `voting`         | `voting_ends_at` passed         | `passed` / `rejected` + `tallies` row    | `proposal.decide`         |
| `passed`         | always (unless refused before)  | `applied`, every change in one savepoint | `proposal.apply`          |

- `nextStep(proposal, now)` decides the step; deadlines must have strictly passed and are read
  from the database clock, since the triggers check them with it.
- Opening a vote freezes `rulesFor(kind, settings, { affectsCreators })` and sets
  `voting_ends_at` = database now + `votingSeconds(kind, settings)` (ordinary `votingSeconds`,
  raised to `governance.protections.minVotingSeconds` for protected proposals) + a 1 s margin, so
  the trigger's own clock reading never sees a window under the minimum. Every electorate member
  (built by the trigger in the same statement) gets a `vote_open` notification
  (`{ proposalId, kind, votingEndsAt }`), inserted in batches of `NOTIFICATION_BATCH` (1,000) so
  a large electorate never exceeds the 65,535 parameters one statement may bind.
- Deciding tallies the frozen electorate and the votes with `tally()` (votes after the deadline
  ignored), sets the status and inserts the `tallies` row; the triggers re-tally both. Audit
  details are `{ passed, rule }` (`decisionRule`: the failing `TALLY_RULES` id or `passed`). A
  database refusal is a TS/SQL disagreement: nothing is recorded, `error` is logged with both
  reasons and `disagreements` is counted. `opts.tallyFn` exists only for the test that proves it.
- Applying writes every change (`value`, `updated_by_proposal_id`) and `applied` inside a
  savepoint. When the settings trigger refuses for good (superseded since the vote opened, the
  re-tally no longer passes, or already applied: `PERMANENT_REFUSAL`, or a settings history row
  for one of the keys after `voting_starts_at`), the savepoint rolls back, the proposal stays
  `passed`, `proposal.apply_refused` is written and a `warn` logged; `dueProposals` skips
  proposals with that audit row. Any other error, including a `42501` from a missing grant, fails
  the step (`failed`, logged) and the next run retries it.
- Oldest deadline first, `limit` per run (default 50); a failing proposal is counted and logged
  and never blocks the others. Concurrent runs are safe: the row lock serializes them and the
  second finds nothing due.

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

`recomputeCouncil` seats a new term when `reseatReason` says so: there is no current term (the
latest by `computed_at` whose window contains `now`), the UTC month changed since it started, or
a seated member is no longer an active streamer member (`councilVacancies`), or the term has
fewer than `size` seats while an active streamer member is unseated and a new seating would fill
more seats (`unfilled`: a term seated before anyone qualified, for example on a fresh instance,
must not stay empty for the rest of the month; ineligible streamers cause no churn). The new term starts
now and ends at the end of the UTC month (`newTermWindow`); otherwise the current term is
returned unchanged. Terms and seats are append-only and the seats go in the term's transaction
(trigger). The method (inputs, weights, totals, window) is stored in `council_terms.method`; the
`council.recompute` audit row names the reason, the previous term and the vacated seats, and a
`coop.council.recomputed` event is written. An advisory lock makes concurrent calls seat once.

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
Banned or deleted users are never activated. A member whose latest membership in a class is
`exited` with `exited_at` inside `exitWindowDays(class)` left voluntarily and is not re-activated
by the job (`exitRespected`). The streamer window is `streamer.windowDays`. The viewer class has
no window, so a viewer exit is respected indefinitely: the job never re-enrols a viewer who left;
they rejoin by an explicit action (a new share confirmed by the treasurer inserts the
membership). Lapsed members, and streamer exits older than the window, re-activate when they
qualify again. Every activation and lapse writes an `audit_log` row (ids
and numbers only) and a `coop.membership.update` event in the same transaction. Membership
history is kept by the database trigger.

## Board elections lifecycle (`advanceElections(db, now)`)

Run by the worker's `elections-advance` job: `nominating → voting` once `nominations_close_at`
has passed (`openElectionVoting`, audit `election.open_voting`), then `closeElection` once
`voting_ends_at` has passed (audit `election.close`); each writes a `coop.election.update`
event. The run reads both lists first, so the run that opens an election never also closes it.

## Audit and outbox helpers (`outbox.ts`)

`emitEvent(tx, type, payload, at)` validates the payload against the event catalog before the
insert; `systemAudit(tx, row, at)` writes an audit row with actor `system`; `pgCode(err)` reads
the SQLSTATE through drizzle's error wrapper.
