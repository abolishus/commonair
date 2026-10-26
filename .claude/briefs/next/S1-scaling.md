<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# S1: scaling and availability on DigitalOcean

**Goal.** Know how far one droplet goes, have a written availability target, and have every step
past one droplet built, rehearsed in the harness and triggered by a measured number, so growth
is a planned change and not an emergency migration.

**State (2026-10-26).** ADR 0025 (proposed) runs production on one DigitalOcean droplet with
dedicated vCPUs, WAL-G to Spaces and a monitoring droplet in a second region. ADR 0010's rule
carries over: one host is a single point of failure, so a tested restore is the launch blocker.
The code is mostly replica-safe already:

- the worker outbox claims rows with `FOR UPDATE SKIP LOCKED` (`services/worker/src/outbox.ts:7`);
- relay issuance elects one leader per tick through Valkey (`packages/config/src/env.ts:364`);
- chat fans out across instances through Valkey (`services/chat/src/bus.ts`).

What is missing: no harness scenario runs two of anything; `selfhost.sh` installs every unit on
one host and cannot point at an external Postgres or Valkey; nothing decides which media host
takes a stream; `load-plan` has never run on production-class hardware; Postgres, Valkey and
Garage each have one copy.

## Decisions first: ADR 0032 (scaling and availability)

The number is the next free one after the planned 0026–0031; take whatever is free when it is
written.

1. **Targets per stage**, proposed: stage 0 at 99.5% monthly (about 3.6 hours), recovery by
   restore within the time the R0 drill measures, data loss bounded by WAL-G's archive interval;
   stage 1 and later at 99.9% with database failover in minutes. Planned upgrades count against
   the budget until stage 2 makes them rolling.
2. **Managed or self-run state** for our own instance. DigitalOcean Managed PostgreSQL (standby
   nodes, automatic failover, its own point-in-time backups) and managed Valkey remove most of the
   failover work, but replace WAL-G (ADR 0003) with the provider's backups, and the app runs
   without a superuser. Self-run means a Postgres droplet plus a streaming replica, WAL-G kept,
   and our own failover. Self-hosters keep the single-host Postgres + WAL-G path either way: the
   platform stays provider-neutral (ADR 0025 decision 1, AGENTS.md non-negotiable 3). Verify the
   managed products' current limits (extensions, roles, trigger support, TLS, failover time)
   against DigitalOcean's docs when writing the ADR; nothing here is checked yet.
3. **The trigger for each stage**, as numbers the dashboards already show or S1-a adds.
4. **Out of scope, with reasons**: Kubernetes (a second deployment path to maintain beside
   Quadlet, for a team this size), multi-region active-active (Postgres is one primary; HLS
   tolerates distance, relays sit near viewers), autoscaling before stage 2 has run by hand.

## Stages

| Stage            | Topology                                                                                                                                                               | Trigger to move on (proposed, ADR sets them)                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 0 launch         | one dedicated-vCPU droplet with the whole stack; WAL-G and object backups to Spaces in another region; monitoring droplet                                              | Postgres CPU over 50% at peak, or the availability target needs failover, or restore time too long |
| 1 state off-host | Postgres and Valkey off the app droplet (managed, or own droplets with a replica, per the ADR); objects in Spaces (R0-b); everything over the VPC                      | app droplet CPU over 60% at peak, or upgrades need to stop causing downtime                        |
| 2 app tier       | two or more app droplets (api, chat, web, worker, origin, tracker) behind a DigitalOcean Load Balancer; real client addresses through PROXY protocol; rolling upgrades | transcode CPU over 70% at peak, or concurrent live streams past S1-a's per-host number             |
| 3 media tier     | separate ingest/transcode droplets (MediaMTX + media), streams placed on one of them, origin routes playlist and segment fetches to the placed host                    | monthly egress past the budget the ADR sets                                                        |
| 4 egress         | member relays and the P1 browser P2P client carry viewers; then a CDN adapter (off by default) or an unmetered media origin elsewhere (ADR 0025 consequences)          | none: this is the long-term shape                                                                  |

Egress is likely the first limit, not compute: DigitalOcean meters transfer past the pooled
allowance (about 1.35 GB per viewer-hour at 3 Mbps). Stage 4's relays and P1 matter from day one;
P1 can run in parallel with all of S1.

## Units

At most six at a time, on disjoint paths. `packages/db` and `packages/contracts` changes are the
orchestrator's contract step.

| Unit               | Owns                                                                       | Build                                                                                                                                                                                                                                                                    |
| ------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1-a capacity      | `harness/scenarios/load-plan.ts`, `docs/operators/capacity.md`             | `load-plan` against two or three dedicated-vCPU droplet sizes; per size: streams and viewers before p95 or CPU breaks, origin egress per viewer, Postgres and Valkey load. Output feeds the launch size and the triggers                                                 |
| S1-b roles         | `scripts/selfhost.sh` (install/upgrade), `infra/selfhost/**`               | `--role all\|data\|app\|media`; external `DATABASE_URL` and `VALKEY_URL` with TLS (`sslmode`, `rediss://`; check both clients support them); only the role's units installed; `upgrade` across hosts runs `migrate` once, data hosts first. Builds on R0-b's external S3 |
| S1-c replicas      | `harness/scenarios/multi-instance.ts`, a compose override under `harness/` | two of each app service in the harness stack: chat across instances, outbox exactly-once, one issuance leader, shared rate limits, WebSocket clients reconnecting when an instance dies, viewer counts unchanged                                                         |
| S1-d managed-pg    | orchestrator: `packages/db/**`, `infra/postgres/**`                        | only if the ADR picks managed Postgres: migrations and protection triggers applied by a non-superuser owner, the non-owner app role, the extensions in use; an integration test against a Postgres with no superuser; one check against the real managed cluster         |
| S1-e placement     | orchestrator contract step, then `services/media/**`, `services/origin/**` | stage 3 only: a stream-to-media-host placement record, ingest addressing (an ingest hostname per media host for RTMP, a WHIP redirect), origin routing by placement, re-placement when a media host dies mid-stream                                                      |
| S1-f load balancer | `infra/caddy/**`, each app service's health route                          | stage 2: Caddy accepts PROXY protocol only from the load balancer, so rate limits keep real addresses; health checks the load balancer can use; connection draining so `upgrade` can roll one droplet at a time                                                          |
| S1-g IaC           | `infra/tofu/digitalocean/**`                                               | OpenTofu for stages 0–2 (droplets, VPC, cloud firewall, volumes, Spaces, reserved IP, load balancer, managed databases if chosen); `digitalocean/digitalocean` provider vetted at the pinned version (ADR 0002, ADR 0022). Also delivers L1 checklist item 8             |

## Order

1. With R0: the ADR, S1-a (it needs only a droplet and the existing scenario), S1-c, S1-g for
   stage 0. These are what L1 needs: a launch size, the targets, and IaC.
2. After R0-b: S1-b, then S1-d if the ADR picks managed Postgres. Stage 1 is then ready before
   its trigger fires.
3. S1-f when stage 1 is live. S1-e when the stage 2 trigger is in sight; it is the largest unit
   and touches the media path, so it gets its own batch.

## Tests and scenarios

- `multi-instance` (S1-c) joins the full harness scenario.
- A `failover` scenario on real droplets, run by the user: kill the Postgres primary (or fail
  over the managed cluster), kill one app droplet; record time to recovery and lost writes
  against the ADR's targets.
- The R0 restore drill, repeated on a calendar (L1 checklist item 6).

## Done means

- ADR 0032 accepted, with targets and triggers.
- `docs/operators/capacity.md` gives per-size numbers from S1-a, and L1's launch size cites it.
- Stages 0–2 can be stood up from `infra/tofu/digitalocean` and `selfhost.sh --role`, and
  `multi-instance` and `failover` pass. Stage 3 is designed and, if its trigger is not near,
  not built.
