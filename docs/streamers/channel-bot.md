<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# The channel bot

Every channel can turn on a built-in bot. It answers commands, posts timed messages, keeps a
song request queue and filters spam, shouting and links. You set it up on the **Bot** page of
the studio (`/bot`) or through the API (`bot.*`, scope `channel:manage:bot`). Why it works the
way it does: [ADR 0026, decision 6](../decisions/0026-interactivity-policies.md).

## The bot account

The first time you turn the bot on, CommonAir creates a bot account for your channel and makes
it a moderator there. Everything the bot says comes from that account, and chat shows it as a
bot. Its messages follow the same chat rules as anyone's: an identical message within 30 seconds
is not sent twice, and the bot's own messages never trigger a command. Commands from other bot
accounts are ignored too, so two bots cannot answer each other forever.

Turning the bot off stops it at once on every chat server. Changes you save (commands, timers,
variables, settings) reach chat within a moment; at worst within a minute.

## Commands

A command is `!name`, a response, and some rules. Viewers type `!name` (any case) at the start
of a message; anything after the name is the command's arguments. A command can also have up to
five aliases (`!hi` for `!hello`). A command name always beats another command's alias.

When someone uses a command, the bot checks, in this order:

1. **User level.** Who may use it: `everyone < follower < subscriber < vip < moderator <
   broadcaster`. Each level includes the levels before it (a VIP can use subscriber commands).
   Too low: the bot says nothing.
2. **Cooldown.** After a use, the command is quiet for `cooldownSeconds` for the whole channel,
   not per viewer. You and your moderators are never held back by a cooldown. During the
   cooldown the bot says nothing.
3. **Cost.** A command with `costPoints` above zero spends the caller's
   [channel points](#channel-points) (points must be on for the channel; with points off the
   command does nothing). Without enough points the bot tells them how much it costs and how many
   they have, nothing is spent and the cooldown is not used up.
4. **Response.** The bot fills in the template and posts it.

### Template variables

Templates only substitute variables. There are no expressions, no conditions and the bot never
fetches anything from the internet.

| Variable        | Becomes                                                                         |
| --------------- | ------------------------------------------------------------------------------- |
| `${user}`       | The display name of whoever used the command                                    |
| `${touser}`     | The first argument without a leading `@` (`!hug @ann` → `ann`), else the caller |
| `${count}`      | How many times the command has been used, this use included                     |
| `${channel}`    | Your channel's display name                                                     |
| `${uptime}`     | How long you have been live (`1h 5m`), or `offline`                             |
| `${points}`     | The caller's points balance (after paying for this command)                     |
| `${pointsName}` | What your channel calls its points                                              |
| `${var:name}`   | The value of your variable `name` (set it on the Bot page)                      |

Anything else, such as a misspelled `${usr}` or a variable you have not set, is posted exactly as
written. What a viewer types is never read as a variable: if Ann calls herself `${uptime}`,
`${user}` becomes the text `${uptime}`. A response longer than a chat message (500 characters)
is cut.

Example: name `hug`, response `${user} hugs ${touser}! (${count} hugs so far)`, cost 10.

## Built-in commands

These three always exist; you cannot create a command with their names or aliases.

- **`!points`**: the caller's balance. Silent when points are off.
- **`!sr <link>`**: a song request (when song requests are on). See [Song requests](#song-requests).
- **`!commands`**: the commands the caller's level can use, in one message.

`!points` and `!commands` answer each viewer at most once every 5 seconds.

## Timers

A timer posts a message every `intervalMinutes`, but only while you are live and only when at
least `minChatLines` chat messages (1 or more; the bot's own do not count) arrived since it last
posted. A quiet room never hears from it. A new timer starts counting lines when the bot first
sees it, and posts as soon as enough lines arrive; after that it waits the full interval again.
Timers can use `${channel}`, `${uptime}`, `${pointsName}` and `${var:name}`; there is no caller,
so `${user}`, `${touser}`, `${count}` and `${points}` stay as written. Each timer posts once
however many chat servers your room is on. The bot checks timers every 15 seconds.

## Song requests

Song requests are a queue of links, nothing more. A viewer types `!sr` and a link; the bot
accepts it when it is an `http` or `https` address of at most 500 characters, with no user name
or password in it and a host name with a dot. The bot never opens the link, looks up titles or
plays anything. It answers with the request's place in the queue, or says why not:

- the queue already holds `maxQueue` requests (you set it, 1 to 200), or
- the viewer already has 3 requests waiting.

You and your moderators see the queue on the Bot page and mark each request played or skipped.

## Channel points

Viewers earn points by watching (see the points page of the studio); the bot lets them spend
them on commands with a cost. Every spend is recorded in the channel's points ledger and sent as
a `channel.points.change` event with reason `command`. You can turn points off in the bot
settings: commands with a cost then do nothing and `!points` is silent.

## Filters

The bot can drop messages before anyone sees them. You, your moderators, your VIPs and the bot
itself are never filtered.

- **Spam**: a character repeated more than `maxRepeatedChars` times in a row (`noooooooooooo`).
- **Caps**: messages of at least `minLength` characters where more than `maxRatio` of the letters
  are capitals. Digits, punctuation and emoji do not count as letters.
- **Links**: any link, unless its host is on your allowlist (`example.org` also allows
  `clips.example.org`), or the sender subscribes and you allow subscribers' links.

The sender sees why their message was not sent. When `timeoutSeconds` is above zero, the bot also
times them out for that long, as a moderator would; the timeout shows in your moderation log as
the bot's.

## What the bot never does

- Run code, evaluate expressions or follow conditions in a template.
- Fetch a URL: not for song requests, not for templates.
- Play, download or look up music.
- Talk in an empty room: every timer needs chat lines first.
- Answer itself or another bot.
- Spend a viewer's points without them typing the command.
