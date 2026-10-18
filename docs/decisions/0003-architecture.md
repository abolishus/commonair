<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0003: Platform architecture and foundational choices

- Status: accepted
- Date: 2026-10-18

## Context

The platform must be production-grade, FOSS end to end, self-hostable on one Linux server, and
built by parallel agents against shared contracts. See [architecture.md](../architecture.md) for
the component map. This ADR records the choices that are not obvious from the code.

## Decisions

1. **Monorepo, Bun workspaces, Vite+ toolchain.** Vite+ (MIT, verified in ADR 0002) provides fmt
   (Oxfmt), lint (Oxlint, type-aware), test (Vitest) and the task runner. Tests run under the Bun
   runtime (`bun --bun vp test run`) so services' `Bun.*` APIs are testable without shims.
2. **Contract-first API with oRPC.** `packages/contracts` holds the full router contract with
   REST-style routes; services implement it, the web app and SDK consume it, and the OpenAPI 3.1
   document is generated from it. Event payloads mirror Twitch EventSub (names, snake_case
   fields, envelopes, HMAC scheme) to make bot migration cheap.
3. **Enforcement in the database.** The ledger's append-only and double-entry rules and the
   governance protections are Postgres triggers. The settings trigger re-tallies the proposal
   from the raw votes and the frozen electorate, so neither an admin role nor an application bug
   can change a protected setting without a passed protected decision (member-wide
   supermajority AND a streamer-class majority, after creator-council review). Changing those
   triggers is itself a protected change to the code and is called out in GOVERNANCE.md.
4. **One playback token per session, Ed25519.** The API signs a short-lived token binding session,
   channel, path and delivery source. The origin and relays verify it with the origin's public
   key, so relays need no database access. Relays sign receipts with their own key over exact
   payload bytes (no JSON canonicalization). Shared test vectors pin both implementations.
5. **Viewer counts from verified sessions only.** Public counts, raids, patronage viewer-hours and
   streaming-hour eligibility use sessions the integrity scorer marked `verified`. Excluded
   sessions are kept with reasons, visible to the streamer and admins.
6. **IRC gateway is a translator.** It opens one upstream chat WebSocket per IRC client and maps
   frames to Twitch-dialect IRC (IRCv3 tags, `msg-id` notices). All chat rules live in the chat
   service only.
7. **Stripe without a Stripe account.** The Stripe adapter targets `stripe-mock` (MIT) in the
   harness, and the harness signs webhook events locally with the configured webhook secret
   using Stripe's documented scheme. With real test-mode keys an operator can use `stripe listen`
   instead. Live keys are refused by config validation. The default adapter is `manual`.
8. **Datacenter detection without a proprietary feed.** The integrity system takes an
   operator-supplied list of hosting-provider CIDR ranges (and optional ASN map) through a
   pluggable lookup interface. The harness ships a small sample list.
9. **Backups with WAL-G** (Apache-2.0) in our own Postgres image, archiving to the S3 bucket
   (Garage by default). pgBackRest (MIT) is the documented alternative.
10. **P2P tracker:** `bittorrent-tracker` (MIT) server-only import running under Bun.
11. **IDs are UUIDv7** minted by the application.

## Consequences

- Contract and schema changes are serialized through the orchestrator; implementers request them.
- The harness can exercise payments, governance and integrity end to end with no vendor accounts.
