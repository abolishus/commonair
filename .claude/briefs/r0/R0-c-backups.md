<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# R0-c: `selfhost.sh backup --objects` and the backup LOWs

You are implementing unit R0-c for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/R0-release.md`,
`.claude/briefs/r0/README.md` and `docs/self-hosting/backups.md`. Do not look outside the
repository. **Wave 2:** start your worktree from R0-b's merged commit (the orchestrator names it
when it starts you), on a branch named `r0/c-backups`.

## Why

The launch blocker is a tested restore (ADR 0025 keeps ADR 0010's rule; L1 checklist item 6:
"WAL-G to Spaces in another region; Garage objects with `selfhost.sh backup --objects`; a
restore drill on a calendar"). WAL-G is scripted, but objects (avatars, banners, VODs, clips,
evidence) are a manual rclone recipe in the docs, and two review LOWs are open on it. The R0
restore onto a second droplet uses whatever this unit ships.

## You own (write only these)

- `scripts/selfhost.sh`: `cmd_backup` and new backup functions, the usage text for `backup`,
  and the `backup` arm of `main` (:1272). Nothing else in the script (R0-b's changes are already
  merged under you; keep them intact).
- `infra/systemd/commonair-object-backup.{service,timer}` (new, if you add a timer)
- `docs/self-hosting/backups.md`
- `scripts/selfhost/e2e-backup.ts` (new: e2e check functions; R0-e wires them)
- New test files for what you add.

## Contracts you must honor (read-only for you)

- R0-b's storage mode (`S3_MODE` or whatever it named it) and the env keys it writes. In external
  mode the objects already live off the host; `--objects` then copies bucket to bucket, or says
  the provider's own durability and versioning are the operator's choice. Decide, and document.
- The tools image is the only place Bun runs on the host; the host has no Bun, Node or git
  (`selfhost.sh` header :8-11). rclone is not in any image today (`infra/containers` has only
  `service.Containerfile` and `probe.Containerfile`); `backups.md:85-88` installs it on the host
  with `apt`/`dnf`.
- AGENTS.md non-negotiables 2 and 7 for any new image or binary: rclone is MIT; if you put it in
  an image, pin it like WAL-G is pinned in `infra/postgres/Containerfile:8,16-31` (version and
  SHA-256), and that Containerfile change is a contract request unless you add a new image under
  your own new path. Prefer the host package if it keeps the script simple; say why.

## What is there today (verified at `8bbdb52`)

- `cmd_backup` (:1218-1224) starts `commonair-backup.service` (a WAL-G base backup and
  `wal-g delete retain FULL $WALG_RETAIN_FULL`, `infra/postgres/backup.sh:19-28`) and lists
  backups. No arguments are passed to it (:1272); no `--objects`.
- `backups.md:83-226`: a read-only Garage key `commonair-object-backup` (:105-107), an rclone
  config with a `[garage]` remote (`endpoint = http://127.0.0.1:3900`, `region = garage`,
  `force_path_style = true`) and an `[offsite]` remote (Hetzner example, `no_check_bucket = true`),
  `rclone sync` for media and evidence (:144-145, and a systemd unit at :174-175), restore with
  `RCLONE_CONFIG_GARAGE_*` overrides (:216-221).
- The drill (:304-380) hardcodes `commonair-backups` (:322) and `drill.example.org`.
- Open LOWs (PROGRESS.md:412-416, :469): the drill's bucket name is hardcoded; the rclone
  restore remote lacks `no_check_bucket` (it is the `[garage]` remote that lacks it).
- The offsite examples name Hetzner (`fsn1.your-objectstorage.com`); ADR 0025 makes DigitalOcean
  Spaces our first real target.

## Build

1. **`selfhost.sh backup [--objects] [--database]`**: no flag keeps today's behavior (database).
   `--objects` copies the media and evidence buckets (and exports? decide: they are regenerable
   and expire, so probably not; say why) to an offsite remote configured in the env file:
   `BACKUP_OBJECTS_REMOTE_*` keys (endpoint, region, bucket, prefix, path style) plus keys from
   the 0600 env file, never argv. New env keys used by the script only need not go into
   `packages/config`, but check `scripts/init-env.ts`/`.env.example` for how script-only keys are
   documented there and send a contract request if they must be listed.
2. Use `rclone sync` with `--checksum` where the store supports it, `no_check_bucket = true` on
   **both** remotes, a bandwidth limit option, and rclone's config passed through environment
   variables (`RCLONE_CONFIG_<REMOTE>_*`), not a file with keys in it. Garage access uses a
   **read-only** key for the copy (create it in `storage-init`'s Garage path or document the one
   command; R0-b owns `infra/garage/**`, so a bootstrap change is a contract request).
3. Exit codes and output that `status` and a timer can use: the last successful object backup
   time written to a state file under `~/.local/state/commonair/` (not `/tmp`), which `status`
   can show (the `status` change itself is one line in R0-b's code: make it, and say so in your
   final message so the reviewer sees it).
4. Optional timer: `commonair-object-backup.timer`, disabled unless the remote is configured.
   `install_units` already installs and enables files in `infra/systemd/` (timers listed at
   :922; check whether a new timer is enabled automatically or needs that line: it is R0-b's
   code, so a needed change is yours only if it is inside the backup arm, otherwise a contract
   request).
5. **Docs**: `backups.md` replaces the manual recipe with the command, keeps the manual recipe
   as "without the script", uses DigitalOcean Spaces as the example offsite store (endpoint,
   region, a key limited to the bucket), fixes both LOWs (the drill reads the bucket from
   `WALG_S3_PREFIX`; `no_check_bucket` on both remotes), and describes the restore of objects.
   Times the drill should record: database restore, object restore, total.
6. **e2e check** in `scripts/selfhost/e2e-backup.ts` (`InHost`/`Expect` shapes as in
   `e2e.ts:100-145`): configure an offsite remote pointing at a second Garage on the host (R0-b's
   `externalStoreSetup` may already do this: reuse it), upload an object, run
   `backup --objects`, delete the object from the instance's bucket, restore with the documented
   command, compare bytes.

## Tests you must add

- Flag parsing for `backup` (no flag, each flag, both, unknown flag).
- The rclone environment built from the env file (no key ever on a command line: assert on the
  argv you build), missing remote configuration refused with a clear message.
- The state file written only on success.

## Done means

Follow `.claude/briefs/_done-means.md`. Run your tests and the existing `scripts/selfhost` unit
tests, `vp lint --deny-warnings`/`vp fmt` on your paths, `shellcheck` if installed. Do not run the
e2e. Commit in your worktree. Final message: design choices (rclone where, exports or not,
external mode), test counts, branch and sha, contract requests, R0-e wiring, and the exact
commands the user runs for the restore onto a second droplet.
