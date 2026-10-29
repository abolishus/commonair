<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Rate limits

Every API call is counted against a **subject** in a **bucket**: a sliding window that admits a
number of requests per period ([ADR 0027](../decisions/0027-oauth-and-eventsub.md) §4). A refused
call answers `429` with `RATE_LIMITED` and `data.retryAfterSeconds`; wait that long before trying
again.

## Who a request counts against

| Caller                                                 | Subject                                    |
| ------------------------------------------------------ | ------------------------------------------ |
| A signed-in browser session, or a personal (bot) token | the user                                   |
| An app's user token (authorization code, device flow)  | the pair **(app, user)**                   |
| An app token (client credentials)                      | the app                                    |
| Nobody (no session, no token)                          | the client address (IPv4, or the IPv6 /64) |

Counting an app's user token against `(app, user)` means one app cannot spend a person's whole
allowance: their own session and every other app they use keep theirs.

**The app bucket.** On top of that, every request an app makes, with any of its tokens and for
any user, also counts against the app itself: **6,000 requests per minute** by default. An app
with many users must spread its work; it cannot overload the instance by multiplying tokens.

## Buckets

Each API procedure names its bucket (most use `default`; writes use `write`). The defaults, per
subject:

| Bucket      | Limit             | Used by                                                                                |
| ----------- | ----------------- | -------------------------------------------------------------------------------------- |
| `default`   | 120 per minute    | Reads                                                                                  |
| `write`     | 30 per minute     | Changes: creating apps, subscriptions, test events, redelivery, …                      |
| `auth`      | 10 per minute     | Sign-in, the OAuth token, revoke and device endpoints (per address), device activation |
| `chat`      | 20 per 30 seconds | Sending chat messages                                                                  |
| `expensive` | 5 per hour        | A few heavy operations such as data exports                                            |
| `app`       | 6,000 per minute  | Every request of one app, all tokens together                                          |
| `eventsub`  | 60 per minute     | New EventSub WebSocket connections, per address                                        |

These defaults may change between versions: treat them as an order of magnitude and honour
`retryAfterSeconds` rather than hard-coding them.

## OAuth endpoints

`POST /api/oauth2/token`, `/api/oauth2/revoke` and `/api/oauth2/device` count against the `auth`
bucket of the calling address and answer `429` with `error: temporarily_unavailable` and a
`Retry-After` header. Device-code polling is exempt from that bucket and throttled by the
device flow itself (`slow_down`, see [OAuth](oauth.md#device-flow)).

## Chat and IRC

Chat sending has its own per-user limits enforced by the chat service (slow mode, the `chat`
bucket), whether the message comes from the web, a WebSocket client or the IRC gateway.

## Good citizenship

- Prefer EventSub over polling the API.
- Back off on `429` for `retryAfterSeconds`, then retry once; do not retry in a tight loop.
- Cache what does not change (the event catalog, user ids).
