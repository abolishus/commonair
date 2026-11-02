<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# S1-b external: `selfhost.sh` on an external Postgres and Valkey

You are implementing unit S1-b for CommonAir (repo: /Users/joshe/Repos/bcon). Before you start,
read:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch8/README.md`. Decisions U4, U5, (a) and (q), "What U4 changes", the path
  ownership and the shared rules are binding.
- `.claude/briefs/b8/contract-step.md`: §1 (the no-superuser test, the monitor role and the
  owner-only restore) and §3.7 (the secret and env names you write).
- ADR 0032 §3 (`docs/decisions/0032-scaling-and-availability.md:113-140`) and its table of
  DigitalOcean's limits (`:56-64`). ADR 0004 (the non-owner app role), ADR 0025 and ADR 0022.
- `.claude/briefs/r0/R0-b-s3-ext.md`. That unit built `--s3-*` the same way, so follow its pattern.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 1**: work in your own git worktree, on branch
`s1/b-external`, cut from the contract step's sha. L1-observability runs beside you and reads the
names you write (contract §3.7).

## Why

U4: our own instance launches on DigitalOcean Managed PostgreSQL and managed Valkey. ADR 0032 §3
gives every operator the same option, with no provider special-cased. So the external path is the
path production runs on, and it is **launch-critical**.

**The bundled Postgres and Valkey stay the default, with full support** (the user, 2026-11-02).
U4 is about how we deploy our instance, not about `selfhost.sh`. External state is an added option,
as `--s3-*` is beside bundled Garage. Every change you make must leave a bundled install, upgrade,
`status` and rollback working exactly as today, and both modes are tested in CI. Today the option parser
(`scripts/selfhost.sh:1627-1688`) knows only the `--s3-*` external flags. The Postgres and Valkey
secrets (`:1257-1276`) and `DATABASE_URL` (`:955`) always point at the bundled containers.

## You own (write only these)

- **`scripts/selfhost.sh`, except the backup section.** You own `usage`, `parse_flags`,
  `configure_env`, `valkey_env`, `backfill_env`, `create_secrets`, `unit_in_mode`,
  `install_units`, `start_migrate`, `cmd_install`, `cmd_upgrade`, `cmd_status` and the helpers
  they call. The backup section, `parse_backup_flags` through `cmd_backup` (`:1880-2265`), is
  S1-h's in wave 2. Do not edit it.
- **`scripts/selfhost/**`**, except `e2e-backup*`, `e2e-dump*`, `selfhost-backup.test.ts` and
  `e2e-metrics.ts` (L1-observability's). You own `e2e.ts`, `units.ts`, `render*`, and the new
  `e2e-external.ts` and `selfhost-external.test.ts`.
- `infra/selfhost/**`.
- `infra/quadlet/commonair-{postgres,valkey,migrate}*`.
- `infra/tests/selfhost-external*` (new) and `infra/tests/selfhost-e2e-variants.test.ts`.
- `docs/self-hosting/{configuration,requirements,scaling}.md`.

**Read-only:** `packages/db/**`, `infra/postgres/**` (contract part (A)), `.github/**` and
`compose.yaml`. Anything else is a **contract request**. That includes the CI matrix entry for the
external variant: send it as an exact diff of `.github/workflows/ci.yml:302-352`.

## Contracts you must honor

- **The roles.** `infra/postgres/{app-role,monitor-role}.sql` and `apply-app-role.ts` are applied by
  the owner role in the operator's URL. That URL's role needs `CREATEROLE`, and no superuser.
- **The names** in contract §3.7: the secrets `commonair-pg-monitor-password`,
  `commonair-valkey-monitor-password`, `commonair-pg-ca` and `commonair-valkey-ca`, and the
  `PG_MONITOR_*`, `VALKEY_MONITOR_*` and `OBSERVABILITY_STATE_MODE` keys.
- **Client TLS** (contract §1.4): `DATABASE_CA_FILE` and `VALKEY_CA_FILE` make the services verify
  a private CA. Every service unit that opens a pool mounts the CA secret when it is set.
- **Decision (q).** No new image. The external containers in the e2e use the images the stack
  already pins.

## Build

1. **Flags.**
   - `--database-url <url>`: the owner's URL. It must say `sslmode=verify-full`.
   - `--database-ca <file>`: copied into `commonair-pg-ca` and mounted where `DATABASE_CA_FILE`
     points (contract §1.4). Without it, the system trust store is used.
   - `--valkey-url <rediss://…>` and `--valkey-ca <file>` (`commonair-valkey-ca`, `VALKEY_CA_FILE`).
   - `--allow-insecure-database` and `--allow-insecure-valkey`, for a private network only. They
     print a warning and are recorded in `commonair.env`, the way `--s3-allow-http` works.
   - Passwords are never flags, because every user can read a command line (`ps`). Refuse
     `postgres://user:pass@` on the command line exactly as `--s3-*key*` is refused (`:1675-1679`).
     The URL carries the user and host only, and the password comes from `DATABASE_PASSWORD` and
     `VALKEY_PASSWORD` in the environment, or from a prompt at a terminal.
2. **Install with external state.**
   - Do not install `commonair-postgres*` or `commonair-valkey*` units (`unit_in_mode`).
   - Remove the `After=`/`Requires=` edges on them from the other units' drop-ins, the way the
     external S3 path drops Garage.
   - Write `DATABASE_URL` (the app role) and the owner URL as secrets, as today.
   - Create the app and monitor roles by running `migrate` with the owner.
   - Generate the monitor passwords.
   - Set the §3.7 keys with `OBSERVABILITY_STATE_MODE=external`.
3. **Preflight, before anything is installed.** Each failure is a `die` with a `fix:` line:
   - TLS verifies against the CA. Use the tools image's `psql`, with `sslmode=verify-full`.
   - The owner has `CREATEROLE` and is not a superuser. A superuser is a warning, not an error.
   - The server version is 17 or 18 (ADR 0032 §3).
   - `max_connections` covers `DATABASE_POOL_MAX` (default 10, `packages/config/src/env.ts:93`)
     times the services that open a pool, plus `migrate` and 3 spare. DigitalOcean allows few
     connections on small nodes, so print both numbers and the fix: a bigger node, or a smaller
     `DATABASE_POOL_MAX`.
   - Valkey answers `PING` over TLS with the password, and its `maxmemory-policy` is `noeviction`.
     Read the policy with `INFO`, not `CONFIG GET`, because DigitalOcean restricts `config`
     (ADR 0032 `:63`).
4. **No `CONFIG` or `ACL` at runtime** (ADR 0032 §3). Prove it in the e2e: run Valkey with an ACL
   user whose rules deny `+@admin` and `+@dangerous`, run the stack through a job cycle, and check
   that nothing failed. Record any command BullMQ or our clients needed in
   `docs/self-hosting/requirements.md`.
5. **`upgrade`** keeps the choice from `commonair.env`. It never installs the bundled units, runs
   `migrate` exactly once with the owner URL, and re-runs the role scripts (they are idempotent).
6. **`status`** covers both modes. For bundled state it reports the units as today. For external
   state it checks the remote, through the same tools image:
   - Postgres reachable, TLS verified, the server version;
   - connections used against `max_connections`;
   - Valkey `PING`;
   - each with how long it took.
     It reports "external" instead of a unit state.
7. **Switching is refused (decided).** Moving an existing instance from bundled to external, or
   back, is a data migration, not a flag.
   - Refuse it with a clear message, the way `refuse_repoint` (`:1109`) refuses S3. The message
     names the current mode, the requested one, and the procedure to follow.
   - Point to the manual dump-and-restore procedure in `docs/self-hosting/managed-services.md`.
     S1-h writes it in wave 2; link it now.
   - Supporting a switch in place is out of scope for batch 8.
8. **The e2e external variant** (`scripts/selfhost/e2e-external.ts`, wired into `e2e.ts` with
   `--state external`). It starts, each outside the instance's network:
   - a Postgres 17 container with TLS and a no-superuser `CREATEROLE` owner, as in contract §1.1;
   - a Valkey container with TLS and two users: an ACL user, and the password-only default user,
     which is DigitalOcean's model since it has no ACL users;
   - Garage as the external S3, as R0-b's `--storage external` does.
     Then it runs install, the §3 preflight, upgrade (`migrate` ran once), `status`, a worker restart,
     and a rollback. It checks that no bundled Postgres or Valkey unit exists.
9. **Docs.**
   - `configuration.md`: the flags, the env, the secrets, and the §3.7 table.
   - `requirements.md`: the external Postgres and Valkey requirements from ADR 0032 §3, plus the
     connection budget.
   - `scaling.md`: that stage 1 is what our instance runs at launch, and that the bundled install
     is the default for everyone else.
   - Present bundled first everywhere, and external as an option.

## Edge cases

- A URL with `sslmode=require` (no verification) is refused without the insecure flag.
- A password with URL-reserved characters gets percent-encoding round-trip tests.
- An IPv6 host literal is accepted.
- A CA file that is not PEM is refused.
- An expired or wrong CA fails the preflight with the certificate subject named.
- A missing `CREATEROLE`: the preflight names the `ALTER ROLE` the operator must ask for.
- Valkey with eviction on is refused, because BullMQ requires `noeviction`.
- `upgrade` on a host where the operator deleted `commonair-pg-ca` re-prompts for it rather than
  silently dropping TLS.
- No secret appears in a unit file, in `commonair.env`, in a log line, or in `status` output.
  Test that.

## Tests you must add

- **Shell unit tests** (`scripts/selfhost/selfhost-external.test.ts`), in the style of
  `selfhost-s3.test.ts`:
  - each flag and its refusal;
  - the password-on-command-line refusal;
  - the env and secret writes, including the §3.7 keys for bundled and external installs;
  - `unit_in_mode` with external state;
  - `upgrade` keeping the mode;
  - the switch refusal.
- **`infra/tests/selfhost-external.test.ts`:**
  - the rendered units have no dependency on a bundled Postgres or Valkey unit in external mode;
  - the bundled mode's rendered units are byte-identical to `main`'s, apart from the §3.7 keys.
- **The bundled e2e** (`--state` absent, the default) must still pass unchanged. CI keeps running
  it, and your matrix row adds the external variant beside it, not instead of it.
- **The e2e external variant**, run locally only if it is fast enough to be a targeted check. CI
  runs it once the orchestrator adds your matrix row.

## Reviewer focus

- TLS is really verified (`verify-full`, `rediss://`), and the insecure flags are explicit and
  recorded.
- No bundled unit is installed for an external service, and no unit orders after one.
- `upgrade` keeps the choice and runs `migrate` once.
- Bundled stays the default, and a bundled install, upgrade, `status` and rollback behave exactly
  as before.
- Switching modes is refused with a clear message.
- No secret is in a unit file, in a log or on a command line.
- The connection budget is checked, and the preflight never writes anything.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun --bun vp test run scripts/selfhost infra/tests`;
- `shellcheck scripts/selfhost.sh`, as CI runs it (`ci.yml:97`);
- `vp lint --deny-warnings` and `vp fmt` on your files;
- `reuse lint`.

`git status` shows only your paths. Commit with `git commit -s`.

Your final message lists:

- the CI matrix diff (a contract request);
- any `compose.yaml` change you need;
- the commands BullMQ needed, if any;
- the exact command for the user or the agent track to run the external variant:
  `sudo bun scripts/selfhost/e2e.ts --distro debian --state external`.
