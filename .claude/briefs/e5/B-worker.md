<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E5 unit B, worker co-op jobs and the governance lifecycle** for CommonAir
(repo: /Users/joshe/Repos/bcon). Read AGENTS.md, PLAN.md, docs/architecture.md and
`.claude/briefs/e5/_common.md` first (all of it), then `docs/testing/e5-selectors.md` in full
(especially "Proposal flows", "Council" and the membership rows), ADR 0020, ADR 0004,
`packages/governance/README.md`, `services/worker/README.md`, and the patterns in
`services/worker/src/runtime/registry.ts`, `jobs/index.ts`, `jobs/money-release-holds.ts` +
`money/job.ts` (scheduled job with a Valkey run lock), `jobs/money-expire-pending.ts`,
`outbox.ts` (internal events are validated and never reach the bus) and how the worker writes
`audit_log` and `events` rows today (`money/renew.ts`, `deletion/account-deletion.ts`). Do not
look outside the repository.

This unit decides proposals, writes tallies and applies settings changes: it gets a second,
security-focused review.

## You own (write only these)

- `packages/governance/**` (new lifecycle module(s), council and membership changes, README,
  tests).
- `services/worker/src/coop/**` (new), `services/worker/src/jobs/coop-*.ts` (new),
  `services/worker/src/jobs/index.ts` (register your jobs only), `services/worker/src/money/**`
  and `jobs/money-expire-pending.ts` (only to cancel the share of an expired share payment),
  the worker's startup/health code only to log a warning and report `COOP_TEST_HOOKS` on
  `/healthz` (as for `MODERATION_TEST_HOOKS`), `services/worker/README.md` (a "Co-op" section),
  `services/worker/tests/coop*.ts`.

## Contracts you must honor (read-only for you)

- `QUEUES.coop`, `COOP_JOBS` (`membership-sync`, `proposals-advance`, `council-recompute`,
  `elections-advance`), `CoopJob` (empty payload), `CoopJobResult` (counts only; the API's test
  hook returns it). Schedules: `proposals-advance` every 15 s, `membership-sync` hourly,
  `council-recompute` daily at 03:10 UTC, `elections-advance` every minute. Each job holds a
  Valkey run lock and is safe to run concurrently with itself and with the API's test-hook
  enqueue (the database row locks are the real guard).
- Events: `coop.proposal.update` (public), `coop.membership.update`, `coop.share.update`,
  `coop.council.recomputed`, `coop.election.update` (internal), validated against `EVENTS` and
  inserted in the same transaction as the change. Audit rows with actor type `system`.
- The triggers in `0001`, `0002`, `0021`: the proposal state machine (only `rules` and
  `voting_ends_at` may be set by the caller when opening a vote), the electorate built by the
  database, the re-tally on `passed`/`rejected`, the `tallies` check (outcome, `reason` and every
  count member-wide and per class must equal the SQL tally), the settings guard (apply exactly
  once, superseded changes refused, all-or-nothing with `applied`), council terms/seats
  append-only and seats only in the term's transaction.
- The API (unit A) never moves a proposal past `discussion` and never writes tallies or settings:
  **you own every transition after submit**.

## Build

1. **Proposal lifecycle** in `packages/governance` (pure helpers + one function per step taking
   a `Database`/`Executor` and `now`), called by `proposals-advance`. One transaction per
   proposal step, each locking the proposal row first, writing audit (actor `system`) + event:
   - `discussion` past `discussion_ends_at` → `council_review` when `affects_creators`, else
     `voting`.
   - `council_review` past `council_review_ends_at` → `voting`, responded or not.
   - Opening a vote: `rules = rulesFor(kind, settings, { affectsCreators })`, `voting_ends_at` =
     now + `governance.ordinary.votingSeconds`, raised to `governance.protections.minVotingSeconds`
     for protected proposals; then one `vote_open` notification per electorate member (the
     electorate exists only after the update: read it in the same transaction).
   - `voting` past `voting_ends_at` → compute `tally()` from the frozen electorate and the votes
     (with `votingEndsAt`), set `passed`/`rejected` (the trigger re-tallies), insert the
     `tallies` row with the TS breakdown and reason (the trigger checks it). A disagreement
     raises: the transaction rolls back, log `error` with the proposal id and the reason pair,
     count it in a metric, and move on to the next proposal (never record anything). Audit
     `proposal.decide` with details `{ passed, rule }`.
   - `passed` → apply every change (`governance_settings.value`, `updated_by_proposal_id`) and set
     `applied`, all in one transaction (audit `proposal.apply`). A superseded change is refused by
     the trigger: roll back that attempt (savepoint), leave the proposal `passed`, write audit
     `proposal.apply_refused` and a `warn` log, and do not retry it every 15 s forever (record
     that it was refused, e.g. by the audit row, and skip proposals that already have one).
   - Proposals are processed oldest deadline first, bounded per run; one failing proposal never
     blocks the others.
2. **Council** (`recomputeCouncil` and its job): seat a new term when there is no current term,
   the UTC month changed, or a seated member of the current term is no longer an active streamer
   member (a vacancy). The new term starts now and ends at the end of the UTC month. Keep the
   advisory lock and the audit; add the `coop.council.recomputed` event. The trigger sets
   `computed_at` and `txid`; seats go in the same transaction as their term.
3. **Membership sync** (`syncMemberships` and its job): add the `coop.membership.update` event
   for every activation and lapse (same transaction). **Respect voluntary exits** (the spec): a
   user whose latest membership in a class is `exited` with `exited_at` inside that class's
   window is not re-activated by the job. The current code comment says exited members who
   qualify again are re-activated; change it to the spec, and keep `lapsed` members re-activating
   when they qualify again. Keep the mass-lapse guard.
4. **Elections** (`elections-advance`): `nominating` → `voting` at `nominations_close_at` (event),
   then `closeElection` at `voting_ends_at` (it exists; add the event).
5. **Share payment expiry:** when `money-expire-pending` fails a `membership_share` payment, set
   its share `cancelled` in the same transaction (event `coop.share.update`).
6. **Test hooks:** with `COOP_TEST_HOOKS=true`, log a warning at every start and report it on
   `/healthz`. The jobs themselves behave the same either way.

## Tests you must add

- `packages/governance` unit: the pure helpers (which step applies, voting end for protected vs
  ordinary, the `rule` for each tally reason, vacancy detection).
- `packages/governance` integration (`createTestDatabase({ governance: FAST_GOVERNANCE })`, app
  role): an ordinary creator-affecting proposal goes discussion → council_review → voting →
  passed → applied, with `vote_open` notifications, the `tallies` row accepted by the trigger,
  the setting changed and every audit/event row present; **a protected proposal that passes
  member-wide and fails in the streamer class is rejected**, its `tallies` row says so, and
  `platform.cut` is unchanged; a quorum miss; a superseded change → `apply_refused` once; a
  forced TS/SQL disagreement (e.g. a test-only electorate mismatch you construct) records
  nothing; concurrent runs of the advance step decide each proposal once; council vacancy and
  month rollover create a new term, otherwise not; voluntary exit not re-activated, lapse
  re-activated; elections advance and close.
- `services/worker` unit/integration: job registration and schedules, run lock, share
  cancellation on expiry, the healthz flag.

## Done means

See `_common.md` "Done means". Your packages: `packages/governance`, `services/worker`
(`bun run test`, `bun run test:int` once each at the end, one at a time, `tsc`), lint/fmt on
changed paths.
