<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Batch 1: R0 code units with S1-a, S1-c and S1-g

Batch 1 of [`.claude/briefs/next/README.md`](../next/README.md): R0's code work and S1's first
units. [ADR 0032](../../../docs/decisions/0032-scaling-and-availability.md) is proposed. S1-c and
S1-g cite it; they do not wait for its acceptance.

## Waves

Two agents never write the same file at the same time (AGENTS.md). R0-b, R0-c and R0-d all touch
`scripts/selfhost.sh` or the Quadlet units, so the R0 units run in three waves. Each wave starts
from the previous wave's merged and verified commit.

| Wave | Units (parallel)                                                                                                                           | Starts from        | Why this order                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| 1    | [R0-a](R0-a-irc-fds.md), [R0-b](R0-b-s3-ext.md), [S1-a](../s1/S1-a-capacity.md), [S1-c](../s1/S1-c-replicas.md), [S1-g](../s1/S1-g-iac.md) | `main`             | disjoint paths; R0-b's units exclude `commonair-irc.container` (R0-a's)                                                 |
| 2    | [R0-c](R0-c-backups.md), [R0-d](R0-d-units.md), [R0-e](R0-e-tests.md)                                                                      | wave 1's R0 merges | R0-c builds on R0-b's storage mode; R0-d edits the units R0-a and R0-b changed; R0-e wires R0-a's and R0-b's e2e checks |
| 3    | [R0-f](R0-f-docs.md)                                                                                                                       | wave 2 merged      | docs describe the finished behavior; it gets every unit's "doc changes for R0-f" list                                   |

S1-a, S1-c and S1-g do not block waves 2 and 3. They merge when reviewed.

## Shared rules

- Only R0-e edits `scripts/selfhost/e2e.ts`. The others write their e2e checks in
  `scripts/selfhost/e2e-<unit>.ts` as functions taking the e2e's helpers:
  `type InHost = (script: string, opts?: { user?: boolean; env?: Record<string, string>; allowFail?: boolean }) => string`
  and `type Expect = (ok: boolean, what: string) => void`.
- Every unit ends with a list of doc changes for R0-f; it does not edit `docs/self-hosting/`
  pages it does not own.
- Contract requests go to the orchestrator, who applies them while merging. The known one is
  R0-b's S3 lines in `commonair-irc.container`.
- Process: `.claude/briefs/_done-means.md`. The user runs `bun run verify`, the self-host e2e,
  the harness scenarios and anything on a droplet.

## After the batch (not code)

These checks need a real server, listed in R0-release.md §3: a restore onto a second droplet,
timed; ACME renewal; Fedora 42 with SELinux enforcing; arm64 on any cloud (DigitalOcean has no
arm64 droplets); a rollback on a real host. Then cut rc.3 from a green `ci-ok`, and tag `v0.1.0`.
