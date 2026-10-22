<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# @commonair/api

The platform API: the oRPC contract from `@commonair/contracts` served as REST (OpenAPI) and
oRPC RPC, better-auth, the MediaMTX hooks, playback sessions and the relay protocol.

| Path                         | What                                                              |
| ---------------------------- | ----------------------------------------------------------------- |
| `/api/*`                     | REST routes from the contract (`OpenAPIHandler`)                  |
| `/api/openapi.json`          | Generated OpenAPI 3.1 document                                    |
| `/api/auth/*`                | better-auth (email + password, magic link, passkeys, TOTP, OAuth) |
| `/api/auth/altcha-challenge` | ALTCHA proof-of-work challenge for signups                        |
| `/rpc/*`                     | oRPC RPC (used by the web app)                                    |
| `/internal/media/*`          | MediaMTX auth and ready/not-ready hooks (never exposed by Caddy)  |
| `/healthz`, `/readyz`        | Liveness, and readiness (Postgres, Valkey)                        |

## Run locally

```sh
bun install
bun scripts/init-env.ts                 # once: writes .env with fresh secrets
bun scripts/infra.ts test               # Postgres, Valkey, Mailpit (and Garage) under Podman
bun run --filter @commonair/db migrate  # apply migrations
cd services/api && bun --env-file=../../.env run dev
```

The API listens on `API_PORT` (3001). Verification and magic-link emails land in Mailpit at
<http://localhost:8025>. Try it:

```sh
curl localhost:3001/api/instance
curl localhost:3001/api/openapi.json | head
```

## Tests

```sh
bun run test       # unit tests (pure logic: access control, rate limiting, ranking, …)
bun run test:int   # integration: real Postgres (createTestDatabase, app role), Valkey, Mailpit
```

Integration tests start the API in-process on a random port, against a throwaway database as
the least-privilege application role, with a unique Valkey key prefix. Set `API_TEST_LOG=1` to
see the service logs.

## Layout

- `src/routes/<namespace>.ts`: one file per contract namespace, assembled in `src/router.ts`.
  Namespaces owned by later units throw `NOT_IMPLEMENTED` (HTTP 501) until they replace the file.
- `src/lib/orpc.ts`: the shared implementer and the one middleware that enforces
  `ProcedureMeta` (access level, token scopes, rate limit). The decision itself is the pure
  `decideAccess` in `src/lib/access.ts`.
- `src/auth/`: better-auth configuration, signup gates (ALTCHA, 13+ age gate, usernames).
- `src/events/outbox.ts` (`emit`) and `src/events/audit.ts` (`audit`): write in the caller's
  transaction. Handlers publish directly only to `BUS.chatControl` and `BUS.live`.
- `src/discovery/`: fair-discovery ranking ([README](src/discovery/README.md)).
- `src/playback/`: delivery-source assignment and the interim session verification rule
  (`verify.ts`, replaced by the integrity unit).
- `src/media/`: MediaMTX auth decisions and lifecycle hooks.
- `src/lib/leaks.ts`: stream-key leak scanning and revocation (`findLeakedKeys`,
  `revokeLeakedKey`; also exported from the package for the chat service).

## Rate limits

Sliding-window buckets in Valkey (`src/lib/ratelimit.ts`, `DEFAULT_RATE_LIMITS`). Procedures pick
a bucket in their contract meta; signed-in callers are limited per user, anonymous callers per
client address (IPv4 per address, IPv6 per /64, HMAC'd). `/api/auth/*` writes use `auth` per address.

| Bucket      | Limit           | Subject                                                        |
| ----------- | --------------- | -------------------------------------------------------------- |
| `default`   | 120 / minute    | user, relay or address                                         |
| `write`     | 30 / minute     | user, relay or address                                         |
| `auth`      | 10 / minute     | address (better-auth writes)                                   |
| `chat`      | 20 / 30 seconds | user                                                           |
| `expensive` | 5 / hour        | user, relay or address                                         |
| `mail`      | 10 / hour       | per template per recipient mailbox, across all senders and IPs |

The `mail` bucket (`recipientLimitedMailer` in `src/mail.ts`) keys on
`<template>:HMAC(AUTH_SECRET, "mail:" + mailbox)`, where the mailbox is the address lower-cased
with any `+tag` dropped (and, for Gmail, dots dropped and googlemail.com folded into gmail.com).
The address itself never reaches Valkey or the logs. Each template has its own cap, so a flood of
magic links cannot block a password reset. Over the cap the mail is dropped silently: the caller
sees the usual success, so the endpoint does not reveal whether an account exists.

Client addresses are canonicalized before hashing (`canonicalIp` in `src/lib/netrange.ts`:
IPv4-mapped IPv6 unwrapped, IPv6 in RFC 5952 form, zone ids dropped), so one client gets one
`ip_hash`, one rate-limit subject and one `stream_keys.last_used_ip_hash` whatever the spelling.

Upgrade note: this changes the hashes of clients the socket reported as `::ffff:a.b.c.d` (they
now hash as `a.b.c.d`). For a broadcast that is live across the deploy, integrity's owner-IP
exclusion compares new viewer hashes with the old `stream_keys.last_used_ip_hash` until the
streamer publishes again. Rate-limit buckets for those clients start over once.

## Money

`money.*` lives in `src/money/`: checkout, subscriptions, tips and the treasurer's payment actions
in `checkout*.ts`, reports in `reports.ts`. The manual adapter (`PAYMENTS_PROVIDER=manual`, the
default) needs no vendor: checkout returns a `CA-XXXXXXXX` reference and the treasurer confirms
receipt. Every movement is posted to the ledger (`@commonair/ledger`) in the same transaction as
the state change, with its outbox events and audit row. State machines, what posts what, the lock
order and the gift-pool rule: [src/money/README.md](src/money/README.md).

Reports (`money/reports.ts`) read every figure from the ledger; `payments` only classifies a
posting (tier, gift, tip, payer). The revenue ledger omits hold releases and shows only CSV-safe
reference tokens. `runPayouts` treats `periodEnd` as an exclusive end.

## Co-op

`coop.*` lives in `src/coop/` (`routes/coop.ts` only maps it); the contract and every flow are in
[docs/testing/e5-selectors.md](../../docs/testing/e5-selectors.md), the policies in ADR 0020.

- **Database first (ADR 0004).** The triggers in `0001`, `0002` and `0021` enforce proposal
  transitions, the electorate and voting window, tallies, council responses, share transitions
  and two-person patronage approval. Handlers check the same rules first for clear errors
  (`coop/policy.ts`, a pure matrix) and map any trigger refusal that still happens (a race) to a
  contract error in `coop/errors.ts`; the SQL message never reaches a client.
- **The API never advances a proposal past discussion**, never writes `tallies` and never writes
  governance settings: the worker does (`proposals-advance`). The API drafts, edits, submits,
  withdraws, comments, votes and publishes the council's response.
- **Secret ballot.** A vote is an upsert of the caller's own `votes` row (one per member, so a
  change never adds a second). The choice goes nowhere else: audit `proposal.vote` and event
  `coop.vote.cast` carry the proposal id only, and a view shows `myVote` to its voter alone.
  While voting is open a view shows participation counts, never a tally; decided proposals show
  the `tallies` row.
- **Shares** use the manual adapter only (`PRECONDITION_FAILED manual_shares` with Stripe).
  `treasurer.confirm` confirms a `membership_share` payment through `coop/membership.ts`
  (`confirmShareTx`): payment `succeeded`, `sharePurchase` posted, share `held`, a viewer
  membership with basis `share`. Exiting the viewer class moves a held share to `refund_pending`;
  `coop.shares.refund` posts `shareRefund` and marks it `refunded`. Lock order: payment → share →
  membership.
- **Patronage.** `run` closes the ledger for exactly the period (`closePeriod`), then
  `computePeriod` with the caller as `computedById` (surplus defaults to all available,
  `availableSurplusCents`); `approve` refuses the runner (`SECOND_APPROVER`; the trigger does too)
  and posts the allocation in the same transaction as its audit row and event.
- **Audit and outbox.** Every action writes both in its transaction. Audit `details` hold ids,
  enums and numbers; free text the actor wrote (a board minute reference, a refund note) goes to
  `reason`. Members act as `user`, treasurers and admins as `admin`.
- **Test hook.** With `COOP_TEST_HOOKS=true` (a warning at start; `/healthz` reports it),
  `POST /internal/coop/tick` behind `INTERNAL_API_SECRET` enqueues the named `COOP_JOBS` job on
  `QUEUES.coop` in the worker's BullMQ prefix, waits up to 30 s and returns its result (504 on
  timeout or failure). Off, the path is 404 before the secret check.

## Relay lifecycle

`src/routes/relays.ts`. Postgres (`relay_nodes.status`) is the record; `KEYS.relays` in Valkey
holds the assignable set and contains `active` relays only.

```text
create ──► pending ──health ok──► active ──health fail──► degraded ──health ok──► active
             ▲                     │  │                       │
             │      draining hb /  │  └── worker: over-report ┴──► suspended ──reinstate──► pending
             │      worker timeout ▼                                  (admin)
             └──── register ─── offline ──heartbeat + health ok──► active
                                   │
   relays.remove (any status) ──► retired (retired_at set, token rotated; terminal)
```

- **Token.** A relay authenticates with the bearer token from `relays.create` (stored as
  `token_hash`). Any status authenticates except retired, so an offline relay can rejoin and a
  suspended one learns it is suspended.
- **Health.** `register` and every non-active heartbeat past the 60 s re-check window run
  `GET <publicUrl>/healthz` (3 s timeout, vetted address). Only a passing check makes a relay
  `active`; writes are compare-and-set on the status and token read, and `publishRelay` re-reads
  the row after writing `KEYS.relays`, so a suspension or retirement committed in between is
  never undone by a heartbeat.
- **Drain.** A heartbeat with `draining: true` sets `offline` and removes the relay from
  `KEYS.relays` at once (no audit row: operational). It never downgrades a suspension. It bumps
  `updated_at`, and the health-check CAS also requires `updated_at` unchanged, so a rejoin check
  already in flight cannot bring a drained relay back.
- **Timeout.** The worker sets relays that stop heartbeating `offline` and removes them from
  `KEYS.relays`.
- **Rejoin.** An offline relay rejoins by heartbeating (active after a passing health check, else
  it stays offline) or by registering again with the same token (`pending`, then `active` on a
  passing check). Offline relays keep their slot in the per-member limit of 5.
- **Suspension.** The worker suspends a relay whose receipts over-report and removes it from
  `KEYS.relays`. The relay still heartbeats and sees `suspended`; neither `register` nor a
  draining heartbeat lifts it. `relays.reinstate` (admin, audited) sets `pending` and runs a
  health check: the relay is republished to `KEYS.relays` only if it passes, otherwise its own
  heartbeats re-check it.
- **Retire.** `relays.remove` sets `retired_at`, rotates `token_hash` to a fresh random value,
  sets `offline`, removes it from `KEYS.relays` and audits `relay.retire` (idempotent). The row
  stays (receipts reference it); `relays.mine` omits it and it frees a slot.
- **Viewers.** `relays.mine` reads Postgres, so worker suspensions and drains show at once. A
  playback session whose token names a relay that is not in `KEYS.relays` (drained, timed out,
  suspended, retired) gets `switchTo` an origin playlist with a fresh origin token on its next
  heartbeat, and the session is re-recorded as `assigned_source = 'origin'`, `relay_id = null`.
  Integrity then judges it on origin fetches. That fails safe: an honest viewer's relay segments
  are missing from the origin count (undercounted), but no watch time goes unproven.
  A `relay_until` column (when the session left the relay) would let integrity judge each part
  on its own evidence; that is a future contract change.

## Notes

- Two-factor authentication turns on automatically once `two_factors` has the columns
  better-auth 1.7's plugin needs (`verified`, `failed_verification_count`, `locked_until`).
- OAuth providers sign in and link existing accounts; new accounts are created through the
  gated email signup only (the age gate needs a birth date).
- MediaMTX's auth requests cannot carry headers, so `/internal/media/auth` authenticates
  internal readers by the `internal` user and `INTERNAL_API_SECRET` password in the body;
  the ready/not-ready hooks require the `x-internal-secret` header.
- Appeals (`src/routes/appeals.ts`): `integrity` appeals take `session`, `user` or
  `integrity_flag` subjects and `moderation` appeals take `moderation_action`. Each must concern
  the appellant. `dmca_notice` and `account_action` return 501 until their tables are wired. An
  overturned integrity appeal is an integrity allowance (`packages/integrity/src/allowance.ts`).
  Nobody resolves their own appeal, and a moderator cannot resolve the appeal of their own mod
  action. Overturning a moderation appeal records the decision only: it does not lift the ban or
  timeout. Resolving writes an audit row (ids and enums only) and no outbox event: the event catalog
  is EventSub's public surface, and appeal outcomes are private to the appellant and staff.
- Playback sessions record the HTTP delivery source (`origin`, `relay`, `cdn`) as
  `assigned_source`, never `p2p`, even when the P2P loader is on. Whether P2P runs is client
  input (`p2pCapable`, `nativeHls`), and integrity expects only a 10% origin share from `p2p`
  sessions. A viewbot could claim P2P to slip past the fetch checks, and an honest lone peer that
  fetches everything over HTTP would trip `too_many_segments`. Instead, `trackerUrls` carry the
  playback token (`?t=`), the tracker records authenticated announces as swarm evidence
  (`KEYS.p2pPeer`/`p2pSwarm`), and integrity applies the reduced share only to evidenced sessions
  (`P2P_EVIDENCE`, ADR 0005).
