<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0032: Scaling and availability in stages

- Status: accepted (2026-10-27; see [Decisions at acceptance](#decisions-at-acceptance-2026-10-27));
  amended 2026-11-02 for U4 ([Decisions at acceptance (2026-11-02)](#decisions-at-acceptance-2026-11-02))
  and S1-d's findings (§3, §4)
- Date: 2026-10-26 (provider facts checked on 2026-10-26)

## Context

[ADR 0025](0025-hosting-on-digitalocean.md) runs our instance on one DigitalOcean droplet with
dedicated vCPUs, WAL-G to Spaces in another region, and a monitoring droplet. One host is a single
point of failure, so a tested restore is the launch blocker (ADR 0010's rule, kept). At
acceptance the maintainers settled four things this ADR builds on:

- 99.5% a month at launch, 99.9% once the database can fail over;
- at stage 1 our instance moves Postgres and Valkey to DigitalOcean's managed services and
  objects to Spaces;
- **`selfhost.sh` gains the same option for every operator**: an external Postgres, Valkey and
  S3 store from any provider, with documented requirements and a tested path. The single-host
  install stays the default;
- no provider is special-cased (ADR 0025 decision 1, AGENTS.md non-negotiable 3).

The code is mostly safe to run as replicas already:

- the worker outbox claims rows with `FOR UPDATE SKIP LOCKED` (`services/worker/src/outbox.ts:7`);
- recurring jobs are BullMQ job schedulers, one run per tick cluster-wide, and integrity jobs
  take a Valkey run lock;
- relay issuance elects one leader per tick in Valkey (`services/origin/src/issuance.ts`): the
  winner keeps the lock for its whole TTL, shorter than the tick interval, so a replica whose
  timer fires later in the same minute skips the tick; a failed tick releases the lock early for
  a retry;
- chat fans out over Valkey pub/sub;
- the API's rate limits live in Valkey;
- viewer counts come from Postgres and are cached in Valkey.

Three things are not replica-safe:

- **The P2P tracker keeps swarms in memory** (`services/tracker/src/swarm.ts:1-6`), so two
  trackers split them.
- **Chat's per-instance caches** (channel 60 s, profile 15 s, standing 30 s) are invalidated over
  at-most-once pub/sub, so a replica can be stale until the cache entry expires.
- **The harness never ran two of anything.** S1-c's `multi-instance` scenario now runs two of
  api, chat, worker and origin on one host (`harness/compose.multi-instance.yaml`); its findings
  are under [Notes from S1-c](#notes-from-s1-c).

Nothing measures host CPU, Postgres CPU or Valkey today. Prometheus scrapes only the OTel
collector, Garage, Loki, Tempo and itself, and the collector has no host or database receivers.
There are app metrics: origin egress bytes, HTTP durations, chat connections, worker queue depth
and outbox lag.

### DigitalOcean's managed services (checked 2026-10-26)

|                      | Managed PostgreSQL                                                                                                                                                                | Managed Valkey                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Versions             | 14–18 (Standard edition); 16–18 (Advanced)                                                                                                                                        | Valkey 8 and 9                                                                                                                       |
| Privileges           | `doadmin` has CREATEROLE, CREATEDB, REPLICATION and BYPASSRLS, but no superuser. Event triggers are therefore impossible. Only listed extensions install.                         | The `acl` command is restricted: no ACL users. `config`, `save`, `bgsave`, `failover`, `replicaof` and `monitor` are restricted too. |
| TLS                  | Required. CA certificate download on Standard; `sslrootcert=system` on Advanced, which needs libpq ≥ 16.                                                                          | Required.                                                                                                                            |
| Standby and failover | 1–3 nodes, automatic failover; DigitalOcean states a 5–10 s outage for failover and maintenance.                                                                                  | A standby takes over at once (5–10 s). Creating a standby or failing over forks the primary, which can run out of memory.            |
| Backups              | Daily full backups plus WAL, point-in-time recovery for 7 days. If no node survives, WAL is backed up every 5 minutes. No access to the WAL archive: WAL-G cannot run against it. | None (no backups or restores); RDB persistence by default; eviction defaults to `noeviction`.                                        |
| Network              | A VPC can be set; its trusted sources are droplet, tag, IP/CIDR or app (no VPC rule type, no IPv6).                                                                               | Same as PostgreSQL.                                                                                                                  |
| SLA                  | 99.95% with a standby node, 99.5% without.                                                                                                                                        | Same as PostgreSQL.                                                                                                                  |

Other facts that shape the stages:

- **Droplets:** 99.99% per droplet; no arm64 droplets.
- **Regional load balancers:** 99.9%. HTTP load balancers send PROXY protocol v1; network (layer 4) load balancers keep the client address without it.
- **Spaces:** 99.9%.
- **Transfer:** pooled per team, $0.01/GiB past the allowance, inbound free. VPC traffic is not
  billed, and neither is Spaces traffic resolved through the VPC resolver.

Sources: docs.digitalocean.com (PostgreSQL limits, secure, features, connection pools; Valkey
limits, connect, eviction, memory usage; databases overview; bandwidth billing; load balancer
features; Spaces S3 compatibility and availability), digitalocean.com/sla (databases, droplets,
regional load balancers, Spaces), postgresql.org (CREATE EVENT TRIGGER).

## Decision

### 1. Targets

The budget is per calendar month. Planned upgrades count against it until stage 2 makes them
rolling.

| Stage       | Availability         | Recovery time                                                                          | Data loss bound                                                                                                                                                                                             |
| ----------- | -------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0           | 99.5% (about 3.6 h)  | the R0 restore drill's measured time, plus 30 minutes to notice and decide             | WAL-G's `archive_timeout` (60 s, `infra/postgres/Containerfile:59`)                                                                                                                                         |
| 1 and later | 99.9% (about 43 min) | database failover within a minute; app host loss within the restore time until stage 2 | on failover, whatever the standby had not replayed: DigitalOcean does not say whether replication to the standby is synchronous, so the `failover` scenario measures it; 5 min if the whole cluster is lost |

Stage 1 is within DigitalOcean's own commitments: 99.95% for a database with a standby node
under our 99.9%. A target above the provider's SLA would be a wish, not a target.

### 2. Stages and their triggers

Each stage is built and rehearsed in the harness before its trigger fires. Triggers are
measured at the daily peak, sustained for 7 days, not at a single spike.

| Stage            | Topology                                                                                                                                                               | Move on when                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 0 launch         | One dedicated-vCPU droplet with the whole stack, sized by S1-a. WAL-G and object backups go to Spaces in another region. A monitoring droplet sits in a second region. | Postgres container CPU over 50%, or the 99.5% budget spent in two months of a quarter, or the restore time over 4 h |
| 1 state off-host | Managed PostgreSQL (one standby) and managed Valkey (one standby). Objects move to Spaces (R0-b). Traffic goes over the VPC.                                           | App droplet CPU over 60%, or upgrade downtime over half the monthly budget                                          |
| 2 app tier       | Two or more app droplets (api, chat, web, worker, origin) behind a regional network load balancer. Rolling upgrades.                                                   | Transcode CPU over 70%, or concurrent live streams past S1-a's per-host number                                      |
| 3 media tier     | Separate ingest and transcode droplets, with streams placed on one of them; origin routes by placement.                                                                | Monthly egress past the budget the maintainers set at launch (an L1 decision)                                       |
| 4 egress         | Member relays and P1's browser P2P carry viewers; then a CDN adapter (off by default) or an unmetered media origin elsewhere.                                          | None: the long-term shape                                                                                           |

The tracker stays a single instance through stage 2. The swarms it holds are soft state that
clients rebuild after a restart. A second tracker needs sticky routing by swarm, or swarms in
Valkey, and is designed when the tracker's own CPU is a measured limit.

Egress is likely the first limit, not compute: about 1.35 GB per viewer-hour at 3 Mbps. Stage 4's
relays and P1 matter from day one, which is why P1 moved into batch 2.

### 3. External services, for every operator

`selfhost.sh` accepts an external Postgres, Valkey and S3 store. When one is external, the units
for that service are not installed, and `status` checks the remote. The requirements are part
of the self-hosting docs (`docs/self-hosting/managed-services.md`, S1-h):

- **PostgreSQL:**
  - a supported major version (the one the release is tested with, 17, and the next);
  - TLS with certificate verification (`sslmode=verify-full`);
  - an owner role that can create tables, plpgsql functions, `SECURITY DEFINER` functions and
    triggers, and holds CREATEROLE, so it can create the non-owner app role (ADR 0004,
    `infra/postgres/app-role.sql`).
  - No superuser, no extensions and no event triggers are needed. The migrations use none:
    `gen_random_uuid()` is core since Postgres 13. S1-d proves this against a Postgres with no
    superuser before S1-b ships.
  - **S1-d's result (2026-11-02, Postgres 17.11).** `packages/db/tests/external-owner.int.test.ts`
    runs the whole path as an owner with only LOGIN and CREATEROLE, over `sslmode=verify-full`
    with a private CA: every migration, the app role, the monitor role, every protection trigger
    (identical to a superuser-migrated database, and each family fires) and the owner-only
    restore in §4. One fix was needed: on Postgres 16 and later a non-superuser may not name
    `SUPERUSER`, `REPLICATION` or `BYPASSRLS` in `ALTER ROLE` even to switch them off, so
    `app-role.sql` and `monitor-role.sql` switch off only the attributes that are on. Nothing
    else needs a superuser. The run against a real DigitalOcean cluster (contract step §1.5)
    follows on the staging project.
  - **Client TLS:** postgres.js reads `sslmode` but not `sslrootcert`, and iovalkey takes no CA
    from the URL. `DATABASE_CA_FILE` and `VALKEY_CA_FILE` name the provider's CA; with them set,
    the clients verify against it and refuse a URL weaker than `sslmode=verify-full` or
    `rediss://`. A `sslrootcert` path in the URL is taken as the CA too, so one URL serves our
    services and `psql`/`pg_dump`.
  - **Monitoring:** `infra/postgres/monitor-role.sql` creates `commonair_monitor` (LOGIN,
    read-only, CONNECT only). It is a member of `pg_monitor` where the owner can grant it, and it
    is not on a managed database: since Postgres 16 a CREATEROLE role grants only roles it holds
    with ADMIN OPTION, and the owner does not hold `pg_monitor` that way. The test confirms the
    grant is refused on Postgres 17 and the role is created anyway. What it misses without
    `pg_monitor` is in §4.
- **Valkey or Redis-compatible:**
  - password authentication, as the default user or an ACL user;
  - TLS (`rediss://`);
  - `noeviction` (BullMQ requires it);
  - persistence on.
  - No `CONFIG` or `ACL` commands at runtime: S1-b checks that BullMQ and our clients issue none
    and records any it finds.
  - A failover loses rate-limit windows and a few seconds of chat fan-out, and queued jobs since
    the last persistence point. Jobs are at-least-once with idempotent handlers, so nothing
    durable is lost.
- **S3:** presigned PUT and GET with SigV4; CORS on the media bucket; path or virtual-host style
  (R0-b).

### 4. Backups when WAL-G cannot run

With an external Postgres, `selfhost.sh backup` takes a nightly logical dump (`pg_dump`, custom
format) to an S3 bucket the operator controls, in another region or provider. A drill restores it
into a scratch database (S1-h). The provider's point-in-time recovery is the first line, and the
dump guarantees that no restore depends on one provider. Our instance keeps 30 daily dumps.

The data restore must not fire the protection triggers (0001 onwards). They guard live writes, not
a copy of rows that already passed them: with triggers on, a restore would double follower counts
(channels load before follows, and the follows trigger counts each row again) and refuse members
of ended watch rooms, entries of closed giveaways and votes of closed jury panels. So the restore
uses `pg_restore --disable-triggers` (or `SET session_replication_role = replica` for the data
load), which needs a superuser or, on a managed database, a role granted `SET` on
`session_replication_role`, and the drill then checks a few counts against the source, for
example `channels.follower_count` against `follows`.

**Amended by S1-d (2026-11-02): the restore needs no superuser.** Both ways above need one, and a
managed database gives none: only a superuser may use `--disable-triggers`, and only a superuser
can grant `SET` on `session_replication_role`. The restore runs as the owner instead, into a
fresh database it owns (`infra/postgres/restore-owner.sql`):

1. `pg_restore --section=pre-data --no-owner`;
2. `restore-owner.sql` with `commonair.restore_triggers=disable`: `ALTER TABLE … DISABLE TRIGGER
   USER` on every table in `public` and `drizzle`, which the owner may do on its own tables (the
   internal foreign-key triggers stay on);
3. `pg_restore --section=data`;
4. `restore-owner.sql` with `commonair.restore_triggers=enable`;
5. `pg_restore --section=post-data` (indexes, constraints and triggers; foreign keys are checked
   here);
6. `apply-app-role.ts`, then `infra/postgres/restore-check.sql` on the source and on the copy.

`restore-check.sql` returns the row count of every table, the ledger balance per currency (0) and
the number of channels whose `follower_count` differs from their counted follows (0). The test
restores a dump of a seeded database this way, as the owner with no superuser, and the two outputs
are equal. A doubled `follower_count` shows up as a non-zero mismatch.

What the test also found: **`pg_dump` puts every trigger in post-data**, so a full sectioned restore
never meets a trigger during the data load, and steps 2 and 4 find nothing to switch. The double
counting above happens only in a data-only restore into a database that already has the triggers
(a migrated one). The drill keeps steps 2 and 4 so one procedure covers both, and the test checks
that `restore-owner.sql` switches every user trigger as the owner and refuses any other role.
Creating the fresh database needs CREATEDB (DigitalOcean's `doadmin` has it) or the provider's
API.

**`pg_monitor` (S1-d).** The owner of a managed database cannot grant `pg_monitor` (§3), so the
metrics role usually lacks it. Without it, `commonair_monitor` still reads `pg_stat_database`,
`pg_stat_user_tables`, `pg_statio_user_tables`, `pg_stat_user_indexes`, `pg_stat_bgwriter`,
`pg_stat_checkpointer`, `pg_stat_wal`, `pg_locks`, `pg_settings` (`max_connections`),
`pg_database_size` and `pg_relation_size` (all checked by the test). It misses:

- `pg_ls_waldir()`: WAL size and file count (permission denied, checked);
- in `pg_stat_activity`, other roles' `state`, wait events and query text: the connection count
  is there, the breakdown by state is not (checked);
- in `pg_stat_replication`, the client and lag columns (Postgres documents them as visible only to
  `pg_read_all_stats`, which `pg_monitor` includes). On a managed cluster the standby is the
  provider's, so replication lag comes from DigitalOcean's metrics endpoint, not from us.

Dashboards and alerts work with that reduced set or say "needs pg_monitor" (L1-observability).
The bundled stack's migrate job runs as a superuser and grants it.

### 5. Load balancing keeps real client addresses

At stage 2 the load balancer is a **network (layer 4)** load balancer that passes TCP and UDP
through with the client's address. This avoids an HTTP load balancer's TLS termination and
PROXY protocol v1, and it keeps RTMP, IRC and WebRTC working. Caddy stays the TLS endpoint on
each app droplet. If the network load balancer cannot carry a port we need, S1-f falls back to
PROXY protocol accepted only from the load balancer's addresses.

### 6. Measure what the triggers name

Stage triggers are only real once dashboards show them. Before launch:

- host CPU, memory, network and disk (node_exporter, or the OTel collector's hostmetrics
  receiver);
- Postgres (postgres_exporter, or the collector's postgresql receiver) and Valkey statistics;
- alerts at 80% of each trigger.

S1-a measures the same quantities from the harness during load runs. The exporters' licenses
and images go through ADR 0002 and ADR 0022 like any dependency.

### 7. Out of scope

- **Kubernetes:** a second deployment path beside Quadlet, for a team this size.
- **Multi-region active-active:** Postgres has one primary; HLS tolerates distance, and relays
  sit near viewers.
- **Autoscaling** before stage 2 has run by hand.
- **Read replicas for the app:** no query load needs them yet. DigitalOcean's Advanced edition
  also allows no reads from standbys.

## Consequences

- The default self-host install does not change. Every external option is opt-in and works with
  any provider that meets section 3, so our instance and a self-hoster on Hetzner or a home
  server run the same code.
- At stage 1, WAL-G no longer covers our database. Our backup story becomes the provider's
  point-in-time recovery plus our own dumps. The dump restore is drilled on the same calendar as
  today's restore drill (L1 checklist item 6).
- A managed Valkey has no backups. Nothing durable may live only in Valkey, which is already the
  rule: the outbox, ledger and jobs' effects are in Postgres.
- DigitalOcean's Advanced PostgreSQL edition with `sslrootcert=system` needs libpq ≥ 16 in any
  client that uses libpq (WAL-G, `pg_dump` in the tools image). Standard edition with a
  downloaded CA works with any version. Our instance starts on Standard unless S1-d finds a
  reason not to. S1-d found none: the downloaded CA works through `DATABASE_CA_FILE` (§3).
- Stage 2's rolling upgrades and planned instance replacement drain chat with SIGTERM (which
  closes the message writer and flushes it), never SIGKILL, which can lose acknowledged messages
  from the last flush interval ([Notes from S1-c](#notes-from-s1-c)). An unplanned host loss can
  still lose that interval.
- A chat instance drops a room's cached settings and standings when its last local member there
  leaves, so the next member to join reads them fresh ([Notes from S1-c](#notes-from-s1-c)).
- New work: S1-b, S1-d and S1-h for stage 1, S1-f and S1-c for stage 2, S1-e for stage 3
  (`.claude/briefs/next/S1-scaling.md`), and the exporters in decision 6.

### Notes from S1-c

The `multi-instance` scenario (`harness/scenarios/multi-instance.ts`) checked the replica-safety
claims above with two of each app service. What it found, and what the code does now:

- **Relay issuance ran twice in a minute.** The leader released its lock at the end of a tick,
  so a replica whose minute timer fired later took it and computed the same tick again. Since
  commit `87479c8` the winner keeps the lock until its TTL runs out and only a failed tick
  releases it early, so one replica computes per tick.
- **Chat's caches bound staleness only while an instance has members in the room.** A chat
  instance subscribes to a room's control channel while it has local members there. When the
  last one leaves, `part()` (`services/chat/src/rooms.ts`) unsubscribes but keeps the directory's
  cached channel and standings (`services/chat/src/directory.ts`: 60 s channel, 30 s standing).
  A ban or a settings change made meanwhile never reaches that instance, so a member who joins
  there before the entry expires could see the old state for up to that TTL. `part()` now
  calls `Directory.evictChannel` when the room empties, so a join after that reads Postgres; the
  TTLs remain the bound for an invalidation missed while the instance is subscribed.
- **Chat acknowledges a message before it is stored.** The `MessageWriter`
  (`services/chat/src/persistence.ts`) batches rows and flushes every 250 ms. SIGTERM closes it
  and flushes what is queued (up to 5 s); SIGKILL loses messages acknowledged but not yet
  flushed. The scenario's instance-loss step kills chat-2 with SIGKILL during a paced burst and
  checks history for every message acknowledged more than 1 s before the kill; what was lost
  within the last interval is reported (`multi.chat.lost_on_kill`), not failed.

## Decisions at acceptance (2026-10-27)

The maintainer accepted the stages as written and answered two of the three open questions:

- **Production region: NYC3,** unless the launch audience turns out to be mostly in Europe, in
  which case FRA1. NYC3 offers every product this ADR uses (droplets, Managed PostgreSQL, Managed
  Valkey, Spaces) and reaches both US coasts; FRA1 would simplify GDPR data residency for an
  EU-first audience. The droplet size still waits for S1-a's numbers, and both are confirmed on
  the L1 checklist.
- **Tracker in stage 2: on one app droplet,** not its own. It is a light WebSocket process, and a
  restart only drops swarms: players fall back to HTTP. A separate droplet is more cost and one
  more host to patch for no availability gain. It moves when its metrics say so.

Still open:

- The egress budget that triggers stage 3, in GiB per month: a maintainers' decision at launch
  (L1), from S1-a's per-viewer egress and the transfer allowance of the launch droplet.

## Decisions at acceptance (2026-11-02)

The maintainer answered U4 of batch 8 (`.claude/briefs/batch8/README.md`), changing the launch
stage for our own instance:

- **Our instance launches at stage 1:** DigitalOcean Managed PostgreSQL and managed Valkey, each
  with one standby node, objects in Spaces, the app droplet and the monitoring droplet as before.
  This is how we deploy our instance, not a change to `selfhost.sh`: bundled Postgres and Valkey
  stay the self-host default with full support, and external managed services are an added
  option beside them, as `--s3-*` is beside Garage.
- **The 99.9% target applies from launch** (about 43 minutes a month), not 99.5%. DigitalOcean's
  SLA for a cluster with a standby is 99.95%, so the target is within what the provider commits
  to (§1).
- **The stage 0 row of §2 and its trigger describe the self-host default only.** Our instance never
  runs at stage 0.
- **Our backups are the provider's point-in-time recovery (7 days) plus S1-h's nightly dump** to
  Spaces in another region, 30 kept, restored by §4's owner-only procedure in a weekly drill and
  once, timed, into a fresh managed cluster on the staging project. That time becomes our restore
  time in §1. **WAL-G does not run for our instance;** it stays the bundled default's backup.
- **Uptime.** The app droplet is still one host until stage 2, so planned upgrades count against
  the 43 minutes. With a minor release every two weeks plus patches, each upgrade must take well
  under 10 minutes of downtime. The stage 1 → 2 trigger, "upgrade downtime over half the monthly
  budget", is about 21 minutes a month; L1-observability alerts at 80% of it. Paging must reach a
  human within minutes, so the monitoring droplet alerts on its own probes, independent of the app
  droplet.
- **Cost.** Two managed clusters with one standby each are billed from day one: four database
  nodes, on top of the app droplet, the monitoring droplet and Spaces. A standby node is billed
  like a primary, so the database line is about double a single-node cluster; the exact prices are
  checked at provisioning. The connection limit of the smallest nodes may force a larger Postgres
  node than the data needs (S1-b's preflight reports it). In exchange: a database failover in
  seconds instead of a restore measured in hours, and no WAL-G to run.
- **Launch-readiness of stage 1** waits for one run of S1-d's checks against a real managed
  cluster on the staging project (contract step §1.5), recorded here.
