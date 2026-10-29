<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: Apache-2.0
-->

# @commonair/sdk

The TypeScript SDK for CommonAir's developer platform: a typed API client, OAuth helpers (PKCE,
device flow, refresh rotation), an EventSub WebSocket client, webhook signature verification and a
small chat client for bots. It runs on Bun, Node 22 or later, Deno and in browsers (Web Crypto,
`fetch` and `WebSocket` only). Licensed Apache-2.0.

## Install

```sh
npm install @commonair/sdk
# or: bun add @commonair/sdk
```

Every CommonAir instance runs the same API; pass your instance's origin as `baseUrl`.

## Quick start

```ts
import { createClient, refreshingToken, memoryStore } from "@commonair/sdk";

const getToken = refreshingToken({
  baseUrl: "https://your.instance",
  clientId: "…",
  store: memoryStore(savedTokens, (rotated) => persist(rotated)),
});
const client = createClient({ baseUrl: "https://your.instance", getToken });

const channel = await client.channels.get({ channel: "somechannel" });
```

Every procedure of the API is on `client`, typed from the platform's contract. Errors are oRPC
errors with the contract's codes (`errorCode(err)`); `RATE_LIMITED` carries the wait
(`retryAfterSeconds(err)`).

## The four helpers

### 1. Sign in: PKCE, device flow, app tokens

- **Authorization code + PKCE** (web and desktop apps): `createPkcePair()`, send the browser to
  `authorizeUrl({ baseUrl, clientId, redirectUri, scopes, state, codeChallenge })`, check `state`
  on the redirect, then `exchangeCode({ …, code, codeVerifier })`. Only `S256` is accepted.
- **Device flow** (bots, CLIs, TVs): `deviceFlow({ baseUrl, clientId, scopes, onCode })` shows the
  user a code to enter at the instance's activation page and polls until they approve (it slows
  down when asked, and stops on `access_denied`, `expired_token` or your `AbortSignal`).
- **Client credentials** (confidential apps, no user): `clientCredentials({ baseUrl, clientId,
  clientSecret })`. App tokens have no scopes; use them for webhook subscriptions.
- `revoke({ token })` revokes a token; revoking a refresh token ends the whole grant.

Confidential clients pass `clientSecret` (sent as `client_secret_post`); public clients omit it.
Refusals throw `OAuthError` with the RFC `error` code.

### 2. Keep tokens fresh: `refreshingToken`

`refreshingToken({ baseUrl, clientId, store })` returns a `getToken()` for `createClient`. It
refreshes a minute before expiry, runs one refresh at a time, and calls your `store.save()` with
every rotated pair **before** using it. Refresh tokens rotate: the old one is spent, and presenting
it again revokes the whole grant, so always persist the new pair. When the refresh token is
refused (`invalid_grant`), `getToken()` throws `ReauthorizeError` from then on: send the user
through authorization again.

### 3. Receive events over a WebSocket: `connectEventSub`

```ts
const session = await connectEventSub({ baseUrl, onNewSession: (id) => subscribeAll(id) });
await subscribeAll(session.sessionId); // within 10 seconds of the welcome
session.onNotification((n) => console.log(n.subscriptionType, n.event));
const closed = await session.closed; // closed.reauthorize: the user revoked the app (4008)
```

The client validates every message, reconnects from scratch when keepalives stop (a new session:
resubscribe in `onNewSession`), follows the server's `session_reconnect` to a new socket without
dropping or duplicating messages, and stops for good on a policy close. A token refresh never ends
a session; later `subscribe` calls just use the new token. `subscribe(client, { type, condition,
sessionId })` creates a WebSocket subscription.

### 4. Verify webhooks: `verifyEventSubRequest`

```ts
const rawBody = await req.text(); // the exact bytes: never re-serialize parsed JSON
const msg = await verifyEventSubRequest({ secret, headers: req.headers, rawBody });
if (!msg.ok) return new Response(null, { status: 403 });
if (msg.messageType === "webhook_callback_verification") return new Response(msg.challenge);
```

It checks the HMAC-SHA256 signature in constant time and refuses messages older than 10 minutes.
Deliveries are retried with the same message id: drop repeats with `createDedupe()`.

### Chat for bots: `connectChat`

`connectChat({ client, token })` joins channels, says things and reads messages over the chat
WebSocket. Chat closes a socket when the token it opened with is rotated, so long-running bots
reconnect with `await getToken()` when `closed` resolves.

## Examples

In [`examples/`](examples/): `device-flow-chat-bot.ts`, `webhook-receiver.ts`,
`eventsub-websocket.ts`, `app-token-webhook.ts`.

## Porting a Twitch bot

- **Scopes**: names follow Twitch's `resource:action` shape. `TWITCH_SCOPE_MAP` maps a Twitch
  scope to the CommonAir scope that covers it (for example `moderator:manage:banned_users` →
  `moderator:manage:chat`, `channel:manage:broadcast` → `channel:manage`).
- **Events**: EventSub type names, condition fields, payload fields, the WebSocket messages and the
  webhook signature scheme follow Twitch's, so handlers port with few changes. Webhook headers use a
  vendor-neutral `eventsub-` prefix (`WEBHOOK_HEADERS`) instead of `twitch-eventsub-`.
- **tmi.js and other IRC bots** need not move to this SDK at all: every instance runs a
  Twitch-compatible IRC gateway (IRCv3 tags, `CAP`, `PASS oauth:<token>`) on plain TCP, TLS and
  WebSocket. Point tmi.js at your instance's IRC host and use a CommonAir bot or OAuth token as the
  password.

## Licence

Apache-2.0. See `LICENSE`.
