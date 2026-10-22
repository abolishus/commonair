<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# PLAN

Source of truth for phases, work units, and open decisions. Progress lives in
[PROGRESS.md](PROGRESS.md). Architecture: [docs/architecture.md](docs/architecture.md).

Every work unit has an owner list of paths (no two concurrent units share a path), the
contracts it honors, the tests it adds, and a done condition. Units are briefed to subagents
with the template in [AGENTS.md](AGENTS.md#subagent-briefing-template).

## Phase 0 — Foundation (orchestrator)

- Name decision (ADR 0001), license policy (ADR 0002), architecture (ADR 0003).
- Root toolchain: Bun workspaces, Vite+ (`vp`) fmt/lint/test, TypeScript 7 strict, REUSE.
- `packages/config`: `SITE` + env schemas; `scripts/check-domains.ts`, `scripts/check-licenses.ts`.
- `bun run verify` / `verify:full`, `scripts/infra.ts`, `scripts/init-env.ts`.
- FOSS docs: CONTRIBUTING (DCO), CODE_OF_CONDUCT, TRADEMARKS, SECURITY, GOVERNANCE, ROADMAP,
  issue/PR templates. AGENTS.md and skills.

## Phase 1 — Shared contracts (orchestrator)

Committed before any fan-out:

- `packages/contracts`: Zod schemas for every entity, the oRPC contract (all procedures with
  input/output, OpenAPI route metadata, scopes), event catalog and payloads, chat wire protocol,
  IRC tag mapping table, OAuth scopes, error codes.
- `packages/db`: Drizzle schema for every table (auth, channels, media, chat, social, bots/apps,
  events/webhooks, payments, ledger, co-op, governance, integrity, relays, T&S, compliance,
  audit), named initial migration, ledger and governance protection triggers.
- `packages/tokens`: playback/segment token and relay receipt formats (TS) + Go test vectors.
- `packages/observability`: logger + OTel bootstrap.
- `compose.yaml` data services (Postgres, Valkey, Garage, Mailpit) so integration tests run.

## Phase 2 — Core platform (parallel pods, each in its own git worktree)

Briefs follow the AGENTS.md template; each unit owns only the paths listed.

| Unit                     | Owns                                                     | Done                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2A api-core              | `services/api/**`                                        | server (oRPC RPC + OpenAPI, better-auth), access control from `ProcedureMeta`, rate limits, auth (email+password, magic link, passkey, TOTP, optional OAuth), ALTCHA, 13+ gate, channels, follows, fair-discovery directory, search, stream keys + leak scan, simulcast targets, MediaMTX hooks, playback sessions + delivery assignment, chat moderation REST, relay protocol, NOT_IMPLEMENTED stubs for later namespaces |
| 2B chat                  | `services/chat/**`                                       | WebSocket chat with every rule, fan-out via Valkey, moderation commands, persistence, plugin pipeline                                                                                                                                                                                                                                                                                                                      |
| 2C irc                   | `services/irc/**`                                        | Twitch-dialect IRC over TCP/TLS/WS translating to chat; unmodified tmi.js works                                                                                                                                                                                                                                                                                                                                            |
| 2D origin                | `services/origin/**`                                     | HLS edge: token checks, playlist rewrite, coalescing cache, accounting, relay pull, issuance, CDN pull                                                                                                                                                                                                                                                                                                                     |
| 2E media                 | `services/media/**`, `infra/mediamtx/**`                 | MediaMTX config, health sampling, adaptive ladder (NVENC/CPU), simulcast, VOD, clips, thumbnails, hash-match hook                                                                                                                                                                                                                                                                                                          |
| 2F relay                 | `relay/**`                                               | Go stdlib relay: register, serve, cache, signed receipts, static builds, container                                                                                                                                                                                                                                                                                                                                         |
| 2G ui                    | `packages/ui/**`                                         | shadcn base-lyra on Base UI, tokens, Rubik, house primitives, Storybook                                                                                                                                                                                                                                                                                                                                                    |
| 2H1 ledger+patronage     | `packages/ledger/**`, `packages/patronage/**`            | chart of accounts, posting rules, poster, payouts; versioned patronage formula with caps and explanations                                                                                                                                                                                                                                                                                                                  |
| 2H2 governance+integrity | `packages/governance/**`, `packages/integrity/**`        | TS mirror of the SQL rules, council seating, elections, membership sync; integrity signals and DB jobs                                                                                                                                                                                                                                                                                                                     |
| 2I infra                 | `compose.yaml`, `infra/**` (not mediamtx)                | full rootless stack, Garage bootstrap, WAL-G Postgres image, app DB role, observability, Caddy, Quadlet                                                                                                                                                                                                                                                                                                                    |
| 2J harness core          | `harness/**`                                             | CLI, scenarios, ffmpeg streamers (RTMP/WHIP, timestamp strip), Playwright viewers (Chromium/WebKit), HTTP viewers, viewbots, tmi.js bot, load test                                                                                                                                                                                                                                                                         |
| 2L worker                | `services/worker/**`                                     | BullMQ runtime + registry, outbox relay, webhooks (signed, retried, SSRF-safe), segment-stream aggregation, live counters, housekeeping                                                                                                                                                                                                                                                                                    |
| 2M libs                  | `packages/email/**`, `packages/observability/src/sdk.ts` | React Email templates (i18n-ready, no remote assets), mailer; OTel SDK under Bun                                                                                                                                                                                                                                                                                                                                           |

## Milestones — end-to-end vertical slices (current approach, from session two)

Phase 3–5 below are the backlog. Work now lands as vertical slices: API route + worker job + web
page + harness scenario together, at most ~6 units in parallel, each reviewed **before** merge and
merged only with `bun run verify` green and its scenario passing against `podman compose up`.

| Slice | Done when this harness scenario passes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1    | `e2e-basic`: sign up in the web UI, verify email, stream key, RTMP publish, watch in Chromium (signed in) and WebKit (anonymous), TTFF + glass-to-glass, chat both ways, offline. In `verify:full`                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| E2    | follows + directory/discovery page + one moderation action (ban/timeout) + tmi.js bot through the IRC gateway                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| E3    | a Go relay joins and serves viewers (origin issuance, receipts verified by the worker); a viewbot swarm is excluded from counts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| E4a   | design system first (session five): every primitive from the pinned shadcn CLI (base-lyra, Base UI) under one theme, shared shells/blocks in `packages/ui`, one Storybook page story per mockup board, drift-enforcement tests, apps/web migrated with every e1–e3 test id intact. No API/worker/DB/harness work                                                                                                                                                                                                                                                                                                                             |
| E4b   | money on top of E4a: the manual adapter (subscription, tip, ledger, revenue dashboard, chargeback clawback), then the Stripe adapter against stripe-mock                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| E4c   | trust & safety (ADR 0006), before any public instance: `trust-safety` passes. A stream showing a synthetic fixture image on the test hash list is ended within two sample intervals, the account is suspended, the evidence is held (deleting the account leaves it held), and an NCMEC report draft is queued. A scripted mature score labels a stream and gates it 18+. A scripted prohibited score blurs a stream and queues it, a moderator clears it, and the audit log shows both. An appeal reverses a label. A fixture-image avatar upload is rejected. Reports, mod queue and appeals UI, NCII takedown form with its 48-hour clock |
| E5    | co-op: memberships, a governance vote incl. the protected-decision rejection, council review, patronage run with statement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| E6    | the rest of Phase 4: simulcast to the mock target, overlays, VOD/clips, data export, account deletion, backup restore, load test, `--no-proprietary` profile                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

E4b follow-ups, decided but not built ([ADR 0007](docs/decisions/0007-e4b-money-follow-ups.md)):
one open unpaid gift per gifter per channel with a 24-hour gift window, automatic refund of money
Stripe collects for an ended subscription, and an "outcome unknown" state for Stripe refund calls.
Stripe Connect transfers to creators' connected accounts are later work (payout runs record
Stripe payouts but move no money).

The web/harness contract for each slice is a `docs/testing/<slice>-selectors.md` file (E1:
[docs/testing/e1-selectors.md](docs/testing/e1-selectors.md)); briefs live in `.claude/briefs/<slice>/`.

## Phase 3 — Product features (parallel pods, after Phase 2 integrates)

| Unit                                             | Scope                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3A web app                                       | `apps/web`: shell, directory, channel page (theatre, PiP, shortcuts, captions), chat UI, dashboard, settings, onboarding, health panel, command palette, embed route, overlay routes, footer Source link                                                                                                                  |
| 3B money                                         | subscriptions (3 tiers), tips, revenue dashboard, refunds, chargebacks + clawback, payouts (min threshold, monthly), Stripe adapter (Checkout, Billing, Connect Express, Tax) against stripe-mock, manual adapter treasurer UI                                                                                            |
| 3C developer platform                            | OAuth apps + scopes, bot accounts, EventSub webhooks + WS, delivery logs, test events, developer console, SDK package, docs pages with runnable examples                                                                                                                                                                  |
| 3D channel bot + interactivity                   | built-in bot (commands, timers, variables, filters, song request stub, loyalty points), polls, predictions, raids, alerts + goal overlays                                                                                                                                                                                 |
| 3E co-op                                         | membership classes + eligibility, shares, governance (proposals, discussion, council review, votes, tallies, protected decisions), creator council recompute, patronage runs + statements, ledger views, transparency page                                                                                                |
| 3F integrity                                     | session verification, signals (ASN/datacenter, concurrency, headless fingerprints, chat ratio, follow/raid bursts), exclusion with reasons, relay receipt cross-check, appeals, audit log                                                                                                                                 |
| 3G trust & safety + compliance                   | reports, mod queue, appeals, mod audit log, DMCA notice/counter-notice, mature labels + 18+ gate, data export, account deletion with pseudonymized retention, legal drafts + versioned acceptance, cookie consent. Automated moderation (hash matching, classifiers, legal hold, NCII takedown) is ADR 0006 and slice E4c |
| 3H VOD/clips/simulcast UI + streamer data export |                                                                                                                                                                                                                                                                                                                           |
| 3I operations                                    | status page, Grafana dashboards + alerts, WAL-G backups + tested restore, runbooks                                                                                                                                                                                                                                        |

## Phase 4 — Harness completion

Every scenario in "Done means" runnable individually (`bun harness/src/cli.ts run <name>`) and as
`full`: 20 streamers × 200 viewers, chat, subscription, tip, moderation, governance vote (with the
protected proposal that passes member-wide but fails in the streamer class), council review, data
export, relay join + serve, SDK bot + tmi.js bot, viewbot swarm excluded, over-reporting relay
caught, simulcast to mock RTMP, overlay alert on tip, chargeback clawback, patronage statement,
account deletion, backup restore. A `--no-proprietary` profile runs it all with no Stripe, OAuth,
or CDN. Load test: N streamers × M viewers reporting origin egress, CPU, p95 latency.

## Phase 5 — Release and self-hosting

GitHub Actions (verify on push, full harness on main + nightly), release workflow (tags,
changelog, images + relay binaries with provenance, cosign signing, CycloneDX SBOM), Quadlet units,
Caddy TLS, `scripts/selfhost.sh` one-command install, operator guide (config, upgrades, backups,
scaling), README contributor quickstart.

Decisions: [ADR 0023](docs/decisions/0023-release-and-self-hosting.md) (semver tags, ghcr.io
plus a mirror recipe, keyless cosign, Debian 13 and Fedora 42+, amd64 and arm64, the release
manifest and self-host bundle contracts, upgrades through `selfhost.sh upgrade`). Units: A CI
and the release workflow, B Quadlet/Caddy/`selfhost.sh`, C docs (after A and B). Briefs are in
`.claude/briefs/phase5/`.

## Phase two (product roadmap, not built now)

Twitch import (channel info, panels, emotes, schedule via Twitch OAuth); email / web push /
Discord go-live notifications; live auto-captions via speech-to-text; i18n (UI is built
translation-ready now: all user-facing strings go through `@commonair/i18n` message catalogs);
installable PWA; ActivityPub federation (followable channels, go-live posts); community
translations through self-hosted Weblate; an ads policy decision for governance.

Feature wins Twitch structurally can't ship (open books, verified audiences, one media clock,
captions, accountable safety), sequenced as Wave 0–3 work units with ADR candidates 0011–0019:
[docs/product/feature-wins.md](docs/product/feature-wins.md).

## Open decisions

| #   | Question                                                               | Status                                                                                                                                      |
| --- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Stripe in the harness without a real test account                      | Decided (ADR 0003): stripe-mock container + locally signed webhook events; real test keys + `stripe listen` when supplied                   |
| D2  | WebTorrent tracker implementation                                      | Decided (ADR 0005, amends 0003): native WS tracker on Bun.serve, playback-token auth, swarm evidence for integrity                          |
| D3  | WAL-G vs pgBackRest                                                    | Decided (ADR 0003): WAL-G in our Postgres image                                                                                             |
| D4  | IP→ASN data source for datacenter detection without a proprietary feed | Decided (ADR 0003): operator-supplied CIDR lists (bundled sample of public cloud ranges in the harness), pluggable lookup interface         |
| D5  | Governance enforcement model                                           | Decided (ADR 0004): triggers + least-privilege app role; residual risk documented                                                           |
| D6  | Automated content moderation (live frames, uploads, legal hold)        | Decided (ADR 0006, accepted 2026-10-20; licenses ADR 0008): tiered actions, PDQ matcher + local classifier, legal floors outside governance |
