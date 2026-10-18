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

## Session two (2026-10-18): end-to-end first

**Milestone E1 reached locally:** `bun scripts/infra.ts stack && bun harness/src/cli.ts run e2e-basic`
passes (web sign-up + email verification, stream key, RTMP publish, Chromium signed-in + WebKit
anonymous playback, chat both ways, offline). First run: TTFF 1.0 s (Chromium) / 1.8 s (WebKit),
glass-to-glass 2.1 s / 3.9 s. `verify --full` and `--scenario` now bring the platform up and install
browsers; CI on main runs `verify:full`.

Landed this session (all reviewed before merge, gate green):

- Infra (2I) merged: WAL-G push under a timeout (DROP DATABASE hang), Garage + migrate in the
  test subset, `infra.ts stack`, `init-env --merge`, tracker behind the `p2p` profile, fixed compose
  subnet trusted for `x-forwarded-for`.
- Web app (3A-e1): TanStack Start on Bun, `/api` + `/rpc` proxy, sign-up/in, dashboard, channel
  page (hls.js / native HLS + heartbeats), chat, embed. Contract: `docs/testing/e1-selectors.md`.
- Harness `e2e-basic` + fix: API-path sign-ups now verify via web-origin links.
- DB: integrity scan indexes (0006), users identity immutability trigger (0007), appeals subject
  index (0008). Storage: presigned PUT signs content type and length.
- Config: media disk budget / ladder cap, `OUTBOUND_ALLOW_PRIVATE_NETWORKS`.

In flight: web review fixes; API, media and integrity review fix rounds (briefs in
`.claude/briefs/e1/`); then worker integrity wiring (`2L-worker-integrity.md`).

## Handoff status (end of session one, 2026-10-18)

`main` at the handoff commit passes the full `bun run verify` (format, lint, typecheck, unit,
integration, licenses, domains, reuse, relay). All units below are merged except infra.

| Unit                       | Branch (`worktree-agent-…`)      | Merged                                | Open items (not done)                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | -------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2A api-core                | a6c3e9d45066950e6                | yes                                   | **API review (see HANDOFF): ReDoS-capable filter check, minors can edit birthDate**, category mature gate, third-party image URLs, better-auth admin endpoints unaudited, rate-limit subject behind proxy / IPv6 /64, relay+simulcast URL SSRF, upload size, per-recipient mail limits, interim verify too fast; `BUS.userControl` publishing; `developer.tokens.list/revoke`; TOTP integration tests |
| 2B chat                    | a10faca9017b35f37                | yes                                   | README for round-two behavior; test for OAuth revocation on an open socket                                                                                                                                                                                                                                                                                                                            |
| 2C irc                     | afc07554b4056edf3                | yes                                   | move `IRC_*` connection-limit env vars into `packages/config`                                                                                                                                                                                                                                                                                                                                         |
| 2D origin                  | a5d29e5776daab709                | yes (includes a `wip(origin)` commit) | integration tests for relay 401→429, CDN URIs without `t=`, HEAD not recorded; multi-replica issuance integration test; `ORIGIN_ISSUANCE_ENABLED` and `ISSUANCE_KEYS` into config/contracts                                                                                                                                                                                                           |
| 2E media                   | a910b90d0855b019d                | yes                                   | stale `processing` VOD reconcile; crash recovery of recordings + work-dir sweep; global disk budget; transcode slot limit; simulcast SSRF + protocol whitelist + generic errors; simulcast key out of argv; thumbnail history cleanup                                                                                                                                                                 |
| 2F relay                   | af349641b1a04d351                | yes                                   | none                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2G ui                      | a346bf0796b847ef4                | yes                                   | wire `test:node` into verify                                                                                                                                                                                                                                                                                                                                                                          |
| 2H1 ledger + patronage     | a0f0430ca5204e3c7                | yes                                   | READMEs for payout clearing, hold lots, `postReversal`, period close; callers must use the new APIs                                                                                                                                                                                                                                                                                                   |
| 2H2 governance + integrity | a3375f41100c11fad                | yes (governance fixes)                | **all integrity review items** (fetch-less bots, stream-hour eligibility, appeal stickiness, false positives, relay suspension, scale + indexes — exact SQL in HANDOFF); `subscriptionQualifies` unit test; `closeElection` test                                                                                                                                                                      |
| 2I infra                   | a856cff1eae87abf9 (head 0b1f3f9) | **no**                                | blocks on: WAL-G `archive_command` hangs when Garage is down, which makes `DROP DATABASE` hang (signal barrier) — needs a timeout wrapper and Garage in the test subset; `scripts/infra.ts` TEST_SERVICES change; compose needs the new infra env vars (now in `.env.example`)                                                                                                                        |
| 2J harness                 | a39c0557744e767c7                | yes                                   | export better-auth routes + ALTCHA field name from contracts; document heartbeat counters as deltas                                                                                                                                                                                                                                                                                                   |
| 2L worker                  | ad54ee1f3dbd2b43b                | yes                                   | decision: `chat:read` events bind to the subscriber's `user_id` (Twitch semantics), kept                                                                                                                                                                                                                                                                                                              |
| 2M email + OTel            | a9ba774c6001ac6db                | yes                                   | none                                                                                                                                                                                                                                                                                                                                                                                                  |

## Next

See HANDOFF.md: Milestone E1 (sign up → go live → watch → chat, end to end) first.

## Previous next steps

- Integrate each Phase 2 branch as it lands: merge locally, reconcile `bun.lock`, apply contract
  requests, `bun run verify`, reviewer subagent, commit, push.
- Then the first end-to-end bring-up (`podman compose up` + harness `ingest-rtmp`, `viewers`).
- Phase 3 briefs (web app, money, developer platform, channel bot, co-op, integrity pipeline,
  trust & safety, compliance, operations).
