<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Building on CommonAir

Apps, bots and integrations talk to a CommonAir instance through OAuth 2.1 tokens, the REST/RPC
API and EventSub (webhooks or a WebSocket). The shapes follow Twitch's where that costs nothing,
so most Twitch tools port with a different base URL and a few documented differences. Throughout,
`https://<your instance>` stands for the instance you build against.

| Page                                          | What it covers                                                                                                 |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| [Getting started](getting-started.md)         | Registering an app in the developer console, confidential or public, redirect URI rules, bots and their tokens |
| [OAuth](oauth.md)                             | Endpoints, authorization code with PKCE, refresh rotation, client credentials, the device flow, scopes, errors |
| [EventSub](eventsub.md)                       | The event catalog, conditions, webhooks (signing, retries), the WebSocket (keepalive, close codes, reconnect)  |
| [Rate limits](rate-limits.md)                 | Who a request counts against: the per-token subject and the per-app bucket                                     |
| [Porting from Twitch](porting-from-twitch.md) | Scope names, the IRC gateway for tmi.js and friends, EventSub differences, what has no equivalent yet          |

The API's own reference is the OpenAPI document at `https://<your instance>/api/openapi.json`.

The developer console is in the studio: **Developer** (`/developer`) for apps and their
subscriptions, **Bots and tokens** (`/developer/bots`) for bot accounts and every token on your
account. Instance administrators find every app under **OAuth apps** (`/admin/apps`).
