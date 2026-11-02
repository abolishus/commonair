<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# B8-harness: shards under the cap, the rate-limit message, and jury reruns

You are implementing unit B8-harness for CommonAir (repo: /Users/joshe/Repos/bcon). Before you
start, read:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch8/README.md`. Decision (o), the follow-ups table, the path ownership and the
  shared rules are binding.
- `.claude/briefs/b8/contract-step.md` §4.3, for the `relay-dvr` scenario and its
  `relay-dvr-switch` step.
- `harness/src/shards.ts`, its comment and the PROGRESS "Batch 7 done" shard times. The dispatch
  run's times: relay 12m18s, clock 13m02s, interact 8m32s and surge 9m25s.
- `harness/scenarios/e2e-relay.ts`, `clock-skew.ts`, `harness/src/w3/steps.ts:169-190` and
  `harness/src/w3/jury.ts`.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 2**: work in your own git worktree, on branch
`b8/harness`, cut from `main` after wave 1 merged. B8-player runs beside you and owns
`harness/src/w3/{watch-rooms,dvr-relay}/**`.

## Why

- **Two shards are each one scenario over the cap.** Decision (o): every harness shard stays under
  about 12 minutes, and a single scenario over it is split or trimmed, not left as an exception.
  `relay` (`e2e-relay`, 12m18s on the dispatch run) and `clock` (`clock-skew`, 13m02s) are over
  (`harness/src/shards.ts:18-20`). Wave 1 also added B8 steps to `interact` and `twitch-import`.
- **`RATE_LIMITED_FORM_ERROR` matches English only** (`harness/src/web/flows.ts:36`), so the
  `en-XA` and `es` runs cannot recognise it.
- **The jury cleanup** after a same-stack rerun only removes panels whose seats are all harness
  members (W3-jury fix report). A rerun on the same stack can leave a panel behind and fail the
  draw.

## You own (write only these)

- `harness/scenarios/{e2e-relay,clock-skew}.ts`.
- `harness/scenarios/relay-dvr.ts` (new).
- `harness/src/web/flows.ts`.
- `harness/src/w3/jury.ts`.
- `harness/tests/b8-harness*` (new).

**Read-only:** `harness/src/{shards,registry,kit,platform}.ts` and `harness/src/{b8,w3}/steps.ts`
(the orchestrator's), `harness/src/w3/{watch-rooms,dvr-relay}/**` (B8-player's), and
`harness/src/seed/**` (decision (p)). Send the `shards.ts` and `registry.ts` changes as **exact
diffs** in your final message; the orchestrator applies them at merge.

## Build

1. **Split `e2e-relay`.**
   - `e2e-relay` keeps the relay base: register, heartbeat, live playback through the relay, and
     receipts.
   - The new `relay-dvr` takes DVR through the relay, the purge feed, `.vtt`, and B8-player's
     `relay-dvr-switch` (contract §4.3).
   - Move the W3 extensions `dvr-relay`, `dvr-purge` and `relay-vtt` to `relay-dvr`. The
     `W3_EXTENSIONS` change in `w3/steps.ts` is the orchestrator's, so send the diff.
   - No step may be lost. Write a test that lists every step name before and after, from the
     scenario modules, and checks that the union is unchanged.
   - Each new scenario must stand up its own prerequisites. `relay-dvr` cannot assume `e2e-relay`
     ran first, so share the relay setup through a function in the scenario files.
   - Propose shards: `relay: ["e2e-relay"]` and `relay-dvr: ["relay-dvr"]`, or pair one of them
     with a short scenario, with the numbers.
2. **Trim `clock-skew`** under the cap.
   - It holds a broadcast through a transcode ladder restart (`shards.ts` comment). Find the waits
     that are fixed sleeps or generous timeouts and replace them with waits on the event they stand
     for: the renditions event, as the `a8a95426` race fix did.
   - Keep every assertion. If it cannot get under about 11 minutes without dropping a check, split
     it the same way as `e2e-relay` and say why.
3. **Re-measure the B8-touched scenarios.** Use the dispatch-run job logs on `main` after wave 1,
   with `gh run view` and the job step durations, for `interact`, `twitch-import` (in `w3`),
   `e4b-money`, `trust-safety` (`long`) and `e5-coop` (`features`). Propose a `shards.ts` layout
   that keeps every shard under about 12 minutes once wave 2's steps land. Your diff to `shards.ts`
   carries the new times in its comment.
4. **The rate-limit message through the catalog.**
   - Replace the English regex with the message from the web catalog for the run's locale. Read
     `error.rateLimited` from `apps/web/src/i18n/locales/<locale>/core.json`, and for `en-XA`
     apply the pseudo-locale transform the web uses.
   - Escape it as a literal, with its `{placeholders}` turned into wildcards.
   - Fall back to the test id or ARIA state the form uses for the error, if there is one; prefer
     that over text.
5. **Jury cleanup on reruns** (`harness/src/w3/jury.ts`).
   - Before the jury step, remove the harness's own panels and their cases, seats and votes,
     identified by the harness's panel marker, not by "every seat is a harness member".
   - Append-only rows (`jury_votes`) cannot be deleted through the app role. Use the test hook W3-jury
     added, or ask for one as a contract request with the exact diff. Never touch a panel the
     harness did not create.

## Edge cases

- **`relay-dvr` alone on a fresh stack:** it passes without `e2e-relay` before it.
- **`clock-skew` on a slow runner:** event-based waits keep a ceiling timeout, so a hang still fails.
- **The rate-limit lookup** for a locale without the key falls back to `en`, with a warning.
- **The jury cleanup on a stack where a real (non-harness) panel exists:** it leaves that panel
  alone.

## Tests you must add

- **`harness/tests/b8-harness.test.ts`:**
  - the step-union test for the split;
  - the rate-limit pattern for `en`, `es` and `en-XA`, matched against the catalog strings;
  - the jury cleanup selector chooses only harness panels, against fixture rows.
- **A typecheck of the new scenario module**, and `registry` and `shards` tests passing with your
  diffs applied locally. Revert them before you commit, because those files are the orchestrator's.

## Reviewer focus

- Every shard is under about 12 minutes, with numbers from a real run.
- No step was lost in the split, and each scenario runs alone.
- The jury cleanup touches only harness rows.
- The rate-limit match works in every run locale.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun --bun vp test run` in `harness`;
- `bunx tsc -p harness`;
- `vp lint --deny-warnings` and `vp fmt`;
- `reuse lint`.

`git status` shows only your paths. Commit with `git commit -s`.

Your final message gives the `shards.ts`, `registry.ts` and `w3/steps.ts` diffs, and the measured
or estimated time per shard. Then tell the user to run each shard as CI does, for example:

```bash
bun run verify --full --only harness --shard relay-dvr
```
