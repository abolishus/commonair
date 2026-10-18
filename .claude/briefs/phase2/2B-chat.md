<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit 2B: Chat service (`services/chat`)

## You own

- `services/chat/**` (new package `@commonair/chat`)

## Contracts (read-only)

- `packages/contracts/src/chat.ts` (ClientFrame, ServerFrame, NOTICE_CODES, CHAT_LIMITS) — the wire protocol, exactly.
- `packages/contracts/src/internal.ts` (ChatTokenClaims, CHAT_TOKEN_TTL_SECONDS), `events.ts` (BUS.chat, BUS.chatControl, BUS.events, EVENTS payloads for chat/mod events), `shapes.ts` (ChannelChatSettings, EmoteRange), `api/entities.ts` (ChatMessage DTO).
- DB tables: users, channels, channel_roles, follows, subscriptions, chat_messages, chat_bans, emotes, word_filters, mod_actions, audit_log, events (outbox), oauth_tokens.
- `@commonair/tokens` (`verifyChatToken`, `sha256Hex`), `@commonair/service`.

## Build

A horizontally scalable chat service on Bun WebSockets (`runService` with `websocket`), path `/ws`, port `CHAT_PORT`.

1. **Auth**: `?token=<chat token>` (verify with INTERNAL_API_SECRET) OR `Authorization: Bearer <OAuth access token>` (server-to-server, e.g. the IRC gateway; look up sha256 in `oauth_tokens`, require scope `chat:read`, and `chat:edit` to send). Anonymous connections are read-only. Send `welcome` with heartbeat interval; drop idle sockets (no ping for 2× interval).
2. **Rooms**: `join`/`part` by channel slug (resolve and cache channel id/settings/roles; invalidate on `BUS.chatControl`). Each instance subscribes to `BUS.chat(channelId)` only while it has local members in that room (ref-counted), and to `BUS.chatControl(channelId)` likewise. Fan-out: publish once to Valkey, deliver to local sockets; respect backpressure (`ws.getBufferedAmount()`; drop/close slow consumers above a threshold rather than buffering unboundedly).
3. **Send pipeline** (in this order; each failure → `notice` with the matching code, plus `ack` with id null): authenticated + `chat:edit`; account not banned/suspended platform-wide; channel not suspended; channel ban or active timeout (`chat_bans`); `requireVerifiedEmail`; `minAccountAgeDays`; `followersOnlyMinutes` (follow age); `subscribersOnly` (active subscription, or role vip/mod/broadcaster); `emoteOnly`; `slowModeSeconds` (mods/broadcaster/VIP exempt); rate limit (CHAT_LIMITS; Valkey sliding window per user per channel; bots use the bot limits; mods higher); duplicate message within `duplicateWindowMs` (exact body, per user per channel); links when `linksAllowed=false` (mods exempt); word filters (`block` → reject with msg_rejected, `hold` → persisted with heldAt and shown only to moderators, `replace` → mask); then a pluggable **middleware chain** (`src/pipeline.ts` exporting `MessageMiddleware` interface: `(ctx) => Promise<"continue" | {drop: NoticeCode} | {transform: string}>` plus a post-send hook `onMessage(ctx, message)`) so the built-in channel bot and stream-key-leak scanner (later units) plug in without editing your files: load middlewares from a registry module you create (`src/plugins/index.ts` exporting an array; ship it with a no-op example).
4. **Emotes**: parse global + channel emotes (cache per channel), enforce tier (subscriber tier ≥ emote tier; broadcaster always), produce `EmoteRange[]` with UTF-16 offsets.
5. **Badges**: broadcaster, moderator, vip, subscriber (with tier), bot (accountType bot), staff (platform admin), member (co-op member — `memberships` active). Color: stable per user (hash → palette of token names, not hex; e.g. "chat-1".."chat-12").
6. **Persistence**: batch insert messages into `chat_messages` (flush every 250 ms or 200 rows; on shutdown flush). Messages are acked only after the batch commit OR immediately with the id (choose and document; the id is a UUIDv7 minted at receive time). Publish every accepted message to `BUS.events` as a `channel.chat.message` BusEvent (NOT via the outbox — chat volume is too high for the outbox), so EventSub subscribers get it.
7. **Moderation commands** (`op: command`, and also chat text starting with `/` from users with permission): `ban <user> [reason]`, `unban`, `timeout <user> [seconds=600] [reason]`, `untimeout`, `delete <messageId>`, `clear`, `slow [seconds]`, `slowoff`, `followers [minutes]`, `followersoff`, `subscribers`, `subscribersoff`, `emoteonly`, `emoteonlyoff`, `mod`/`unmod`/`vip`/`unvip` (broadcaster only), `me <text>` (action). Each writes chat_bans/channel_roles/channels.chatSettings as appropriate + `mod_actions` + `audit_log` + outbox event (`channel.ban`, `channel.unban`, `channel.moderator.add/remove`, `channel.chat.clear`, `channel.chat.message_delete`, `channel.chat_settings.update`) in one transaction, then publishes the control frame on `BUS.chatControl` so every instance (and the IRC gateway) updates. Moderators cannot act on the broadcaster or other moderators (only the broadcaster can).
8. **Inline events**: subscribe to `BUS.events` and forward `channel.subscribe`, `channel.subscription.gift`, `channel.tip`, `channel.raid`, `channel.poll.*`, `channel.prediction.*` as `{op:"event"}` frames to the room.
9. Metrics via `meter("chat")`: connections, messages in/out, dropped by reason, fan-out latency histogram.

## Dependencies you may add

none beyond catalog (`iovalkey` via `@commonair/service`, `drizzle-orm`, `zod`).

## Tests

- Unit: every pipeline rule (table-driven), emote parsing incl. surrogate pairs, rate limiter, command parser, permission matrix (who can ban whom), color assignment.
- Integration: two chat service instances on random ports sharing Valkey: a message sent on instance A arrives at a client on B; timeouts enforced across instances; slow mode; held message visible to mods only; command writes audit_log/mod_actions/events rows; bearer-token (OAuth) connection with and without chat:edit; anonymous read-only; persistence batch flush on shutdown; backpressure closes a non-reading client.

## Done means

See common rules. Also `services/chat/README.md` documenting the protocol flow and scaling model.
