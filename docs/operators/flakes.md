<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# The flake log

This page holds R0's "ten green `main` runs" rule (`.claude/briefs/next/R0-release.md`, "Done
means"): before `v0.1.0`, the intermittent CI failures must either recur and be fixed from their
diagnostics, or stay away for ten runs of CI on `main`. Every run of the `ci` workflow on `main`
since batch 8's contract step is listed here, with what failed and whether it was a known flake.

## How a run counts

- **Green:** `ci-ok` passed on the first attempt. Only these count toward the ten.
- **Green on rerun:** the first attempt failed, a rerun passed. It counts only if every failure
  in the failed attempts was a known flake from the watch list below, and that flake's
  "recurred" count goes up by one. A rerun that passes after a real bug was fixed in another
  commit is not green: it is listed as red.
- **Red:** a real failure (a bug in the change, or a test that was wrong). The fix is named.
- **Light:** the push changed no code the harness or the self-host e2e covers, so those jobs were
  skipped (`ci-changes`). A light run does not count: the slow suites, where most flakes live,
  did not run.
- **Cancelled** runs are listed when they ran long enough to show a failure.

The counter resets only for the flake that recurred, not for the others: the rule is per flake.

## Watch list

| Flake                                                                                                | Where                 | First seen                                 | Recurred since the contract step                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `clock-mediamtx.int` "fMP4 times are the SRT timeline"                                               | `services/media`      | batch 7                                    | no                                                                                                                                    |
| `media.int` "T0 live: the synthetic pattern gets the publisher kicked first and one sealed t0 job"   | `services/media`      | batch 7                                    | **yes**: 4 of 4 attempts of 41719827574 (`timed out waiting for source ready in MediaMTX`); fixed by `fix/media-t0-live` (`13bd2f8c`) |
| the moderation ONNX classifier tests                                                                 | `packages/moderation` | batch 7                                    | no                                                                                                                                    |
| "transcode ladder starts above the viewer threshold"                                                 | `services/media`      | batch 7 (fixed as a race once, `a8a95426`) | no                                                                                                                                    |
| a chat-filter timing test                                                                            | `services/chat`       | the batch 7 dispatch run                   | no                                                                                                                                    |
| `ingest-whip` (TTFF)                                                                                 | harness, `rest` shard | R0 (root cause `5e4ce6c`)                  | no                                                                                                                                    |
| `integrity-basic`                                                                                    | harness               | R0                                         | no                                                                                                                                    |
| WebKit `drivers.int` API-mode playback (new candidate)                                               | `harness` integration | 41692011499 attempt 1                      | once (41692011499 attempt 1, passed on rerun)                                                                                         |
| self-host e2e (debian, external, bundled) fails its step after `selfhost e2e passed` (new candidate) | CI `selfhost-e2e` job | 41736761538 attempt 1                      | once (passed on rerun); the failed-log excerpt holds no error, so the cause is not known yet                                          |

## Runs since the contract step

Contract step merged at `6f620512` (2026-11-03). Newest first.

| Run         | Commit     | What it was                       | Result          | What failed, and which known flake recurred                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | ---------- | --------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 41736761538 | `c389b4e7` | wave 1 fixes, the last one        | green on rerun  | Attempt 1: self-host e2e (debian, external, bundled), its End-to-end step failed after the e2e printed `selfhost e2e passed` (a new candidate, above). Attempt 2: all 23 jobs green, harness and e2e included.                                                                                                                                                                                                                                                                                                                                                        |
| 41732483201 | `9a972c35` | wave 1 fixes merged               | red (cancelled) | Attempt 1: verify (integration), `webhooks.int` read a delivery row between two writes; fixed by `801b6a35` (both writes in one transaction). Attempt 2: harness `interact`, `giveaway-verify-mine` looked for the username in the site header; fixed by `c389b4e7`. Real bugs, not flakes.                                                                                                                                                                                                                                                                           |
| 41721879712 | `883fc249` | D wave 1 merged with wave 1       | red             | self-host e2e (debian, external, external): `podman exec … exited 125` creating the CA secrets, fixed by `12ad856e`. Harness `interact` `grace-bet-web` (fixed `dd6438af`), `rest` `data-export` giveaway-section and `w3` `portability` incoming-cleanup inserted rows without an id (fixed `6a34513f`), `rest` `ingest-rtmp` WebKit heartbeats, a check that did not wait for the beat it asserted (fixed `d0da0f8f`), `w3` `federation` actor-disabled-event, a step that never suspended a followed channel (fixed `6a34513f`). New code from wave 1, not flakes. |
| 41719827574 | `d8e6414e` | wave 1 integration                | red (cancelled) | verify (integration), 4 of 4 attempts: `media.int` "T0 live" (watch list) timed out waiting for MediaMTX's source. Four in a row is not a flake at this commit: the test reused a kicked broadcast, fixed by `13bd2f8c`. It is counted as a recurrence all the same, so its counter starts again.                                                                                                                                                                                                                                                                     |
| 41698456414 | `f8569fb5` | D wave 1 merged with the contract | light           | Green; harness and self-host e2e skipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 41698202294 | `edf99b85` | docs                              | light           | Green; harness and self-host e2e skipped.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 41692011499 | `6f620512` | the contract step                 | green on rerun  | Attempt 1: verify (integration), the WebKit `drivers.int` API-mode playback test (PROGRESS, "Batch 8 contract step merged"). Attempt 2: all 22 jobs green.                                                                                                                                                                                                                                                                                                                                                                                                            |

**The count:** no run since the contract step is green on its first attempt with the slow suites
running. Two are green on rerun (41692011499, 41736761538), each after a failure that is now a
watch-list candidate; two are light. `ingest-whip` and `integrity-basic` did not recur in the
three runs where the harness finished (41692011499, 41721879712, 41736761538), and nothing else on
the watch list recurred except `media.int` "T0 live", now fixed. So the rule stands at **0 of 10**
green runs, **3 of 10** clean harness runs for `ingest-whip` and `integrity-basic`, and **0 of 10**
for "T0 live" since its fix.

The earlier history (batch 7 and before, including the batch 7 dispatch run 41365937421, green)
is in PROGRESS.md.

## Keeping it

The orchestrator updates this page after every push to `main`, once its run has finished:

1. List the runs: `gh run list --branch main --workflow ci.yml --limit 20`. Scheduled runs
   (`--event schedule`) and `workflow_dispatch` runs go in the same table, marked as such.
2. For a run with more than one attempt, or a red one, list each attempt's failed jobs:
   `gh api repos/abolishus/commonair/actions/runs/<id>/attempts/<n>/jobs --jq '.jobs[] |
   select(.conclusion == "failure") | .name'`, then the failing test from
   `gh run view --job <job id> --log-failed` (its `FAIL` and `✗` lines).
3. Add a row, newest first: the run id, the short sha, what the push was, the result as defined
   above, and the failing tests with the fix commit or the flake they match.
4. Update the watch list: bump "recurred" for a known flake; add a new candidate when a test
   fails once and passes on rerun with no change. After two recurrences, brief an agent to fix it
   from its diagnostics (HANDOFF: "Rerun once. If one repeats, brief an agent").
5. Update the count. `v0.1.0` waits for ten green runs, or for each flake that recurred to be
   fixed and then stay away for ten runs.
