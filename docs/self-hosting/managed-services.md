<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Managed Postgres and Valkey

**The bundled install is the default, and most instances should keep it.** `selfhost.sh install`
runs Postgres (with WAL-G backups) and Valkey in containers on the instance's host, and nothing on
this page applies to it.

This page is the option: running the instance against external Postgres and Valkey servers, such
as a managed service, with `selfhost.sh install --database-url … --valkey-url …`. It is written
as a procedure, because it is the one our own production instance follows (ADR 0032, stage 1).
DigitalOcean is the worked example; nothing in the code is specific to it.

Read first: [requirements.md](requirements.md#external-postgres-and-valkey) (what the servers
need) and [configuration.md](configuration.md#postgres-and-valkey) (the flags, keys and secrets).

## What the servers must offer

From ADR 0032 §3; the install's preflight checks each item it can before anything is installed.

- **PostgreSQL 17 or 18** (releases are tested on 17), with TLS and certificate verification
  (`sslmode=verify-full`, the provider's CA if it is not publicly trusted).
- **An owner role with `CREATEROLE`** that owns the database, or may create in it and in its
  `public` schema. No superuser, extension or event trigger is needed: `migrate` creates the
  tables, functions and triggers and the `commonair_app` and `commonair_monitor` roles as that
  owner. A restore needs no superuser either ([Restore into a new cluster](#restore-into-a-new-cluster)).
- **Enough connections** for the services' pools ([the connection budget](requirements.md#connection-budget)).
- **Valkey (or Redis-compatible)** with a password, TLS (`rediss://`), `maxmemory-policy
  noeviction` and persistence on. No `CONFIG` or `ACL` command is sent at runtime.
- **An S3 bucket in another region** for the nightly dumps, private
  ([Dumps and drills](#dumps-and-drills)).

## Set it up (any provider)

1. **Create the servers**: a PostgreSQL cluster and a Valkey cluster, each with a standby if the
   provider offers one, reachable from the instance's host only (a private network, or the
   provider's trusted-sources list).
2. **The owner**: a role with `LOGIN` and `CREATEROLE` that owns an empty database for the
   instance (`CREATE DATABASE commonair OWNER <owner>`, or the provider's console).
3. **The CA**: download the provider's CA certificate if the server's certificate is not
   publicly trusted. It goes to `--database-ca` (and `--valkey-ca` if Valkey's needs one too).
4. **The connection budget**: as the owner, `SHOW max_connections;`. The preflight compares it
   with `DATABASE_POOL_MAX` × 5 + 4 and prints the largest pool size that fits; set
   `DATABASE_POOL_MAX` in `install`'s environment if the default (10) does not.
5. **Install**, as `commonair` on the instance's host, with the passwords in the environment
   (never on the command line or in the URL):

   ```sh
   read -rs DATABASE_PASSWORD && export DATABASE_PASSWORD   # the owner's
   read -rs VALKEY_PASSWORD && export VALKEY_PASSWORD
   sh ~/commonair/selfhost.sh install --version vX.Y.Z --domain stream.example.org --email ops@example.org \
     --database-url 'postgres://<owner>@<host>:<port>/commonair?sslmode=verify-full' --database-ca ~/pg-ca.crt \
     --valkey-url 'rediss://[<user>@]<host>:<port>'
   unset DATABASE_PASSWORD VALKEY_PASSWORD
   ```

6. **The dump store**: the `BACKUP_OBJECTS_REMOTE_*` settings of [backups.md](backups.md#objects)
   (a private bucket in another region, a key limited to it) and rclone on the host. Then take
   the first dump and drill it:

   ```sh
   sh ~/commonair/selfhost.sh backup --dump
   sh ~/commonair/selfhost.sh backup --drill
   ```

7. **Check**: `selfhost.sh status` shows `state: external …`, both servers `external` with TLS
   verified, `last dump:` with a time and size, and `last restore drill:` passed.
   `systemctl --user list-timers` shows `commonair-dump.timer` (nightly) and
   `commonair-drill.timer` (weekly).

## DigitalOcean (the worked example)

Our production instance runs this way. OpenTofu creates the clusters
(`infra/tofu/digitalocean/modules/instance/managed_state.tf`, on with `enable_managed_state`,
which production sets by default); `selfhost.sh install` points the instance at them.

**What the tofu module creates, and why** (`managed_state.tf`, and `backups.tf` for the dump store):

| Resource                                                   | Setting                                           | Why                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `digitalocean_database_cluster.pg`                         | `engine = "pg"`, `version = 17`, `node_count = 2` | a primary and one standby: DigitalOcean's 99.95% SLA, failover in 5–10 s                         |
| `digitalocean_database_cluster.valkey`                     | `node_count = 2`                                  | the same for Valkey                                                                              |
| `digitalocean_database_valkey_config`                      | `noeviction`, `persistence = "rdb"`, `ssl`        | BullMQ requires `noeviction`; RDB keeps queued jobs across a restart                             |
| `digitalocean_database_firewall` (both)                    | one rule, `type = "tag"`, the env's app tag       | trusted sources: only droplets tagged `commonair-<env>-app` connect; no VPC rule type exists     |
| both clusters                                              | `private_network_uuid` = the app VPC              | the instance connects over the private network (`managed_state_secrets.pg_owner_uri` is private) |
| `digitalocean_spaces_bucket.instance`                      | media, exports, evidence in the app region        | the objects ([object-storage.md](object-storage.md))                                             |
| `digitalocean_spaces_bucket.object_backups` (`backups.tf`) | private, versioned, in `backup_region`            | the offsite copy of the objects, and the dumps under `<prefix>/dumps`                            |

**The procedure:**

1. `tofu apply` with `enable_managed_state = true` and `instance_origin` set (production's
   default). `tofu output -json managed_state` gives the hosts and ports;
   `tofu output -json managed_state_secrets` the owner URI (`doadmin`, private network) and the
   Valkey URI. Take the passwords from those URIs and keep them out of shell history.
2. **The owner is `doadmin`.** It has `CREATEROLE`, `CREATEDB`, `REPLICATION` and `BYPASSRLS`, but
   is no superuser, which is all the instance needs. Create the database once:
   `CREATE DATABASE commonair;` as `doadmin` (in `defaultdb`).
3. **Standard edition, with the downloaded CA** (ADR 0032, "Consequences"). Download it from
   the cluster's Overview page (Connection details, "Download CA certificate"), or from the API
   (`GET /v2/databases/<cluster-uuid>/ca`, base64 in `ca.certificate`). Advanced edition's
   `sslrootcert=system` needs libpq 16 or later in every client; our images have it, but our
   instance starts on Standard.
4. **The connection limit at the chosen size.** DigitalOcean sets `max_connections` by node size
   and reserves three: the 1 GB node allows 22, enough only for `DATABASE_POOL_MAX=3`. The tofu
   default, `db-s-1vcpu-2gb` (a standby needs at least that), allows 50, so 47 for us (measured
   2026-11-04): the default pool of 10 needs 54 and the preflight refuses it. Install with
   `DATABASE_POOL_MAX=8` in the environment (44 needed). An idle instance used 22. A larger node
   may be needed for connections alone, before the data needs it.
5. **Valkey's certificate is publicly trusted** (Let's Encrypt, `*.i.db.ondigitalocean.com`;
   measured 2026-11-04). The CA from the control panel or `get-ca` is the project CA, which signs
   only the Postgres certificates: given to `--valkey-ca`, verification fails. Leave
   `--valkey-ca` out (the system's CAs are used).
6. **Valkey has no ACL users**: the `acl` command is restricted, so the instance uses the
   `default` user with the cluster's password: `--valkey-url rediss://default@<private host>:<port>`
   (or without `default@`). `VALKEY_MONITOR_USER` stays empty.
7. Install as in step 5 above, with `--database-url 'postgres://doadmin@<private host>:25060/commonair?sslmode=verify-full'`
   and `--database-ca` the downloaded certificate.
   **Objects in Spaces: not tried end to end yet** (the 2026-11-04 run used bundled Garage).
   Give `S3_EVIDENCE_*` the evidence key from `managed_state_secrets.evidence_*`, not the
   instance key: storage-init refuses two equal keys. storage-init also checks a fourth,
   `backups` bucket at the S3 endpoint unless `AWS_ENDPOINT` or `WALG_S3_PREFIX` is set, and
   stage 1 creates no such bucket; that gap is open.
8. **The dump store** is the `object_backups` bucket tofu creates in `backup_region` (another
   region than the droplet's, private, versioned, with `object_backups_key` limited to it):
   `BACKUP_OBJECTS_REMOTE_ENDPOINT` and `_REGION` from `tofu output backups`, `_BUCKET` its
   `object_backups_bucket`, and the key from `tofu output -json object_backups_key`. The same
   bucket holds the object copy (`<prefix>/media`, `<prefix>/evidence`) and the dumps
   (`<prefix>/dumps`).

## What the provider backs up, and what it does not

| What                                   | Backed up by                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Postgres                               | DigitalOcean: daily full backups plus WAL, point-in-time recovery for **7 days**, into a new cluster |
| Postgres, beyond 7 days or the account | our nightly dump, 30 kept, in another region ([Dumps and drills](#dumps-and-drills))                 |
| Valkey                                 | **nothing**: no backups or restores. It holds only queues, sessions and caches, by design            |
| Media and evidence in Spaces           | not backed up by Spaces: `selfhost.sh backup --objects` copies them to `backup_region`               |
| `commonair.env` and the CA files       | you: keep an offline copy ([backups.md](backups.md#what-is-not-backed-up))                           |

WAL-G does not run against a managed database: there is no access to its WAL. The provider's
point-in-time recovery is the first line; the dumps guarantee that no restore depends on one
provider or one account.

## Dumps and drills

`selfhost.sh backup` with an external Postgres takes a dump (the same as `backup --dump`):
`pg_dump` in custom format, as the owner, over verified TLS, from the release's Postgres image,
streamed through rclone into `<bucket>/<prefix>/dumps/<UTC date>/` with its `counts.json` and
`commonair.dump.sha256`. `commonair-dump.timer` runs it nightly, `commonair-drill.timer` restores
the newest one into a throwaway container weekly and checks it. [backups.md](backups.md#logical-dumps)
has the details: the 30 kept, the checksum, the lock with `upgrade`, and what the drill checks.

**Dumps contain personal data.** The bucket must be private; `backup --dump` refuses a bucket that
lists its contents without a key, or whose objects can be read without one.

## Restore into a new cluster

This is the real disaster restore (the provider's point-in-time recovery cannot help: the
account, the region or the backups are gone), and the managed-cluster drill: the same procedure,
run once on the staging project and timed.

**Our instance's restore time** (agent track U5, 2026-11-04, ADR 0032 §1): a fresh two-node
cluster was online in 9 min 40 s, and steps 3 and 4 took 2 min 26 s for a small (735 KB) dump,
with every count equal. So about 13 minutes to restored data, plus step 5. The restore step grows
with the dump: time it again at the instance's real size.

Write down the time at each step marked **(time)**.

1. **(time: start)** Create a fresh cluster: in staging, `tofu apply` with
   `enable_managed_state = true`; in a disaster, the same module in a new region or account, or
   the provider's console. The same major version (17). Download its CA. Create the database as
   above (`CREATE DATABASE commonair;` as `doadmin`): it must be new and empty.
2. **Fetch the newest dump** and check it, as `commonair` on a host with rclone and the
   `BACKUP_OBJECTS_REMOTE_*` settings (the instance's, or a new droplet with the offline copy of
   `commonair.env`):

   ```sh
   D=$(date -u +%Y-%m-%d)   # or the date you restore from: rclone lsf off:<bucket>/<prefix>/dumps
   mkdir -p ~/restore && cd ~/restore
   rclone copy "off:<bucket>/<prefix>/dumps/$D" .
   sha256sum -c commonair.dump.sha256
   ```

   (`off` is a remote for the dump store: [backups.md](backups.md#without-the-script) shows one.)
   Stop if the check fails: take the day before.

3. **(time: restore starts)** Restore as the owner, through the owner-only order
   (`infra/postgres/dump-restore.sh` in the Postgres image: the roles the grants name, pre-data,
   user triggers off, data, triggers on, post-data). The URL, with the password, goes in a Podman
   secret, never on the command line:

   ```sh
   PG_IMAGE=$(sed -n 's/^Image=//p' ~/commonair/quadlet/commonair-postgres.container)
   read -rs PW
   printf 'postgres://doadmin:%s@<new host>:25060/commonair?sslmode=verify-full' "$PW" |
     podman secret create commonair-restore-target -
   unset PW
   podman run --rm --secret commonair-restore-target,type=env,target=RESTORE_TARGET_URL \
     -v ~/restore:/restore:ro,Z -v ~/new-pg-ca.crt:/ca.crt:ro,Z -e PGSSLROOTCERT=/ca.crt \
     --entrypoint /usr/local/bin/commonair-dump-restore "$PG_IMAGE" /restore/commonair.dump
   ```

   **(time: restore done)** when it prints `done`. Percent-encode reserved characters in the
   password (`@ : / ? #`) first.

4. **Check the counts** against the dump's: every row count, the ledger balance per currency (0)
   and `follows.count_mismatch` (0), the checks the weekly drill runs:

   ```sh
   podman run --rm --secret commonair-restore-target,type=env,target=URL \
     -v ~/new-pg-ca.crt:/ca.crt:ro,Z -e PGSSLROOTCERT=/ca.crt --entrypoint sh "$PG_IMAGE" \
     -c 'psql -XqAt -F " " -d "$URL" -f /usr/local/share/commonair/restore-check.sql' | sort > got
   sed -n 's/^ *"\([^"]*\)": \(-\{0,1\}[0-9]*\),\{0,1\}$/\1 \2/p' counts.json | sort > want
   diff want got && echo "counts match"
   podman secret rm commonair-restore-target
   ```

   An empty `diff` is the pass. Anything else: stop, and do not point the instance at it.

5. **Point the instance at it.** `selfhost.sh` never moves an instance to another database on
   its own, so that nobody strands data by mistake. After a restore the data has moved, so, as
   `commonair`, edit `DATABASE_OWNER_URL` in `~/.config/commonair/commonair.env` to the new
   cluster's URL (without the password), then reinstall with the same URL and the new CA:

   ```sh
   read -rs DATABASE_PASSWORD && export DATABASE_PASSWORD
   sh ~/commonair/selfhost.sh install --reinstall \
     --database-url 'postgres://doadmin@<new private host>:25060/commonair?sslmode=verify-full' \
     --database-ca ~/new-pg-ca.crt
   unset DATABASE_PASSWORD
   ```

   `migrate` finds every migration applied and gives `commonair_app` and `commonair_monitor`
   their logins and passwords. On a new droplet, install with the offline copy of
   `commonair.env` (edited the same way) instead: it holds the session and signing keys and
   `EVIDENCE_PRIVATE_KEY`.

6. **(time: end)** `selfhost.sh status` is healthy; sign in and check recent data. Take a first
   dump from the new cluster (`selfhost.sh backup --dump`). Write down the dump's date, the three
   times and anything that went wrong; in staging, destroy the cluster afterwards.

## What a failover loses

Measured by the agent track (2026-11-04, ADR 0032 §1). The switch was a node resize, a planned
switch to new nodes; DigitalOcean offers no way to force a failover:

- **Postgres:** writes failed for 7.9 s, and none of 13,453 acknowledged writes was lost.
  Connections drop and the services reconnect; requests during those seconds fail and are retried
  by clients. A crash of the primary is not something we could trigger, and DigitalOcean does not
  document the standby as synchronous, so still assume that writes acknowledged in the last
  moments before an unplanned failover can be lost.
- **Valkey, measured:** `INCR`s failed for 5.9 s, and none of 13,438 acknowledged increments was
  lost.
- **Valkey:** rate-limit windows, a few seconds of chat fan-out, and queued jobs since the last
  persistence point. Jobs are at-least-once with idempotent handlers, so nothing durable is lost:
  the outbox, the ledger and every job's effects are in Postgres.
- **Neither** is a restore: a failover keeps the data and the URL.

## Moving between bundled and managed services

`selfhost.sh` refuses to switch an existing instance between bundled and external Postgres and
Valkey, in either direction: the switch moves the data, and that is a dump and a restore, done by
hand, in a maintenance window. From bundled to managed:

1. **A final dump in a maintenance window.** Announce the window, then stop what writes: as
   `commonair`, `systemctl --user stop commonair-caddy.socket commonair-caddy.service` (no
   traffic), wait for the worker's queue to drain, and take the dump:

   ```sh
   sh ~/commonair/selfhost.sh backup --dump
   ```

   It goes to the offsite store like any dump (set up the `BACKUP_OBJECTS_REMOTE_*` settings
   first if you have none). Keep the instance stopped from here on:
   `systemctl --user stop 'commonair-*'`.

2. **Restore it into the managed cluster through the owner-only order**:
   [Restore into a new cluster](#restore-into-a-new-cluster), steps 1 to 4, with today's dump.

3. **Reinstall with the external flags.** The env file still says bundled, which is what makes
   `install` refuse the switch. Now that the data is in the new cluster, you tell it so by hand:
   keep a copy of the env file, add the line `STATE_MODE=external` to
   `~/.config/commonair/commonair.env`, and reinstall with the passwords in the environment, as in
   [Set it up](#set-it-up-any-provider):

   ```sh
   cp -p ~/.config/commonair/commonair.env ~/commonair.env.bundled
   printf 'STATE_MODE=external\n' >> ~/.config/commonair/commonair.env
   sh ~/commonair/selfhost.sh install --reinstall --database-url … --database-ca … --valkey-url …
   ```

   The bundled Postgres and Valkey units are not installed any more; their volumes stay.

4. **Check the counts** (step 4 of the restore, if not done already), then `status`, a sign-in
   and recent data, and a first `backup --dump` and `backup --drill` against the new servers.
   Only then remove the old volume (`podman volume rm commonair-postgres-data`).

From managed back to bundled, the same way round: a final dump; then remove the `STATE_MODE` and
`DATABASE_OWNER_URL` lines from the env file and `install --reinstall` without the URL flags,
which installs an empty bundled Postgres; stop every unit but `commonair-postgres`, drop and
recreate its empty `commonair` database, and restore the dump into it with
`commonair-dump-restore` as `commonair`, the bundled owner, before the services start again.
