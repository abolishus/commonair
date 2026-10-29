<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0027: OAuth for third-party apps, the EventSub WebSocket, and the SDK

- Status: accepted (2026-10-27; the maintainer accepted the recommended answers, see
  [Decisions at acceptance](#decisions-at-acceptance-2026-10-27))
- Date: 2026-10-27 (code checked at `ccf9c17`)

## Context

Milestone E9 (`.claude/briefs/next/E9-developer-platform.md`, batch 3) opens the platform to
third-party developers: register an app, have a streamer authorize it with scopes, call the
public API, and receive events by webhook or WebSocket, with a published SDK. Twitch bots should
port with a scope map and the IRC gateway. This ADR fixes the protocol shape before the contract
step.

What the code has today:

- **App and token tables exist, the flows do not.** `oauth_apps`
  (`packages/db/src/schema/platform.ts:11-29`) has a `clientSecretHash` that is `notNull` (`:21`),
  exact `redirectUris` (`:22`) and a `confidential` flag whose comment says only public apps must
  use PKCE (`:23-24`). `oauth_codes` (`:31-44`) has a nullable `codeChallenge` (`:41`) and no
  challenge method. `oauth_tokens` (`:46-65`) hashes access and refresh tokens (`:56-57`), has
  `revokedAt`, no refresh-family id, and a `userId` that is `notNull` (`:52-54`). Nothing in
  `services/api` reads `oauth_codes`.
- **Bearer tokens already authenticate.** `resolveToken` (`services/api/src/lib/caller.ts:36`)
  looks a token up by SHA-256, inner-joined to its user (`:42`), and returns its scopes and
  `appId`. Revoking a token publishes a `disconnect` on `BUS.userControl` with the token hash
  (`services/api/src/routes/developer.ts:65`); the chat service closes matching sockets
  (`services/chat/src/server.ts:110-120`). `developer.tokens.validate` keeps Twitch's
  `/oauth2/validate` shape (`services/api/src/routes/developer.ts:74`).
- **Twelve developer stubs.** `apps.*` (`services/api/src/routes/developer.ts:26-30`) and
  `events.*` (`:96-102`).
- **Webhook delivery is built** in the worker (`services/worker/src/webhooks/**`: signing,
  backoff, SSRF guard, callback verification, redelivery). `event_subscriptions` already carries
  a `websocketSessionId` (`packages/db/src/schema/platform.ts:87-114`) and states `enabled`,
  `verification_pending`, `failed`, `revoked` (`packages/contracts/src/enums.ts:207`).
- **The WebSocket message shapes are declared** (`WsMetadata`, `WsMessage`,
  `packages/contracts/src/events.ts:775-797`): `session_welcome`, `session_keepalive`,
  `notification`, `session_reconnect`, `revocation`, with `keepalive_timeout_seconds` and
  `reconnect_url`. No server implements them. The API process passes no WebSocket handler to the
  shared server (`services/api/src/main.ts:32`), though `packages/service/src/server.ts:26`
  accepts one; Caddy routes `/api/*` and `/rpc/*` to it
  (`infra/caddy/Caddyfile:162-167`) and `/chat` to the chat service (`:176-179`).
- **Rate limits are keyed by user, not by app.** The subject is `u:<userId>` for any signed-in
  or token caller (`services/api/src/lib/orpc.ts:137`), over the buckets in
  `DEFAULT_RATE_LIMITS` (`services/api/src/lib/ratelimit.ts:18`), stored in Valkey.
- **Scopes have English descriptions in the contract** (`packages/contracts/src/scopes.ts:8`
  onward) and a Twitch map (`TWITCH_SCOPE_MAP`, `:31`).
- **No SDK.** `packages/sdk` does not exist; `harness/src/bots/sdk-bot.ts` is a stand-in that
  describes the surface the SDK must provide. `@commonair/contracts` is `private: true`.
- **Open test gap.** PROGRESS.md's 2B chat row lists "test for OAuth revocation on an open
  socket" as not done (`PROGRESS.md:1184`).

There are no third-party apps, no issued app tokens and no public instance, so every change below
is a clean replacement with no migration window for existing clients.

## Decisions

### 1. OAuth 2.1 shape

- **Authorization code with PKCE for every client**, confidential or public, `S256` only. A
  confidential client also authenticates with its secret at `/oauth/token`. Why: PKCE protects
  against code interception whatever the client type, and OAuth 2.1 requires it; one rule is
  simpler to implement and to document than two.
- **No implicit grant, no password grant.**
- **Exact redirect URI match** against `oauth_apps.redirectUris`: no prefix, wildcard or query
  tolerance. Loopback redirects for native apps match on scheme, host and path, with any port
  (RFC 8252), the one exception OAuth 2.1 keeps.
- **Refresh-token rotation with reuse detection.** Every refresh returns a new refresh token and
  revokes the old one. Tokens carry a family id; presenting an already-rotated refresh token
  revokes the whole family and publishes a `disconnect` for each revoked access token.
- **Client credentials for app-only tokens.** An app can get a token with no user, for app-level
  reads and for managing its own webhook subscriptions. Such a token carries no scopes: every
  procedure that requires a scope refuses it, so it can never act as, or read the private data
  of, a user. A webhook subscription it creates is backed by a user who has authorized the app
  with the event's scopes, recorded in `event_subscriptions.userId` as today
  (`packages/db/src/schema/platform.ts:92-95`), and is refused if no such authorization exists.
- **Consent screen in plain words.** `apps/web/src/routes/_app/oauth.*.tsx` (new, E9-oauth)
  lists each requested scope through an i18n key per scope (`oauth.scope.<name>`); the English
  descriptions in `packages/contracts/src/scopes.ts` stay as API reference text, not UI copy. The
  user can see and revoke every authorization in settings.
- **Endpoints**: `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, `/oauth/device`, in
  `services/api/src/oauth/**` (new, E9-oauth), behind the `auth` rate-limit bucket
  (`services/api/src/lib/ratelimit.ts:21`). Device-code polling at `/oauth/token` is throttled
  per device code by the RFC 8628 `interval` and `slow_down` instead, since a bot polling every
  5 seconds would exceed `auth`'s 10 a minute.

### 2. Device code flow: yes

RFC 8628 device authorization for clients that cannot open a browser redirect: headless chat bots,
CLIs, set-top tools. The device shows a short user code and a verification URL on our domain; the
user approves on any signed-in device on the same consent screen. Codes are short-lived, stored
hashed (a new `oauth_device_codes` table in the contract step), and the token endpoint answers
`authorization_pending` and `slow_down` per the RFC. Why: Twitch bot authors expect it, and
without it a headless bot needs a hand-copied token.

### 3. The EventSub WebSocket runs inside `services/api`, at `/eventsub/ws`

- **Placement.** A WebSocket handler in the API process (`services/api/src/eventsub/**`, new,
  E9-ws), routed by a new Caddy `handle /eventsub/ws` block to `api:3001`. Why: the API already
  resolves bearer tokens and scopes and owns subscription creation; a separate service would
  duplicate token resolution and the subscription rules, and add a unit to deploy.
- **Session lifecycle.** On connect the server sends `session_welcome` with the session id and
  `keepalive_timeout_seconds`. The client creates subscriptions over HTTP with
  `transport.method = "websocket"` and that session id within 10 seconds, or the socket closes.
  Notifications arrive as `notification` messages.
- **Keepalive.** Default 10 seconds, client-selectable between 10 and 600 by a query parameter on
  connect. The server sends `session_keepalive` whenever no other message went out within the
  timeout, so a client that hears nothing for longer than that can treat the socket as dead.
- **Reconnect.** Before an API instance stops (rolling upgrades, ADR 0032 stage 2) it sends
  `session_reconnect` with a `reconnect_url` that carries a one-time resume token. Any API
  instance accepts it, because subscriptions are rows keyed by `websocketSessionId`, not process
  state; the new socket takes them over and the old one closes 30 seconds later. Events go out on
  whichever socket currently holds the session.
- **Limits.** At most 300 enabled subscriptions per session and 3 open sessions per (app, user)
  pair; limits live in the API's config (contract step) so tests can lower them.
- **Revocation closes the socket.** Every API instance subscribes to `BUS.userControl` as chat
  does. When a token is revoked (by the user, by refresh-token reuse, by app removal or
  suspension), each subscription it backs moves to `revoked` and gets a `revocation` message,
  then the socket closes with a policy close code. The `developer-platform` harness scenario
  (new, E9) asserts it, and E9 adds the same open-socket test for chat that the 2B row is missing.
- **Fan-out.** Each API instance reads `BUS.events` and delivers to the sessions it holds, after
  the same scope and condition checks the webhook path applies.

### 4. Rate limits per app and per user token; abuse suspends the app

- **Per token**: requests made with an app's user token are counted against the subject
  `(app, user)`, not the user alone, so one app cannot spend a user's whole allowance for every
  other app and the user's own session. The existing buckets apply per subject.
- **Per app**: a new `app` bucket counts every request an app makes across all its tokens, so an
  app with many users cannot overload the instance. The default is set in
  `DEFAULT_RATE_LIMITS` in the contract step.
- **Suspension.** An admin can suspend an app (new `oauth_apps.suspendedAt` and reason code):
  its tokens stop resolving, its sockets close (decision 3), its webhook subscriptions move to
  `revoked`, and an `audit_log` row records who did it and why, by reason code (AGENTS.md: every
  admin action writes an audit row). Unsuspending does not restore tokens; users re-authorize.

### 5. The SDK: `@commonair/sdk` on npmjs.com, published with provenance

- **Registry and name.** `@commonair/sdk` on npmjs.com only; no JSR for now, so there is one
  release path to secure.
- **Publishing.** From GitHub Actions with npm trusted publishing (OIDC, no long-lived npm token)
  and `--provenance`, from a workflow pinned to commit SHAs (AGENTS.md rule 7). This is the same
  standard ADR 0022 asks of what we install (it warns on missing npm provenance,
  `docs/decisions/0022-supply-chain.md:27`).
- **Contents.** A typed client generated from the oRPC contract, auth helpers (PKCE, device
  flow, refresh), an EventSub WebSocket client (welcome, keepalive watchdog, reconnect), and
  webhook signature verification. The generated client and the schemas it needs are emitted into
  the package at build time, because `@commonair/contracts` is private.
- **Dependencies.** No runtime dependency outside the license allowlist that
  `bun scripts/check-licenses.ts` enforces, each vetted with `bun scripts/vet-package.ts`.
- **Harness.** `harness/src/bots/sdk-bot.ts` is replaced by the SDK, so `e2e-social` exercises it.
- **License.** Apache-2.0, for `packages/sdk` only (added 2026-10-29, [ADR 0035](0035-sdk-license.md)).

## Consequences

- E9's contract step changes `platform.ts` as a clean replacement: `oauth_codes.codeChallenge`
  becomes required with a method column fixed to `S256`; `oauth_apps.clientSecretHash` becomes
  nullable (public clients have no secret) and the `confidential` comment changes to say PKCE is
  required for all; `oauth_tokens` gains a refresh family id and a rotated marker, and its
  `userId` becomes nullable for client-credentials tokens; `oauth_apps` gains suspension columns;
  a new `oauth_device_codes` table.
- `resolveToken` must handle a token with no user (an app-only caller) instead of inner-joining
  users, and scoped procedures must refuse it.
- `UserControlMessage` (`packages/contracts/src/events.ts:845-851`) requires a `userId` and has no
  app-level reason, so it cannot yet express "close every socket of this app" or revoke an
  app-only token. The contract step makes `userId` optional, adds an optional `appId` and an
  `app_suspended` reason, and chat and IRC honour `appId` as well.
- The API process gains WebSocket handling and a `BUS.userControl` subscriber; the Caddyfile
  gains `/eventsub/ws`.
- Rate-limit keys change for token callers; session callers keep `u:<userId>`.
- ~~The SDK is AGPL-3.0-or-later like every package (AGENTS.md rule 1). Whether a client library
  that third parties embed should carry a more permissive license is not decided here.~~
  Superseded 2026-10-29 by [ADR 0035](0035-sdk-license.md): the SDK (`packages/sdk` only) is
  Apache-2.0.
- Revocation notices are best effort after commit (decided 2026-10-29). Revoking a grant, a token
  or an app commits the revocation first, then publishes the `BUS.userControl` messages and
  enqueues the webhook `revocation` jobs, the same way `developer.tokens.revoke` already does. If
  that publish or enqueue fails, it is logged and not retried in the request, and the caller still
  gets success: the database revocation is authoritative. Revoked tokens stop resolving at once,
  chat revalidates OAuth tokens within 30 seconds, the EventSub fan-out re-authorizes each
  subscription at least every 30 seconds, and webhook deliveries are authorized when they are
  sent, so a lost notice delays the end of delivery to a revoked grant by at most that window.
- Publishing the SDK needs an npm organisation for `@commonair` and a trusted-publisher link to
  the repository, which only the maintainer can set up.

## Alternatives considered

- **PKCE only for public clients**, as `platform.ts:23` says today. Rejected: OAuth 2.1 requires
  it for all, and two rules mean two test paths.
- **No device flow**, telling bot authors to paste a token. Rejected: it pushes long-lived tokens
  into config files and breaks Twitch-bot expectations.
- **A separate EventSub service.** Rejected: duplicates token and scope resolution and the
  subscription rules for no isolation gain at our size; it can split out later if the socket
  count demands it.
- **Rate limits per user only** (today's key). Rejected: one misbehaving app would exhaust a
  user's allowance for everything else.
- **Publishing to JSR as well.** Deferred: a second registry is a second release path to secure.

## Decisions at acceptance (2026-10-27)

The maintainer accepted the recommended answers:

1. **OAuth 2.1 shape.** Authorization code with PKCE required for every client, no implicit
   grant, exact redirect URI match, refresh-token rotation with reuse detection, client
   credentials for app-only tokens; the consent screen lists scopes in plain words via i18n keys.
2. **Device code flow.** Yes: headless chat bots cannot do a browser redirect, and Twitch bot
   authors expect it.
3. **EventSub WebSocket placement.** Inside `services/api` behind Caddy at `/eventsub/ws`, since
   the API already authenticates tokens and scopes. Keepalive, reconnect message, a per-session
   subscription limit, and a revoked token closing the open socket are specified above; the open
   chat test gap from PROGRESS.md's 2B row is closed in E9.
4. **Rate limits** per app and per user token; app abuse suspension writes an audit row.
5. **SDK.** `@commonair/sdk` on npmjs.com, published from GitHub Actions with trusted publishing
   and provenance (fits ADR 0022); no JSR for now. A typed client generated from the oRPC
   contract, EventSub WS and webhook signature helpers, no runtime dependency outside the
   allowlist.

Decided in drafting within these answers (recorded so reviewers can check them): PKCE is `S256`
only; loopback redirects may vary the port; the keepalive default is 10 seconds (10 to 600); a
new session must subscribe within 10 seconds; 300 subscriptions per session and 3 sessions per
(app, user); the old socket closes 30 seconds after a reconnect; unsuspending an app does not
restore its tokens. The SDK's license is left open (decided 2026-10-29 in ADR 0035: Apache-2.0).

Settled in review (2026-10-27): app-only tokens carry no scopes, and a webhook subscription made
with one is backed by a user's existing authorization of the app (the drafter's list of
user-acting scopes missed `user:manage:follows`, `user:read:email` and `clips:edit`); device-code
polling is throttled by the RFC interval rather than the `auth` bucket; `UserControlMessage`
gains an app form.
