<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# @commonair/chat

The chat service: Bun WebSockets at `/ws` on `CHAT_PORT`, horizontally scalable through
Valkey pub/sub. It is the only place chat rules are enforced; the IRC gateway translates IRC to
this protocol over one upstream connection per IRC client.

```sh
bun run --filter @commonair/chat start   # needs DATABASE_URL, VALKEY_URL, INTERNAL_API_SECRET
bun run --filter @commonair/chat test     # unit
bun run --filter @commonair/chat test:int # integration (Postgres + Valkey)
```

## Protocol flow

Frames are JSON text messages, validated against `ClientFrame` / `ServerFrame` in
`@commonair/contracts/chat`.

1. **Connect.** Credentials are checked before the upgrade (401/403 on failure):
   - `?token=<chat token>` from the API's `chat.connectToken` (HMAC, `INTERNAL_API_SECRET`).
     A token with `uid: null` is anonymous.
   - `Authorization: Bearer <OAuth access token>` for server-to-server clients (the IRC gateway,
     bots). The token's SHA-256 is looked up in `oauth_tokens` (not revoked, not expired); it
     needs `chat:read`, and `chat:edit` to send.
   - Neither: anonymous, read-only.

   The server sends `welcome` with `heartbeatMs`. Clients send `ping` at that interval; any
   frame counts as activity, and a socket silent for 2 × `heartbeatMs` is closed with code 4000.

2. **Join / part** by channel slug. `joined` carries the settings and `me` (`badges`,
   `canModerate`, `canChat`); badges are `"type"` or `"type/tier"` strings (`"subscriber/2"`). Up to 100 rooms per connection; join/part/command frames share a
   small per-socket token bucket.
3. **Send.** Every `send` is answered by an `ack` (`id` null on rejection), preceded by a
   `notice` when a rule rejected it or a filter held it. The message itself arrives as a
   `message` frame to everyone in the room, the sender included. Text starting with `/` is a
   command (`/me text` is an action message; text starting with `//` is sent as-is).
4. **Commands** (`op: "command"` or `/…` text): `ban`, `unban`, `timeout [duration=600]`,
   `untimeout`, `delete <messageId>`, `clear`, `slow [seconds=30]`, `slowoff`,
   `followers [duration=0, minutes by default]`, `followersoff`, `subscribers`,
   `subscribersoff`, `emoteonly`, `emoteonlyoff`, `mod`/`unmod`/`vip`/`unvip` (broadcaster
   only), `me`. Durations accept `s/m/h/d/w` suffixes. Every `command` frame is answered by
   exactly one `notice` (`cmd_success`, a mode code such as `slow_on`, `no_permission`,
   `usage` for bad arguments, `invalid_user` for unknown targets, `unrecognized_cmd`,
   `msg_ratelimit` …).
5. **Moderation frames** (`ban`, `delete`, `clear`, `settings`) and inline platform
   **events** (`channel.subscribe`, `channel.subscription.gift`, `channel.tip`, `channel.raid`,
   `channel.poll.*`, `channel.prediction.*`) are pushed to the room as they happen.
6. **Held messages** (word filter `hold`) are acked with `held: true` and a `msg_held` notice,
   persisted with `held_at`, and delivered only to moderators as `{op:"message", held:true}`.
7. **Reply pairing.** The `notice`, `error` and `ack` answering a `send`, `command`, `join` or
   `part` frame echo its `nonce`; errors about a join/part/send carry its `channel`.

### Send pipeline

Rules run in this order; the first failure wins (notice code in parentheses):

| #   | Rule                                                           | Exempt                                                          |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | logged in with `chat:edit` (`msg_requires_login`)              |                                                                 |
| 2   | no platform suspension (`msg_banned`)                          |                                                                 |
| 3   | channel not suspended (`msg_channel_suspended`)                |                                                                 |
| 4   | no channel ban / active timeout (`msg_banned`, `msg_timedout`) |                                                                 |
| 5   | `requireVerifiedEmail` (`msg_verified_email`)                  | broadcaster, mods, bot accounts                                 |
| 6   | `minAccountAgeDays` (`msg_account_too_new`)                    | broadcaster, mods                                               |
| 7   | `followersOnlyMinutes` (`msg_followersonly`)                   | broadcaster, mods, VIPs                                         |
| 8   | `subscribersOnly` (`msg_subsonly`)                             | broadcaster, mods, VIPs                                         |
| 9   | `emoteOnly` (`msg_emoteonly`)                                  | broadcaster, mods                                               |
| 10  | `slowModeSeconds` (`msg_slowmode`)                             | broadcaster, mods, VIPs                                         |
| 11  | rate limit, `CHAT_LIMITS` per 30 s (`msg_ratelimit`)           | mods 100, bots 50, verified bots 7500 across channels, users 20 |
| 12  | duplicate within 30 s, exact body (`msg_duplicate`)            |                                                                 |
| 13  | links when `linksAllowed=false` (`msg_links_blocked`)          | broadcaster, mods                                               |
| 14  | word filters: block (`msg_rejected`), hold, replace            | broadcaster, mods                                               |
| 15  | plugin middleware chain                                        |                                                                 |

Regex word filters are screened when a channel loads: backreferences, quantified groups that
contain a quantifier or an alternation (`(a+)+`, `(a|aa)*`) and repetition counts above 1000 are
rejected (and logged), since they can backtrack catastrophically. All filters together get a
25 ms budget per message; past it the message is held for moderators rather than passed.

Slow mode and duplicate detection are recorded only once a message is accepted, so a rejected
message never starts a wait; the rate limit counts every attempt.

### Plugins

`src/plugins/index.ts` lists `MessageMiddleware`s (see `src/pipeline.ts`). Each may return
`"continue"`, `{ drop: <NoticeCode> }` or `{ transform: "<new body>" }`, gets an `onMessage`
hook for accepted messages, and an `init(host)` call with a `PluginHost` that can `say` as a user
(the channel bot) and run `command`s. A throwing middleware is logged and skipped.

### Emotes, badges, colors

A whitespace-delimited word equal to a global or channel emote code (channel wins) becomes an
`EmoteRange` with UTF-16 offsets, if the sender's subscription tier covers the emote's tier
(broadcasters use all). Badges: staff (platform admin), broadcaster, moderator, vip,
subscriber (with tier), member (active co-op membership), bot. Colors are design-token names
`chat-1` … `chat-12`, a stable hash of the user id.

## Persistence and acks

Messages are acked **immediately** with their id, a UUIDv7 minted at receive time, and fanned
out at once. Rows are batch-inserted into `chat_messages` every 250 ms or every 200 rows, and
flushed on shutdown. A failed batch is retried row by row (bad rows are dropped and counted); if
the database is unreachable the rows stay queued (bounded at 50 000) and are retried. A crash can
therefore lose at most one flush interval of messages that clients already saw. `/delete` of a
message that may still be buffered on another instance waits briefly for it to land.

Accepted messages are published straight to `BUS.events` as `channel.chat.message`, not through
the outbox: chat volume is too high for it. Moderation commands, in contrast, write their rows,
`mod_actions`, `audit_log` (no free text; the reason lives in `mod_actions`) and an outbox event in
one transaction.

## Scaling model

- Every instance is stateless apart from caches; a load balancer may send any socket anywhere.
- An instance subscribes to `chat:<channelId>` and `chat-control:<channelId>` only while it has
  local members in that room (reference-counted), plus `bus:events` and `bus:live`.
- A message is published **once** to `chat:<channelId>`; each instance with members delivers it
  to its local sockets, serializing the frame once per instance.
- Moderation and settings changes are published on `chat-control:<channelId>` as a `ServerFrame`
  (`ban`, `delete`, `clear`, `settings`) or `{op:"invalidate", scope:"channel"|"user", userId?}`.
  Every instance drops the affected cache entries and forwards frames to its members. The API
  publishes the same messages after REST moderation (see `src/control.ts`).
- Channels, users and standings (roles, follow, subscription, ban) are cached per instance with
  short TTLs (60 s / 60 s / 30 s), so a lost pub/sub message heals on its own.
- Rate limits, slow mode and duplicate windows live in Valkey, so they hold across instances.
- **Backpressure:** before each write the socket's buffered amount is checked; above 1 MiB the
  socket is terminated (metric `chat.dropped{reason=slow_consumer}`)
  rather than buffered without bound. Each socket handles its frames in order with at most 32 in
  flight.
- **Shutdown** (SIGTERM): sockets get close code 1012 so clients reconnect to another instance,
  then buffered messages are flushed and connections closed.

## Metrics (`meter("chat")`)

`chat.connections` (up/down, by `via`), `chat.messages.in`, `chat.messages.out`,
`chat.dropped` (by `reason`: `slow_consumer`, `rejected` + `code`, `persist_failed`,
`persist_overflow`, `bad_frame`, `idle`, `send_failed`), `chat.fanout.latency` (ms histogram).
