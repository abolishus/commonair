<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Chat replay

Live chat is saved with your broadcast and replayed beside its VOD and its clips, in step with
the video: a line shows up at the moment the person who wrote it was watching, not when the
server happened to receive it. Why it works the way it does:
[ADR 0012, amendment 1](../decisions/0012-media-clock.md#amendment-1-part-2-timeline-spine).

In this release replay is available through the API (`vods.chat` at `GET /vods/{id}/chat`,
`clips.chat` at `GET /clips/{id}/chat`). The replay panel on the watch page comes in a later
release.

## Where a line is placed

Every player reports which moment of the broadcast it is showing. When a viewer sends a message,
that moment travels with it, and chat stores it beside the time the message arrived:

- A line can be placed at most **60 seconds** before it arrived, never before the broadcast
  started, and never after it arrived. Nobody can plant a line next to a moment they did not see.
- Messages from IRC clients, bots and the HTTP chat API have no player. They are placed at the
  time they arrived minus the channel's typical delay (the median delay of the verified viewers
  watching, once at least three of them report one).
- Someone who rewound the stream (watching behind the live edge) is not at the live moment. Their
  messages are placed at the time they arrived and marked "said while catching up".
- Chat sent while you are offline has no broadcast and is not replayed.

The time a message arrived stays the official time for reports, rate limits and moderation.

## What replay shows and hides

Replay shows only what the live room could still see, and what the person watching chose to see:

- **Deleted messages** (by their author, a moderator, or a report decision) are never replayed.
- **Held messages** that a moderator never approved are never replayed.
- **`/clear`**: everything sent before a clear during that broadcast is left out.
- **Bans and timeouts**: when you ban or time someone out during a broadcast, the lines they sent
  before it are left out of that broadcast's replay, as they were purged live. A permanent channel
  ban hides the person on every replay of your channel.
- **Suspended accounts**: while the platform suspends an account, its messages are hidden.
- **Blocks**: someone who blocked a user never sees that user's lines in replay. Because of this,
  replay is worked out for each viewer and never stored in a shared cache.
- **The video decides**: replay is served exactly when the VOD or clip itself can be watched by
  that person. A private VOD's chat is yours only; a subscribers-only VOD's chat is for
  subscribers; a removed VOD has no replay; an 18+ broadcast's replay needs a confirmed adult, as
  its video does.

A clip replays the chat of the moment it was cut from. It keeps no copy of its own: once those
messages age out (below), the clip's replay is empty and says chat is no longer kept.

## How long chat is kept

- Chat attached to a VOD that still exists is kept as long as that VOD, but never more than
  **60 days**.
- Chat with no VOD (VOD recording off, the VOD deleted or expired, or chat sent while offline) is
  kept **30 days**. That is also the window in which a message can be reported; a filed report
  keeps its own copy of the reported text as evidence.
- Your VOD retention setting (up to 60 days) therefore decides how long its chat replays. A VOD
  that expires after 14 days leaves its chat to the 30-day rule.
- Chat from an account under a legal hold is kept until the hold is released.

The chat input tells everyone in your chat that their messages are saved with the VOD, with a
link to the privacy policy.

## For operators: the two settings

| Setting                | Default | What it does                                                   |
| ---------------------- | ------- | -------------------------------------------------------------- |
| `CHAT_RETENTION_DAYS`  | `30`    | Days chat is kept when its broadcast has no VOD that exists    |
| `CHAT_REPLAY_MAX_DAYS` | `60`    | Days chat is kept at most, VOD or not (at least the one above) |

The worker's `chat-retention` job applies them every hour, in batches, and the privacy policy
states the configured figures. The worker and the API refuse to start when
`CHAT_REPLAY_MAX_DAYS` is lower than `CHAT_RETENTION_DAYS`. Keep `CHAT_REPLAY_MAX_DAYS` at least
the longest VOD retention a channel can choose (60 days), so no VOD outlives its chat.
