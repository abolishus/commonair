<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W0-integrity: close out the 2H2 integrity list

You are implementing unit W0-integrity for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, PLAN.md and docs/architecture.md first, then `.claude/briefs/next/W0-prerequisites.md`
(row W0-integrity), `docs/product/feature-wins.md` §5 "Wave 0" and §4.4 (what W1-watch-gate will
build on your marker), `packages/integrity/README.md` and `.claude/briefs/w0/contract-step.md`. Do
not look outside the repository. Work in your own git worktree on a branch named `w0/integrity`,
starting from the W0 contract-step commit.

No ADR gates this unit. feature-wins §7 lists "fetch-unjudged = unverified" under ADR 0015 (W1);
this brief builds the marker W1 needs without deciding the W1 gate policy. If ADR 0015 is written
before you start and says otherwise, the orchestrator updates this brief before launch.

## Why

The 2H2 review list (`PROGRESS.md:1153`, not `:235` or `:907` as older plans say) is mostly done in
code (`b30bc78`: appeal stickiness, relay receipt coverage, database-counter tolerance, HTTP share
from server evidence only, distinct segment counting, stream-hour eligibility). What is left: a
session that the delivery path cannot judge (CDN pulls are tokenless) still verifies on the other
signals alone, nothing marks it, so the W1 verified-watch gate and the stream-hour eligibility that
feeds membership cannot tell it apart from a judged one; and `integrity-basic` proves none of the
fetch-less, CDN-bot or false-positive cases. Size S.

## You own (write only these)

- `packages/integrity/src/**`, `packages/integrity/tests/**`, `packages/integrity/README.md`
- `services/worker/src/integrity/**` (`classifier.ts`, `fetches.ts`, `jobs.ts`, `lock.ts`) and
  `services/worker/tests/integrity*.ts`
- `harness/scenarios/integrity-basic.ts`, new `harness/src/integrity-*.ts` helpers, new
  `harness/tests/integrity-*.test.ts`

Not yours: `harness/src/viewbot.ts`, `http-viewer.ts`, `browser-viewer.ts`, `platform.ts` (shared
by other scenarios; build on their options or add a new helper file), `PROGRESS.md` and
`HANDOFF.md` (the orchestrator closes the 2H2 row and the `HANDOFF.md:451` gap line from your
report), `packages/patronage/**`, `packages/governance/**`, `services/api/**`. Do **not** create
`services/worker/src/integrity/verified-watch.ts`: that is W1-watch-gate's file (feature-wins §5,
note under the Wave 0 table). `packages/governance/src/inputs.ts` is E7-coop's in wave 1. Need a
change outside your paths? Do not make it: put the exact change in your final message as a
contract request.

## Contracts you must honor (read-only for you)

- Verdicts `pending | verified | excluded` (`session_verdict`, `packages/db/drizzle/0000_initial.sql:49`)
  and reason codes stored in `playback_sessions.verdict_reasons` (`packages/db/src/schema/delivery.ts:89`).
  Reason codes are stable: never rename one, only add (`packages/integrity/src/types.ts:6-31`).
- Appeal and allowance shapes (`packages/integrity/src/allowance.ts`; `appeals` with kind
  `integrity`). An allowance never covers a session that started after the decision (`score.ts:50-52`).
- The worker's job names and run locks (`services/worker/src/integrity/jobs.ts:84-87`, :189).
- Integrity uses server-observed quantities only; client-reported bytes, `p2pCapable` and the
  assigned source never lower expectations (`signals/fetch.ts:27-33`). Keep that.
- No PII in logs or reasons (AGENTS.md "Code style").

## What is there today (verified at `9c51c93`)

- `fetchChecks` (`packages/integrity/src/signals/fetch.ts:98-173`) returns `skipped: "cdn"` for every
  CDN-assigned session (:107) and `skipped: "no_accounting"` when an origin session has no
  accounting at all (:128). Neither sets `mediaUnconfirmed`, and `scoreSession`
  (`packages/integrity/src/score.ts:43-82`) only holds a session back for `mediaUnconfirmed`
  (:77-80). So a skipped session verifies with no delivery evidence and no reason says so. (A
  relay session without receipt coverage also returns `no_accounting`, but with
  `mediaUnconfirmed = true` (:113), so it stays pending.)
- The API promotes a session to `verified` on heartbeat before the scorer has run
  (`services/api/src/routes/playback.ts:237-253`, only while `scored_at` is null and without
  `media_unconfirmed`; not your file). Such a session has no reasons yet, so it carries no
  `fetch_unjudged` until the worker scores it.
  The README documents the CDN gap (`packages/integrity/README.md:152-154`), as does
  `HANDOFF.md:451`.
- Verified sessions feed: stream-hour eligibility (`packages/integrity/src/jobs.ts:745-822`, the
  join at :781), follow-burst prior viewing (`jobs.ts:666`), public viewer counts
  (`services/api/src/lib/viewers.ts:38`), patronage (`packages/patronage/src/inputs.ts:101`) and
  governance inputs (`packages/governance/src/inputs.ts:92`).
- `integrity-basic` (`harness/scenarios/integrity-basic.ts`, 152 lines): three honest viewers and a
  datacenter, headless, playlist-polling `ViewbotSwarm`; the count converges to 3 and each bot's
  verdict and reasons are read from Postgres (:115-148). No CDN case, no bot without any requests,
  no honest-but-unusual viewer.
- The harness can run a step only when the CDN adapter is configured:
  `ctx.optionalStep(name, ["cdn"], fn)` (`harness/src/scenario.ts:160-164`; `cdn` is a proprietary
  need, `:38`, skipped under `--profile no-proprietary`).

## Build

1. **Mark fetch-unjudged sessions.** Add a non-signal reason `FETCH_UNJUDGED = "fetch_unjudged"` in
   `types.ts` and append it in `scoreSession` whenever `fetchChecks` skipped the session (`cdn` or
   `no_accounting`), for every verdict, so admins and streamers see it. The verdict itself does not
   change in this unit (public counts keep CDN viewers; ADR 0015 decides the gate policy in W1).
   Export a pure predicate `gateEligible({ verdict, reasons })`: verified and not `fetch_unjudged`.
   This is the marker W1-watch-gate reads; document it in the README next to the CDN limitation.
2. **Use the marker where verified sessions earn something.** Stream-hour eligibility (`jobs.ts:781`)
   and follow-burst prior viewing (`jobs.ts:666`) count only gate-eligible sessions. Check whether
   they can read an interim-verified, not yet scored session (see above); if they can, a CDN session
   counts until it is scored, so either require `scored_at is not null` there or explain why the
   window makes it moot. `gateEligible` takes the verdict and reasons as stored; document that an
   unscored session has no reasons. The filter in SQL:
   `not ('fetch_unjudged' = any(coalesce(ps.verdict_reasons, '{}')))`; check the column type and
   any index the query relies on, and keep `0006_integrity_scan_indexes.sql`'s plans. Patronage and
   governance inputs are not your files: put the exact SQL change for
   `packages/patronage/src/inputs.ts:101` and `packages/governance/src/inputs.ts:92` in your final
   message as a contract request, flagged as a policy question for the user (CDN viewers would stop
   counting toward patronage and governance).
3. **Re-scoring.** Existing sessions get the reason the next time the scorer touches them; do not
   rewrite history in a migration. Confirm a session already `verified` before your change gains the
   reason on its next re-score (or say why it never re-scores).
4. **`integrity-basic` cases** (keep the existing ones):
   - **Fetch-less bot:** sessions that heartbeat with plausible fingerprints from residential-looking
     addresses and make no playlist or media request at all. Each must not verify (pending with
     `media_unconfirmed`, or excluded with `fetch_pattern`), with the reasons read from Postgres as
     today.
   - **CDN bot** (`ctx.optionalStep(..., ["cdn"], ...)`): a session assigned `cdn` that never pulls
     anything. It may verify (no fetch judgement), but its reasons include `fetch_unjudged` and
     `gateEligible` is false; its hour does not count toward stream-hour eligibility. Find how a
     harness viewer gets a CDN assignment; if it needs an API test hook, report the exact hook as a
     contract request and leave the step skipped with that reason.
   - **False positives:** honest viewers that look unusual must verify: several honest viewers
     behind one address (a household), and an honest viewer whose tab is hidden for a while
     (heartbeat cadence changes). The public count includes them.
   - Parameters stay overridable (`--set bots=… --set convergeSeconds=…`); add any new ones to the
     header comment.

## Tests you must add

- `signals.test.ts` / `score-channel-relay.test.ts`: `fetch_unjudged` appears for `cdn` and
  `no_accounting`, never for judged origin/relay/p2p sessions; it survives an allowance; it does not
  change the verdict; `gateEligible` truth table (pending, excluded, verified with and without the
  reason).
- `jobs.int.test.ts` (`createTestDatabase()`): a CDN session does not make an hour eligible; a judged
  session still does; follow-burst prior viewing ignores CDN watch time.
- `services/worker/tests/integrity.int.test.ts`: the worker path writes the reason into
  `verdict_reasons`.
- Pure helpers of the new scenario cases in `harness/tests/integrity-*.test.ts`.

## Done means

Follow `.claude/briefs/_done-means.md`, with this batch's rule: the orchestrator runs the gate; you
run targeted checks only and never run the gate, `podman`, `scripts/infra.ts` or harness scenarios.
Run `bun run test` and `bun run test:int` in `packages/integrity` and `services/worker` (one at a
time), `bunx tsc -p packages/integrity --noEmit`, `bunx tsc -p services/worker --noEmit`,
`bunx tsc -p harness --noEmit`, `vp lint --deny-warnings` and `vp fmt` on your paths. Commit in your
worktree (`git commit -s`, Conventional Commits, message ending with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Final message: what you
built, test counts per package, branch and sha, contract requests (patronage/governance SQL, any
CDN-assignment hook), the text the orchestrator should use to close the 2H2 row (`PROGRESS.md:1153`)
and update `HANDOFF.md:451`, and the exact live commands:
`bun harness/src/cli.ts run integrity-basic` and, on a stack with the CDN adapter configured, the
same with the CDN step not skipped.

## Contract step as landed

- Your base is main after the W0 contract step merge (`648d04e`, "merge: W0 contract step"), which contains all of E7. Recheck line numbers against it.
- The migrations taken are `0028_enforcement_statements` and `0029_w0_protections`.
- The next free migration number is 0030.
- `0029_snapshot` is a copy of 0028.
- No changes from this step beyond the base sha and migration numbers.
