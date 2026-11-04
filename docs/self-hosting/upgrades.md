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

## Release cadence

- **A minor release about every two weeks** (`v0.2.0`, `v0.3.0`, …), cut from the newest commit
  whose full test run passed. Its notes cover everything since the previous minor or patch
  release, and `CHANGELOG.md` in the repository has the same in plain words.
- **Patch releases as needed** (`v0.2.1`), for a fix that cannot wait: a security issue, data
  loss, an upgrade or rollback that fails. Take them as they come.
- **Release candidates** (`v0.3.0-rc.1`) come before some minors for testing. They are marked
  as prereleases; a production instance does not need them.

Before 1.0, a minor release may change behaviour; the notes say how at the top.

## What `upgrade` does, in order

1. **Checks** Podman 5 and the systemd user manager.
2. **Downloads and verifies** the new release: `SHA256SUMS`, its signature (when cosign is
   installed, and always with `--require-signature`), then the bundle, checked against
   `SHA256SUMS`. It refuses the version that is already installed.
3. **Unpacks** it into `~/.local/share/commonair/releases/<version>/` and **hands the rest of the
   upgrade to the new release's own `selfhost.sh`** ([below](#the-new-releases-script-runs-the-upgrade)),
   which applies your mirror (`--registry`, or the one recorded at install).
4. **Pulls every image by digest.** If a pull fails, it stops here and nothing has changed. It
   also stops, before anything changes, when a container outside the instance holds the
   `commonair` network that the restart must re-create.
5. **Takes a WAL-G base backup** of the running database (`commonair-backup.service`). If the
   backup fails, it stops here and nothing has changed.
6. **Updates the env file** with the new release's `tools` image: it adds variables the new
   release introduces, keeps every existing value and every key you added, and recreates the
   Podman secrets, hash-list files and model.
7. **Installs the new units:** `~/.local/share/commonair/previous` points at the old release,
   `~/commonair` at the new one, and the Quadlet units, timers and sockets are replaced. A unit
   the new release no longer ships is stopped and removed. Your drop-in directories stay
   ([README.md](README.md#customizing-a-unit)).
8. **Stops the stack and runs the migrations to completion** (`commonair-migrate`, up to 15
   minutes), before any service that uses the database starts.
9. **Starts every service and waits until each is healthy** (up to 15 minutes), then syncs the
   IRC certificate.
10. **Removes old releases**, keeping the current and the previous one.

If step 8 or 9 fails, it **rolls back** on its own (below) and exits with an error.

`--bundle <path>` upgrades from a local bundle instead of downloading, with the same checks.
`--registry` and `--insecure-no-checksum` work as for `install` ([install.md](install.md)).

### The new release's script runs the upgrade

The script you run is the installed release's, but a new release may install differently (new
units, settings or checks), and only its own script knows how. So once step 2 has verified the
bundle and step 3 has unpacked it, `upgrade` runs the bundle's `selfhost.sh` with the same
arguments, and its outcome is the upgrade's: its exit status, its rollback. The log says
`handing the upgrade to release <version>'s selfhost.sh`. The new script verifies the same
bundle again from its `SHA256SUMS` (and signature) rather than downloading it again, and hands
off no further. Nothing has changed on the host before the hand-off. When the new script is
identical to the running one there is no hand-off. With an external Postgres and Valkey, what
the first script asked for (passwords, a CA file) is handed over, not asked for again.

Afterwards `~/commonair/selfhost.sh` is the new release's script, since `~/commonair` points at
the new release.

**From 0.1.0-rc.11 or older**, the installed script has no hand-off: it upgrades with its own
code, which can fail on a newer release (staging, from rc.9 to rc.11: unhealthy, then rolled
back). Run the new release's script instead. Download and verify the bundle as for an install
([install.md](install.md)), unpack its `selfhost.sh`, and run that one:

```sh
tar -xzf commonair-selfhost_X.Y.Z.tar.gz commonair-selfhost_X.Y.Z/selfhost.sh
sh commonair-selfhost_X.Y.Z/selfhost.sh upgrade --bundle commonair-selfhost_X.Y.Z.tar.gz
```

`upgrade` backs up the database, not the objects. If you copy objects off the server
([backups.md](backups.md#objects)), the daily copy keeps running as before; for a fresh copy
right before the upgrade, run `sh ~/commonair/selfhost.sh backup --objects` first. `status`
shows the `last object backup:` time.

### Object storage

`upgrade` keeps the object store the instance was installed with (`S3_MODE` in the env file) and
takes no `--s3-*` flag. To change a key or the public endpoint of an external store, use
`install --reinstall` ([object-storage.md](object-storage.md#afterwards)).

Upgrading from 0.1.0-rc.2 or older, on Garage, step 6 writes Garage's endpoint, region and path
style into `commonair.env` (`S3_ENDPOINT=http://garage:3900`, `S3_REGION=garage`,
`S3_FORCE_PATH_STYLE=true`): earlier releases set them in the units. Step 7 stops and removes
`commonair-garage-init`, which `commonair-storage-init` replaces.

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
- **New env-file variables.** They stay, and the old release ignores them. The units of the
  release you roll back to pass only the keys of their own lists, from that release.

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

## Upgrading across several releases

If you skipped a few minors (say you run `v0.2.0` and the latest is `v0.5.0`), you can upgrade in
one step: the bundle carries every migration, and `upgrade` runs the ones your database has not
had, in order. Read the notes of each release in between, not only the last one: a breaking
change or a new required setting from `v0.3.0` still applies to you.

What one step gives up is the automatic rollback's safety. A rollback lands on your old release,
which then runs against a schema several releases newer, and the additive-migration rule only
covers one release (below). So for several minors:

- **The safe path: one minor at a time.** `upgrade --version v0.3.0`, check `status`, then
  `v0.4.0`, then `v0.5.0`. Each step can roll back safely, and each takes a fresh pre-upgrade
  backup. Patch releases in between can be skipped: take the newest patch of each minor.
- **The quick path: straight to the latest**, with a known-good backup you have restored once
  ([backups.md](backups.md)). If the upgrade fails and its automatic rollback does not come up
  healthy, restore the backup taken in step 5.

Either way, the images of every release you pass through are pulled, so a mirror
([mirroring.md](mirroring.md)) needs each of them.

## Going back after a successful upgrade

`upgrade` also installs an older version, for example back to `v0.1.0` after `v0.2.0`:

```sh
sh ~/commonair/selfhost.sh upgrade --version v0.1.0
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

A fork releases with the same workflow as the project (`.github/workflows/release.yml`,
[docs/maintainers/releasing.md](../maintainers/releasing.md)): a version tag on the fork builds
its images into `ghcr.io/<fork owner>/commonair`, the bundle's units name them by digest, and the
fork's own workflow signs `SHA256SUMS` keylessly. `selfhost.sh` needs to know only the fork's
repository URL.

### Where `selfhost.sh` gets the repository URL

In this order, the first one set wins:

1. `COMMONAIR_REPOSITORY_URL` in the environment of the `selfhost.sh` run;
2. `COMMONAIR_REPOSITORY_URL` in `~/commonair/release.env`, which the installed release recorded
   when it was built, from `SITE.repository.url` in the fork's code
   (`packages/config/src/site.ts`);
3. the project's own repository.

It must be an `https://` URL. It decides two things:

- **Where a release is downloaded from:** `<url>/releases/download/v<version>/` (with
  `--version`; a `--bundle` is not downloaded).
- **Which signature is accepted.** `selfhost.sh` checks `SHA256SUMS` against the identity
  `^<url, dots escaped>/\.github/workflows/release\.yml@refs/tags/v`, also for a `--bundle`
  whenever cosign is installed. For `https://github.com/example/commonair`:

  ```sh
  --certificate-identity-regexp '^https://github\.com/example/commonair/\.github/workflows/release\.yml@refs/tags/v'
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
  ```

  Only the fork's `release.yml`, running for a version tag, matches: not the project's
  releases, not another workflow or a branch. The same flags check a fork's release by hand
  ([verifying.md](verifying.md#the-identity)).

### First install

Set the variable for the install command. Run as root with `--yes`, it passes through to the
`commonair` user's run:

```sh
COMMONAIR_REPOSITORY_URL=https://github.com/example/commonair \
  sh "commonair-selfhost_$VERSION/selfhost.sh" install --yes --version "v$VERSION" \
  --domain stream.example.org --email ops@example.org --require-signature
```

Download and verify the fork's bundle the way [install.md](install.md#2-download-and-verify-the-release)
shows, with the fork's URL in `BASE` and the fork's identity in `cosign verify-blob`.

### Upgrades, and the one trap

`release.env` records the URL in the fork's **code**, not the one the release came from. A fork
that never changed `SITE.repository.url` records the project's URL, so an `upgrade` without the
variable downloads **the project's** release of that version, which verifies against the
project's identity and installs: the instance silently leaves the fork. Fix it once, in one of two
ways:

- **In the fork (best):** set `repository` in `packages/config/src/site.ts` to the fork, and
  `DEFAULT_REPOSITORY_URL` in `scripts/selfhost.sh` to the same URL (a test keeps the two
  equal). Every release built after that records the fork's URL, its `selfhost.sh` defaults to
  it, and its "Source" link points at the fork, as the AGPL expects. An `upgrade` reads the
  URL of the release that is installed, so set the variable once more for the upgrade to the
  first such release; after that, upgrades need none. Check what the installed release
  recorded with `sed -n 's/^COMMONAIR_REPOSITORY_URL=//p' ~/commonair/release.env`.
- **On the server:** set the variable in the `commonair` user's login environment, so every
  `upgrade` sees it. Its login shell (`/bin/sh`) reads `~/.profile`:

  ```sh
  echo 'export COMMONAIR_REPOSITORY_URL=https://github.com/example/commonair' >> ~/.profile
  ```

  Log in again and check with `echo "$COMMONAIR_REPOSITORY_URL"`. Not
  `~/.config/environment.d/`: the systemd user manager reads that for its units, and an SSH
  shell never sees it. `~/.profile` is not read either by a command passed to `ssh` (`ssh
  commonair@… 'sh ~/commonair/selfhost.sh upgrade …'`) or by a run as root, which passes on
  root's environment instead: put the variable in front of the command there.

The timers never download anything, so they need no URL.

## Resetting a staging instance

A staging instance filled with the full demo seed (`bun harness/src/cli.ts seed full`) holds
append-only rows (ledger, co-op, votes, audit) that only a database reset removes (ADR 0004).
Reset it by hand, as the `commonair` user:

```sh
sh ~/commonair/selfhost.sh reset-staging --confirm staging.example.org
```

It refuses, and changes nothing, unless `commonair.env` has `DEMO_SEED_FULL=true` (only local and
staging instances set it; staging runs `NODE_ENV=production` like any instance, so that flag is
what tells them apart) and `--confirm` equals the instance's `PUBLIC_HOSTNAME` exactly. It does not
take a backup first: every row is gone afterwards.

In order, it:

1. stops every unit but Postgres, Valkey and Garage;
2. drops the `commonair` database and creates it again, as the owner role;
3. flushes Valkey (sessions, queues and caches that name the old rows);
4. runs `commonair-migrate`, as `install` and `upgrade` do (`GOVERNANCE_BOOTSTRAP_JSON` applies);
5. with `--base-seed` only, runs the basic demo seed (`demo:seed`) from the release's tools image;
6. starts the stack again and waits for health.

Object storage is not reset: VODs and clips stay in the media bucket. They are harmless, and the
next seed writes new ones.

Then fill it with the full seed. The seed needs test hooks, mocks and peers that a normal install
does not have, so it runs in **staging seed mode**, from a harness container on the instance's
own network. The commands, in order, are in [Seeding staging](../testing/seeding.md#seeding-staging):
upgrade, `seed-mode open`, `reset-staging`, `seed-mode run`, `seed-mode coverage`, `seed-mode close`.
Open seed mode before the reset: the reset's migrations apply seed mode's governance bootstrap.

While seed mode is open, `upgrade` and `install --reinstall` refuse and name `seed-mode close`.
Seed mode closes itself 6 hours after it opens at the latest (ADR 0040).

The full seed refuses a database that has any users, so skip `--base-seed` when you mean to run it:
`--base-seed` is for a staging instance that only needs the basic demo accounts.
