<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0032: Scaling and availability in stages

- Status: proposed
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
  reason not to.
- Stage 2's rolling upgrades and planned instance replacement drain chat with SIGTERM (which
  closes the message writer and flushes it), never SIGKILL, which can lose acknowledged messages
  from the last flush interval ([Notes from S1-c](#notes-from-s1-c)). An unplanned host loss can
  still lose that interval.
- A chat instance with no local members in a room can serve that room's bans and settings
  stale for up to the cache TTL (30 s standing, 60 s channel) to the next member who joins there.
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
  there before the entry expires can see the old state for up to that TTL. This is a known
  bound, not a bug to fix before stage 2: the TTLs are the bound for every missed invalidation.
- **Chat acknowledges a message before it is stored.** The `MessageWriter`
  (`services/chat/src/persistence.ts`) batches rows and flushes every 250 ms. SIGTERM closes it
  and flushes what is queued (up to 5 s); SIGKILL loses messages acknowledged but not yet
  flushed. The scenario's instance-loss step kills chat-2 with SIGKILL and checks history
  for every message acknowledged before the kill.

## Open questions

- The egress budget that triggers stage 3, in GiB per month: a maintainers' decision at launch
  (L1), from S1-a's per-viewer egress and the transfer allowance of the launch droplet.
- The production region (ADR 0025's open question), which also places the managed databases.
- Whether to run the tracker in stage 2 as one instance on one app droplet or on its own small
  droplet.
