<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit D: Postgres survives a long WAL replay after a restore

You are implementing unit D of the Phase 5 follow-up for CommonAir (repo:
/Users/joshe/Repos/bcon; you work in your own git worktree of it, branched from `main`). Read
AGENTS.md, PLAN.md "Phase 5", `.claude/briefs/phase5/_common.md`, ADR 0023 (§10 restart rules),
and `docs/self-hosting/backups.md` first. Do not look outside the repository.

## The problem

After `commonair-restore` (infra/postgres/restore.sh) prepares an empty data directory with a
base backup and `recovery.signal`, the next Postgres start replays the archived WAL before it
accepts connections. `infra/quadlet/commonair-postgres.container` gives that start limited time:

- `HealthCmd=pg_isready …` with `HealthStartPeriod=30s`, `HealthRetries=10`, `HealthInterval=10s`
  and `HealthOnFailure=kill`: after about two minutes of "rejecting connections" the container
  is killed, and `Restart=always` starts it again, so a long replay never finishes;
- `Notify=healthy` with `TimeoutStartSec=300`: systemd fails the start after five minutes.

`docs/self-hosting/backups.md` works around it with a manual `podman run … commonair-replay`
procedure. Remove the need for it.

## You own (write only these)

- `infra/postgres/**` (you may add a health script and `COPY` it in the Containerfile)
- `infra/quadlet/commonair-postgres.container`
- in `compose.yaml`: only the `postgres` service's `healthcheck` block (keep compose and the unit
  equivalent; `infra/tests/compose.test.ts` has a "Quadlet mirror" test that must stay green —
  you may edit only the assertions in it that cover Postgres health)
- `docs/self-hosting/backups.md` ("Restore" section) and `docs/self-hosting/troubleshooting.md`
  (only a Postgres-replay entry, if one is useful)
- new tests: `infra/tests/postgres-health*.test.ts` / `*.int.test.ts`

## Contracts you must honor (read-only for you)

- ADR 0023 §10: `Restart=always`, `RestartMode=direct`, `RunInit=true`,
  `StartLimitIntervalSec=0`, `HealthOnFailure=kill`, dependents use `Wants=`/`After=` on
  long-running units and `Requires=` only on the one-shots. `commonair-migrate` starts after
  Postgres is healthy and must never hang forever behind a Postgres that will not come up
  (a past review HIGH).
- `infra/postgres/restore.sh` and `entrypoint.sh` behaviour (restore into an empty directory,
  `recovery.signal`, `RECOVERY_TARGET_TIME`).
- Target hosts run Podman 5.4+ (Debian 13, Fedora 42+). CI's e2e runs Podman 4.9 (ubuntu-24.04):
  any Quadlet key or `podman run` flag you rely on must exist there too, or the unit must still
  load and behave sanely without it. Check the man pages of the versions you rely on.

## Build

- "Healthy" keeps meaning "accepts connections": dependents (migrate, api, worker, …) must still
  start only once Postgres accepts connections.
- A Postgres that is replaying WAL and **making progress** is never killed by its health check
  and never fails its start for taking long. Recovery progress is observable (for example the
  replay LSN from `pg_controldata`/`pg_last_wal_replay_lsn()` once connections are allowed in
  hot standby, or the startup process's title `startup recovering <segment>`); pick something
  that works before the database is consistent.
- A Postgres that is **stuck** (no replay progress and not accepting connections for a bounded
  time, say 10 minutes; or not starting at all) is still killed and restarted, so the
  "never hangs forever" rule holds. Document the bound.
- A normal start (no `recovery.signal`) behaves as today: unhealthy after about two minutes →
  killed → restarted.
- Options to evaluate, and say in a comment why you chose one: Podman startup health checks
  (`HealthStartupCmd`, `HealthStartupRetries`, `HealthStartupInterval`, … — check Quadlet and
  Podman 4.9 support), a recovery-aware `HealthCmd` script, `TimeoutStartSec=` changes. Avoid
  `TimeoutStartSec=infinity` unless something else bounds a stuck start.
- Replace the manual replay procedure in `backups.md` with what an operator does now (likely:
  nothing, plus how to watch progress in the journal). Keep the docs plain and short.

## Tests you must add

- Unit tests that assert the unit's health and timeout keys and the compose mirror.
- An integration test (`*.int.test.ts`, needs podman; build the postgres image as
  `infra/tests/*.int.test.ts` do elsewhere, or reuse a helper there) that runs the health script
  against a real Postgres in three states: accepting connections (healthy), in recovery with a
  `restore_command` that is deliberately slow but advancing (not killed / reported as
  progressing), and stuck (reported failing after the bound; shorten the bound through an env
  variable for the test).
- Shell scripts you add pass `shellcheck` (CI runs it on scripts; see `.github/workflows/ci.yml`
  `lint-workflows` for the exact invocation).

## Done means

- `bun run verify --quick` passes, plus `cd infra && bun --bun vp test run` for your new
  integration test(s) and `tests/compose.test.ts`. Do not run the self-host e2e.
- No files outside your ownership list changed (`git status`).
- Commit on your branch with Conventional Commits, `git commit -s`, and the trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Final message: what you built and why that design, test counts, any contract requests
  (exact changes in files you do not own), and anything left undone.
