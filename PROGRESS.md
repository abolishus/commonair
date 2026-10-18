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

Phase 2 (each unit a background subagent in its own worktree; briefs in `.claude/briefs/phase2/`).
"Merged" means merged into `main` with the gate green; every merged unit gets an independent review,
and its author fixes the findings in a follow-up round.

| Unit                       | Status                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 2A api-core                | running                                                                                                                                       |
| 2B chat                    | merged; review running; contract-adoption round running                                                                                       |
| 2C irc                     | merged; reviewed; fix round running (WS without subprotocol, nonce pairing, join pacing, caps)                                                |
| 2D origin                  | merged (worker owns `egress_samples`); reviewed; fix round running (issuance persistence + leader, upstream pools, CDN tokens, token refresh) |
| 2E media                   | running                                                                                                                                       |
| 2F relay                   | merged; reviewed; fix round running (fetch limits, shutdown drain, reload verification)                                                       |
| 2G ui                      | merged; review running                                                                                                                        |
| 2H1 ledger + patronage     | merged; reviewed; fix round running (payout race, payout clearing, FIFO holds, locked reversals)                                              |
| 2H2 governance + integrity | merged; review running                                                                                                                        |
| 2I infra                   | running                                                                                                                                       |
| 2J harness core            | running                                                                                                                                       |
| 2L worker                  | merged; reviewed; fix round running (broadcaster-bound webhook auth, VOD prefix guard, poison entries, flaky timing tests)                    |
| 2M email + OTel            | merged; reviewed; fixes merged                                                                                                                |

Orchestrator changes since fan-out: gate runs uncached; contract absorption (webhook jobs, integrity
keys, cut/payout shapes, workerEnv, NOREPLY_EMAIL, SMTP_REQUIRE_TLS, chat control shapes, nonce echo,
bot verification); migrations 0003 (patronage retained, nominations) and 0004 (bot_verified).

Known decisions: relay receipts count media bytes only (segments, parts, init); issuance counts the same.

## Next

- Integrate each Phase 2 branch as it lands: merge locally, reconcile `bun.lock`, apply contract
  requests, `bun run verify`, reviewer subagent, commit, push.
- Then the first end-to-end bring-up (`podman compose up` + harness `ingest-rtmp`, `viewers`).
- Phase 3 briefs (web app, money, developer platform, channel bot, co-op, integrity pipeline,
  trust & safety, compliance, operations).
