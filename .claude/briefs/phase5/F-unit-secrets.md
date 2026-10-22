<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit F: each unit sees only the secrets it needs

You are implementing unit F of the Phase 5 follow-up for CommonAir (repo:
/Users/joshe/Repos/bcon; you work in your own git worktree, branched from the base the
orchestrator names). Read AGENTS.md, PLAN.md "Phase 5", `.claude/briefs/phase5/_common.md`,
ADR 0023, ADR 0024, `docs/self-hosting/configuration.md` and `docs/self-hosting/backups.md`
first. Do not look outside the repository.

## The problem

Every Quadlet unit has `EnvironmentFile=%h/.config/commonair/commonair.env`, and most compose
services use the shared `env_file`. So Caddy, MediaMTX, Grafana, Garage, Loki, Tempo,
Prometheus, the OTel collector and Valkey all receive the database passwords, the session and
signing keys, the S3 keys and the evidence keys. A compromise of any internet-facing
third-party process leaks everything.

## You own (write only these)

- `infra/quadlet/*.container` (the env lines only, plus any `ExecStartPre=` you add)
- `scripts/selfhost.sh` (env-file writing and rendering; keep everything else as is)
- `scripts/selfhost/**` except `e2e.ts`, where you may only add checks (see Tests)
- new files under `infra/selfhost/` or `scripts/selfhost/` for the per-unit key lists
- `compose.yaml`: `env_file`/`environment` of each service, and `x-app-env`/`x-env-file`
  anchors
- `infra/tests/compose.test.ts` (the "Quadlet mirror" block and any env assertions),
  new `infra/tests/*env*.test.ts`, `scripts/tests/selfhost*.test.ts`
- `packages/config/src/env.ts`: JSDoc only, and only if a variable's "set in the units" note
  changes; then regenerate `docs/self-hosting/configuration.md` with
  `bun scripts/config-reference.ts` (you may edit `scripts/config-reference.ts` if its "set in
  the units" column must learn the new layout)
- docs: `docs/self-hosting/configuration.md` (prose), `backups.md` (its `--env-file` lines),
  `troubleshooting.md`, `upgrades.md`, `infra/README.md`
- removing the unused `MEDIAMTX_RTMP_URL` everywhere it is set: compose, the units,
  `.env.example`, `packages/config/src/env.ts` (the schema entry), `.railway/railway.ts`, and
  the generated reference. First prove with `git grep` that no code reads it.

## Contracts you must honor (read-only for you)

- `commonair.env` stays the operator's single source of truth: one file to edit, back up and
  restore (backups.md tells operators to keep an offline copy). Whatever you derive from it must
  pick up an operator's edit on the next `systemctl --user restart <unit>` or the next
  `selfhost.sh upgrade`, and the docs must say which.
- The services read their env through the Zod schemas in `packages/config/src/env.ts`
  (`apiEnv`, `workerEnv`, … composed from `coreEnv`, `databaseEnv`, `storageEnv`, …). A
  service must still receive every variable its schema reads; derive the per-service key lists
  from those schemas (and a test must fail when a schema gains a variable a unit does not get).
- Third-party units get only what their images read (check each image's docs/entrypoint):
  Postgres (`POSTGRES_PASSWORD`, WAL-G's S3 settings), Garage (its RPC secret, admin token),
  Grafana (admin password), MediaMTX (its `MTX_*` settings and the auth hook URL), Caddy
  (`PUBLIC_HOSTNAME`, `TLS_MODE`, `ACME_*`, `S3_BUCKET_MEDIA`, `S3_BUCKET_EXPORTS`), and so on.
- Prefer files generated with mode 0600 in `~/.config/commonair/` (or podman `Secret=` where
  it is simpler); `selfhost.sh` is POSIX sh, shellcheck-clean, with no Bun on the host (the
  tools image has Bun). A plain `grep -E '^(KEY|KEY)=' commonair.env > unit.env` step run as
  `ExecStartPre=` in each unit is acceptable and keeps operator edits effective on restart; if
  you choose it, make the key lists data files shipped in the bundle, and make the step fail
  closed (a unit must not start with an empty or stale env when the source is unreadable).
- ADR 0023 §10 restart rules; the bundle layout (`scripts/selfhost/bundle.ts`), whose tests
  must keep passing; Podman 4.9 compatibility for every Quadlet key (CI runs the e2e there).
- Compose keeps working for development: `podman compose up` with a single `.env`. Mirror the
  split there so third-party services no longer get `env_file`; app services may keep the
  shared file in development if mirroring per-service lists in compose would be unmaintainable
  — say which you chose and why, and keep the "Quadlet mirror" test meaningful.
- Do not edit `scripts/verify.ts`, `package.json`, `bun.lock`, `infra/containers/**`,
  `REUSE.toml`, `infra/caddy/Caddyfile`. Report contract requests instead.

## Tests you must add

- For every unit, the derived env contains every key its service schema reads and no key
  outside its list; third-party units contain no `*PASSWORD*`, `*SECRET*`, `*_KEY*` or
  `DATABASE_URL`-style key except the ones they need (allowlist in the test).
- The rendering step: a key list renders exactly those keys from a sample env, preserves values
  with `=`, quotes and spaces, fails closed on an unreadable source, and writes mode 0600.
- Compose: third-party services have no shared `env_file`.
- e2e additions (cannot be run by you; must type-check): after install, `podman exec
  commonair-caddy env` has no `DATABASE_URL`, `POSTGRES_PASSWORD`, `SESSION_*` or `S3_SECRET*`;
  `commonair-api` has `DATABASE_URL`.

## Done means

- `bun run verify --quick` passes, plus `cd infra && bun --bun vp test run tests/compose.test.ts`
  and your new tests, `cd scripts && bun --bun vp test run`, `bun scripts/config-reference.ts
  --check`, and shellcheck on `scripts/selfhost.sh`. Do not run the self-host e2e.
- No files outside your ownership list changed.
- Commit on your branch: Conventional Commits, `git commit -s`, trailer
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Final message: the design and why, test counts, contract requests, anything left undone.
