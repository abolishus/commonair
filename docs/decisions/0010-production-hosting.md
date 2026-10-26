<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0010: Production hosting on Hetzner dedicated servers

- Status: superseded by [ADR 0025](0025-hosting-on-digitalocean.md) (2026-10-26); accepted
  2026-10-21. Kept for its reasoning; Hetzner stays a valid self-host target
- Date: 2026-10-21 (prices and allowances checked on this date)

## Context

Railway hosts staging ([docs/deploy/railway.md](../deploy/railway.md)). It cannot host
production:

- Railway has no public UDP. WebRTC/WHIP works only over ICE-TCP, and encoders that need UDP fail.
- Its Postgres backups are Railway's own, not WAL-G (ADR 0003), so the restore drill does not
  test what production would run.
- Its volumes mount as root, so there is no media work-dir volume, and the relay is not deployed.

The platform's own production path is rootless Podman with Quadlet units (`infra/quadlet`),
Caddy for TLS, WAL-G for Postgres and Garage for object storage. That runs on any Linux host. The
choice of host is decided by three properties of this workload:

1. **Egress dominates cost.** One viewer at about 3 Mbps uses about 1.35 GB per hour. 1,000
   concurrent viewers watching 4 hours a day is about 160 TB a month. Member relays and the
   WebTorrent P2P swarm (ADR 0005) take part of this off the origin, but the origin still
   serves every viewer that has neither.
2. **The media path needs CPU and public UDP.** The FFmpeg ladder, frame sampling and the ONNX
   classifier (ADR 0006) run on CPU, and WebRTC ingest wants UDP on 8189.
3. **We run our own stateful services.** Postgres with protection triggers and a non-owner app
   role (ADR 0004), WAL-G and Garage need persistent local disks and root on the host to set up.

Options compared at 160 TB of monthly egress:

| Option                        | Egress                                                 | UDP | Fit with Quadlet stack | Notes                                                       |
| ----------------------------- | ------------------------------------------------------ | --- | ---------------------- | ----------------------------------------------------------- |
| Railway                       | metered                                                | no  | no (own IaC)           | staging only                                                |
| DigitalOcean droplets         | $0.01/GiB after a pooled allowance, about $1,600/month | yes | yes                    | best API and CLI; the bandwidth price rules it out          |
| Hetzner Cloud (EU)            | about 20 TB included per VM, then billed per TB        | yes | yes                    | US locations include only 1–8 TB per VM                     |
| **Hetzner dedicated (Robot)** | **unmetered 1 Gbit/s port**                            | yes | yes                    | Germany and Finland only; ordered through the Robot console |
| OVHcloud dedicated            | unmetered                                              | yes | yes                    | has Canadian and US datacenters                             |

Hetzner raised prices twice in 2026 (April across the range, June mostly on cloud lines; the
EX44 went from €42.30 to €47.30). It is still the cheapest of these per core and per terabyte
for this workload.

## Decision

1. **Production runs on Hetzner dedicated servers** with the existing Quadlet units, unchanged
   from the documented production path. No Hetzner-specific code. Railway stays the staging host.
2. **Launch topology is one dedicated server** (AMD AX or Intel EX class, at least 64 GB RAM,
   two NVMe disks in software RAID 1) running the whole stack, plus:
   - **Off-host backups.** WAL-G writes to an S3 endpoint that is not on the server: Hetzner
     Object Storage or a Garage node on a second host. `infra/postgres/walg-env.sh` already lets
     `AWS_*`, `WALG_S3_ENDPOINT` and `WALG_S3_PREFIX` override the local Garage, so this needs
     configuration only. Hetzner Object Storage is an S3 endpoint chosen in config; Garage
     stays the FOSS default (AGENTS.md non-negotiable 3).
   - **A small Hetzner Cloud VM in a second location** for uptime checks and the status page,
     so monitoring does not fail with the server it watches.
3. **Scale out by role, not by bigger boxes.** In order: move Postgres and Valkey to their own
   server; add origin/media servers; rely on member relays and P2P before any CDN. The E6 load
   test sets the numbers for each step.
4. **Infrastructure as code where the provider allows it.** Hetzner Cloud resources (the
   monitoring VM, firewalls, Object Storage buckets, DNS if used there) are described with
   OpenTofu and the `hetznercloud/hcloud` provider (MPL-2.0; verify at the pinned version per ADR
   0002). Dedicated servers are ordered by hand in Robot. Their setup after the first boot is
   scripted (`scripts/selfhost.sh`, PLAN Phase 5) and runs over SSH, so a rebuilt server is
   reproducible.
5. **Deploys go through the release pipeline** (PLAN Phase 5: signed images, `podman
   auto-update`), not through interactive SSH. SSH is for setup and debugging.

## Consequences

- Production and local development run the same images, units and config files, so a
  production fault can be reproduced with `podman compose` on a laptop.
- Bandwidth cost is flat until a server's 1 Gbit/s port fills. Watch port utilization, not a bill.
- One server is a single point of failure at launch. Disk failures are covered by RAID 1 and
  Hetzner's replacement service. Anything worse means a restore from off-host WAL-G backups onto
  a new server, so **a tested restore (PLAN 3I/E6) is a launch blocker**.
- **Abuse reports become an operator duty.** Hetzner forwards abuse and copyright complaints and
  expects an answer, usually within 24 hours, or it may block the server's IP. The operator guide
  needs an abuse-response runbook built on [operators/trust-safety.md](../operators/trust-safety.md).
- Hetzner's account checks can take days. Open the account well before launch.
- The production units expose only Caddy (80/443), RTMP (1935), WebRTC ICE (8189/udp) and IRC
  (6667/6697) publicly; WHIP signaling goes through Caddy. A test enforces that list. Remaining
  gaps are tracked in [deploy/hetzner.md](../deploy/hetzner.md#gaps-before-go-live).

## Open questions

- **Region.** Hetzner dedicated servers exist only in Falkenstein and Nuremberg (Germany) and
  Helsinki (Finland).
  - For an EU or mixed audience, any of the three is fine. HLS tolerates the extra latency to
    other continents, and member relays can sit closer to viewers.
  - For a mostly North American audience, compare OVHcloud dedicated servers in Canada or the US
    with Hetzner EU plus North American member relays. Decide this before ordering hardware.
- **Object Storage location** for off-host backups: a second Hetzner location (other than the
  server's) is preferred, so one datacenter incident cannot take both.
- **Server size** is a placeholder until the E6 load test reports origin egress, CPU and p95
  latency per N streamers × M viewers.
