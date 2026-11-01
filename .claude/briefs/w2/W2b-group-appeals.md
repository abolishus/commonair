<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W2b-group-appeals: appeal one exclusion group, re-score what an overturn covers

You are implementing unit W2b-group-appeals for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, PLAN.md and docs/architecture.md first, then `.claude/briefs/batch6/README.md`
(decisions (k), (m), (p), path ownership and shared rules are binding),
`.claude/briefs/w2/contract-step.md` (§1.1 `APPEAL_SUBJECTS` `exclusion_group`, §1.3
`appeals.create`, §3 `constants.ts`, §5 the `analytics/appeals.ts` stub), `docs/decisions/0014-attestation-key.md`
decision 4 (re-score past finalize), `docs/product/feature-wins.md` §4.9, the merged
`.claude/briefs/w2/W2-rollup-analytics.md`, `docs/testing/w2-selectors.md` (analytics) and
`.claude/briefs/_done-means.md`. Do not look outside the repository. Work in your own git worktree
on branch `w2/group-appeals`, created from `main` **after wave 1 merged** (rollup included). **Wave
2**, beside W2b-attestations; you share no file. Checked against `8fc2c974`; recheck line numbers.

## Why

A creator whose count dropped sees "120 sessions excluded under datacenter" as one group. If those
were real viewers (a school network, a VPN-heavy audience), they need one way to say so that does
not mean appealing 120 sessions, and an overturn must actually change the numbers: the scorer
never revisits an ended session past finalize (`packages/integrity/src/jobs.ts:215`), so this unit
re-scores the covered sessions itself and makes the rollup and the attestation catch up.

## You own (write only these)

- `services/api/src/analytics/appeals.ts` (stub) and `services/api/tests/group-appeals*.test.ts`
- `packages/integrity/src/rescore.ts` (new) and `packages/integrity/tests/rescore*.test.ts`
- Web: `apps/web/src/components/analytics/group-appeal*` (the rollup unit left a `group-appeal.tsx`
  stub mounted on each excluded-group row)
- i18n: keys under `analytics.groupAppeal.` in `apps/web/src/i18n/locales/{en,es}/w2-analytics.json`
  (handed over from rollup; do not touch its other keys) and the regenerated `keys/w2-analytics.gen.ts`
- Harness: `harness/src/w2/group-appeals.ts` and `harness/tests/w2/group-appeals.test.ts`

Read-only, in particular: `services/api/src/routes/appeals.ts` (`KIND_SUBJECTS` `:87-92`,
`subjectConcerns` `:148`, `create` `:588`, `resolve` `:670`), `packages/integrity/src/{score,allowance,store,types,jobs,constants}.ts`,
`services/api/src/analytics/**` (rollup's), `services/worker/src/jobs/{broadcast-rollup,integrity-attestation}.ts`,
`packages/contracts/**`, `packages/db/**`. You need `routes/appeals.ts` to call you on create and
on an overturn; if the contract step did not wire those two calls, that is a **contract request**
(exact diff in your final message), not an edit.

## Contracts you must honor (read-only for you)

- Subject `exclusion_group` = one exclusion category (`EXCLUSION_CATEGORIES`) within one broadcast,
  kind `integrity`; input `{broadcastId, category}` on `appeals.create`.
- Rollup rows (`broadcast_audience_minutes`, the excluded-group totals the analytics API shows) and
  the 5-session minimum group size; the 24 h display delay.
- Category attribution is the rollup's: a session's category is that of its first exclusion reason.
- Re-runs: the rollup job is re-runnable and emits `analytics.rollup.ready`; the attestation job
  appends a `supersede` only when figures differ.

## Build

1. **Create** (`analytics/appeals.ts`, called from `appeals.create`): the caller owns the broadcast's
   channel; the broadcast is `live` kind, ended, past the 24 h display delay and has a rollup; the
   category's group is shown (≥ 5 sessions; a hidden group is NOT_FOUND, like any subject that does
   not concern the caller). **Rate limit** (decision (m)): at most 1 group appeal per broadcast (any
   category, any status) and 3 per channel per rolling 7 days; serialize the check with a
   transaction-scoped advisory lock on the channel so two concurrent creates cannot both pass;
   refuse with the contract's rate-limit error carrying `retryAfterSeconds`. Store the category as
   the contract step shaped it; no free text from the user in append-only columns.
2. **Overturn** (called from `resolve` with `overturned`, same transaction):
   `rescoreExclusionGroup(tx, {broadcastId, category, decidedAt})` in `packages/integrity/src/rescore.ts`.
   Evidence in Valkey expires after 6 h (`store.ts:28`), so re-score **from stored data**: for each
   ended session of the broadcast whose category is the appealed one, drop that category's signal
   codes from `verdict_reasons`; if no exclusion signal remains, set `verified` (or `pending` when
   `insufficient_heartbeats` / `media_unconfirmed` remain) and append `allowed_on_appeal`; if
   another category's signal remains, keep `excluded` with the reduced reasons (the session moves
   group). Never touch sessions started after `decidedAt`, other broadcasts, or other categories'
   sessions. Write `integrity_flags`/audit rows as the existing overturn path does, and in the same
   transaction the outbox event that makes the worker re-run the rollup (the rollup then emits
   `analytics.rollup.ready`, which drives the attestation re-check → `supersede`). Use the event the
   contract step provides; if none exists, contract request.
3. **Reject**: nothing changes; the appeal still counts against the rate limit.
4. **Web** (`group-appeal*`): on each excluded group with ≥ 5 sessions, an "Appeal this group"
   action opening a `Dialog` that explains what an appeal covers, the limits left this week, and the
   result once decided; disabled with a `Tooltip` reason when rate-limited or already appealed.
   `toast.*` on submit; en + es keys under `analytics.groupAppeal.`; 320 px; keyboard and screen reader.

## Tests you must add

- Unit (`rescore.ts` pure part): one category among several reasons, the only reason, with
  `fetch_unjudged` and `insufficient_heartbeats` present, a session started after the decision, an
  empty group, idempotent second overturn.
- API integration (`createTestDatabase()`): ownership and NOT_FOUND for others; hidden group (4
  sessions) refused; before the 24 h delay refused; 2nd appeal on one broadcast refused; 4th per
  channel in 7 days refused and the 7-day edge allowed; concurrent creates (only one passes);
  overturn changes exactly the covered sessions' verdicts and writes the re-run event; reject
  changes nothing; audit rows hold ids only.
- Harness `harness/src/w2/group-appeals.ts`, `integrity-basic`: a group appeal on the swarm's
  `datacenter` group succeeds, a second on the same broadcast is rate-limited; an admin overturns
  it; after the rollup re-run the group's sessions count as verified and the channel's attestation
  chain gains a `supersede` entry that verifies.

## Done means

Follow `.claude/briefs/_done-means.md`: targeted checks only (`bun --bun vp test run` and
`bun run test:int` in `packages/integrity` then `services/api`, one at a time; `bunx tsc -p` for
each and `apps/web`; `vp lint --deny-warnings` and `vp fmt` on your paths; `vp build`, `bun run
i18n:check` and `bun --bun vp test run tests/i18n.test.ts` in `apps/web`; `bun --bun vp test run`
in `harness`; `reuse lint`). `git status` shows only your paths. Commit with `git commit -s`. Final
message as `_done-means.md`, plus the live command (`bun harness/src/cli.ts run integrity-basic
--set w2=<the group-appeal step name in steps.ts>`).

**Reviewer focus:** the re-score touches exactly the covered sessions; the rate limit holds under
concurrency; the overturn, its event and its audit rows commit together; no thresholds leak.
