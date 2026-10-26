<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# L1: the first public instance

**Goal.** Run CommonAir's own instance in public on the release artifacts, per ADR 0025
(proposed: DigitalOcean droplets for staging and production, superseding ADR 0010's Hetzner
server and Railway staging). Growth past one droplet is [S1](S1-scaling.md).

Mostly the user's and counsel's work; Claude's part is the checklist, the runbooks and fixes.

## Open decisions (ADR 0025 "Open questions" and others)

- ADR 0025 accepted (it is proposed).
- Region (North American or European audience first), droplet size (dedicated vCPUs, from the
  load test), Spaces region for off-host backups (not the droplet's region).
- Mail: a relay on a non-blocked port (DigitalOcean blocks outbound 25, 465 and 587; staging uses
  Resend on 2587), or DigitalOcean lifts the block.
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
4. Monitoring: the Grafana dashboards and alerts in `infra/grafana` reviewed; an alert route to
   a human; a public status page (none exists; PLAN 3I listed one) on the monitoring droplet in a
   second region (ADR 0025 decision 3).
5. Moderation staffing: who works the queue, the NCII 48-hour clock, on-call for T0.
6. Backups: WAL-G to Spaces in another region; Garage objects with `selfhost.sh backup --objects`;
   a restore drill on a calendar.
7. Load: `load-plan` at the expected launch size on the chosen droplet (S1-a), with the S1
   stage-1 triggers and the availability target agreed.
8. Infrastructure: droplets, cloud firewall, volumes, Spaces buckets and reserved IP in OpenTofu
   (ADR 0025 decision 4); the agent token scoped by the operator (decision 5).
9. Security: an external review of the release and the instance's exposed surface.

## Done means

The user signs off each checklist item; the instance runs the tagged release; the runbooks in
`docs/operators/` match what was done.
