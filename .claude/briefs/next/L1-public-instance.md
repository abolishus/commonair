<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# L1: the first public instance

**Goal.** Run CommonAir's own instance in public on the release artifacts, per ADR 0010 (one
Hetzner dedicated server; Railway for staging only).

Mostly the user's and counsel's work; Claude's part is the checklist, the runbooks and fixes.

## Open decisions (ADR 0010:92-104 and others)

- Region, server size, Object Storage location.
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
   server).
2. E7 done (no 501s in reachable UI apart from 3C/3D, or those pages hidden).
3. W0-sor done if the instance accepts EU users.
4. Monitoring: the Grafana dashboards and alerts in `infra/grafana` reviewed; an alert route to
   a human; a public status page (none exists; PLAN 3I listed one).
5. Moderation staffing: who works the queue, the NCII 48-hour clock, on-call for T0.
6. Backups: WAL-G to off-site storage; Garage objects with `selfhost.sh backup --objects`;
   a restore drill on a calendar.
7. Load: `load-plan` at the expected launch size on the chosen server.
8. Security: an external review of the release and the instance's exposed surface.

## Done means

The user signs off each checklist item; the instance runs the tagged release; the runbooks in
`docs/operators/` match what was done.
