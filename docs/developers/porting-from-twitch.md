<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Porting from Twitch

Most Twitch bots and tools port with a new base URL, new credentials and a scope map. This page
lists what carries over and what does not.

## The quickest routes

- **New code, or code you are willing to touch**: use the SDK, `@commonair/sdk` (Apache-2.0). It
  has helpers for PKCE and the device flow, an EventSub WebSocket client and a webhook verifier,
  with examples: a device-flow chat bot, a webhook receiver, an EventSub WebSocket client and an
  app-token webhook subscription.
- **A chat bot built on tmi.js, twitchio or another IRC library**: point it at the instance's
  IRC gateway and give it a CommonAir token. Nothing else changes. See
  [the gateway's README](../../services/irc/README.md) for ports, TLS, capabilities and the
  commands it understands.
- **EventSub consumers**: change the base URL and the header prefix, then read the differences
  below.

## Credentials

1. Register an app in the developer console ([Getting started](getting-started.md)) for the
   client id and secret, or create a **bot account** and mint it a token on
   **Bots and tokens** (`https://<your instance>/developer/bots`). A minted bot token is the
   equivalent of a token from Twitch's token generator: no app, no refresh, 1 to 365 days.
2. For IRC: password `oauth:<token>`, nick = the bot's username (lowercase).
3. Scopes: map Twitch's names with the table below.

## Scope map

`TWITCH_SCOPE_MAP` in `@commonair/contracts/scopes` is the machine-readable form; the IRC gateway
and the SDK use it.

| Twitch scope                     | CommonAir scope              |
| -------------------------------- | ---------------------------- |
| `chat:read`                      | `chat:read`                  |
| `chat:edit`                      | `chat:edit`                  |
| `moderator:manage:chat_messages` | `moderator:manage:chat`      |
| `moderator:manage:banned_users`  | `moderator:manage:chat`      |
| `moderator:manage:chat_settings` | `moderator:manage:chat`      |
| `channel:moderate`               | `moderator:manage:chat`      |
| `channel:manage:broadcast`       | `channel:manage`             |
| `channel:read:subscriptions`     | `channel:read:subscriptions` |
| `channel:manage:polls`           | `channel:manage:polls`       |
| `channel:manage:predictions`     | `channel:manage:predictions` |
| `channel:manage:raids`           | `channel:manage:raids`       |
| `user:read:email`                | `user:read:email`            |
| `user:read:follows`              | `user:read:follows`          |
| `clips:edit`                     | `clips:edit`                 |

CommonAir-only scopes: `channel:read:tips`, `channel:manage:bot`, `channel:read:points`,
`channel:manage:points`, `user:manage:follows`. The full list is in [OAuth](oauth.md#scopes).

## OAuth differences

| Twitch                                                             | CommonAir                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `id.twitch.tv/oauth2/authorize`                                    | `https://<your instance>/oauth2/authorize`                                                  |
| `id.twitch.tv/oauth2/token`, `/revoke`, `/device`                  | `https://<your instance>/api/oauth2/token`, `/api/oauth2/revoke`, `/api/oauth2/device`      |
| `id.twitch.tv/oauth2/validate` with `Authorization: OAuth <token>` | `https://<your instance>/api/oauth2/validate` with `Authorization: Bearer <token>`          |
| PKCE optional                                                      | PKCE with `S256` required for every client, confidential or not                             |
| Implicit grant (`response_type=token`)                             | Not offered (OAuth 2.1): use the code grant with PKCE, or the device flow                   |
| `scope` in token responses is an array                             | `scope` is a space-separated string (RFC 6749); split it                                    |
| Refresh tokens may be reused                                       | Every refresh rotates the refresh token; reusing an old one revokes the whole authorization |
| Device flow at `twitch.tv/activate`                                | Device flow at `https://<your instance>/activate`                                           |
| `Client-Id` header on every API call                               | Not needed: the bearer token identifies the app                                             |
| OIDC (`openid` scope, ID tokens)                                   | Not offered yet                                                                             |

## EventSub differences

| Twitch                                                                | CommonAir                                                                                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Headers `Twitch-Eventsub-Message-Id`, `…-Signature`, `…-Timestamp`, … | Headers `eventsub-message-id`, `eventsub-message-signature`, `eventsub-message-timestamp`, … (prefix `eventsub-`) |
| Signature: the same HMAC-SHA256 over id + timestamp + body            | The same; see [EventSub](eventsub.md#messages-and-signing)                                                        |
| `POST /helix/eventsub/subscriptions` answers `{ "data": [ … ] }`      | `POST /api/eventsub/subscriptions` answers the subscription object itself                                         |
| WebSocket transport `{ "method": "websocket", "session_id": … }`      | `{ "method": "websocket", "sessionId": … }`                                                                       |
| `wss://eventsub.wss.twitch.tv/ws`                                     | `wss://<your instance>/eventsub/ws`                                                                               |
| `channel.chat.message` by webhook or WebSocket                        | WebSocket only (refused by webhook with `websocket_only`)                                                         |
| Condition ids are numeric strings                                     | User ids are UUIDs                                                                                                |
| Close codes 4000 to 4007                                              | The same, plus `4008`: the authorization was revoked (do not reconnect with that token)                           |
| Conduits, `channel.follow` v2 with a moderator condition              | Not offered: `channel.follow` v1 with `broadcaster_user_id` only                                                  |

The welcome, keepalive, notification, reconnect and revocation messages have Twitch's shapes; the
event payloads carry the fields CommonAir has, so compare a few notifications with what your code
reads.

## No equivalent yet

- **Helix**: the API is not Helix-compatible. Calls map to CommonAir's own REST endpoints,
  described by `https://<your instance>/api/openapi.json`.
- **Bits, cheers, channel point rewards and redemptions, hype trains, charity, shoutouts, ads,
  whispers, the schedule**: no scopes, endpoints or events. Loyalty points (`channel.points.change`,
  `channel:read:points`) are CommonAir's own and work differently from channel points.
- **Twitch scopes not in the map** above have no CommonAir counterpart: drop them from your
  requests (an unknown scope makes the authorization fail with `invalid_scope`).
- **Extensions, Drops and Twitch's PubSub**.
