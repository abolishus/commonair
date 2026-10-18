<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# `@commonair/irc`: Twitch-compatible IRC gateway

Lets existing Twitch chat bots and libraries (tmi.js, twitchio, irc-framework, plain IRC
clients) talk to CommonAir chat without code changes: point them at this host and give
them a CommonAir OAuth token.

The gateway is a **pure translator**. Every IRC connection gets its own upstream WebSocket
to the chat service (`CHAT_INTERNAL_URL`), authenticated with the client's own token as
`Authorization: Bearer <token>`. All chat rules (permissions, slow mode, bans, filters,
rate limits) are enforced upstream; the gateway only enforces protocol limits.

## Listeners

| Env               | Default | Transport                                                 |
| ----------------- | ------- | --------------------------------------------------------- |
| `IRC_PORT`        | 6667    | Plain TCP                                                 |
| `IRC_TLS_PORT`    | 6697    | TLS (`IRC_TLS_CERT_FILE` + `IRC_TLS_KEY_FILE`, PEM)       |
| `IRC_WS_PORT`     | 6680    | IRC over WebSocket, path `/` (what tmi.js uses)           |
| `IRC_HEALTH_PORT` | 6681    | HTTP: `/healthz`, `/readyz`, `/stats` (connection counts) |

TLS: production refuses to start without cert and key files. In development, if they are
unset, an ephemeral self-signed certificate for `localhost` is generated at startup (a
warning is logged); clients must then skip verification or trust that certificate.

WebSocket subprotocols: `irc` (tmi.js), `text.ircv3.net`, `binary.ircv3.net`, or none.
With `irc` or none, a frame may carry several CRLF-separated lines in both directions; the
IRCv3 subprotocols carry one line per frame.

## Pointing clients at the gateway

Tokens come from the CommonAir developer console (OAuth apps / bot accounts). Scopes:
`chat:read` to read, `chat:edit` to send, `moderator:manage:chat` for moderation commands
(see `TWITCH_SCOPE_MAP` in `@commonair/contracts` for the Twitch names). Use the bot
account's login as the nick.

**tmi.js** (unmodified):

```js
const client = new tmi.Client({
  options: { skipUpdatingEmotesets: true }, // otherwise tmi.js calls Twitch's API for emote sets
  connection: { server: "irc.example.org", port: 443, secure: true }, // or port: 6680, secure: false
  identity: { username: "mybot", password: "oauth:<token>" },
  channels: ["somechannel"],
});
```

Leave out `identity` for an anonymous, read-only `justinfanNNNN` connection.

**twitchio** and other raw-IRC libraries: connect to `irc.example.org:6697` (TLS) or `:6667`,
send `PASS oauth:<token>` and `NICK <login>`. For twitchio, override the IRC host/port where
the library allows it (for example by subclassing its websocket/connection class) and pass the
same token.

**Plain IRC clients** (irssi, WeeChat, HexChat): server `irc.example.org/6697` with TLS,
server password `oauth:<token>`, nick = your login. Request the caps below for tags.

## Protocol

Server lines use exactly Twitch's shapes, including the prefix `tmi.twitch.tv` and user
prefixes `login!login@login.tmi.twitch.tv`. This is a protocol constant, not a domain we
use: tmi.js and other libraries route server lines by comparing the prefix to that exact
string.

### Capabilities

| Cap                    | Effect                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `twitch.tv/tags`       | IRCv3 tags on every line                                                                                  |
| `twitch.tv/commands`   | `USERSTATE`, `ROOMSTATE`, `GLOBALUSERSTATE`, `CLEARCHAT`, `CLEARMSG`, `NOTICE`, `USERNOTICE`, `RECONNECT` |
| `twitch.tv/membership` | `JOIN` for other chatters (announced the first time they speak; there is no presence feed)                |

`CAP LS [302]` suspends registration until `CAP END`; a bare `CAP REQ` (tmi.js) does not.
`CAP REQ` is atomic: one unsupported cap NAKs the whole request. `CAP LIST` and `-cap`
removal are supported.

### Client commands

`CAP`, `PASS` (with or without `oauth:`), `NICK`, `USER` (ignored), `JOIN #a,#b` (and
`JOIN 0`), `PART`, `PRIVMSG #chan :text`, `PING`, `PONG`, `QUIT`. A bare `PING` gets
`PONG :tmi.twitch.tv`, as tmi.js expects. Client tag `reply-parent-msg-id` on `PRIVMSG`
sends a reply.

`PRIVMSG` text: `\x01ACTION …\x01` and `/me` are actions; `!commands` are ordinary chat
(bots answer upstream). Chat commands with `/` or `.`:

| Command                                     | Upstream          | Notes                                                 |
| ------------------------------------------- | ----------------- | ----------------------------------------------------- |
| `/ban <user> [reason]`, `/unban <user>`     | `ban`, `unban`    |                                                       |
| `/timeout <user> [duration] [reason]`       | `timeout`         | duration `600`, `10m`, `1h`, `2d`, `1w` (max 2 weeks) |
| `/untimeout <user>`                         | `untimeout`       |                                                       |
| `/delete <msg-id>`, `/clear`                | `delete`, `clear` |                                                       |
| `/slow [seconds]`, `/slowoff`               | `slow`, `slowoff` |                                                       |
| `/followers [duration]`, `/followersoff`    | `followers`, …    | bare number = minutes; `30m`, `1h`, `1 week`          |
| `/subscribers`, `/subscribersoff` (`/subs`) | `subscribers`, …  |                                                       |
| `/emoteonly`, `/emoteonlyoff`               | `emoteonly`, …    |                                                       |
| `/mod`, `/unmod`, `/vip`, `/unvip <user>`   | same              | broadcaster only (upstream decides)                   |

Malformed arguments get Twitch's `usage_*` notice locally; other `/commands` get
`msg-id=unrecognized_cmd`. A successful moderation command is answered with Twitch's
command-specific msg-id (`ban_success`, `timeout_success`, …), so `client.ban()` and
friends resolve in tmi.js.

### Server lines

- Welcome `001`–`004`, `375`/`372`/`376`, then `GLOBALUSERSTATE` (not for anonymous).
- On join: `JOIN`, `353`/`366`, `USERSTATE`, `ROOMSTATE` (`emote-only`, `followers-only`
  with `-1` = off, `r9k=0`, `room-id`, `slow`, `subs-only`). Mode changes send a
  `ROOMSTATE` with only the changed keys, like Twitch.
- `PRIVMSG` with `badge-info`, `badges` (`broadcaster/1`, `moderator/1`, `vip/1`,
  `subscriber/0|2000|3000` by tier, `bot-badge/1`, `staff/1`, `member/1` for co-op members),
  `color` (hex, see `src/colors.ts`), `display-name`, `emotes` (code-point offsets,
  inclusive), `first-msg`, `flags`, `id`, `mod`, `returning-chatter`, `room-id`,
  `subscriber`, `tmi-sent-ts`, `turbo`, `user-id`, `user-type`, `vip` (VIPs only) and
  `reply-parent-*` for replies. A client's own messages are not echoed back to it (as on
  Twitch); messages it sent from another connection are.
- `CLEARCHAT` (clear, or ban/timeout with `ban-duration` and `target-user-id`), `CLEARMSG`
  (`login`, `target-msg-id`, the deleted text when still known).
- `NOTICE` with `msg-id` from `src/notices.ts`. Held messages → `msg_rejected`, blocked →
  `msg_rejected_mandatory` (tmi.js `automod`); codes unknown to this gateway →
  `unrecognized_cmd`.
- `USERNOTICE`: `sub`, `subgift` (attributed to the preceding gift batch's gifter, else
  `ananonymousgifter`), `submysterygift`, `raid`, and a CommonAir extension `tip` with
  `msg-param-amount` (minor units), `msg-param-currency` and `msg-param-exponent`.
- `RECONNECT` before a graceful shutdown; `ERROR :Closing Link: …` before the gateway
  closes a connection (upstream gone, flooding, ping timeout).

### Limits

- Tag section up to 8191 bytes; the rest of a line 512 bytes including CRLF (answered with
  `417`). `PRIVMSG` is measured like Twitch: up to 500 characters of text, longer text is
  truncated.
- Per-connection token bucket (burst 60, 10 lines/s). Excess lines are dropped with one
  `msg_ratelimit` notice; sustained flooding disconnects (`Excess Flood`). User-facing chat
  rate limits are upstream's.
- 100 channels per connection (`405`), 30 s to register, `PING` after 4 min of silence and
  disconnect after 8, and slow readers are disconnected once 1 MiB of output is queued.

## Development

```sh
bun run --filter @commonair/irc start   # needs the chat service at CHAT_INTERNAL_URL
bun run --filter @commonair/irc test     # unit
bun run --filter @commonair/irc test:int # unmodified tmi.js + raw TCP/TLS against a fake chat service
```
