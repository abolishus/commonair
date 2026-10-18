<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit 2C: IRC gateway (`services/irc`)

## You own

- `services/irc/**` (new package `@commonair/irc`)

## Contracts (read-only)

- `packages/contracts/src/chat.ts` (ClientFrame/ServerFrame/NOTICE_CODES — your upstream protocol), `api/entities.ts` (ChatMessage), `scopes.ts` (TWITCH_SCOPE_MAP), `events.ts`.
- Env: `servicePorts` (IRC_PORT, IRC_TLS_PORT, IRC_WS_PORT, IRC_TLS_CERT_FILE/KEY_FILE), `coreEnv.CHAT_PUBLIC_URL` is public; the upstream is `internalEnv.CHAT_INTERNAL_URL`.

## Build

A Twitch-compatible IRC gateway so **unmodified tmi.js** (and other Twitch IRC libraries) work by pointing them at our host. It is a pure translator: every IRC client gets one upstream WebSocket to the chat service authenticated with `Authorization: Bearer <token>` (the token from `PASS oauth:<token>`); all chat rules are enforced upstream.

1. Listeners: plain TCP (`IRC_PORT`), TLS (`IRC_TLS_PORT`, cert/key files; if unset in development, generate an ephemeral self-signed cert at startup and log a warning; in production require files), and IRC-over-WebSocket (`IRC_WS_PORT`, path `/` — tmi.js uses `ws(s)://host:port`), text frames carrying IRC lines (tmi.js may send several lines per frame; handle `\r\n` splitting both ways).
2. Commands: `CAP LS 302`, `CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership` (ACK the supported ones; behavior changes with each cap like Twitch), `CAP END`, `PASS oauth:<token>` (also accept without `oauth:`), `NICK`, `USER`, `JOIN #a,#b`, `PART`, `PRIVMSG #chan :text` (including `\x01ACTION ...\x01` → isAction, and Twitch-style chat commands `/ban`, `/timeout`, `.ban`, `/me`, etc. mapped to upstream `command` frames), `PING`/`PONG`, `QUIT`. Anonymous `justinfanNNNN` nick with no PASS → read-only upstream connection (no Authorization).
3. Server lines exactly in Twitch shape: welcome numerics `001`–`004`, `375`/`372`/`376` from `tmi.<host>`; `GLOBALUSERSTATE` after login; on JOIN: `JOIN`, `353`/`366` names, `USERSTATE`, `ROOMSTATE` (with `emote-only`, `followers-only` (-1 = off), `r9k`, `room-id`, `slow`, `subs-only`); `PRIVMSG` with IRCv3 tags `badge-info`, `badges` (e.g. `broadcaster/1,subscriber/2000,moderator/1`), `color` (map our color token to a fixed hex palette here — IRC clients need hex; keep the mapping table in one file), `display-name`, `emotes` (`id:start-end/...`, Twitch uses code-point offsets inclusive: convert from our UTF-16 exclusive ranges correctly), `first-msg`, `flags`, `id`, `mod`, `room-id`, `subscriber`, `tmi-sent-ts`, `turbo`, `user-id`, `user-type` (`mod` or empty), `vip`, `reply-parent-*` for replies; `CLEARCHAT` (ban/timeout/clear with `ban-duration`, `target-user-id`), `CLEARMSG` (`login`, `target-msg-id`), `NOTICE` with `msg-id` mapped from our NOTICE_CODES (keep a mapping table; unknown → `msg-id=unrecognized_cmd`), `USERNOTICE` for subs/gifts/raids (`msg-id=sub|subgift|raid`, `msg-param-*` tags) from upstream `event` frames, `RECONNECT` on graceful shutdown. Tag value escaping per IRCv3 (`\s`, `\:`, `\\`, `\r`, `\n`).
4. Flood control and limits: max line length 512 bytes (8191 for tags), per-connection command rate limit, max channels per connection (100), clean disconnect on upstream close with an `ERROR` line.
5. Health: `runService` HTTP health on `IRC_HEALTH_PORT` reporting connection counts.

## Dependencies you may add

- devDependency `tmi.js` 1.8.5 (MIT) and `@types/tmi.js` for tests.

## Tests

- Unit: IRC line parser/serializer (tags escaping, prefixes, trailing params, multi-line frames), emote offset conversion (incl. emoji/astral chars), NOTICE msg-id mapping, CAP negotiation state machine, command translation table.
- Integration: start the gateway against a **fake upstream chat server** you write in the test helpers (a Bun WebSocket server implementing the ServerFrame/ClientFrame protocol and checking the bearer token); then connect **unmodified tmi.js** over WebSocket and over plain TCP (tmi.js supports `connection: { server, port, secure }`; for TCP use a raw-socket test client if tmi.js only does WS — verify), log in with an OAuth token, join, receive a PRIVMSG with tags, send a message, run `!` command round-trip (fake upstream echoes a bot reply), receive CLEARCHAT and NOTICE, anonymous justinfan read-only. Also a raw TLS client test with the ephemeral cert.

## Done means

See common rules. `services/irc/README.md` documents how to point tmi.js, twitchio and others at the gateway, and the supported caps/commands.
