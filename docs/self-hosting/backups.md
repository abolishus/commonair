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

The first start after a restore replays WAL before Postgres accepts connections. The units
give that limited time: `commonair-postgres` counts as failed (and is restarted) when its
health check has not passed after about two minutes, and its start times out after five. A
small archive replays well within that. If you restore an old base backup with a lot of WAL
after it, or the restart loop shows in `journalctl --user -u commonair-postgres`, finish the
replay by hand before step 4:

```sh
podman run -d --name commonair-replay --network commonair \
  --env-file ~/.config/commonair/commonair.env \
  -e POSTGRES_USER=commonair -e POSTGRES_DB=commonair \
  -e WALG_S3_ENDPOINT=http://garage:3900 -e S3_REGION=garage \
  -v commonair-postgres-data:/var/lib/postgresql/data "$PG_IMAGE"
# Wait until this prints "f" (recovery over, database promoted), then stop it.
podman exec commonair-replay psql -U commonair -d commonair -tAc 'select pg_is_in_recovery()'
podman stop commonair-replay && podman rm commonair-replay
```

Then run step 4.

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

The drill runs a full copy of production: real accounts, queued notifications and simulcast
targets. Keep it from reaching anyone.

1. Install the same version on a throwaway server or VM, with `--tls internal` and a hostname
   of its own, such as `drill.example.org`.
2. Copy your env file over the new one, then change it before anything starts:
   - Give the drill **a key that can only read the backup bucket** (`AWS_ACCESS_KEY_ID`,
     `AWS_SECRET_ACCESS_KEY`). The restored database starts archiving its own WAL on promotion,
     and with a writable key it would write into your production backup prefix.
   - Point mail nowhere: `SMTP_HOST=localhost`, `SMTP_PORT=1025`, `SMTP_USER=` and
     `SMTP_PASSWORD=` (nothing listens there, so sending fails). Otherwise the worker sends
     queued notifications to real members with your production credentials.
   - Turn off payments: `PAYMENTS_PROVIDER=manual` and `STRIPE_SECRET_KEY=`.
3. Run the [restore](#restore) from step 1 on, but replace its step 4 with a reinstall that
   keeps the drill's hostname and TLS mode (the copied env file holds production's):

   ```sh
   sh ~/commonair/selfhost.sh install --reinstall --domain drill.example.org --tls internal
   ```

   Then turn off the drill's daily backup, which the reinstall enabled:
   `systemctl --user disable --now commonair-backup.timer`. If you only need to look at data,
   also stop the worker: `systemctl --user stop commonair-worker.service`.

4. Sign in on the drill instance (trust its root first, [tls.md](tls.md#internal-ca)) and check
   recent data: the newest accounts, streams and ledger entries. Do not go live on it: the
   restored simulcast targets would push the stream to real third-party platforms.
5. Write down the date, the backup restored, how long it took, and anything that went wrong.
   Then delete the server.

Contributors can run the automated drill against a development stack with
`bun harness/src/cli.ts run backup-restore` (see `harness/README.md`).
