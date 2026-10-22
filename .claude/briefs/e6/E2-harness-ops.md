<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit E2: harness operations (restore drill, load-plan, full, no-proprietary, SDK bot)

You are implementing unit E2 of slice E6 for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, `harness/README.md`, `.claude/briefs/e6/_common.md`, `docs/testing/e6-selectors.md`
("Backup and restore drill", "Load test", "`full` and the `no-proprietary` profile",
"Scenarios") and ADR 0021 first. Do not look outside the repository. Unit E1 writes five
feature scenarios in parallel (`simulcast`, `overlay-alert`, `vod-clips`, `data-export`,
`account-deletion`); you register them.

## You own (write only these)

- `harness/src/registry.ts`, `harness/src/args.ts`, `harness/src/runner.ts`,
  `harness/src/scenario.ts`, `harness/src/cli.ts`, `harness/src/load.ts`,
  `harness/src/http-viewer.ts`, new modules `harness/src/drill/**` and `harness/src/load/**`
- `harness/scenarios/backup-restore.ts`, `harness/scenarios/load-plan.ts`,
  `harness/scenarios/load-smoke.ts`, `harness/scenarios/e2e-social.ts`,
  and the `inFull` flags of `harness/scenarios/e5-coop.ts`, `trust-safety.ts`, `e2e-relay.ts`
  (only those lines and their comments)
- `harness/tests/**` except `harness/tests/e6/**`, `harness/README.md`

## Build

1. **`backup-restore`**: the drill exactly as the spec (throwaway container from the stack's
   Postgres image on the compose network, own volume, `WALG_S3_PREFIX=s3://<backups>/drill/<runId>`,
   migrate as owner + app role, seed with the demo seed and 20 `@commonair/ledger` postings as the
   app role, fingerprint, `commonair-backup`, WAL marker + `pg_switch_wal`, stop, wipe, empty
   volume, `commonair-restore`, start, wait for promotion, compare, refusal checks as the app
   role, cleanup in `finally` including the S3 prefix). Never touch the stack's own container or
   volume: refuse to run if the computed names collide. Put the fingerprint and compare logic in
   `harness/src/drill/` as pure functions with unit tests that prove a missing trigger, a changed
   function body, a dropped grant, a disabled trigger and an unbalanced transaction each fail the
   comparison. `needs` includes `podman`.
2. **`load-plan`** (not in `full`): `streamers=20 viewersPerStreamer=200 seconds=120
   browserViewers=20`, all `--set`-able; extend `load.ts` with per-streamer viewers, optional
   sharding of HTTP viewers across child processes (`Bun.spawn` of a harness entry point)
   when a single process cannot drive them, and the report fields in the spec (origin egress
   total/per viewer/by source, CPU per container avg/max, p95 glass-to-glass, p95 TTFF, stall
   ratio and count, errors). `load-smoke` keeps 2 × 10 and gains the same report fields.
3. **`full`**: every scenario except `load-plan`, `smoke` first, `e2e-relay` last; set
   `inFull` true (or remove `false`) for `e5-coop`, `trust-safety`, `e2e-relay`; register E1's
   five scenarios by name (import them from `harness/scenarios/<name>.ts`; they land in the same
   merge). Document the harness stack (`bun scripts/infra.ts stack --harness`, fresh Postgres
   volume once with the E5 bootstrap) in `harness/README.md`.
4. **`--profile no-proprietary`**: before running, read the API `/healthz` booleans `stripe`,
   `oauth`, `cdn` and fail the run with a clear message if any is true; skip scenarios and steps
   whose `needs` include `stripe`/`oauth`/`cdn` with the reason in the report; add a step-level
   skip mechanism if none exists (e4b-money's Stripe variant is the expected one); print the skip
   table at the end. Unit-test the selection and the skip reasons.
5. **SDK bot in `e2e-social`**: after the tmi.js `!ping` step, create a bot token
   (`me.bots.createToken`, scopes `chat:read chat:edit`), start `harness/src/bots/sdk-bot.ts`, and
   assert both bots answer `!ping` and the SDK bot's reply carries the bot badge.

## Tests you must add

Unit tests for the drill compare logic (above), load report math (p95, stall ratio, egress per
viewer, sharding split), `full` composition and order, the profile selection/skips, and arg
parsing for the new `--set` keys.

## Done means

As in `_common.md`. Run `harness` unit tests you added or touched and `bunx tsc -p harness
--noEmit`. The user runs the scenarios; give the exact commands (including the harness stack
bring-up).
