<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Upgrades

Upgrade with `selfhost.sh upgrade`, as the `commonair` user. Nothing upgrades on its own: there
is no `podman auto-update`, and the units never pull a moving tag.

```sh
sh ~/commonair/selfhost.sh upgrade --version v0.1.0 --require-signature
```

Read the release notes first. They list breaking changes at the top.

## What `upgrade` does, in order

1. **Checks** Podman 5 and the systemd user manager.
2. **Downloads and verifies** the new release: `SHA256SUMS`, its signature (when cosign is
   installed, and always with `--require-signature`), then the bundle, checked against
   `SHA256SUMS`. It refuses the version that is already installed.
3. **Unpacks** it into `~/.local/share/commonair/releases/<version>/` and applies your mirror
   (`--registry`, or the one recorded at install).
4. **Pulls every image by digest.** If a pull fails, it stops here and nothing has changed.
5. **Takes a WAL-G base backup** of the running database (`commonair-backup.service`). If the
   backup fails, it stops here and nothing has changed.
6. **Updates the env file** with the new release's `tools` image: it adds variables the new
   release introduces, keeps every existing value and every key you added, and recreates the
   Podman secrets, hash-list files and model.
7. **Installs the new units:** `~/.local/share/commonair/previous` points at the old release,
   `~/commonair` at the new one, and the Quadlet units and timers are replaced.
8. **Stops the stack and runs the migrations to completion** (`commonair-migrate`, up to 15
   minutes), before any service that uses the database starts.
9. **Starts every service and waits until each is healthy** (up to 15 minutes), then syncs the
   IRC certificate.
10. **Removes old releases**, keeping the current and the previous one.

If step 8 or 9 fails, it **rolls back** on its own (below) and exits with an error.

`--bundle <path>` upgrades from a local bundle instead of downloading, with the same checks.
`--registry` and `--insecure-no-checksum` work as for `install` ([install.md](install.md)).

## Rollback

When the new release does not become healthy, `upgrade` points `~/commonair` back at the
previous release, reinstalls its units, runs its migration step and starts it again. The previous
release's images are still on the host. If that comes up healthy, `upgrade` says so and exits
with an error; the failed release stays in `~/.local/share/commonair/releases/` for inspection.

The rollback cannot undo three things:

- **The schema.** Migrations only go forward. If the new release's migrations ran, the old
  release now runs against the new schema. That is safe only because migrations between
  adjacent releases are additive (below).
- **Data written by the new release** while it ran.
- **New env-file variables.** They stay, and the old release ignores them.

If the rolled-back release does not work against the new schema, the last resort is to restore
the backup taken in step 5 ([backups.md](backups.md#restore)). `selfhost.sh backup` lists the
backups with their times.

A failed migration does not change the schema: each migration runs in a transaction.

## The additive-migration rule

[ADR 0023 §9](../decisions/0023-release-and-self-hosting.md) requires that the previous release
keeps working against the next release's schema. So migrations between adjacent releases only
add: new tables, new nullable or defaulted columns, new indexes. A column is renamed or dropped
in two releases: the first stops using it, the next removes it ("expand, then contract").

For you as an operator, this means:

- **Rollback is safe across one release**, not more.
- **Skipping releases works** (the migrations of every release in between run in order), but
  then a rollback lands on a release more than one schema behind, which the rule does not
  cover. Upgrade one release at a time if you want the automatic rollback to be safe, or be
  ready to restore the pre-upgrade backup.

## Going back after a successful upgrade

`upgrade` also installs an older version:

```sh
sh ~/commonair/selfhost.sh upgrade --version v0.1.0-rc.2
```

This runs the older release against the newer schema. It is safe for one release back under the
rule above. For anything further, restore a backup taken before the upgrade instead.

## Pinning a version

The installed version stays until you run `upgrade`. Nothing else changes it:

- `install --reinstall` without `--version` reuses the installed release.
- The units pull images by digest, never by tag.
- The timers only take backups and copy the IRC certificate.

`sh ~/commonair/selfhost.sh status` shows the installed and the previous version.

## Mirrors

If you install from your own registry ([mirroring.md](mirroring.md)), `selfhost.sh` records it in
`~/.config/commonair/selfhost.conf` and every later `upgrade` pulls from it. Copy the new
release into the mirror before you upgrade, or step 4 fails (and changes nothing). Pass
`--registry <host/namespace>` to `upgrade` to switch to a different mirror.

## A fork's releases

`upgrade` downloads from the repository recorded in the installed release (`release.env` in
`~/commonair`) unless `COMMONAIR_REPOSITORY_URL` is set. A fork that has not changed the
repository URL in its code records the upstream URL there, so set
`COMMONAIR_REPOSITORY_URL=https://…` (the fork's repository) for every `upgrade` of a fork.
