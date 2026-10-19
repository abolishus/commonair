<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E2 web ↔ harness contract

Milestone E2 adds follows, the discovery directory, one moderation action (timeout/ban from chat)
and a Twitch bot (unmodified tmi.js) through the IRC gateway. It extends
[e1-selectors.md](e1-selectors.md): everything there still holds. Changing one of these is a
contract change: update this file, `apps/web` and the `e2e-social` scenario together. Tests select
by `data-testid` (never by visible text, which is translated).

## API used (already in the contract)

- `directory.home` (sections `spotlight`, `newAndLive`, `live`, `following`), `directory.live`.
- `channels.get` → `viewer.following` (null/absent when anonymous), `followerCount`.
- `channels.follow` / `channels.unfollow` (both return the new `followerCount`), `me.follows`.
- `chat.bans.ban` / `chat.bans.unban` / `chat.bans.list`; the chat socket's `joined.me.canModerate`
  decides whether moderation controls render, and chat commands `/timeout`, `/ban`, `/unban`
  remain available to moderators.

## Routes

| Route       | Change in E2                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| `/`         | Becomes the directory: live sections from `directory.home`, plus the E1 sign-up/sign-in/dashboard links |
| `/$channel` | Follow button, follower count, chat moderation controls for moderators                                  |

The directory is server-rendered and refetched on navigation; the harness reloads `/` and waits
(up to 60 s) for a just-started stream to appear, because ranking and viewer counts are computed
on an interval.

## Test ids

| Test id                | Element / meaning                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nav-directory`        | header link to `/`                                                                                                                                                                |
| `directory`            | wrapper of the directory on `/`                                                                                                                                                   |
| `directory-section`    | one section; `data-section` = `spotlight` \| `new` \| `live` \| `following`. Rendered only when it has cards (`following` only when signed in)                                    |
| `stream-card`          | one live stream card (the house `<StreamCard>`); `data-channel` = channel slug; it contains a link to `/$channel`                                                                 |
| `directory-empty`      | `<EmptyState>` shown when nothing is live                                                                                                                                         |
| `follow-button`        | on `/$channel`, absent on your own channel. Signed in: toggles follow, `data-following` = `true` \| `false`, disabled while a request is in flight. Anonymous: links to `/signin` |
| `follower-count`       | on `/$channel`; `data-count` = integer follower count (text is the formatted number)                                                                                              |
| `chat-message`         | (E1) now also carries `data-id` = message id and `data-deleted="true"` once removed by a moderator, a timeout or a ban (the row stays, its text is replaced)                      |
| `chat-message-actions` | per-message `<IconButton tooltip>` opening the moderation menu; rendered only when `joined.me.canModerate` and the author is not you                                              |
| `chat-mod-timeout`     | menu item: time the author out for 600 s                                                                                                                                          |
| `chat-mod-ban`         | menu item: ban the author (opens a `ConfirmDialog`; confirm with `confirm-dialog-confirm`)                                                                                        |
| `chat-notice`          | a system notice line in chat; `data-code` = the server `notice` code (e.g. `msg_timedout`, `msg_banned`, `cmd_success`)                                                           |

`chat-mod-timeout` acts at once (no dialog; Twitch parity) and shows a toast. Both actions go
through `chat.bans.ban` (timeout: `durationSeconds: 600`). The removed user's messages turn into
`data-deleted="true"` rows for everyone in the room (the `ban` server frame).

## The `e2e-social` scenario

1. Streamer `S` (API-path sign-up) goes live over RTMP. Viewer `F` and troll `T` sign up and open
   the web app signed in; a bot account owned by `S` connects with tmi.js to the IRC gateway's
   WebSocket listener and joins `#S`.
2. `F` opens `/`, finds `stream-card[data-channel=S]` in a `live` (or `spotlight`/`new`) section,
   clicks it, lands on `/$channel` and clicks `follow-button` → `data-following="true"` and
   `follower-count` `data-count` increases by one. `channels.followers` (as `S`) lists `F`. After a
   reload of `/`, `S` appears in `directory-section[data-section=following]`.
3. `F` sends `!ping` in web chat; the tmi.js bot answers and `F` sees a `chat-message` with
   `data-author` = the bot. The bot also sees `F`'s message with Twitch-compatible tags.
4. `T` sends a message; `S` (on their own channel page) opens `chat-message-actions` on it and
   clicks `chat-mod-timeout`. `F` sees `T`'s message become `data-deleted="true"`; the tmi.js bot
   receives a `CLEARCHAT` for `T` with `ban-duration=600`; `T`'s next send shows
   `chat-notice[data-code=msg_timedout]`; `chat.bans.list` shows `T` with an expiry.
5. `S` lifts it (`chat.bans.unban`), `T` can chat again; `F` clicks `follow-button` again →
   `data-following="false"`. The stream stops.
