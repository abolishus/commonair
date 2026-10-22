<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit E1: harness feature scenarios

You are implementing unit E1 of slice E6 for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, `harness/README.md`, `.claude/briefs/e6/_common.md` and
`docs/testing/e6-selectors.md` (Scenarios) first. Do not look outside the repository. Batch 1
(API, worker, `packages/ui`) is merged on `main`; unit D (web) runs in parallel with you, so
build the web steps against the spec's test ids and keep `--set via=api` working on its own.

## You own (write only these)

- `harness/scenarios/simulcast.ts`, `overlay-alert.ts`, `vod-clips.ts`, `data-export.ts`,
  `account-deletion.ts`
- New helper modules under `harness/src/e6/**` (DB helpers, Mailpit/S3/zip/ffprobe helpers you
  need) and their tests under `harness/tests/e6/**`

Unit E2 owns `harness/src/registry.ts`, `args.ts`, `runner.ts`, `scenario.ts`, `cli.ts`,
`load.ts`, `harness/scenarios/{load-plan,backup-restore,e2e-social,load-smoke}.ts` and
`harness/README.md`. **E2 registers your five scenarios in `full`**: export each with
`defineScenario` under exactly these names: `simulcast`, `overlay-alert`, `vod-clips`,
`data-export`, `account-deletion`. If you need a change in a shared harness file (platform
client, existing DB helpers, the browser driver), report it as a contract request instead of
editing it.

## Build

The five scenarios exactly as the spec's steps, each runnable on its own
(`bun harness/src/cli.ts run <name>`) on the harness stack. Use the ops tick
(`INTERNAL_ROUTES.opsTick`, internal secret) instead of waiting for schedules; retry a
`{ skipped: 1 }`. Reuse existing helpers (ingest via ffmpeg, manual tips + treasurer confirm from
`e4b-money`, role CLI, Mailpit client, DB helper as in `harness/src/safety-db.ts`). Frames
arriving at the mock target: ffprobe `-count_frames` on
`rtmp://localhost:${MOCK_RTMP_PORT:-1936}/live/<key>`. Zip reading: `fflate`. Scanning for PII:
search the archive bytes and the DB columns for exact values (ids, emails, usernames, display
names, message texts generated per run with distinctive random markers). Reports carry ids,
counts and timings only: never a token, key, signed URL or email (redact as the existing
reporters do).

## Tests you must add

Unit tests for every helper (PII scanner, zip reader, ffprobe frame parser, signed-URL tamper,
SSE/overlay waiters) and a dry-run test per scenario if the harness has that pattern.

## Done means

As in `_common.md`. Run `harness` unit tests you added or touched and `bunx tsc -p harness
--noEmit`. The user runs the scenarios against the live stack; give the exact commands.
