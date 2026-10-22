<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E5 unit E, the harness `e5-coop` scenario** for CommonAir (repo:
/Users/joshe/Repos/bcon). Read AGENTS.md, `.claude/briefs/e5/_common.md` (all of it),
`docs/testing/e5-selectors.md` in full (especially "Stack and test hooks" and "Scenario
`e5-coop`"), ADR 0020, `harness/README.md`, and the scenarios `harness/scenarios/e4b-money.ts`
(money actors, treasurer confirm, `--set via=api`, ledger checks through `src/money-db.ts`) and
`harness/scenarios/trust-safety.ts` (`src/safety-db.ts`: app-role refusal checks inside a
transaction that is always rolled back; the test-hook calls; log scanning), plus
`harness/compose.trust-safety.yaml`. Do not look outside the repository.

## You own (write only these)

- `harness/scenarios/e5-coop.ts`, new `harness/src/coop*.ts` (pure helpers, DB checks, web
  drivers), `harness/compose.e5-coop.yaml`, the scenario's registration, `harness/README.md` (an
  "e5-coop" section), `harness/tests/coop*.test.ts`.

## Contracts you must honor (read-only for you)

- The API (`coop.*`, `treasurer.confirm`, `money.tip`), the web test ids and the routes in the
  spec, the test hook `POST /internal/coop/tick` (`CoopTickBody`, `INTERNAL_API_SECRET`), the
  role CLI (`grantRole` in `src/money-db.ts`) for `treasurer` ×2 and `admin`.
- `harness/compose.e5-coop.yaml` sets, for the services that need them: `COOP_TEST_HOOKS=true`
  (api, worker) and `GOVERNANCE_BOOTSTRAP_JSON` (the `migrate` service) exactly as the spec's
  "Stack and test hooks" lists it (shallow merge per key: `membership.classes` must carry the
  whole object for each class you override). It must layer cleanly with
  `harness/compose.trust-safety.yaml` (the final check runs `e5-coop`, `e4b-money` and
  `trust-safety` on one stack started with both overrides).

## Build

1. The scenario's steps 1–9 exactly as the spec lists them, with `--set via=api` (API only) and
   the default (web flows for the steps the spec says are web: buy share, treasury confirm and
   refund, appoint worker, proposal draft, a vote, council page, patronage run/approve, statement,
   transparency, settings). Steps run as a prefix (`--set steps=1-5`).
2. **Preflight:** fail fast with a clear message and the reset hint (ADR 0020) when
   `governance.ordinary.discussionSeconds` > 60 or the tick hook answers 404.
3. **Timing:** governance windows run on the database clock. Wait on state, never on fixed
   sleeps alone: poll `coop.proposals.get` with a deadline after each tick, and tick
   `proposals-advance` until the expected status (bounded). The streamer qualification streams
   an ffmpeg test pattern with a harness viewer until `coop.membership` shows the streamer class
   eligible, then ticks `membership-sync` (bounded wait, reported).
4. **DB checks** (owner `DATABASE_URL`, read-only except the rolled-back refusal checks): the
   protected proposal cannot be set `passed`, a `tallies` row with `passed = true` cannot be
   inserted, and its change cannot be applied to `platform.cut`, each as the app role inside a
   transaction that is always rolled back (throw if the role switch fails, as `safety-db.ts`
   does); `platform.cut` unchanged; every ledger transaction of the run (share purchase, tip,
   period close, patronage allocation, share refund) balances; for every action the `audit_log`
   row (action, actor type) and the `events` row exist; no audit `details`, event payload or
   captured service log line contains a vote choice tied to a user, a comment body or an email.
5. **API details from batch 1:** a proposal change sends the **whole** setting value (read
   `discovery.ranking` from `coop.settings` and replace `spotlightSlots`); a tick may answer
   `{ skipped: 1 }` (run lock busy), so tick again; drafts emit no event until submit; votes are
   judged by the database clock, so after a tick that opens voting, vote at once.
6. **Idempotent across runs** on a long-lived stack: usernames unique per run, the patronage
   period starts at this run's start (after any earlier period), `spotlightSlots` alternates, and
   step 9 exits every member the run created so later runs start from a clean electorate.
7. Report: ids, statuses, timings and counts only (no emails, no comment text, no choices).

## Tests you must add

- Unit tests for the pure helpers (step parsing, period choice, expected tally per class from
  the votes the scenario casts, bootstrap JSON shape, log-needle building, the compose override
  layering with the trust-safety override).

## Done means

See `_common.md` "Done means". Your package: `harness` (`bun run test`, `tsc`), lint/fmt on
changed paths. **No live scenario runs** (the head agent does the bring-up).
