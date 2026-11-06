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

The objects (avatars, thumbnails, clips, VODs, sealed evidence) are copied to another S3 store
by `selfhost.sh backup --objects`, daily once you have set it up ([Objects](#objects)).

Beside WAL-G, `selfhost.sh backup --dump` takes a **logical dump** of the database to the same
offsite store ([Logical dumps](#logical-dumps)). With an external Postgres
([managed-services.md](managed-services.md)) WAL-G cannot run, and the nightly dump is the
backup; with the bundled one it is an optional second copy. A weekly **restore drill** restores
the newest backup into a throwaway container and checks it, in both modes
([Automatic restore drills](#automatic-restore-drills)).

### Which backup, when

| Instance                       | Database backup                                   | Its restore                                                           | Drill (weekly timer)               |
| ------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------- |
| Bundled Postgres (the default) | WAL-G: continuous WAL plus a daily base backup    | [Restore](#restore-from-wal-g): any point in time, to the last minute | `commonair-drill-walg.timer` (on)  |
| Bundled, with dumps too        | WAL-G, plus a nightly dump (opt-in)               | WAL-G first; a dump for another host, version or provider             | both                               |
| External Postgres              | the provider's point-in-time recovery, plus dumps | the provider's first; a dump when it cannot help                      | `commonair-drill.timer` (the dump) |

WAL-G restores to a point in time and is the fast path on the same kind of host. A dump restores
only to the night it was taken, but into any Postgres 17 or later, as an owner with no superuser:
another provider, a managed cluster, or a newer major version.

## Where backups go

By default, to the `commonair-backups` bucket of the local Garage, under `wal/`, or of the
external store when the instance uses one ([object-storage.md](object-storage.md)). On Garage
that protects against a broken database, not against losing the server. **For a real instance, send backups
off the server.**

### Off-host S3

WAL-G reads `AWS_*` settings before the platform's `S3_*` ones, so pointing it elsewhere takes
only env-file entries. The services keep using the instance's own store for media.

Create a bucket and a key at the other location, then add to
`~/.config/commonair/commonair.env`:

```sh
AWS_ENDPOINT=https://ams3.digitaloceanspaces.com
AWS_REGION=ams3
AWS_ACCESS_KEY_ID=<key>
AWS_SECRET_ACCESS_KEY=<secret>
WALG_S3_PREFIX=s3://<bucket>/wal
```

That example is DigitalOcean Spaces in Amsterdam: pick a region other than the server's, and
check the endpoint form against your provider's documentation. A second Garage node on another
host works the same way, with its own endpoint, region (`garage` unless you changed it) and a
key that has read and write access to the bucket. `AWS_S3_FORCE_PATH_STYLE` defaults to `true`,
which both accept.

Apply the settings and take a base backup right away, because the new location has none yet:

```sh
sh ~/commonair/selfhost.sh install --reinstall
sh ~/commonair/selfhost.sh backup
```

Only the Postgres container receives these settings (`AWS_*` and `WALG_*` are on its key list,
[configuration.md](configuration.md#which-unit-sees-which-key)). Give the key access to the
backup bucket only all the same.

## `selfhost.sh backup`

```sh
sh ~/commonair/selfhost.sh backup                    # the database: WAL-G, or a dump with an external Postgres
sh ~/commonair/selfhost.sh backup --objects          # media and evidence, offsite
sh ~/commonair/selfhost.sh backup --database --objects
sh ~/commonair/selfhost.sh backup --dump             # a logical dump, offsite
sh ~/commonair/selfhost.sh backup --drill            # restore the newest dump into a throwaway container
sh ~/commonair/selfhost.sh backup --drill --walg     # the same for the newest WAL-G base backup
sh ~/commonair/selfhost.sh backup --restore-objects  # the offsite copy back into the buckets
```

- **`--database`** (the default with the bundled Postgres) runs `commonair-backup.service` now
  (a base backup, then the retention cleanup) and lists every base backup with its name and
  time. `upgrade` takes one before it changes anything. With an external Postgres it is refused:
  WAL-G cannot run there.
- **`--dump`** (the default with an external Postgres) takes a logical dump to the offsite store
  ([Logical dumps](#logical-dumps)). With `--database`, the base backup goes first.
- **`--drill`** restores the newest dump into a throwaway container and checks it; **`--drill
  --walg`** does the same with the newest WAL-G base backup (bundled Postgres only). Each runs on
  its own ([Automatic restore drills](#automatic-restore-drills)).
- **`--objects`** copies the media and evidence buckets to the offsite store
  ([Objects](#objects)). With `--database` too, the database goes first.
- **`--restore-objects`** copies the offsite copy back ([Restore objects](#restore-objects)). It
  runs on its own.
- **`--bwlimit <rate>`** limits the bandwidth of `--objects`, `--restore-objects`, `--dump` and
  `--drill`'s fetch, in rclone's syntax: `20M` (bytes per second), or a timetable such as
  `"08:00,4M 23:00,off"`. Without it, `BACKUP_OBJECTS_BWLIMIT` in the env file applies, if set.
- **`--max-delete <n|off>`** (with `--objects`) overrides `BACKUP_OBJECTS_MAX_DELETE` for this
  run ([Guards](#guards-against-emptying-the-copy)).
- **`--allow-empty-source`** (with `--objects`) copies a bucket that is empty although its
  offsite copy is not, which empties the copy. Without it, that run is refused.

The exit status is 0 when everything asked for succeeded and 1 otherwise, with the reason on
stderr. `selfhost.sh status` shows when the last base backup ran and whether it succeeded, and
when the last object backup succeeded and where to:

```text
last backup: Mon 2026-10-26 03:12:40 UTC (success)
last object backup: 2026-10-26T04:21:07Z (to https://ams3.digitaloceanspaces.com/stream-example-org-offsite/objects)
```

The object backup's time comes from `~/.local/state/commonair/object-backup`, which a run
rewrites only when every bucket was copied. A monitor can read its `LAST_SUCCESS=` line and alert
when it is older than a day and a half. Dumps and drills have their own lines and state files:

```text
last dump: 2026-11-03T02:31:12Z, 1.4 GiB (https://ams3.digitaloceanspaces.com/stream-example-org-offsite/objects/dumps/2026-11-03)
last restore drill: dump 2026-11-02T05:40:09Z success in 412s
```

(`~/.local/state/commonair/db-dump`, and `restore-drill-dump` and `restore-drill-walg`.)

## What is not backed up

- **Data exports** (`S3_BUCKET_EXPORTS`). Each expires after 7 days, and a member can request a
  new one, so `--objects` leaves them out.
- **The env file**, `~/.config/commonair/commonair.env`. It holds every secret: the database
  passwords, the S3 keys, the session and signing keys, and `EVIDENCE_PRIVATE_KEY`, without
  which sealed evidence cannot be read. Keep an offline copy somewhere safe, and update it when
  you change the file. A restore onto a new server needs it. The per-unit copies in
  `~/.config/commonair/unit-env/` need no backup: each unit writes its own from this file
  whenever it starts.
- **Valkey.** It holds only presence, caches and queues, and starts empty by design.
- **Objects**, until you set up an offsite store for them ([Objects](#objects)). Until then
  `status` says `last object backup: not configured`.

## Objects

Avatars, panels, thumbnails, clips, VODs and sealed evidence live in the object store: Garage on
the server by default, or an external store ([object-storage.md](object-storage.md)).
`selfhost.sh backup --objects` copies them to another S3 store with [rclone](https://rclone.org/)
`sync`, and once it has succeeded, does so daily.

| Bucket (env variable, default name)        | Holds                                    | Copied by `--objects`?                                                        |
| ------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------- |
| `S3_BUCKET_MEDIA`, `commonair-media`       | avatars, panels, thumbnails, clips, VODs | Yes, to `<bucket>/<prefix>/media`                                             |
| `S3_BUCKET_EVIDENCE`, `commonair-evidence` | sealed moderation evidence               | Yes, to `<bucket>/<prefix>/evidence`. Reading it needs `EVIDENCE_PRIVATE_KEY` |
| `S3_BUCKET_EXPORTS`, `commonair-exports`   | members' data exports                    | No. Each expires after 7 days, and members can request a new one              |
| `S3_BUCKET_BACKUPS`, `commonair-backups`   | WAL-G's Postgres backups                 | No. Send WAL-G off the server instead ([Off-host S3](#off-host-s3))           |

`rclone sync` makes the copy match the bucket, so an object deleted on the instance (a removed
VOD, or the media of a deleted account) leaves the copy at the next run too. That is what
account deletion promises; it also means the copy is not an archive of everything ever stored,
and that objects deleted on the instance by mistake leave the copy at the next daily run unless
a guard below stops it. **Turn on versioning, with an expiry rule, at the offsite store** (on
Spaces, through its S3 API; most providers offer it): it is what keeps a deleted object
recoverable for a while, whatever deleted it.

**With an external store** (`S3_MODE=external`) the objects already live off the server, and
the provider keeps them durable. `--objects` copies them bucket to bucket all the same, to a
store in another region or at another provider, so that losing the account or the region does
not lose them. Against a bucket emptied or thinned out by mistake, rely on versioning at the
provider (on the instance's store, the offsite one, or both): the guards below catch only a
bucket emptied completely or a deletion larger than the limit.

#### Guards against emptying the copy

A lost Garage volume (the instance starts again with empty buckets), a bucket emptied by
mistake, or `--objects` typed on a new server where `--restore-objects` was meant all look the
same to `rclone sync`: an empty bucket, and a copy to make match it. So `--objects`:

- **lists both buckets first** and refuses, before copying anything, when a bucket is empty but
  its offsite copy is not. The error says to restore ([Restore objects](#restore-objects)). If
  the bucket is empty on purpose, run `selfhost.sh backup --objects --allow-empty-source` once.
- **stops at a deletion limit**: rclone's `--max-delete`, by default 1000 objects per bucket and
  run (`BACKUP_OBJECTS_MAX_DELETE`). A run that reaches it fails, with what it deleted up to
  then, and `status` keeps the previous success. If the deletions are expected (many accounts
  or VODs removed at once), run `selfhost.sh backup --objects --max-delete off` once.
- **refuses to run during a restore**, or after a `--restore-objects` that did not finish
  ([Restore objects](#restore-objects)).

### What runs where

rclone runs on the server, from the distribution's packages: as root, `apt install rclone`
(Debian 13) or `dnf install rclone` (Fedora). `selfhost.sh` gives it its settings through
environment variables (`RCLONE_CONFIG_*`) for that run only: no key is on a command line, where
any user of the server could read it, and none is written to an rclone config file. An
`~/.config/rclone/rclone.conf` of your own is ignored.

#### Objects in Garage

rclone reads Garage on `127.0.0.1:3900`, the port Garage publishes on the loopback for this,
with a key that can read the media and evidence buckets and nothing else. The first `--objects`
run creates that key in Garage (`commonair-object-backup`) and keeps it in the env file as
`BACKUP_OBJECTS_SOURCE_ACCESS_KEY_ID` and `BACKUP_OBJECTS_SOURCE_SECRET_ACCESS_KEY`. If the env
file names a key that Garage does not know (an env file restored onto a new server), it creates
a new one.

#### Objects in an external store

rclone reads the store at `S3_ENDPOINT` with the instance's own keys, the main key for media and
the evidence key for evidence (`sync` never writes to its source). Better, create a key that can
only read those two buckets and set it as `BACKUP_OBJECTS_SOURCE_ACCESS_KEY_ID` and
`BACKUP_OBJECTS_SOURCE_SECRET_ACCESS_KEY`. If the server reaches the store at another address
than the containers do, set `BACKUP_OBJECTS_SOURCE_ENDPOINT`.

#### Comparison and encryption

rclone compares objects by hash and size (`--checksum`): S3 listings carry an MD5 for most
objects, so it needs no request per object to decide what changed. Objects uploaded in parts
have no MD5 both sides share, and rclone compares those by size.

`--objects` does not encrypt media on the way. If you do not trust the offsite store with it,
copy by hand ([Without the script](#without-the-script)) through an
[rclone crypt](https://rclone.org/crypt/) remote instead. Sealed evidence is encrypted either way.

### Set it up: DigitalOcean Spaces

An example for an instance on a droplet in `NYC3`, with the copy in Amsterdam:

1. **A bucket.** In the control panel, create a Spaces bucket in `AMS3` (a region other than the
   droplet's), with file listing restricted and no CDN, say `stream-example-org-offsite`. It can
   hold the WAL-G backups too, under another prefix (`WALG_S3_PREFIX=s3://<bucket>/wal`).
2. **A key limited to it.** Under Spaces Object Storage, Access Keys, create a key with limited
   access: read, write and delete on that bucket only. The secret is shown once.
3. **The settings.** As `commonair`, add to `~/.config/commonair/commonair.env`:

   ```sh
   BACKUP_OBJECTS_REMOTE_ENDPOINT=https://ams3.digitaloceanspaces.com
   BACKUP_OBJECTS_REMOTE_REGION=ams3
   BACKUP_OBJECTS_REMOTE_BUCKET=stream-example-org-offsite
   BACKUP_OBJECTS_REMOTE_PREFIX=objects
   BACKUP_OBJECTS_REMOTE_ACCESS_KEY_ID=<Spaces access key>
   BACKUP_OBJECTS_REMOTE_SECRET_ACCESS_KEY=<Spaces secret key>
   ```

4. **rclone.** As root: `apt install rclone` (Debian) or `dnf install rclone` (Fedora).
5. **The first copy**, as `commonair`:

   ```sh
   sh ~/commonair/selfhost.sh backup --objects
   ```

   The first run copies everything and can take a while; later runs copy only what changed. Its
   success turns on `commonair-object-backup.timer`, which runs the same command daily at 04:00
   UTC (an hour after the base backup, so the two do not compete for the disk), and at the next
   boot if the server was off then. `systemctl --user list-timers` shows the next run. A failed
   run shows in `systemctl --user status commonair-object-backup.service` and its journal, and
   `status` keeps showing the last success.

Every setting:

| Key                                       | Meaning                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- |
| `BACKUP_OBJECTS_REMOTE_ENDPOINT`          | The offsite store's S3 endpoint, `https://host[:port]`. Required                         |
| `BACKUP_OBJECTS_REMOTE_REGION`            | The region it signs requests for (`ams3`, or `garage` for a Garage). Required            |
| `BACKUP_OBJECTS_REMOTE_BUCKET`            | Its bucket. Required                                                                     |
| `BACKUP_OBJECTS_REMOTE_ACCESS_KEY_ID`     | A key for that bucket with read, write and delete. Required                              |
| `BACKUP_OBJECTS_REMOTE_SECRET_ACCESS_KEY` | Its secret. Required                                                                     |
| `BACKUP_OBJECTS_REMOTE_PREFIX`            | A path inside the bucket. Default: none (`<bucket>/media`, `<bucket>/evidence`)          |
| `BACKUP_OBJECTS_REMOTE_PATH_STYLE`        | `true` (default) or `false`: path-style or virtual-hosted URLs. Spaces accepts both      |
| `BACKUP_OBJECTS_REMOTE_ALLOW_HTTP`        | `true` accepts an `http://` endpoint, for a store on a trusted network. Default refused  |
| `BACKUP_OBJECTS_BWLIMIT`                  | rclone's bandwidth limit for every run, as for `--bwlimit`. Default: none                |
| `BACKUP_OBJECTS_MAX_DELETE`               | Most objects a run may delete from each bucket's copy, or `off`. Default: 1000           |
| `BACKUP_OBJECTS_SOURCE_ACCESS_KEY_ID`     | The key that reads the instance's buckets (Garage: created by the first run)             |
| `BACKUP_OBJECTS_SOURCE_SECRET_ACCESS_KEY` | Its secret                                                                               |
| `BACKUP_OBJECTS_SOURCE_ENDPOINT`          | External store only: where the server reaches it, if not at `S3_ENDPOINT`                |
| `BACKUP_DUMP_KEEP`                        | Complete logical dumps kept ([Logical dumps](#logical-dumps)). Default 30; fewer refused |

No container receives these keys: only `selfhost.sh` reads them. A
second Garage node works as the offsite store as well, with its own endpoint, region `garage` and
a key with read and write on its bucket.

To stop the daily copy: `systemctl --user disable --now commonair-object-backup.timer`. A later
`backup --objects` by hand leaves it off.

### Restore objects

`selfhost.sh backup --restore-objects` copies the offsite copy back into the instance's media
and evidence buckets, with the instance's own keys, which can write (the backup key cannot): the
main S3 key for media, the evidence key for evidence. It uses `rclone copy`, not `sync`, so it
deletes nothing on the instance, and running it again copies only what is still missing or
different.

Only one `--objects` or `--restore-objects` runs at a time: each takes a lock
(`~/.local/state/commonair/object-backup.lock`), and the other, the daily timer's run included,
is refused while it is held. A lock left by a run that was killed is taken over. From the start
of a restore until it succeeds, `--objects` is refused too
(`~/.local/state/commonair/object-restore-incomplete`): the instance may still lack objects the
copy has, and a sync would delete them from the copy. If a restore fails, run it again until it
succeeds. You need not stop the timer for a restore, though on a server that lost objects you
may want to anyway: `systemctl --user stop commonair-object-backup.timer`, and `start` it again
afterwards.

On a new server, run it after the [restore onto a new server](#onto-a-new-server), once the
instance runs: its Garage then has both buckets and the keys from your env file, which also
holds the `BACKUP_OBJECTS_REMOTE_*` settings. Install rclone first.

```sh
sh ~/commonair/selfhost.sh backup --restore-objects
```

Sealed evidence is readable again only with the `EVIDENCE_PRIVATE_KEY` of the env file it was
sealed with. With an external store, you need this only if the store itself lost the objects.

### Without the script

The same copy by hand, for a store `selfhost.sh` does not handle or to add an rclone crypt
layer. With an external store there is no `commonair-garage` container: create a read-only key
for the two buckets at your provider, and point the source remote below at the store's
endpoint, region and path style instead. With Garage, as `commonair`, create the read-only key in
the local Garage and allow it to read the two
buckets (with your bucket names, if the env file sets others):

```sh
podman exec commonair-garage /garage key create commonair-object-backup
podman exec commonair-garage /garage bucket allow --read commonair-media --key commonair-object-backup
podman exec commonair-garage /garage bucket allow --read commonair-evidence --key commonair-object-backup
```

The first command prints the `Key ID` and the `Secret key`. To see them again, run
`podman exec commonair-garage /garage key info --show-secret commonair-object-backup`. Each
command also logs two `INFO` lines about its connection to the node, which you can ignore.

Write `~/.config/rclone/rclone.conf` with one remote for each side, readable only by `commonair`
(`chmod 600`):

```ini
[garage]
type = s3
provider = Other
endpoint = http://127.0.0.1:3900
region = garage
force_path_style = true
access_key_id = <Key ID of commonair-object-backup>
secret_access_key = <its Secret key>
no_check_bucket = true

[offsite]
type = s3
provider = Other
endpoint = https://ams3.digitaloceanspaces.com
region = ams3
force_path_style = true
access_key_id = <key>
secret_access_key = <secret>
no_check_bucket = true
```

`no_check_bucket` on both stops rclone from trying to create a bucket, which a key limited to
one bucket cannot do. Copy, with your bucket name in place of `<bucket>`:

```sh
rclone sync --checksum garage:commonair-media offsite:<bucket>/media
rclone sync --checksum garage:commonair-evidence offsite:<bucket>/evidence
```

Run those from a systemd user unit and timer of your own. Do not start their names with
`commonair-`: `selfhost.sh install` and `upgrade` remove every `commonair-*` unit in
`~/.config/systemd/user/` that the release does not ship. To restore by hand, give the `garage`
remote keys that can write, from the env file, for that run only:

```sh
ENV=~/.config/commonair/commonair.env
RCLONE_CONFIG_GARAGE_ACCESS_KEY_ID=$(sed -n 's/^S3_ACCESS_KEY_ID=//p' "$ENV") \
RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY=$(sed -n 's/^S3_SECRET_ACCESS_KEY=//p' "$ENV") \
  rclone copy offsite:<bucket>/media garage:commonair-media
RCLONE_CONFIG_GARAGE_ACCESS_KEY_ID=$(sed -n 's/^S3_EVIDENCE_ACCESS_KEY_ID=//p' "$ENV") \
RCLONE_CONFIG_GARAGE_SECRET_ACCESS_KEY=$(sed -n 's/^S3_EVIDENCE_SECRET_ACCESS_KEY=//p' "$ENV") \
  rclone copy offsite:<bucket>/evidence garage:commonair-evidence
```

## Logical dumps

`selfhost.sh backup --dump` runs `pg_dump` (custom format) as the database's owner, from the
release's Postgres image, over the same verified TLS the services use, and streams it through
rclone into the offsite store of [Objects](#objects):

```text
<bucket>[/<prefix>]/dumps/<UTC date>/commonair.dump          the dump
<bucket>[/<prefix>]/dumps/<UTC date>/counts.json             row counts, ledger balances, follower check
<bucket>[/<prefix>]/dumps/<UTC date>/commonair.dump.sha256   its SHA-256, written last
```

- **Consistent.** The counts and the dump are taken in one snapshot, so the drill compares a
  restore with exactly what was dumped, on a live instance.
- **Streamed, never staged.** The checksum and the size are taken on the way. If `pg_dump` or the
  upload fails, the partial object is deleted and nothing stays on the server; the previous dumps
  are untouched. A directory without its `.sha256` is an incomplete dump and never counts.
- **30 kept** (ADR 0032 §4). After each dump, retention deletes the dumps older than the newest
  30 complete ones, and leftovers of failed runs older than those. While 30 or fewer exist it
  deletes nothing. It counts dumps, not days, so gaps (a server that was off) never shorten the
  history. `BACKUP_DUMP_KEEP` keeps more; fewer than 30 is refused. With versioning on the
  bucket (the tofu module's `object_backups` bucket has it), a deleted dump stays recoverable as a
  noncurrent version for `backup_noncurrent_days`.
- **Private.** A dump holds personal data. `--dump` refuses a bucket that lists its contents
  without a key, and one whose objects can be read without a key (it writes and reads back a
  probe object first). Keep the bucket private, in another region than the server, with a key
  limited to it.
- **One at a time.** A dump, a drill and an upgrade take one lock
  (`~/.local/state/commonair/db-backup.lock`): a schema change while `pg_dump` runs can fail it,
  so the nightly dump never overlaps a migration. A lock left by a killed run is taken over.
- **Nightly.** `commonair-dump.timer` runs it at 02:00 UTC plus up to 50 minutes. It is enabled at
  install with an external Postgres; with the bundled one, the first successful `--dump` turns it
  on (and `systemctl --user disable --now commonair-dump.timer` turns it off). A failed run shows
  in `systemctl --user status commonair-dump.service` and its journal; `status` keeps the last
  success.

It needs the [Objects](#objects) settings and rclone, nothing else: no key goes to the container
but the owner's URL, from its Podman secret. With the bundled Postgres the owner is `commonair`;
with an external one, the `--database-url` user. The image's `pg_dump` is version 17, which
refuses to dump a newer server: an external Postgres 18 needs a release built on 18 first.

## Restore

Two ways back, one per kind of backup:

- **From WAL-G** (the bundled Postgres): below. It restores the newest base backup and replays the
  archive, to the last minute or to a point in time, into this instance's own volume.
- **From a dump** (an external Postgres, another provider, or a bundled instance that lost its
  WAL-G backups): [managed-services.md, "Restore into a new cluster"](managed-services.md#restore-into-a-new-cluster).
  It restores the night's dump as an owner with no superuser, through the owner-only order, into
  a new, empty database, and checks the counts before the instance uses it.

With an external Postgres, the provider's point-in-time recovery comes first, and a dump is for
when it cannot help.

### Restore from WAL-G

`commonair-restore` (in the `postgres` image) fetches a base backup into an **empty** data
directory and prepares WAL replay. The next Postgres start replays the archive and promotes.
It refuses a data directory that is not empty.

These steps replace the database of the instance you run them on. As `commonair`:

```sh
# 1. Stop everything, then start only Garage (needed when backups are in the local Garage;
#    skip the second command on an instance with an external store).
systemctl --user stop 'commonair-*'
systemctl --user start commonair-garage.service

# 2. Keep a copy of the current data, then empty the volume.
podman volume export commonair-postgres-data --output ~/postgres-data-before-restore.tar
podman volume rm commonair-postgres-data
podman volume create commonair-postgres-data

# 3. Restore the newest base backup into it, with the keys the Postgres unit gets from the env
#    file (written fresh, so a just-replaced env file counts). They name the store WAL-G reads:
#    Garage, the external store, or your AWS_* location.
PG_IMAGE=$(sed -n 's/^Image=//p' ~/commonair/quadlet/commonair-postgres.container)
PG_ENV=~/.config/commonair/unit-env/commonair-postgres.env
sh ~/commonair/scripts/selfhost/render-env.sh ~/commonair/infra/selfhost/env/commonair-postgres.keys \
  ~/.config/commonair/commonair.env "$PG_ENV"
podman run --rm --network commonair \
  --env-file "$PG_ENV" \
  -v commonair-postgres-data:/var/lib/postgresql/data \
  "$PG_IMAGE" commonair-restore

# 4. Start Postgres on its own. It replays the archived WAL, then accepts connections;
#    this command returns once it does, which can take a while (see below).
systemctl --user start commonair-postgres.service

# 5. Start the instance again (migrations first, then every service).
sh ~/commonair/selfhost.sh install --reinstall
```

To restore a specific backup instead of the newest, pass its name (from `selfhost.sh backup`)
after the target directory: `commonair-restore /var/lib/postgresql/data <backup-name>`. For a
point in time, add `-e RECOVERY_TARGET_TIME='2026-10-18 12:00:00+00'` to the `podman run`.

The replay in step 4 takes as long as the archive after the base backup needs: seconds for a
recent backup, possibly hours for an old one. You need to do nothing while it runs. Watch it in
another terminal:

```sh
journalctl --user -fu commonair-postgres
```

Each `restored log file "…" from archive` line is one replayed WAL segment (16 MB). The replay
is over at `database system is ready to accept connections`.

`commonair-postgres` waits as long as the replay keeps advancing. If no new segment has been
replayed for 10 minutes (a fetch from the backup bucket that hangs, say), it stops Postgres and
starts it again, which resumes the replay from its last restartpoint; a start that has not
finished after 12 hours fails the same way. A fetch that fails outright (the bucket refuses the
connection, the key is wrong) stops Postgres at once with `commonair-wal-fetch: … stopping
recovery instead of promoting early` in the journal, and it restarts and retries the same way.
The replay ends only when the archive has no next segment, never because the bucket failed.
Step 4 then returns an error: check the journal, fix the cause and run step 4 again. Do not skip
it: `selfhost.sh install` gives Postgres only 15 minutes.

### Onto a new server

When the old server is gone:

1. Install the **same version** on the new server ([install.md](install.md)), with the same
   `--domain`.
2. As `commonair`, replace `~/.config/commonair/commonair.env` with your offline copy. It holds
   the database passwords the restored database expects, the `AWS_*` settings of your off-host
   backups and the `BACKUP_OBJECTS_REMOTE_*` settings of your object backups.
3. Run the [restore](#restore-from-wal-g) from step 1 on.
4. As root, install rclone; then, as `commonair`, restore the objects
   ([Restore objects](#restore-objects)):
   `sh ~/commonair/selfhost.sh backup --restore-objects`.

   With an external store (`S3_MODE=external`), install in step 1 **without** the `--s3-*`
   flags: the new server then archives its WAL to its own Garage, not into the old server's
   backups bucket. The env file of step 2 carries `S3_MODE=external` and the store's keys, and
   the restore's `install --reinstall` switches the instance to the store and drops Garage's
   unit. Skip `--restore-objects` while the store still holds the buckets.

5. Once the restore checks out, take a first object backup from the new server
   (`selfhost.sh backup --objects`), which turns its daily timer on.

Then point DNS at the new server.

## The restore drill

**An untested backup does not count.** Two drills run on their own every week, on the instance's
own server, and a full drill onto a scratch server proves the rest: run that one at least before
launch and after changing anything about backups.

### Automatic restore drills

Each restores the newest backup into a **throwaway** Postgres container on this server, checks
it, and removes the container and its volume. Neither ever connects to the live database: the
throwaway server listens on no TCP port (only on a Unix socket inside its container, and refuses
host logins), and every check runs inside that container, after it has proved that the server it
reaches is the one whose data directory holds the drill's marker.

| Drill                        | Timer                                                                       | What it restores, and how                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `selfhost.sh backup --drill` | `commonair-drill.timer`, weekly (Sunday 05:00 UTC +1h)                      | the newest complete dump: its SHA-256 first, then the owner-only order as an owner with no superuser, in a container with no network       |
| `backup --drill --walg`      | `commonair-drill-walg.timer`, weekly (Saturday 05:00 UTC +1h, bundled only) | the newest WAL-G base backup and its archive, replayed with archiving off; on the `commonair` network only to fetch from the backup bucket |

Then the checks, as `infra/postgres/dump-drill.sh` runs them, printing check names and numbers,
never a row:

- **row counts per table**, against the dump's `counts.json` (dump drill only);
- **`follows.count_mismatch` = 0**: every channel's `follower_count` equals its counted follows
  that are not excluded. A restore that loaded the data with the triggers on would double them;
- **each ledger transaction balances per currency**, and every currency's balance is 0;
- **no `SECURITY DEFINER` function is executable by `PUBLIC`**: the grants came back, not
  dropped;
- for WAL-G, that the restored database has its migrations.

Before it starts, a drill checks the free disk where Podman keeps volumes: three times the dump's
size, or twice the live data directory's for WAL-G, and refuses with a `fix:` line if there is
not enough. A dump whose checksum fails is never restored. A failed check fails the drill.

Each drill records its result in `~/.local/state/commonair/restore-drill-dump` or
`restore-drill-walg` (`status` shows them), and pushes two gauges to the metrics collector, with
`kind="dump"` or `kind="walg"`: `commonair_restore_drill_success` (1 or 0) and, after a success,
`commonair_restore_drill_seconds`, which the restore-time alert reads
([monitoring.md](../operators/monitoring.md#metrics-pushed-by-jobs)). A failed drill raises
[CommonairRestoreDrillFailed](../operators/monitoring.md#commonairrestoredrillfailed), and a drill
that stops reporting for 8 days raises
[CommonairRestoreDrillOverdue](../operators/monitoring.md#commonairrestoredrilloverdue).

`commonair-drill-walg.timer` is on with the bundled Postgres. `commonair-drill.timer` is on with
an external one; with the bundled one, the first successful `backup --drill` turns it on. The
two run on different days (Saturday and Sunday), since one drill at a time holds the database
lock. Like `commonair-backup.timer`, the drill timer for your mode is turned on again by every
`install --reinstall` and `upgrade`: `systemctl --user disable --now commonair-drill-walg.timer`
lasts until then.

### The full drill onto a scratch server

It checks what the automatic drills cannot: the whole instance, objects included, on another
server, and how long that takes. With an external Postgres, the restore into a new managed
cluster is in [managed-services.md](managed-services.md#restore-into-a-new-cluster).

The drill reads the backups over the network, so they must be [off the server](#off-host-s3):
production's local Garage listens only on its own `127.0.0.1`. The drill runs a full copy of
production: real accounts, queued notifications and simulcast targets. Keep it from reaching
anyone, and keep it from writing to your backups.

#### Read-only keys for the drill

Create keys that can read the backups and do nothing else: one for the WAL-G bucket (the bucket
of your `WALG_S3_PREFIX`) and, if the object copy is in another bucket, one for that
(`BACKUP_OBJECTS_REMOTE_BUCKET`). On production, as `commonair`, this prints both:

```sh
ENV=~/.config/commonair/commonair.env
sed -n 's|^WALG_S3_PREFIX=s3://\([^/]*\).*|\1|p' "$ENV"
sed -n 's/^BACKUP_OBJECTS_REMOTE_BUCKET=//p' "$ENV"
```

With DigitalOcean Spaces, create a key with limited access and only read permission on that
bucket (or those buckets). On a second Garage node that runs as a `commonair-garage` container,
as `commonair` there, with the bucket printed above:

```sh
BUCKET=<the WAL-G bucket>
podman exec commonair-garage /garage key create commonair-restore-drill
podman exec commonair-garage /garage bucket allow --read "$BUCKET" --key commonair-restore-drill
```

The first command prints the `Key ID` and the `Secret key` (later:
`podman exec commonair-garage /garage key info --show-secret commonair-restore-drill`). Keep the
key for the next drill, or delete it afterwards with
`podman exec commonair-garage /garage key delete --yes commonair-restore-drill`. With another
provider, create a key with read access to the bucket only, if it offers one. If it does not,
the drill uses your production key, and only the steps below that turn off archiving and the
backup timers protect your backups: do not skip them.

#### Run the drill

Write down the time at each step marked **(time)**: the drill's record is how long the database
restore, the object restore and the whole drill took.

1. **(time: start)** Install the same version on a throwaway server or VM, with `--tls internal`
   and a hostname of its own, such as `drill.example.org`. Turn off its daily backup at once,
   before it can run with the settings you are about to copy in:
   `systemctl --user disable --now commonair-backup.timer`. Its retention cleanup deletes old
   base backups, and with your production settings those would be production's.
2. Copy your env file over the new one, then change it before anything starts:
   - Set `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` to the drill's read-only key, and
     `BACKUP_OBJECTS_REMOTE_ACCESS_KEY_ID` and `BACKUP_OBJECTS_REMOTE_SECRET_ACCESS_KEY` to the
     read-only key of the object copy's bucket. Never run `selfhost.sh backup --objects` on the
     drill: `rclone sync` would make production's copy match the drill's buckets, deleting
     whatever the drill lacks. With a read-only key it cannot.
   - Point mail nowhere: `SMTP_HOST=localhost`, `SMTP_PORT=1025`, `SMTP_USER=` and
     `SMTP_PASSWORD=` (nothing listens there, so sending fails). Otherwise the worker sends
     queued notifications to real members with your production credentials.
   - Turn off payments: `PAYMENTS_PROVIDER=manual` and `STRIPE_SECRET_KEY=`.
3. Turn off WAL archiving on the drill's Postgres with a Quadlet drop-in, which replaces the
   image's command (`archive_mode=on` and WAL-G's `archive_command`):

   ```sh
   mkdir -p ~/.config/containers/systemd/commonair-postgres.container.d
   printf '[Container]\nExec=postgres -c archive_mode=off\n' \
     > ~/.config/containers/systemd/commonair-postgres.container.d/drill.conf
   systemctl --user daemon-reload
   ```

   Once the restored database promotes, it starts a new timeline and would archive it into the
   same `WALG_S3_PREFIX` it replays from. With a key that can write, that puts the drill's WAL
   and timeline history into production's archive, and a later restore of production follows
   the newest timeline: the drill's. With the read-only key every upload fails, and Postgres
   keeps each segment on disk and retries forever. A scratch `WALG_S3_PREFIX` is no way out:
   the replay fetches WAL through the same setting, so it would find no archive to replay.
   `selfhost.sh install` keeps drop-in directories, so this one stays through the reinstall
   below.

4. **(time: database restore starts)** Run the [restore](#restore-from-wal-g) from step 1 on, but replace
   its step 5 with a reinstall that keeps the drill's hostname and TLS mode (the copied env file
   holds production's):

   ```sh
   sh ~/commonair/selfhost.sh install --reinstall --domain drill.example.org --tls internal
   ```

   **(time: database restore done)** when it reports the instance running. The reinstall
   enables the daily base backup again, so turn it off again:
   `systemctl --user disable --now commonair-backup.timer`. If you only need to look at data,
   also stop the worker: `systemctl --user stop commonair-worker.service`.

5. **(time: object restore starts)** As root, install rclone; then, as `commonair`:

   ```sh
   sh ~/commonair/selfhost.sh backup --restore-objects
   ```

   **(time: object restore done)** when it returns. `commonair-object-backup.timer` stays off:
   only a successful `backup --objects` turns it on.

6. Sign in on the drill instance (trust its root first, [tls.md](tls.md#internal-ca)) and check
   recent data: the newest accounts, streams and ledger entries, and that recent avatars,
   thumbnails and VODs load. Do not go live on it: the restored simulcast targets would push
   the stream to real third-party platforms. **(time: end)**
7. Write down the date, the base backup restored, the three times (database restore, object
   restore, total from start to end), and anything that went wrong. Then delete the server.

Contributors can run the automated drill against a development stack with
`bun harness/src/cli.ts run backup-restore` (see `harness/README.md`).
