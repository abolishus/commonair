<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# PROGRESS

Updated by the orchestrator after every integration step. Phases and units: [PLAN.md](PLAN.md).

## Done and verified

- Phase 0: name (ADR 0001), license policy + verified licenses (ADR 0002), architecture (ADR 0003),
  toolchain, REUSE, config module, stray-domain and license checks, `verify` script, project docs,
  AGENTS.md + skills, CI workflow.
- Phase 1: contracts (enums, shapes, scopes, events, chat protocol, tokens, full oRPC router,
  OpenAPI generation), Drizzle schema (all domains) + `0000_initial` + `0001_protections`
  (append-only ledger/audit, double-entry balance, governance protections re-tallying votes),
  tokens package with RFC 8032-anchored vectors, data services in `compose.yaml`.
- Two security reviews of the database protections; every proven bypass fixed with a regression
  test (`0002_protections_hardening.sql`, ADR 0004). Tests run as a least-privilege role.
- Secret scanning and push protection enabled on the GitHub repository.

## In flight

Phase 2 units, each a background subagent in its own git worktree (briefs in
`.claude/briefs/phase2/`), started 2026-10-18:

| Unit                       | Owns                                                     | Status  |
| -------------------------- | -------------------------------------------------------- | ------- |
| 2A api-core                | `services/api/**`                                        | running |
| 2B chat                    | `services/chat/**`                                       | running |
| 2C irc                     | `services/irc/**`                                        | running |
| 2D origin                  | `services/origin/**`                                     | running |
| 2E media                   | `services/media/**`, `infra/mediamtx/**`                 | running |
| 2F relay                   | `relay/**`                                               | running |
| 2G ui                      | `packages/ui/**`                                         | running |
| 2H1 ledger + patronage     | `packages/ledger/**`, `packages/patronage/**`            | running |
| 2H2 governance + integrity | `packages/governance/**`, `packages/integrity/**`        | running |
| 2I infra                   | `compose.yaml`, `infra/**` (not mediamtx)                | running |
| 2J harness core            | `harness/**`                                             | running |
| 2L worker                  | `services/worker/**`                                     | running |
| 2M email + OTel SDK        | `packages/email/**`, `packages/observability/src/sdk.ts` | running |

## Next

- Integrate each Phase 2 branch as it lands: merge locally, reconcile `bun.lock`, apply contract
  requests, `bun run verify`, reviewer subagent, commit, push.
- Then the first end-to-end bring-up (`podman compose up` + harness `ingest-rtmp`, `viewers`).
- Phase 3 briefs (web app, money, developer platform, channel bot, co-op, integrity pipeline,
  trust & safety, compliance, operations).
