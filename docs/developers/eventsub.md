<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# EventSub

EventSub tells your app when something happens on a channel: a follow, a subscription, a poll, a
chat message. Subscribe to an event type with a condition (which channel) and a transport:

- **Webhook**: we `POST` each event to your HTTPS callback, signed with your secret. For servers.
- **WebSocket**: your client holds a socket open and events arrive on it. For bots and tools
  that cannot receive inbound HTTP.

The shapes follow Twitch's EventSub; [Porting from Twitch](porting-from-twitch.md) lists the
differences.

## The catalog

`GET https://<your instance>/api/eventsub/types` (no token needed) lists every type with its
version, condition fields, required scopes, transports and a description. Every type is version
`1` today.

| Type                           | Condition                        | Scopes                       | Transports         |
| ------------------------------ | -------------------------------- | ---------------------------- | ------------------ |
| `stream.online`                | `broadcaster_user_id`            | none                         | webhook, websocket |
| `stream.offline`               | `broadcaster_user_id`            | none                         | webhook, websocket |
| `channel.update`               | `broadcaster_user_id`            | none                         | webhook, websocket |
| `channel.follow`               | `broadcaster_user_id`            | none                         | webhook, websocket |
| `channel.subscribe`            | `broadcaster_user_id`            | `channel:read:subscriptions` | webhook, websocket |
| `channel.subscription.end`     | `broadcaster_user_id`            | `channel:read:subscriptions` | webhook, websocket |
| `channel.subscription.gift`    | `broadcaster_user_id`            | `channel:read:subscriptions` | webhook, websocket |
| `channel.tip`                  | `broadcaster_user_id`            | `channel:read:tips`          | webhook, websocket |
| `channel.raid`                 | `to_broadcaster_user_id`         | none                         | webhook, websocket |
| `channel.chat.message`         | `broadcaster_user_id`, `user_id` | `chat:read`                  | websocket only     |
| `channel.chat.message_delete`  | `broadcaster_user_id`, `user_id` | `chat:read`                  | webhook, websocket |
| `channel.chat.clear`           | `broadcaster_user_id`, `user_id` | `chat:read`                  | webhook, websocket |
| `channel.chat_settings.update` | `broadcaster_user_id`, `user_id` | `chat:read`                  | webhook, websocket |
| `channel.ban`                  | `broadcaster_user_id`            | `moderator:manage:chat`      | webhook, websocket |
| `channel.unban`                | `broadcaster_user_id`            | `moderator:manage:chat`      | webhook, websocket |
| `channel.moderator.add`        | `broadcaster_user_id`            | `moderator:manage:chat`      | webhook, websocket |
| `channel.moderator.remove`     | `broadcaster_user_id`            | `moderator:manage:chat`      | webhook, websocket |
| `channel.poll.begin`           | `broadcaster_user_id`            | `channel:manage:polls`       | webhook, websocket |
| `channel.poll.progress`        | `broadcaster_user_id`            | `channel:manage:polls`       | webhook, websocket |
| `channel.poll.end`             | `broadcaster_user_id`            | `channel:manage:polls`       | webhook, websocket |
| `channel.prediction.begin`     | `broadcaster_user_id`            | `channel:manage:predictions` | webhook, websocket |
| `channel.prediction.progress`  | `broadcaster_user_id`            | `channel:manage:predictions` | webhook, websocket |
| `channel.prediction.lock`      | `broadcaster_user_id`            | `channel:manage:predictions` | webhook, websocket |
| `channel.prediction.end`       | `broadcaster_user_id`            | `channel:manage:predictions` | webhook, websocket |
| `channel.goal.begin`           | `broadcaster_user_id`            | none                         | webhook, websocket |
| `channel.goal.progress`        | `broadcaster_user_id`            | none                         | webhook, websocket |
| `channel.goal.end`             | `broadcaster_user_id`            | none                         | webhook, websocket |
| `channel.points.change`        | `broadcaster_user_id`            | `channel:read:points`        | webhook, websocket |
| `coop.proposal.update`         | none                             | none                         | webhook, websocket |

The catalog endpoint is the source of truth; this table is a snapshot.

**WebSocket-only types**: `channel.chat.message` is published straight from chat and never
passes through the event outbox that feeds webhooks, so it is offered on the WebSocket only. A
webhook subscription to it is refused with `PRECONDITION_FAILED` (`websocket_only`).

## Conditions

A condition names exactly the type's fields, each non-empty; any field ending in `user_id` is a
user id (a UUID, not a username). Unknown or missing fields are refused (`condition_keys`). An
event matches when every condition field equals the event's field of the same name. On chat types,
`user_id` names the reading user whose authorization backs the subscription (as on Twitch).

## Subscribing

All endpoints take `Authorization: Bearer <token>` and JSON.

| Call                                              | What                                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `POST /api/eventsub/subscriptions`                | Create a subscription                                                            |
| `GET /api/eventsub/subscriptions`                 | Your subscriptions, paged (`cursor`, `limit`), filterable by `type` and `status` |
| `DELETE /api/eventsub/subscriptions/{id}`         | Delete one                                                                       |
| `GET /api/eventsub/subscriptions/{id}/deliveries` | A webhook subscription's delivery log, paged                                     |
| `POST /api/eventsub/subscriptions/{id}/test`      | Send a test event (enabled webhook subscriptions only)                           |
| `POST /api/eventsub/deliveries/{id}/redeliver`    | Deliver a logged notification again, same message id                             |

```json
{
  "type": "channel.follow",
  "version": "1",
  "condition": { "broadcaster_user_id": "<user id>" },
  "transport": {
    "method": "webhook",
    "callback": "https://bot.example.org/eventsub",
    "secret": "<10 to 100 characters>"
  }
}
```

For the WebSocket, the transport is `{ "method": "websocket", "sessionId": "<id from session_welcome>" }`.
The answer is the subscription: `id`, `type`, `version`, `condition`, `transport`, `status`
(`enabled`, `verification_pending`, `failed`, `revoked`), `failureCount`, `createdAt`.

The developer console does the same from an app's page (webhooks only): pick a type, fill the
condition, the callback and a secret (it can generate one), then watch the status, the delivery
log, test events and redelivery.

### Who backs a subscription

Scoped types need a user's authorization of your app, and that user must be the right person for
the condition:

| Required scopes                         | The authorizing user must be                                           |
| --------------------------------------- | ---------------------------------------------------------------------- |
| none                                    | nobody: the app subscribes on its own (backed by the app's owner)      |
| `moderator:*` (`moderator:manage:chat`) | the broadcaster or one of the channel's moderators                     |
| `chat:read` only                        | the reading user named in `user_id` (chat is public; read as yourself) |
| any other scope                         | the broadcaster                                                        |

- With a **user access token**, the token's user backs the subscription: they must hold the scope
  and fit the rule above, or the call answers `FORBIDDEN`.
- With an **app token** (client credentials), the user named by the condition backs it (the
  `moderator_user_id`, else `broadcaster_user_id` or `to_broadcaster_user_id`, else `user_id` for
  chat types); that user must have authorized **your app** with the scope, or the call answers
  `FORBIDDEN` ("the broadcaster has not authorized this app").
- A WebSocket subscription always needs a user access token (an app token is refused).

The check runs again for every event: when the authorization is revoked, the subscription moves
to `revoked` and you get a `revocation` message (status `authorization_revoked`).

### Limits

| Limit                                                 | Value  | Refusal                                              |
| ----------------------------------------------------- | ------ | ---------------------------------------------------- |
| Webhook subscriptions per app (enabled or pending)    | 10,000 | `PRECONDITION_FAILED` `subscription_limit`           |
| Webhook subscriptions per user without an app         | 1,000  | `PRECONDITION_FAILED` `subscription_limit`           |
| Condition fields                                      | 8      | `BAD_REQUEST`                                        |
| Callback URL length                                   | 2,048  | `PRECONDITION_FAILED` `callback_url`                 |
| Subscriptions per WebSocket session                   | 300    | `PRECONDITION_FAILED` `websocket_subscription_limit` |
| Open WebSocket sessions per authorization (app, user) | 3      | `PRECONDITION_FAILED` `websocket_session_limit`      |

Instance operators can change the WebSocket limits (`EVENTSUB_WS_MAX_SUBSCRIPTIONS`,
`EVENTSUB_WS_MAX_SESSIONS_PER_GRANT`). Other refusals: `callback_url` (the callback is not `https`
on a public host, or too long), `version`, `token_required` (a scoped type subscribed without a user's
authorization), `websocket_session` (no open session has that id), `webhook_only` and
`not_enabled` (test events), `notification_only` and `not_replayable` (redelivery: test events
cannot be redelivered).

## Webhooks

### Verification

A new webhook subscription starts `verification_pending`. We `POST` a
`webhook_callback_verification` message whose JSON body carries `subscription` and `challenge`.
Answer `200` with the challenge, as is, as the body. The subscription then turns `enabled`; any
other answer turns it `failed`.

### Messages and signing

Every request carries these headers:

| Header                          | Value                                                           |
| ------------------------------- | --------------------------------------------------------------- |
| `eventsub-message-id`           | Unique per message; the same on every retry and redelivery      |
| `eventsub-message-retry`        | `0` on the first attempt, then the retry count                  |
| `eventsub-message-type`         | `notification`, `webhook_callback_verification` or `revocation` |
| `eventsub-message-signature`    | `sha256=` + hex HMAC-SHA256                                     |
| `eventsub-message-timestamp`    | When the message was sent (ISO 8601)                            |
| `eventsub-subscription-type`    | The event type                                                  |
| `eventsub-subscription-version` | `1`                                                             |

A notification's body is `{ "subscription": { … }, "event": { … } }`.

**Verify every request before trusting it**: compute
`HMAC-SHA256(secret, message_id + timestamp + raw_body)` over the raw bytes you received (not a
re-serialized object), hex-encode it, prefix `sha256=`, and compare with the signature header in
constant time. Reject messages whose timestamp is more than 10 minutes away from now, and drop
message ids you have already processed (retries and redeliveries reuse them). `verifyWebhook` in
`@commonair/contracts/events` and the SDK's webhook helper do exactly this.

### Retries and failures

- Any `2xx` within 10 seconds is a success. Anything else (another status, a timeout, a refused
  connection) is a failed attempt; the log keeps the status, the error and the first 2 KB of your
  answer.
- A notification is tried up to **5 times**, about 1 minute, 5 minutes, 30 minutes and 2 hours
  apart (±10%), so for about 2.6 hours in all.
- After **3 consecutive events** that exhausted every attempt, the subscription turns `failed`
  and we send a `revocation` message with status `notification_failures_exceeded`. Create a new
  subscription once your receiver is healthy.
- A `revocation` message (status `authorization_revoked`) also follows a revoked authorization
  or a suspended app.
- **Redeliver** a logged notification from the console or the API: the same message id goes out
  again as a new attempt. **Test events** (from the console or `…/test`) are synthesized, logged
  like any delivery, and cannot be redelivered.

## The WebSocket

### Connecting

```text
wss://<your instance>/eventsub/ws?keepalive_timeout_seconds=30
```

`keepalive_timeout_seconds` is optional: 10 by default, 10 to 600. No token is needed to connect.
The first message is `session_welcome`:

```json
{
  "metadata": { "message_id": "…", "message_type": "session_welcome", "message_timestamp": "…" },
  "payload": {
    "session": {
      "id": "…",
      "status": "connected",
      "keepalive_timeout_seconds": 10,
      "reconnect_url": null,
      "connected_at": "…"
    }
  }
}
```

Within **10 seconds**, create at least one subscription with `transport.sessionId` set to that
id, using a user access token; otherwise the socket closes with `4003`. A session belongs to the
first authorization that subscribes on it; at most 3 sessions per authorization (app, user) and
300 subscriptions per session.

### Messages

| `message_type`      | When                                                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `session_welcome`   | Once, on connect                                                                                                  |
| `session_keepalive` | When nothing else was sent for `keepalive_timeout_seconds`; if you get nothing for longer, reconnect              |
| `notification`      | An event: `payload.subscription` and `payload.event`; `metadata.subscription_type` and `subscription_version` too |
| `session_reconnect` | The server is moving you (a deploy): connect to `payload.session.reconnect_url`, then let the old socket go       |
| `revocation`        | A subscription ended (`authorization_revoked`): `payload.subscription`                                            |

Never send anything on the socket: any message from the client closes it with `4001`.

### Reconnecting

On `session_reconnect`, open the `reconnect_url` (it carries a one-time `resume` token, `ces_…`).
The new socket gets a `session_welcome` for the **same session id** with your subscriptions
intact; the old one then closes (`1000`). You have 30 seconds (the operator's
`EVENTSUB_WS_RECONNECT_GRACE_SECONDS`); after that the old socket closes with `4004` and the
session is gone. A spent or unknown resume token closes the new socket with `4007`.

After any other close, connect again from scratch and subscribe again: subscriptions do not
outlive their session.

### Close codes

| Code   | Meaning                                                                                 |
| ------ | --------------------------------------------------------------------------------------- |
| `4000` | Internal server error (also: your client read too slowly and the send buffer filled up) |
| `4001` | The client sent a message                                                               |
| `4002` | Ping-pong failed (Twitch's code; reserved, not sent today)                              |
| `4003` | Connection unused: no subscription within 10 seconds of the welcome                     |
| `4004` | Reconnect grace time expired                                                            |
| `4005` | Network timeout (Twitch's code; reserved, not sent today)                               |
| `4006` | Network error (Twitch's code; reserved, not sent today)                                 |
| `4007` | Invalid reconnect: the resume token is spent, unknown or expired                        |
| `4008` | Authorization revoked: the token behind the session was revoked or the app suspended    |

`4008` is ours (Twitch has no such code): reconnecting with the same token will not work;
the person has to authorize your app again.
