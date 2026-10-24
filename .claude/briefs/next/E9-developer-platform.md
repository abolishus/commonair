<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E9: developer platform (PLAN 3C)

**Goal.** A third-party developer registers an app, a streamer authorizes it with scopes, the
app reads and acts through the public API with `@commonair/sdk`, and receives events by webhook
or WebSocket. A Twitch bot ports with a scope map and the IRC gateway.

## State

- Built: `oauth_apps`, `oauth_codes`, `oauth_tokens`, `event_subscriptions`,
  `webhook_deliveries` (`schema/platform.ts`); the whole webhook delivery side in the worker
  (`services/worker/src/webhooks/**`: signing, backoff, SSRF guard, callback verification,
  test events, redelivery, pruning; `webhooks.int.test.ts` seeds subscriptions in SQL);
  `developer.tokens.list/revoke/validate`; `me.bots.*` (bot tokens with `appId: null`);
  `TWITCH_SCOPE_MAP`; EventSub WS message shapes (`events.ts`: `WsMetadata`, `session_welcome`).
- Missing: 12 stubs in `services/api/src/routes/developer.ts` (`apps.*` `:26-30`,
  `events.*` `:96-102`); the OAuth authorize/token endpoints (`oauthCodes` unused in the API);
  the EventSub WebSocket server; `packages/sdk`; a developer console; developer docs.
  `harness/src/bots/sdk-bot.ts` is a stand-in written to be replaced by the SDK.

## Decisions first: ADR 0026 (OAuth and EventSub)

- OAuth 2.1 shape: authorization code with PKCE required for every client, no implicit grant,
  exact redirect URI match, refresh-token rotation with reuse detection, client credentials for
  app-only tokens. Consent screen lists scopes in plain words (i18n keys).
- Device code flow for headless bots: recommended (Twitch has it; chat bots need it).
- Where the EventSub WebSocket runs: in `services/api` behind Caddy at `/eventsub/ws`
  (recommended; it already authenticates tokens) versus a new service. Keepalive, reconnect
  message, subscription limit per session, what a revoked token does to an open socket (closes
  it: there is an open test gap for chat, PROGRESS.md 2B row).
- Rate limits per app and per user token; how app abuse is suspended (audit row).
- SDK scope: typed client generated from the oRPC contract, EventSub WS and webhook signature
  verification helpers, no runtime dependency outside the repo's allowlist. Published to npm
  under the project's scope (user to confirm the registry and name).

## Contract step

Routes for `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`, `/oauth/device`; any missing
`oauth_*` columns (PKCE challenge, refresh family id); EventSub WS limits in config; selectors
doc `docs/testing/e9-selectors.md` (console pages, consent screen).

## Units

| Unit       | Owns                                                                                    | Builds                                                                                         |
| ---------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| E9-oauth   | `services/api/src/oauth/**`, `apps/web/src/routes/_app/oauth.*.tsx` (consent)           | authorize, token, refresh rotation, revoke, device flow, consent page                          |
| E9-apps    | `routes/developer.ts` (`apps.*`)                                                        | app CRUD, secret rotation (shown once, stored hashed), removal revokes its tokens              |
| E9-subs    | `routes/developer.ts` (`events.*`)                                                      | subscribe, list, unsubscribe, deliveries, sendTest, redeliver on top of the worker jobs        |
| E9-ws      | `services/api/src/eventsub/**`                                                          | WebSocket transport: welcome, keepalive, reconnect, revocation, per-session limits             |
| E9-sdk     | `packages/sdk/**`, `harness/src/bots/sdk-bot.ts`                                        | typed client, auth helpers, EventSub WS and webhook verification; harness bot uses it          |
| E9-console | `apps/web/src/routes/_studio/developer*.tsx` (or a `_dev` layout), `docs/developers/**` | console (apps, secrets, subscriptions, delivery log, test events), docs with runnable examples |

E9-apps and E9-subs share `routes/developer.ts`: split it into `routes/developer/{apps,events}.ts`
in the contract step.

## Harness

`developer-platform`: register an app in the console; authorize it as a streamer with PKCE;
refresh rotates and a replayed refresh token revokes the family; subscribe by webhook to
`channel.follow` and by WebSocket to `channel.chat.message`; a follow and a chat message arrive
on both, signatures verify with the SDK; revoking the app closes the socket and stops
deliveries. `e2e-social`'s SDK bot runs on `@commonair/sdk`.

## Done means

The scenario in `full`; `developer.ts` has no `notImplemented`; the SDK has its own unit tests
and passes `check-licenses`; verify green.
