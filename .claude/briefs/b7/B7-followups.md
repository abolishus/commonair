<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# B7-followups: batch 6 loose ends (re-score threshold, statements for resolve/suspend, rehearsal samples, clause locale)

You are implementing unit B7-followups for CommonAir (repo: /Users/joshe/Repos/bcon). Read these
first:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch7/README.md`. Decision (g), "Batch 6 follow-ups", the path ownership and
  the shared rules are binding.
- `.claude/briefs/w3/contract-step.md`:
  - §2.1 `ENFORCEMENT_SOURCE_ACTIONS` gains `report.resolve`, `user.suspend` and `channel.suspend`.
  - §2.6 `KEYS.rehearsalModerationSamples`.
  - §5.6 the widened media Valkey seam.
- PROGRESS.md: the batch 5 and batch 6 "Open" lists.
- ADR 0014 decision 4 (re-score) and ADR 0019 (statements of reasons).
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 2**. Work in your own git worktree on branch
`b7/followups`, cut from `main` after wave 1 merged.

## You own (write only these)

- `packages/integrity/src/rescore.ts` and its tests
- `services/worker/src/moderation/sor-{build,schemas}.ts` and their tests
- `services/api/src/transparency/enforcement.ts` (only `modActionCells`)
- the `report.resolve`, `user.suspend` and `channel.suspend` audit-detail lines in
  `services/api/src/routes/safety.ts` (around `:416` and `:581`)
- `services/media/src/moderation/moderation.ts` (only the sample count)
- `services/worker/src/jobs/rehearsal-driver.ts` (only the report field)
- `services/api/src/routes/me-enforcement.ts` (the locale)
- `harness/src/w2/{group-appeals,enforcement}.ts` and `harness/src/w2/rehearsal/**`
- tests named after these files

Read-only: everything else. Anything else is a **contract request**. In particular, a contract
field such as `RehearsalReport.moderation.samples` belongs to the contract step. If the contract
step did not add it, request it.

## Build

1. **Re-score threshold (decision (g)).** `rescore.ts` currently keeps a session excluded if any
   signal remains after an overturn. Change it to remove the overturned category's signals,
   re-run the scorer's exclude decision (the same threshold and weights as the live scorer; import
   the scorer, don't copy it), and keep the session excluded only if the remainder still crosses
   the threshold. A session that falls below the threshold becomes verified, and the rollup and
   `supersede` follow as today.
2. **Statements for `report.resolve` and suspensions.**
   - The audit rows for a report resolve with an action, and for `user.suspend` /
     `channel.suspend`, must carry what `sor-build` needs. That is the `clauseId` the W2 contract
     step made required, the ground, and the facts reference, with ids only.
   - Add `SOR_DETAILS` schemas and the statement builder for these actions (`sor-build.ts`
     `planStatements` `:144`).
   - A resolve that only dismisses, and an unsuspend, write no statement. Follow
     `expectsStatement`.
   - `modActionCells` (`enforcement.ts:395-434`) must then exclude platform actions that now have
     a statement, so nothing is double-counted. Test that it doesn't.
3. **Rehearsal moderation sample count.**
   - Media's frame scan increments `KEYS.rehearsalModerationSamples(broadcastId)` for rehearsal
     broadcasts only, with a TTL that matches the rehearsal report's (24 h). Use the widened seam
     (`incr`/`expire`).
   - The rehearsal driver reads it into the report's moderation section.
4. **Clause titles by locale.** `me-enforcement.ts` reads clause titles from the email `en`
   catalog. Use `resolveCatalog(member.locale)` (batch 5 open item).

## Tests you must add

- **`rescore.ts`, unit (exhaustive):**
  - one category overturned: the remainder is below the threshold, then above it;
  - several categories overturned;
  - an overturn of a category the session never had;
  - threshold edges.
- **`rescore.ts`, integration:** a group appeal overturn moves the sessions that now fall below the
  threshold, and keeps those that still cross it.
- **SoR, unit and integration:**
  - a statement is written for an actioned report resolve, for a user suspend and for a channel
    suspend;
  - none for a dismiss or an unsuspend;
  - `modActionCells` drops the counted ones;
  - the transparency report's totals are unchanged except for the moved rows.
- **Media integration:** the counter rises for rehearsal frames and never for live ones.
- **Rehearsal driver:** the report shows the count.
- **`me-enforcement`:** an `es` member gets Spanish clause titles.
- **Harness:**
  - Update the `integrity-basic` `group-appeal` expectation to the threshold rule. Use the seeded
    multi-category viewbots: a session left with only a sub-threshold signal is verified after
    the overturn.
  - `trust-safety` `enforcement` (the `sor-resolve` extension): a report resolved with a suspend
    has a statement.
  - `rehearsal`: the report's moderation sample count is > 0.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun run test` / `test:int` in `packages/integrity`, `services/worker`, `services/api` and
  `services/media` (one `test:int` at a time); `bunx tsc -p` each.
- `bun --bun vp test run` in `harness`.
- `vp lint --deny-warnings` and `vp fmt`; `reuse lint`.
- `git status` shows only your paths; commit with `git commit -s`.

Then tell the user to run `bun harness/src/cli.ts run integrity-basic --set
w3=group-appeal-threshold`, `trust-safety --set w3=sor-resolve` and `rehearsal --set
w3=moderation-samples`.
