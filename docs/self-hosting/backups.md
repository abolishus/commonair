<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Backups

Postgres is backed up with [WAL-G](https://github.com/wal-g/wal-g), which ships in the
`postgres` image:

- **Continuous WAL archiving.** Every finished write-ahead-log segment goes to S3, at least
  once a minute while the database is busy (`archive_timeout=60`).
- **A daily base backup** at 03:00 UTC (plus up to 30 minutes of random delay) from
  `commonair-backup.timer`. A server that was off at 03:00 takes it at the next boot. After each
  base backup, WAL-G keeps the newest `WALG_RETAIN_FULL` (7 by default) and deletes older ones.

A restore takes the newest base backup and replays the archived WAL after it, so you lose at
most the last minute or so of writes.

## Where backups go

By default, to the `commonair-backups` bucket of the local Garage, under `wal/`. That protects
against a broken database, not against losing the server. **For a real instance, send backups
off the server.**

### Off-host S3

WAL-G reads `AWS_*` settings before the platform's `S3_*` ones, so pointing it elsewhere takes
only env-file entries. The services keep using the local Garage for media.

Create a bucket and a key at the other location, then add to
`~/.config/commonair/commonair.env`:

```sh
AWS_ENDPOINT=https://fsn1.your-objectstorage.com
AWS_REGION=fsn1
AWS_ACCESS_KEY_ID=<key>
AWS_SECRET_ACCESS_KEY=<secret>
WALG_S3_PREFIX=s3://<bucket>/wal
```

That example is Hetzner Object Storage in Falkenstein; pick a location other than the server's,
and check the endpoint form against Hetzner's documentation. A second Garage node on another
host works the same way, with its own endpoint, region (`garage` unless you changed it) and a
key that has read and write access to the bucket. `AWS_S3_FORCE_PATH_STYLE` defaults to `true`,
which both accept.

Apply the settings and take a base backup right away, because the new location has none yet:

```sh
sh ~/commonair/selfhost.sh install --reinstall
sh ~/commonair/selfhost.sh backup
```

Every container reads the env file, so these credentials are visible to all of them
([README.md](README.md#known-limitations)). Give the key access to the backup bucket only.

## `selfhost.sh backup`

```sh
sh ~/commonair/selfhost.sh backup
```

It runs `commonair-backup.service` now (a base backup, then the retention cleanup) and lists
every base backup with its name and time. `selfhost.sh status` shows when the last backup ran
and whether it succeeded. `upgrade` takes one before it changes anything.

## What is not backed up

- **Objects in Garage**: avatars, thumbnails, clips, VODs, data exports and sealed evidence.
  `selfhost.sh` does not copy them anywhere. If you need them to survive the server, copy the
  buckets (`S3_BUCKET_MEDIA`, `S3_BUCKET_EVIDENCE`) to another S3 location on your own schedule.
- **The env file**, `~/.config/commonair/commonair.env`. It holds every secret: the database
  passwords, the S3 keys, the session and signing keys, and `EVIDENCE_PRIVATE_KEY`, without
  which sealed evidence cannot be read. Keep an offline copy somewhere safe, and update it when
  you change the file. A restore onto a new server needs it.
- **Valkey.** It holds only presence, caches and queues, and starts empty by design.

## Restore

`commonair-restore` (in the `postgres` image) fetches a base backup into an **empty** data
directory and prepares WAL replay. The next Postgres start replays the archive and promotes.
It refuses a data directory that is not empty.

These steps replace the database of the instance you run them on. As `commonair`:

```sh
# 1. Stop everything, then start only Garage (needed when backups are in the local Garage).
systemctl --user stop 'commonair-*'
systemctl --user start commonair-garage.service

# 2. Keep a copy of the current data, then empty the volume.
podman volume export commonair-postgres-data --output ~/postgres-data-before-restore.tar
podman volume rm commonair-postgres-data
podman volume create commonair-postgres-data

# 3. Restore the newest base backup into it.
PG_IMAGE=$(sed -n 's/^Image=//p' ~/commonair/quadlet/commonair-postgres.container)
podman run --rm --network commonair \
  --env-file ~/.config/commonair/commonair.env \
  -e WALG_S3_ENDPOINT=http://garage:3900 -e S3_REGION=garage \
  -v commonair-postgres-data:/var/lib/postgresql/data \
  "$PG_IMAGE" commonair-restore

# 4. Start the instance again (migrations first, then every service).
sh ~/commonair/selfhost.sh install --reinstall
```

To restore a specific backup instead of the newest, pass its name (from `selfhost.sh backup`)
after the target directory: `commonair-restore /var/lib/postgresql/data <backup-name>`. For a
point in time, add `-e RECOVERY_TARGET_TIME='2026-10-18 12:00:00+00'` to the `podman run`.

The first start after a restore replays WAL before Postgres accepts connections; on a large
archive that takes a while, and the services wait for it.

### Onto a new server

When the old server is gone:

1. Install the **same version** on the new server ([install.md](install.md)), with the same
   `--domain`.
2. As `commonair`, replace `~/.config/commonair/commonair.env` with your offline copy. It holds
   the database passwords the restored database expects and the `AWS_*` settings of your
   off-host backups.
3. Run the [restore](#restore) from step 1 on.

Then point DNS at the new server.

## The restore drill

**An untested backup does not count.** Restore onto a scratch server regularly (at least before
launch and after changing anything about backups), and check that your data is there.

1. Install the same version on a throwaway server or VM, with `--tls internal` and any hostname.
2. Copy your env file over the new one, but give the drill **a key that can only read the
   backup bucket** (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`). The restored database starts
   archiving its own WAL on promotion, and with a writable key it would write into your
   production backup prefix.
3. Run the [restore](#restore) from step 1 on. Then turn off the drill's daily backup, which
   `install --reinstall` enabled: `systemctl --user disable --now commonair-backup.timer`.
4. Sign in on the drill instance (trust its root first, [tls.md](tls.md#internal-ca)) and check
   recent data: the newest accounts, streams and ledger entries.
5. Write down the date, the backup restored, how long it took, and anything that went wrong.
   Then delete the server.

Contributors can run the automated drill against a development stack with
`bun harness/src/cli.ts run backup-restore` (see `harness/README.md`).
