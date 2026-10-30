<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# S1: scaling and availability on DigitalOcean

**Goal.** Know how far one droplet goes, have a written availability target, and have every step
past one droplet built, rehearsed in the harness and triggered by a measured number, so growth
is a planned change and not an emergency migration.

**State (2026-10-26).** ADR 0025 (accepted) runs production on one DigitalOcean droplet with
dedicated vCPUs, WAL-G to Spaces and a monitoring droplet in a second region. ADR 0010's rule
carries over: one host is a single point of failure, so a tested restore is the launch blocker.
The code is mostly replica-safe already:

- the worker outbox claims rows with `FOR UPDATE SKIP LOCKED` (`services/worker/src/outbox.ts:7`);
- relay issuance elects one leader per tick through Valkey (`packages/config/src/env.ts:364`);
- chat fans out across instances through Valkey (`services/chat/src/bus.ts`).

What is missing: no harness scenario runs two of anything; `selfhost.sh` installs every unit on
one host and cannot point at an external Postgres, Valkey or S3, managed or not; nothing decides which media host
takes a stream; `load-plan` has never run on production-class hardware; Postgres, Valkey and
Garage each have one copy.

## Decisions first: ADR 0032 (scaling and availability)

Drafted 2026-10-26 as [ADR 0032](../../../docs/decisions/0032-scaling-and-availability.md)
(proposed), with DigitalOcean's limits checked. Where it differs from this plan, the ADR wins:
stage 2 uses a network (layer 4) load balancer rather than PROXY protocol, the tracker stays a
single instance, and managed Valkey has no ACL users (password auth instead).

1. **Targets per stage**, proposed: stage 0 at 99.5% monthly (about 3.6 hours), recovery by
   restore within the time the R0 drill measures, data loss bounded by WAL-G's archive interval;
   stage 1 and later at 99.9% with database failover in minutes. Planned upgrades count against
   the budget until stage 2 makes them rolling.
2. **Managed state, decided with the user on 2026-10-26.** Stage 0 runs Postgres, Valkey and
   Garage on the droplet, exactly what self-hosters run. At stage 1 our instance moves to
   DigitalOcean Managed PostgreSQL (with a standby node) and managed Valkey, objects to Spaces,
   **and the self-hosting suite gains the same option for everyone**: `selfhost.sh` accepts an
   external Postgres, Valkey and S3 from any provider (DigitalOcean, AWS, Hetzner, a cluster the
   operator runs), with documented requirements and a tested path. The single-host Postgres +
   WAL-G install stays the default, and no provider is special-cased (ADR 0025 decision 1,
   AGENTS.md non-negotiable 3). The ADR records:
   - the requirements an external Postgres must meet: the protection triggers and the non-owner
     app role created by a non-superuser owner (ADR 0004, non-negotiable 9), the extensions in
     use, TLS, a supported major version. If DigitalOcean's product fails them, our instance
     self-runs a primary and replica instead, and the external path still ships;
   - backups when WAL-G cannot run (a managed cluster has no access to its WAL): the provider's
     point-in-time backups, plus a nightly logical dump to an S3 bucket the operator controls, so
     no restore depends on one provider;
   - Valkey requirements (version, ACL user, TLS) and what the platform loses during a Valkey
     failover (rate-limit windows, chat fan-out for a few seconds; nothing durable).
     Verify DigitalOcean's current limits (extensions, roles, trigger support, TLS, failover time)
     against its docs when writing the ADR; nothing here is checked yet.
3. **The trigger for each stage**, as numbers the dashboards already show or S1-a adds.
4. **Out of scope, with reasons**: Kubernetes (a second deployment path to maintain beside
   Quadlet, for a team this size), multi-region active-active (Postgres is one primary; HLS
   tolerates distance, relays sit near viewers), autoscaling before stage 2 has run by hand.

## Stages

| Stage            | Topology                                                                                                                                                               | Trigger to move on (proposed, ADR sets them)                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 0 launch         | one dedicated-vCPU droplet with the whole stack; WAL-G and object backups to Spaces in another region; monitoring droplet                                              | Postgres CPU over 50% at peak, or the availability target needs failover, or restore time too long |
| 1 state off-host | DigitalOcean Managed PostgreSQL (standby node) and managed Valkey; objects in Spaces (R0-b); everything over the VPC; self-hosters get the same external option        | app droplet CPU over 60% at peak, or upgrades need to stop causing downtime                        |
| 2 app tier       | two or more app droplets (api, chat, web, worker, origin, tracker) behind a DigitalOcean Load Balancer; real client addresses through PROXY protocol; rolling upgrades | transcode CPU over 70% at peak, or concurrent live streams past S1-a's per-host number             |
| 3 media tier     | separate ingest/transcode droplets (MediaMTX + media), streams placed on one of them, origin routes playlist and segment fetches to the placed host                    | monthly egress past the budget the ADR sets                                                        |
| 4 egress         | member relays and the P1 browser P2P client carry viewers; then a CDN adapter (off by default) or an unmetered media origin elsewhere (ADR 0025 consequences)          | none: this is the long-term shape                                                                  |

**Stage 4 owns CDN fetch-judging** (decided 2026-10-30, batch 4): ADR 0015 GA criterion 1 needs
the CDN adapter to judge fetches per session the way origin and relays do. W1's verified-watch
gate ships with `CHAT_WATCH_GATE=off` and its GA waits for this stage.

Egress is likely the first limit, not compute: DigitalOcean meters transfer past the pooled
allowance (about 1.35 GB per viewer-hour at 3 Mbps). Stage 4's relays and P1 matter from day one;
P1 can run in parallel with all of S1.

## Units

At most six at a time, on disjoint paths. `packages/db` and `packages/contracts` changes are the
orchestrator's contract step.

| Unit               | Owns                                                                       | Build                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1-a capacity      | `harness/scenarios/load-plan.ts`, `docs/operators/capacity.md`             | `load-plan` against two or three dedicated-vCPU droplet sizes; per size: streams and viewers before p95 or CPU breaks, origin egress per viewer, Postgres and Valkey load. Output feeds the launch size and the triggers                                                                                                                                                    |
| S1-b external      | `scripts/selfhost.sh` (install/upgrade), `infra/selfhost/**`               | external Postgres, Valkey and S3 for any operator: `--database-url`, `--valkey-url` with TLS (`sslmode=verify-full`, `rediss://`; check both clients support them), the bundled units for that service not installed, `status` checks the remote. Then `--role all\|app\|media` for stage 2 hosts; `upgrade` across hosts runs `migrate` once. Builds on R0-b's external S3 |
| S1-c replicas      | `harness/scenarios/multi-instance.ts`, a compose override under `harness/` | two of each app service in the harness stack: chat across instances, outbox exactly-once, one issuance leader, shared rate limits, WebSocket clients reconnecting when an instance dies, viewer counts unchanged                                                                                                                                                            |
| S1-d external-pg   | orchestrator: `packages/db/**`, `infra/postgres/**`                        | migrations and protection triggers applied by a non-superuser owner, the non-owner app role, the extensions in use; an integration test against a Postgres with no superuser and TLS required; one check against DigitalOcean's managed cluster. Required: the external path depends on it                                                                                  |
| S1-h backups-ext   | `scripts/selfhost.sh` (backup), `docs/self-hosting/managed-services.md`    | `selfhost.sh backup` with an external Postgres: a nightly logical dump to the operator's S3 bucket, its restore drill, and the provider's own backups described; `managed-services.md` lists the requirements for each external service, with DigitalOcean as the worked example                                                                                            |
| S1-e placement     | orchestrator contract step, then `services/media/**`, `services/origin/**` | stage 3 only: a stream-to-media-host placement record, ingest addressing (an ingest hostname per media host for RTMP, a WHIP redirect), origin routing by placement, re-placement when a media host dies mid-stream                                                                                                                                                         |
| S1-f load balancer | `infra/caddy/**`, each app service's health route                          | stage 2: Caddy accepts PROXY protocol only from the load balancer, so rate limits keep real addresses; health checks the load balancer can use; connection draining so `upgrade` can roll one droplet at a time                                                                                                                                                             |
| S1-g IaC           | `infra/tofu/digitalocean/**`                                               | OpenTofu for stages 0–2 (droplets, VPC, cloud firewall, volumes, Spaces, reserved IP, load balancer, managed databases if chosen); `digitalocean/digitalocean` provider vetted at the pinned version (ADR 0002, ADR 0022). Also delivers L1 checklist item 8                                                                                                                |

## Order

1. With R0: the ADR, S1-a (it needs only a droplet and the existing scenario), S1-c, S1-g for
   stage 0. These are what L1 needs: a launch size, the targets, and IaC.
2. After R0-b: S1-d first (if the triggers cannot be created by a non-superuser, the external
   Postgres path needs a different design), then S1-b and S1-h. Stage 1 is then ready, for us
   and for self-hosters, before its trigger fires.
3. S1-f when stage 1 is live. S1-e when the stage 2 trigger is in sight; it is the largest unit
   and touches the media path, so it gets its own batch.

## Tests and scenarios

- `multi-instance` (S1-c) joins the full harness scenario.
- The self-host e2e gains an external-services variant: Postgres with no superuser and TLS,
  Valkey with an ACL user and TLS, Garage standing in for an external S3, each in its own
  container outside the instance's network; install, upgrade, backup and restore pass.
- A `failover` scenario on real droplets, run by the user: kill the Postgres primary (or fail
  over the managed cluster), kill one app droplet; record time to recovery and lost writes
  against the ADR's targets.
- The R0 restore drill, repeated on a calendar (L1 checklist item 6).

## Done means

- ADR 0032 accepted, with targets and triggers.
- `docs/operators/capacity.md` gives per-size numbers from S1-a, and L1's launch size cites it.
- Stages 0–2 can be stood up from `infra/tofu/digitalocean` and `selfhost.sh`, and
  `multi-instance`, the external-services e2e and `failover` pass.
- `docs/self-hosting/managed-services.md` lets an operator point a self-hosted instance at
  managed Postgres, Valkey and S3 from any provider that meets the requirements. Stage 3 is designed and, if its trigger is not near,
  not built.
