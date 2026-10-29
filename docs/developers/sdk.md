<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# The TypeScript SDK (`@commonair/sdk`)

`@commonair/sdk` wraps the developer platform (ADR 0027) so a bot or app does not hand-roll PKCE,
device polling, refresh rotation, EventSub reconnects or signature checks. It is Apache-2.0
([ADR 0035](../decisions/0035-sdk-license.md)), so bots under any licence can embed it, and it runs
on Bun, Node 22 or later, Deno and in browsers. The source is [`packages/sdk`](../../packages/sdk);
this page walks through the four examples next to it.

## Install

```sh
npm install @commonair/sdk
```

Pass your instance's origin as `baseUrl` everywhere (the API, the OAuth endpoints and the EventSub
WebSocket share it). Register an app in the developer console first: a **public** app (no secret)
for bots and native apps, a **confidential** one (with a secret) for servers.

## The pieces

| Need                               | Use                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Call the API                       | `createClient({ baseUrl, token \| getToken })`: every procedure, typed; errors carry the contract's codes |
| A user signs in through a browser  | `createPkcePair()`, `authorizeUrl(…)`, then `exchangeCode(…)` on the redirect                             |
| A user signs in on a device or CLI | `deviceFlow({ …, onCode })`                                                                               |
| The app acts as itself             | `clientCredentials(…)` (no user, no scopes)                                                               |
| Tokens stay valid                  | `refreshingToken({ …, store })` as `getToken`                                                             |
| Events over a WebSocket            | `connectEventSub(…)` and `subscribe(client, …)`                                                           |
| Events by webhook                  | `verifyEventSubRequest(…)` and `createDedupe()`                                                           |
| Chat                               | `connectChat({ client, token })`                                                                          |

## 1. A chat bot signed in with the device flow

[`device-flow-chat-bot.ts`](../../packages/sdk/examples/device-flow-chat-bot.ts) asks for
`chat:read chat:edit` with `deviceFlow`: it prints a short code and the activation URL, the
streamer approves on the instance's `/activate` page, and polling (at the server's `interval`,
5 seconds slower after each `slow_down`) returns the tokens. It stores them in a file through a
`TokenStore`, then answers `!ping`.

### Token storage and rotation

`refreshingToken({ baseUrl, clientId, store })` reads the pair from `store.load()` once and
returns a `getToken()`:

- it refreshes a minute before the access token expires (`refreshAheadSeconds`), and
  `getToken.refresh()` forces a rotation;
- concurrent callers share one refresh, never two;
- each rotated pair goes to `store.save()` before the new token is used. The old refresh token is
  spent: presenting it again is treated as theft and revokes the whole grant, so the SDK never
  retries with it, keeps the new pair in memory even if `save()` throws, and you must persist it;
- when the server refuses the refresh token (`invalid_grant`: the user revoked the app, or a
  replay killed the grant), `getToken()` throws `ReauthorizeError` from then on. Run the
  authorization again.

Treat the stored pair as a password: never log it or commit it.

Chat closes a socket when the token it was opened with is replaced, so a long-running bot
reconnects chat with a fresh `await getToken()` whenever `chat.closed` resolves, as the example
does.

## 2. Receiving webhooks

[`webhook-receiver.ts`](../../packages/sdk/examples/webhook-receiver.ts) runs `Bun.serve` and hands
every request to `verifyEventSubRequest({ secret, headers, rawBody })`:

- read the body as text and verify those exact bytes; parse only what the verifier returns;
- the signature is HMAC-SHA256 over message id, timestamp and body, compared in constant time;
  messages more than 10 minutes old or ahead are refused (`stale_timestamp`), so keep the clock in
  sync;
- answer `webhook_callback_verification` with `challenge` as plain text, and anything else with a
  2xx quickly (do slow work afterwards);
- deliveries are retried and redelivered with the same message id: drop repeats with
  `createDedupe(maxEntries)`.

A refusal comes back as `{ ok: false, reason }` (`missing_headers`, `unknown_message_type`,
`stale_timestamp`, `bad_signature`, `invalid_body`). On a Web `Request`,
`verifyEventSubWebRequest(request, secret)` does the reading for you.

## 3. The EventSub WebSocket

[`eventsub-websocket.ts`](../../packages/sdk/examples/eventsub-websocket.ts) connects with
`connectEventSub({ baseUrl, onNewSession })`, subscribes with `subscribe(client, { type,
condition, sessionId })` within 10 seconds of the welcome (an unused socket is closed with 4003),
and logs notifications.

### Reconnects

- **Keepalive watchdog.** The server sends `session_keepalive` when it has been quiet for
  `keepalive_timeout_seconds` (10 by default, 10 to 600 with `keepaliveSeconds`). If nothing
  arrives for that long plus 2 seconds, the client treats the socket as dead and connects again
  from scratch, with backoff. That is a **new session**: subscriptions do not carry over, so
  `onNewSession(sessionId)` must subscribe again.
- **`session_reconnect`.** Before an API instance stops, it sends a `reconnect_url`. The client
  opens it, waits for its welcome (the same session id, with its subscriptions), then closes the
  old socket. Messages are deduplicated by `message_id`, so nothing arrives twice, and
  `onNewSession` is not called.
- **Policy closes end the client.** `closed` resolves with the code and its name
  (`EVENTSUB_WS_CLOSE`): 4001 (the client sent traffic), 4003 (never subscribed), 4007 (a bad
  reconnect URL) and 4008 (the authorization was revoked or the app suspended, `reauthorize: true`).
  Network failures and 4000, 4002, 4004, 4005, 4006 reconnect from scratch.
- **Token refreshes do not touch the session.** A session is bound to the grant, not to one access
  token; after a refresh, `subscribe` calls on the same session use the new token.

Every message is validated against the platform's schema; anything else is dropped and reported
through `onError`.

## 4. An app token subscribing a webhook

[`app-token-webhook.ts`](../../packages/sdk/examples/app-token-webhook.ts) gets an app token with
`clientCredentials` and subscribes `channel.follow` for a broadcaster by webhook. App tokens have
no scopes: they can subscribe scope-free events for anyone, and scoped events only for
broadcasters who authorized the app. The subscription turns `enabled` once the receiver from
example 2 answers the challenge.

## Errors

- API calls throw oRPC errors with the contract's codes: `errorCode(err)` reads it, and
  `retryAfterSeconds(err)` reads the wait on `RATE_LIMITED`.
- OAuth endpoints throw `OAuthError` with the RFC `error` code (`invalid_grant`, `access_denied`,
  …) and the HTTP status.
- `ReauthorizeError` means only a new authorization helps.
- Chat refusals throw `ChatError` with the server's code.

## Porting from Twitch

- Scopes map through `TWITCH_SCOPE_MAP`; event types, conditions, payloads, WebSocket messages and
  the signature scheme follow Twitch's. Webhook headers are `eventsub-…` (`WEBHOOK_HEADERS`) rather
  than `twitch-eventsub-…`.
- tmi.js and other IRC bots can keep IRC: the instance's IRC gateway speaks Twitch's dialect over
  TCP, TLS and WebSocket, with a CommonAir token as the `PASS oauth:` password.
