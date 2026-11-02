<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# S1-h backups-ext: logical dumps, the dump drill and `managed-services.md`

You are implementing unit S1-h for CommonAir (repo: /Users/joshe/Repos/bcon). Before you start,
read:

- AGENTS.md, PLAN.md and docs/architecture.md.
- `.claude/briefs/batch8/README.md`. Decisions U4, U5 and (a), "What U4 changes", the path
  ownership and the shared rules are binding.
- `.claude/briefs/b8/contract-step.md`:
  - §1.3 (the owner-only restore: `infra/postgres/restore-owner.sql` and its five steps);
  - §1.4 (client TLS);
  - §3.7 (the names).
- ADR 0032: §3 and §4 (`:113-157`), "Consequences" (`:188-199`), and part (A)'s amendment.
- `.claude/briefs/r0/R0-c-backups.md` and `docs/self-hosting/backups.md`, for the existing WAL-G
  and object backup paths.
- `.claude/briefs/s1/S1-b-external.md`, merged in wave 1.
- `.claude/briefs/_done-means.md`.

Do not look outside the repository. This is **wave 2**: work in your own git worktree, on branch
`s1/h-backups-ext`, cut from `main` after wave 1 merged. S1-b's external path is on `main`, and
R0-release-prep runs beside you, owning `e2e.ts` and the other self-hosting docs.

## Why

With an external Postgres, WAL-G cannot run: a managed cluster gives no access to its WAL (ADR 0032
`:63`). Under U4 that is **our production instance at launch**. Our backups become:

- DigitalOcean's point-in-time recovery, 7 days;
- a nightly logical dump to a bucket we control, in another region, so no restore depends on one
  provider;
- a drill that proves the dump restores.

`docs/self-hosting/backups.md:349` restores WAL-G only, and `docs/self-hosting/managed-services.md`
does not exist. It becomes the operator path we use ourselves.

**Both modes stay fully supported** (the user, 2026-11-02). Bundled Postgres is the self-host
default, and its backups stay WAL-G, with today's restore and a new WAL-G drill timer. External
Postgres adds `pg_dump` and the dump drill. Never weaken or replace the WAL-G path.

## You own (write only these)

- **`scripts/selfhost.sh`: the backup section** (`parse_backup_flags` through `cmd_backup`, at
  `:1880-2265` on `4e92eefe`; recheck after S1-b's merge), plus the timer install calls for your
  units. If a timer install must go inside `install_units`, send it as a contract request with the
  exact lines.
- `scripts/selfhost/{e2e-backup,e2e-dump}*.ts` and `scripts/selfhost/selfhost-backup.test.ts`.
- `infra/postgres/{dump,dump-restore,dump-drill}.sh` (new). Not `restore-owner.sql`, which is the
  contract step's; you call it.
- `infra/quadlet/commonair-{dump,drill}*` (new: services and timers).
- `docs/self-hosting/{backups,managed-services}.md`.
- Tests named after these files.

**Read-only:** the rest of `selfhost.sh` and `scripts/selfhost/**` (S1-b's, now
R0-release-prep's `e2e.ts`), `packages/db/**`, `infra/postgres/{app-role,monitor-role}.sql`,
`restore-owner.sql`, and `infra/tofu/**`. The orchestrator wires `e2e-dump.ts` into `e2e.ts` at
merge.

## Build

1. **`selfhost.sh backup --dump`**:
   - runs `pg_dump --format=custom` as the owner over verified TLS, using the tools image;
   - streams it to the operator's bucket with rclone, under `dumps/<UTC date>/commonair.dump`, with
     a SHA-256 sidecar file;
   - keeps 30 dumps (ADR 0032 §4). Retention deletes by date, never more than the newest 30 kept,
     and refuses to delete when fewer than 30 exist;
   - reuses `object_remote`, the locks and `--bwlimit` from R0-c.
     It is the **default** `backup` action when state is external, and is available with bundled
     state too, as a second copy beside WAL-G.
2. **The timer.** `commonair-dump.timer` runs nightly at a randomized minute
   (`RandomizedDelaySec`), installed only for an external Postgres unless the operator opts in.
   Failures are logged to the journal and reported in `status`: the last dump's time and size.
3. **`selfhost.sh backup --drill`** (`commonair-drill.timer`, weekly):
   1. fetches the newest dump and checks its SHA-256;
   2. starts a **throwaway** Postgres container on the host, from the image the stack pins, on a
      private network, with no published port;
   3. restores into it as a no-superuser owner role created there, through contract §1.3's
      owner-only order, so the drill also proves the path a managed-cluster restore takes;
   4. checks counts:
      - `channels.follower_count` against `count(*)` of non-excluded follows, per channel;
      - ledger entries balancing per transaction and currency;
      - row counts per table against the counts recorded with the dump (write a small
        `counts.json` beside it at dump time);
   5. removes the container and its volume;
   6. pushes `commonair_restore_drill_seconds` and a success gauge through OTLP, as named by
      L1-observability.
      It **never** connects to the live database. Test that the drill's connection string can only
      point at the throwaway container.
4. **A drill into a managed cluster** (manual, documented): the same procedure against a fresh
   managed cluster, which is how a real disaster restore runs. The agent track (U5) runs it once on
   the staging project and records the time. That time is our instance's restore time for ADR 0032
   §1.
5. **The WAL-G drill on a timer** too (`commonair-drill.timer --walg`) for bundled state. It restores
   the latest base backup into a throwaway container, as `backups.md` describes by hand today.
6. **`docs/self-hosting/managed-services.md`** (new). This is the page our own production follows,
   so write it as a procedure, not a survey:
   - the requirements for Postgres, Valkey and S3, from ADR 0032 §3 and S1-b's
     `requirements.md`;
   - at the top, that the bundled install is the default and this page is the option;
   - provider-neutral steps: create the owner, get the CA, check the connection budget, run
     `selfhost.sh install --database-url … --valkey-url …`;
   - **moving an existing bundled instance to managed services:** `selfhost.sh` refuses a switch
     in place (S1-b). Document the manual procedure:
     1. take a final `backup --dump` in a maintenance window;
     2. restore it into the managed cluster through the owner-only order;
     3. reinstall with the external flags;
     4. check counts.
   - **the DigitalOcean worked example**, matching `infra/tofu/digitalocean/modules/instance/managed_state.tf`:
     - `node_count = 2`, `noeviction` and `rdb`;
     - the trusted-sources tag rule;
     - `doadmin` as the owner;
     - Standard edition with the downloaded CA (ADR 0032 `:197-199`);
     - the connection limit at the chosen size;
     - that Valkey has no ACL users;
   - what the provider backs up and what it does not;
   - the dump and drill;
   - the restore runbook into a new cluster, with the time from the agent track's run;
   - what a failover loses (ADR 0032 §3).
     No provider is special-cased in code.
7. **`docs/self-hosting/backups.md`:** add the dump path, the drill, and when to use each. Keep the
   WAL-G sections and fix the `:349` restore section to point at both.

## Edge cases

- **A dump while migrations run:** `pg_dump` takes a consistent snapshot, but a schema change
  mid-dump can make it fail. `upgrade` and the dump timer must not overlap. Use the existing
  backup lock.
- **The bucket is unreachable:** the dump fails and nothing local is left behind (stream, do not
  stage). If it must stage, it uses the instance's state directory with a size check first.
- **A corrupt or truncated dump:** the checksum fails before any restore.
- **A drill on a host with too little disk:** check free space against the dump's size times 3
  first, and refuse with a `fix:` line.
- **Personal data:** dumps contain it. The bucket must be private. Say so in the docs, and refuse a
  public-read bucket when the provider lets you check.
- **The drill must not leak the dump** into the journal or logs: no `pg_restore` verbose output
  with row data.

## Tests you must add

- **Shell unit tests** (`selfhost-backup.test.ts`): the flags, retention selection (fewer than 30,
  exactly 30, 31, gaps in dates), refusing a public bucket, the lock, and the drill's target
  guard.
- **Script tests** for `dump-drill.sh`'s count checks, against a fixture dump. They must fail on a
  doubled `follower_count`, which is the bug a trigger-enabled restore would cause.
- **`scripts/selfhost/e2e-dump.ts`** (wired by the orchestrator): on the external-state e2e, take a
  dump, run the drill, check the gauge, delete one dump past retention, and check the newest 30
  stay. On the bundled e2e, run the WAL-G drill timer's service once and check its gauge. The
  existing WAL-G backup checks (`e2e-backup.ts`) keep passing unchanged.

## Reviewer focus

- The restore disables only user triggers, and only for the data load, then re-enables them and
  checks counts.
- The drill never touches the live database.
- Bundled WAL-G backups and restore are unchanged, and both modes have a drill.
- Retention is 30, and never deletes below 30.
- Dumps are checksummed and private, with no row data in logs.
- `managed-services.md` matches the tofu module and is what production follows.

## Done means

Follow `.claude/briefs/_done-means.md`:

- `bun --bun vp test run scripts/selfhost infra/tests`;
- `shellcheck` on your shell files;
- `vp lint --deny-warnings` and `vp fmt`;
- `reuse lint`.

`git status` shows only your paths. Commit with `git commit -s`.

Your final message lists the `install_units` lines (a contract request) and the exact commands for
the agent track:

```bash
selfhost.sh backup --dump
```

```bash
selfhost.sh backup --drill
```

It also gives the managed-cluster restore procedure, to run once on the staging project and time.
