<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Architecture overview

This is the map for contributors. Decisions behind it are recorded as ADRs in
[`decisions/`](decisions/); the engineering rules live in [`AGENTS.md`](../AGENTS.md).

## Components

```
                 ┌────────────── streamers (OBS / ffmpeg) ──────────────┐
                 │ RTMP :1935                         WHIP :8889        │
                 ▼                                                      ▼
            ┌─────────┐   auth hook (HTTP)    ┌──────────────┐
            │ MediaMTX│ ────────────────────▶ │ services/api │ ◀── web, SDK, bots (oRPC / OpenAPI)
            │ ingest  │   runOnReady/NotReady │  oRPC + auth │ ◀── Stripe webhooks (optional adapter)
            │ + HLS   │ ────────────────────▶ │  + eventsub  │
            └────┬────┘                       └──────┬───────┘
     RTSP pull   │  LL-HLS                           │ Postgres (Drizzle)  Valkey (pub/sub, presence,
                 │                                   │ rate limits, cache)  BullMQ (jobs)
   ┌─────────────┴──┐     ┌──────────────────┐       │
   │ services/media │     │ services/origin  │ ◀─────┘ playback sessions, signed segment tokens
   │ ffmpeg ladder, │     │ HLS edge: token  │
   │ simulcast, VOD │     │ check, playlist  │ ──▶ viewers (hls.js + p2p-media-loader)
   │ recording,     │     │ rewrite, egress  │ ──▶ member relays (Go) ──▶ viewers
   │ thumbnails     │     │ accounting       │ ──▶ optional CDN origin-pull (off by default)
   └────────────────┘     └──────────────────┘
   ┌──────────────┐  Valkey pub/sub  ┌─────────────┐
   │ services/chat│ ◀──────────────▶ │ services/irc│ ◀── tmi.js and other Twitch-IRC bots (TCP/TLS/WS)
   │ Bun WS       │                  │ IRCv3 tags  │
   └──────────────┘                  └─────────────┘
   ┌────────────────┐
   │ services/worker│ BullMQ: webhook delivery, exports, deletion, patronage runs, council
   │                │ recompute, integrity scoring, receipt verification, VOD retention, backups
   └────────────────┘
```

| Unit        | Path               | Runtime                          | Responsibility                                                                                                                                                                      |
| ----------- | ------------------ | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web app     | `apps/web`         | TanStack Start (React 19) on Bun | All user-facing UI, SSR, the embeddable player route, OBS overlay routes                                                                                                            |
| API         | `services/api`     | Bun                              | oRPC router (RPC for our clients, OpenAPI REST for everyone), better-auth, MediaMTX auth/lifecycle hooks, payment webhooks, EventSub WebSocket transport, playback session issuance |
| Chat        | `services/chat`    | Bun WebSockets                   | Chat rooms, moderation enforcement, slow mode, filters, emotes, fan-out via Valkey                                                                                                  |
| IRC gateway | `services/irc`     | Bun TCP/TLS + WS                 | Twitch-compatible IRC dialect (IRCv3 tags, CAP, PASS oauth:) bridged to chat                                                                                                        |
| Origin      | `services/origin`  | Bun                              | HLS edge in front of MediaMTX: verifies signed playback tokens, rewrites playlists (relay/CDN assignment, renditions), logs segment fetches for integrity and egress-by-source      |
| Media       | `services/media`   | Bun + FFmpeg                     | Adaptive transcoding above the viewer threshold, simulcast restreams, VOD recording and clips, thumbnails, frame sampling for automated moderation (ADR 0006)                       |
| Worker      | `services/worker`  | Bun + BullMQ                     | Background jobs (see diagram)                                                                                                                                                       |
| Tracker     | `services/tracker` | Bun                              | WebTorrent tracker for viewer-to-viewer segment sharing                                                                                                                             |
| Relay       | `relay/`           | Go (stdlib only)                 | Member-run segment cache: registers, health-checked, serves assigned viewers, signs bandwidth receipts                                                                              |
| Harness     | `harness/`         | Bun + Playwright + FFmpeg        | Simulated streamers, viewers, bots, viewbots, load test, scenarios                                                                                                                  |

Shared packages (`packages/*`) hold everything two units must agree on:

| Package         | Contents                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------- |
| `config`        | `SITE` identity (the only place the domain lives), env schemas                                                 |
| `contracts`     | Zod schemas, the oRPC contract (router types), event payloads, chat and IRC protocol types, scopes             |
| `db`            | Drizzle schema, committed named migrations, client factory, append-only/ledger triggers                        |
| `ledger`        | Double-entry posting rules and account chart                                                                   |
| `governance`    | Tally rules, quorum, protected-decision enforcement, council review rules                                      |
| `patronage`     | Versioned allocation formulas with line-by-line explanations                                                   |
| `integrity`     | Viewer/session/relay scoring signals and exclusion decisions                                                   |
| `payments`      | Payment-provider adapter interface, `manual` (default) and `stripe` adapters                                   |
| `storage`       | S3-compatible object storage adapter (Garage by default)                                                       |
| `tokens`        | Ed25519 playback/segment token and relay receipt signing and verification (TS side; the relay has the Go side) |
| `observability` | OpenTelemetry setup, structured logger, metrics helpers                                                        |
| `email`         | React Email templates and the mailer                                                                           |
| `ui`            | shadcn/Base UI components, house primitives, theme tokens, Storybook                                           |
| `player`        | hls.js + p2p-media-loader player component with integrity heartbeats                                           |
| `sdk`           | Published TypeScript SDK: typed API client, EventSub WebSocket client, chat client                             |

## Key flows

**Going live.** OBS publishes to `rtmp://…/live/<stream key>` (or WHIP). MediaMTX calls the
API's auth hook, which resolves the key to a channel (constant-time compare against a hashed
key), rejects banned/suspended channels, and returns 200. MediaMTX's `runOnReady` hook marks
the broadcast live; the API writes a `broadcasts` row, publishes `stream.online` to the event
bus, and the media service starts recording/simulcast as configured.

**Watching.** The web player asks the API for a playback session (`playback.start`), getting a
short-lived Ed25519-signed token that binds session, channel, and delivery assignment (origin,
relay, or CDN). Playlists from `services/origin` embed per-session segment tokens; the origin or
relay verifies each segment request. The player heartbeats every 10 s with playback stats
(stalls, P2P/HTTP bytes, latency). Viewer counts are computed only from sessions that the
integrity scorer marks verified.

**Relays.** A relay registers with a member's relay token, the origin health-checks it and
assigns it a share of new sessions in proportion to declared and measured capacity. The relay
pulls segments from the origin, verifies viewer tokens with the origin's public key, and every
minute submits Ed25519-signed receipts (token id, bytes, segment count). The worker cross-checks
receipts against the origin's issuance log for that relay; over-reporting beyond tolerance
suspends the relay pending review. Only verified receipts count toward patronage.

**Events.** Every domain event is written to the `events` outbox table in the same transaction
as the change that caused it, then published on Valkey. The worker delivers webhooks (HMAC
signed, retried with backoff, delivery log kept) and the API's EventSub WebSocket fans out to
subscribed connections. Overlays and bots consume the same stream.

**Money.** Payment adapters turn provider events into normalized payment events. Every revenue
event, platform cut, refund, chargeback, cost, payout and patronage allocation is posted to the
append-only double-entry ledger (database triggers reject UPDATE/DELETE and unbalanced
transactions).

**Governance.** Protected settings live in `governance_settings`. A database trigger rejects any
change that does not reference a proposal whose recorded tally passed the protected-decision
rule (member-wide supermajority AND a streamer-class majority). Admin roles cannot bypass it.

## Data and state

- Postgres 17 is the system of record. Migrations are generated by drizzle-kit with names and
  committed in `packages/db/drizzle/`.
- Valkey holds ephemeral state only: presence, rate-limit buckets, caches, pub/sub, BullMQ.
  Losing Valkey loses no durable data.
- Object storage (S3 API) holds VODs, clips, thumbnails, exports, uploads and WAL archives.

## Running more than one instance

ADR 0032 runs the app services as replicas from stage 2; the `multi-instance` harness scenario
rehearses it. Known bounds:

- **Relay issuance** takes a Valkey leader lock per tick (`services/origin/src/issuance.ts`). The
  winner keeps it until its TTL, shorter than the tick, so one replica computes per tick; a
  failed tick releases it for a retry.
- **Chat caches** (channel 60 s, profile 15 s, standing 30 s; `services/chat/src/directory.ts`)
  are invalidated over the room's control channel, which an instance subscribes to only while it
  has local members in the room. After the last one leaves it keeps its caches, so a ban or
  settings change made meanwhile reaches it only when the entry expires.
- **Chat acknowledges messages before storing them**: `MessageWriter` flushes every 250 ms.
  SIGTERM closes and flushes it; SIGKILL can lose acknowledged messages from the last interval,
  so rolling upgrades drain chat with SIGTERM.

## Observability

Every service initializes `@commonair/observability` first: OTLP traces and metrics to the
OpenTelemetry Collector, JSON logs to stdout (shipped to Loki). Grafana dashboards and alert
rules are provisioned from `infra/grafana/`.
