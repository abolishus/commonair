<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **shared safe-regex + chat filter hardening** for CommonAir (repo:
/Users/joshe/Repos/bcon). Read AGENTS.md, HANDOFF.md ("Open items"), PLAN.md and
docs/architecture.md first. Do not look outside the repository. You work in your own git worktree:
run `git merge main --no-edit` first.

## You own (write only these)

- `packages/safe-regex/**` (just moved there from `services/api/src/lib/safe-regex.ts`; the API
  imports `unsafeFilterRegexReason` and `MAX_PATTERN_LENGTH` from it — keep those exports)
- `services/chat/**`

## Contracts you must honor (read-only for you)

- `packages/contracts` (chat protocol), `packages/db` (`chat_filters` or equivalent table),
  `packages/config`. Another unit is editing `services/api` in parallel: do not touch it.

## Build (each with tests)

1. **Fix the cost model** (`packages/safe-regex/src/index.ts`). Review finding: an unbounded repeat
   is weighted as a constant 32 instead of growing with input length, and total cost is not capped
   across top-level alternatives, so `.*.{0,20}!|…` repeated ~18 times costs 40–120 ms per message.
   Make the model sound: treat an unbounded repeat whose character set overlaps a following
   variable element as O(n) per start position (refuse such chains unless separated by a
   disjoint required element), and cap the **sum** of costs over top-level alternatives (and over
   alternatives inside groups). Keep realistic filter patterns accepted. Add a benchmark-style unit
   test: every accepted pattern from a generated adversarial corpus (incl. the `.*.{0,20}!|…` ×18
   case) must run over a 500-char worst-case message in < 5 ms with `giu` flags.
2. **Chat uses the shared validator**: replace `unsafeRegexReason` in `services/chat/src/content.ts`
   with `unsafeFilterRegexReason` from `@commonair/safe-regex` (already a dependency of
   `@commonair/chat`), so patterns saved before the API's stricter check are **re-validated on
   load** in `compileFilters` and skipped (reported via `onInvalid`) if refused.
3. **Hard timeout**: keep the per-message `FILTER_BUDGET_MS` budget, and additionally make sure one
   single `RegExp.exec` cannot exceed it unbounded. Either run filter evaluation in a Bun `Worker`
   with a hard timeout (terminate + respawn; the message is held, never passed) or justify in the
   README why the validator makes it unnecessary, with the benchmark test as evidence. Prefer the
   Worker if it keeps p99 filter latency under 2 ms for typical filter sets — measure and report.
4. Update `services/chat/README.md` for the filter pipeline and the round-two behavior noted in
   PROGRESS.md (README for round-two behavior).

## Tests you must add

- `packages/safe-regex/tests`: catastrophic corpus refused (existing + new cost-model cases),
  realistic patterns accepted, timing test above.
- `services/chat/tests`: a stored pattern the validator refuses is skipped with `onInvalid`; the
  timeout path holds the message.

## Done means

- `bun run verify --quick` passes and `cd services/chat && bun run test:int` passes (data services
  are up at the `.env.example` defaults; do not run `podman compose`).
- No files outside your ownership list changed (`git status`).
- Commit in your worktree with `git commit -s` (Conventional Commits), ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, only when the gate is green (check
  the exit code).
- Final message: what you built, test counts, measured latencies, branch + commit sha, contract
  requests, anything left undone.
