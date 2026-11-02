<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# L1: the first public instance

**Goal.** Run CommonAir's own instance in public on the release artifacts, per ADR 0025
(DigitalOcean droplets for staging and production, superseding ADR 0010's Hetzner server and
Railway staging). Growth past one droplet is [S1](S1-scaling.md).

Mostly the user's and counsel's work; Claude's part is the checklist, the runbooks and fixes.

## Open decisions (ADR 0025 "Open questions" and others)

- Region (North American or European audience first), droplet size (dedicated vCPUs, from the
  load test), Spaces region for off-host backups (not the droplet's region).
- Mail: settled, a relay's alternate port (DigitalOcean blocks outbound 25, 465 and 587; Resend on
  2587, as on staging).
- An egress budget: DigitalOcean meters transfer past the pooled allowance, so the launch size
  needs a monthly egress ceiling and an alert on it (S1).
- Legal entity (ROADMAP.md non-goal today: "legal incorporation of the cooperative"), terms,
  privacy notice and DMCA agent registration with real contacts in `instanceSite()`.
- CSAM detection: ROADMAP.md lists a real vendor as a non-goal, but ADR 0006 needs hash lists
  for a public instance. Decide which lists (and agreements) before launch; NCMEC reporting
  needs the entity.
- Age assurance: the adapter is not built (ADR 0006:291). Decide whether launch is
  18+-content-free until it exists.
- Payments: test mode only until M1's gate clears (so no real subscriptions at launch).

## Launch checklist

1. R0 done (`v0.1.0` installed from the signed release, ACME, tested restore to a second
   droplet).
2. E7 done (no 501s in reachable UI apart from 3C/3D, or those pages hidden).
3. W0-sor done if the instance accepts EU users.
4. Monitoring: the Grafana dashboards and alerts in `infra/grafana` reviewed, including the remote
   Postgres and Valkey metrics from the managed clusters (batch 8 U4); an alert route to a human
   that pages within minutes against the 99.9% budget; a public status page on the monitoring
   droplet in a second region (ADR 0025 decision 3) that alerts on its own probes when the app
   droplet is down.
5. Moderation staffing: who works the queue, the NCII 48-hour clock, on-call for T0.
6. Backups (stage 1 at launch, batch 8 U4): DigitalOcean's point-in-time recovery (7 days) plus
   S1-h's nightly logical dump to Spaces in another region, 30 kept; the weekly dump drill on its
   timer; one timed restore into a fresh managed cluster and one timed app-droplet rebuild from
   tofu, recorded in ADR 0032. Objects are in Spaces (R0-b), backed up with
   `selfhost.sh backup --objects`. WAL-G does not run for our instance.
7. Load: `load-plan` at the expected launch size on the chosen droplet (S1-a), with the S1 stage-2
   triggers agreed, the 99.9% target from launch, and the managed Postgres node sized for the
   connection budget (S1-b's preflight). `failover` run against the managed clusters.
8. Infrastructure: droplets, cloud firewall, volumes, Spaces buckets, reserved IP and the managed
   Postgres and Valkey clusters (`enable_managed_state = true`) in OpenTofu (ADR 0025 decision 4);
   the agent token scoped by the operator to a staging-only project with a spending cap (decision
   5, batch 8 U5).
9. Security: an external review of the release and the instance's exposed surface.

## Done means

The user signs off each checklist item; the instance runs the tagged release; the runbooks in
`docs/operators/` match what was done.
