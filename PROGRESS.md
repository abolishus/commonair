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

## E4c `trust-safety` harness bring-up (2026-10-21, in progress)

Steps 1–6 of `trust-safety` pass against the local Podman stack (T0 off air ≈ 5 s against a 9 s
limit, T2 label ≈ 4 s, T1 restrict ≈ 3 s). Step 7 (NCII clock) fails: F's live clips fail in media
(see "Open" below). Run it with `bun scripts/infra.ts stack harness/compose.trust-safety.yaml`, then
`bun harness/src/cli.ts run trust-safety` (`--set steps=7` runs one step).

Fixed (each with a regression test checked against the old code; API/worker/media changes
reviewed independently):

- Env/infra: `TRUSTED_PROXY_CIDRS` was unset locally, so all simulated users shared one auth
  rate-limit bucket (local `.env` only). `infra.ts stack [override.yaml...]` layers compose
  overrides and recreates containers whose image was rebuilt (podman-compose does not).
  Compose defaults `S3_PUBLIC_ENDPOINT` to the published Garage port (presigned uploads and media
  URLs carried `garage:3900`). ffmpeg is now in the api and worker images (uploads and live T1/T2
  scans failed without it).
- API: the `/internal/moderation/*` test hooks were never served; `startModeration` now runs at
  boot (fail closed) and `/healthz` reports the hooks; `bullmq` was not a dependency, so every
  real T0/escalation/NCII enqueue threw; `vods.list/get` and `clips.create/list/get` implemented
  (were 501) with T0/NCII/T1 hiding, a removed-source backstop for clips and the 18+ gate on media
  URLs; removing a VOD also removes its broadcast's clips.
- Worker: `t0-media` job ids had `:` in a form BullMQ rejects, so evidence moves after T0 (and the
  daily reconciler and digest checks) never ran; the T0 evidence count is logged as
  `evidenceCount`.
- Web: a T1-restricted stream shows `stream-restricted` and plays only for confirmed adults; a
  decided moderation case stays open and refreshed.
- Harness: deletion timestamps read as strings; queue rows open through their button.

Open: live clips fail with "broadcast is not live here and has no VOD". The recorder's poll loop
runs, but `Bun.file(<dir>/<runId>.m3u8).exists()` is false inside the media process although the
playlist is on disk (`known` stays 0), so `localWindow` is always empty. Not yet explained; the
recorder's `runs` id has not yet been compared with the on-disk playlist name.
`e4b-money` passes on the same stack (82/82).
vods/clips `update/remove` remain 501 (E6). `vods.broadcast_id` has no index (the clip backstop
subquery uses it).

## E4b validation (2026-10-21)

Resumed at the user's request. Local `e4b-money` passes: manual API **77/77** assertions,
manual browser **82/82**, Stripe API against stripe-mock **95/95**. Stripe used the pinned
v0.206.0 upstream fixtures with `balance_transaction.fee=50` and matching `net`; stock fixtures
report zero fees and cannot confirm payments. Temporary mock keys and a compose override were
used; no real Stripe account or money. The manual adapter was restored afterward.

Storybook builds; Support dark/light, mobile 320, gift controls, instructions, no-tiers,
PageTabs disabled tabs and wrapped ChoiceToggle inspected. Fixed oversized option-card radios
(horizontal Field orientation), treasury actions racing a debounced search, and the harness
reading the provider before Support loaded. Added option-card and worker health-port regressions.
The gate also exposed formatting/lint issues and a macOS watcher-test race, now fixed.

Full `bun run verify` passed before the last money/infra fixes. The rerun stopped at infra up
because the local `.env` predated the E4c evidence keys (`garage-init: S3_EVIDENCE_ACCESS_KEY_ID
is required`); after `init-env --merge`, `bun scripts/infra.ts test` is healthy. Final gate: user.
Local setup: web uses port 3100; the existing Podman network is `10.89.0.0/24`, so API trust was
set to that actual subnet for these runs. No Railway deployment was performed. ADR 0007
follow-ups remain deferred.

Gate flakes fixed on 2026-10-21. These were load-related failures, and none was a product bug:

- The harness player now waits up to 2 s for WebKit's native-HLS answer.
- Compose Postgres runs with `max_connections=400` (`POSTGRES_MAX_CONNECTIONS`, applied by the
  entrypoint). The parallel suites peaked at the default of 100 and got "remaining connection slots
  are reserved". A restore needs at least the primary's value, and `restore.sh` now says so.
- Integration files that use a test database allow 30 s per test and 60 s for hooks: the suites
  run in parallel, and Postgres runs DROP DATABASE one at a time.
- The chat emote-only test waits for the settings frame on the other instance.
- Media VOD fixture rows are inserted after the upload, so the service's stale-VOD reconcile
  cannot finalize them first. The barrier tests fail fast instead of hanging.
- The chat filter latency test asserts p50 < 2 ms and p99 < 50 ms.
- The stack test tears down by label with `--depend`.
- `infra.ts test` now removes test containers and stacks older than 2 h and idle test databases
  created more than 2 h ago. Killed runs had leaked 4 running stacks, 22 containers and 60
  databases.

## Session eight (2026-10-20–21): E4c trust & safety (implemented; user validation pending)

ADR 0006's open questions resolved (native TypeScript PDQ/vPDQ, default classifier
`AdamCodd/vit-base-nsfw-detector` on ONNX Runtime for sexual content only, NCMEC drafted by the
platform and filed by a `legal` user, evidence sealed in append-only Postgres because Garage
cannot deny delete) and the license judgments recorded in ADR 0008. Both were accepted
2026-10-20.
**Contract step done** (head agent, on `main`, since pushed): spec, enums, migrations
0015/0016 with DB-enforced protections, hold CLI (`3d51fbc`); contracts with internal events,
moderation jobs and payloads, T&S entities, `moderation.*`/`ncii.*` procedures and 501 stubs,
`legal`/`safety-staff` access (`7501bb9`, `0e948da`); `moderationEnv` and the evidence keypair in
init-env (`f038c0e`); `packages/moderation` scaffold with the evidence seal implemented and
tested (`2813f99`); the worker-only Garage evidence bucket and key, evidence secrets scoped per
service in compose/Quadlet (`6377f0c`); `scripts/fetch-model.ts` with the pinned digest
(`5658eef`); unit briefs A–F (`738532e`). **Units A–F are reviewed and merged** on local `main`
(HEAD `132a402`, pushed). B, C and D had additional security reviewers; HIGH findings were
fixed and focused re-reviews passed. Final targeted checks: API integration 171/171 (13 files),
worker integration 68/68, media integration 23/23, web unit 677/677 plus typecheck/lint/build,
harness unit 289/289 plus typecheck/lint. The operator guide and production mounts are integrated;
hash lists mount read-only with an empty FOSS default, the ONNX model mounts read-only into API
and worker, and deprecated `HASH_MATCH_*` settings are removed. User validation remains: full
`bun run verify`, `bun run verify --scenario trust-safety`, image rebuilds, Storybook, browser and
Railway checks.

## Session six (2026-10-19): E4b money (in progress)

Manual adapter first, then Stripe against stripe-mock (PLAN.md E4b). Plan and units in
HANDOFF.md "Session six in flight" and `.claude/briefs/e4b/`.
Session seven (2026-10-20): all nine units (A–I) reviewed and merged — manual adapter, Stripe adapter, web pages, harness `e4b-money` (manual and `provider=stripe`), ledger/worker and ui follow-ups. E4b is code-complete; not yet run by the user: verify, e4b-money, Storybook, browser.

Paused 2026-10-20 at the user's request. On `main`: the contract step, migrations 0013–0014, the
operator role CLI, `packages/payments` scaffold, the spec `docs/testing/e4b-selectors.md`, and
the worker money jobs (expiry, renewal, hold release; reviewed, fix round merged). Built but not
merged (branches listed in HANDOFF.md "Resume point"): API checkout, API reports, web Support
dialog, harness `e4b-money`; web money pages unfinished. Not run live by the user yet.

## Session five (2026-10-18): E4a design system (in progress; resumed 2026-10-19)

Application design only (PLAN.md E4a). Mockup canvas: <https://claude.ai/artifact/Ve5J5XjRZV42eRE2cdReVd>
(29 boards). Units in `.claude/briefs/e4/`: U1 primitives (shadcn CLI 4.21.1, preset `b1ZhhFNpx`),
U2 shells/headers, U3 data blocks, U4 form blocks, U5 media/player/chat blocks, U6 page stories +
enforcement + apps/web migration. U1–U5 are now reviewed, merged and pushed to `main` at
`3b882054`. U1 brought in the primitives and gallery; U2 shells/navigation/headers; U3 data blocks
plus cataloged TanStack Table 8.21.3; U4 form/settings blocks; U5 media/player/chat blocks. Review
HIGHs were fixed and focused re-reviews passed. Targeted tests/typecheck/lint/format passed; UI
Storybook builds passed for U1, U2, U4 and U5. The aggregate unit-test command also completed
successfully during integration. U6b (apps/web migration + apps/web source-policy test) merged
2026-10-19 after review and re-review (`6d31d95`). U6a (board page stories + packages/ui
source-policy test) merged after review and re-review (`2a5c2c7`). U7 packages/ui follow-ups (new compositions,
allowlist cleared, `formatUnitCost`) merged ahead of its independent review at the user's request;
its review found no HIGH; the four MEDIUMs are fixed (`4c2829e`). E4a is complete pending the user's gate, Storybook and browser checks.

## Session four (2026-10-18): E3 slice built

All merged and pushed to `main`; live testing is the user's (HANDOFF.md "For the user to run").
Review was lighter at the user's request (HIGHs only, no re-review of fix rounds).

- **E3 built**: API relay lifecycle (retire/rejoin/drain/suspend), Go relay draining + heartbeat
  state machine, web `/relays` + player `data-source`, harness `e2e-relay` with a liar relay.
  Contract: `docs/testing/e3-selectors.md`. Milestone E3 is reached when the user's live
  `e2e-relay` run passes.
- P2P: `services/tracker` built; integrity judges P2P only on per-session evidence with a
  channel-wide per-network cap (ADR 0005, `KEYS.p2pChannelNet`).
- Legal drafts seeded by the migrate job; legal API; consent rate-limited.
- Next: E4 opens with the design-system track, then money (PLAN.md).

## Session three (2026-10-18): E2 slice built, review-gated

All merged after independent review (HIGH findings re-reviewed), pushed to `main`; live testing is
the user's (see HANDOFF.md "For the user to run").

- Worker integrity wiring merged (jobs, run locks, fetch evidence, viewer-count republish).
- API round 3: appeals, heartbeat floor, canonical IP hashes, `pinnedGet` deadline,
  `channels.get.viewer.following`. P2P source recording deferred until the tracker gives
  server-side swarm evidence.
- Shared `@commonair/safe-regex` with a sound cost model; chat filters re-validated on load and run
  in a worker pool with a hard timeout and quarantine.
- **E2 built**: directory home, follow button, chat moderation (web) + `e2e-social` scenario with a
  tmi.js bot through the IRC gateway (harness). Contract: `docs/testing/e2-selectors.md`.
  Milestone E2 is reached when the user's live `e2e-social` run passes.
- Contracts/config: auth routes, appeal subjects, `ircEnv`, `ORIGIN_ISSUANCE_ENABLED`; harness
  Mailpit basic auth for Railway staging; IRC health port published.

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

Also merged after review: API (2A) rounds one and two, integrity (2H2) and media (2E) review
fixes, web review fixes. Open: worker integrity wiring (branch `worktree-agent-a07b926d662d5d4bd`,
WIP), API round 3 and the contract requests listed in HANDOFF.md.

## Handoff status (end of session one, 2026-10-18; superseded by HANDOFF.md)

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
