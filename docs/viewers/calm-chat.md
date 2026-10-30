<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Calm Chat and blocking people

Busy chats move too fast to read, and with a screen reader they are close to unusable: every line
is announced. **Calm Chat** is a reading mode for the chat beside a stream. It only changes what
your own screen shows; nobody else sees a difference, and nothing is removed from the chat itself.
Why it works the way it does: [feature-wins §4.2](../product/feature-wins.md) and
[ADR 0012, amendment 1](../decisions/0012-media-clock.md) (blocks, decisions 7 and 8).

## Turning it on

Select the leaf button in the chat header. It is off until you turn it on, also when your
system asks for reduced motion, and the choice is saved on this device (in your browser's local
storage; if the browser refuses storage, it holds until you leave the page). Turn it off again and
every line is back, including the ones Calm Chat held back: it is a view over the chat, not a
filter on it.

The settings button next to it has:

- **New lines per second**: how many new lines may appear each second, from 1 to 10 (3 by
  default).
- **Show subscribers' messages first**: off by default.
- The keyboard keys (below).

Moderators always see the raw chat, so the buttons are not shown to them.

## What it does

- **Waves.** Messages that say the same thing within 5 seconds of each other become one line,
  "PogChamp ×312". Messages count as the same only when they have exactly the same words in the
  same order, after ignoring letter case, extra spaces, look-alike characters (full-width letters,
  ligatures) and invisible characters. Two messages that differ by even one word are never
  grouped, so a wave cannot hide an insult inside copies of a harmless message. A message made only
  of emotes groups with messages of the same emotes. When several people send the same line (a
  copypasta, or a pile-on), the wave says how many: "from 12 people". Open a wave to see each
  message, or report the whole wave at once with **Report wave**: moderators get one report with
  up to 50 of its messages.
- **A speed limit.** At most the set number of new lines appear each second. When more arrive,
  the most important go first: mentions of you, the broadcaster, moderators, replies to you,
  people chatting for the first time this session, subscribers if you chose so, then everyone
  else. Lines that do not fit are skipped on your screen (they stay in the chat) and counted in
  the summary.
- **A summary instead of every line.** A single line under the chat, read out politely by screen
  readers at most every 5 seconds: "12 new messages, 2 waves (PogChamp ×312), 1 mention of you".
- **Removed messages leave.** A message a moderator deletes, or every message of someone who is
  banned, leaves its wave, and the count drops.

## What it never hides

- Mentions of you (`@yourname`) and replies to your messages: always shown, never grouped, never
  skipped by the speed limit.
- Your own messages.
- Messages from the broadcaster and the channel's moderators: never grouped.
- Chat notices (slow mode, a message of yours that was refused) and events such as tips and
  subscriptions.
- The line under the message box that says chat is saved with the broadcast's VOD and replayed
  beside it.

## Keyboard

With focus in the chat list:

| Key | What it does        |
| --- | ------------------- |
| `j` | Next line           |
| `k` | Previous line       |
| `m` | Next mention of you |

Only one line of the chat is in the Tab order (the newest, or the last one you moved to), so Tab
moves past the chat in one step. Lines do not animate when your system asks for reduced motion.

## Blocking someone

Open the menu beside one of their chat messages and choose **Block**. After you confirm:

- Their messages are not shown to you at all, in live chat and in chat replay. They are not
  grouped or counted either. A reply that quotes them says "Replying to a blocked user".
- They are not told, and nothing changes for anyone else. You can block a moderator or the
  broadcaster too: it only changes what you see.
- It takes effect at once in the tab where you blocked them.

You can block up to 1,000 people. The list is in **Settings, Privacy, Blocked users**, newest
first, where **Unblock** shows their next messages again. Your list is kept until you remove
someone or one of you deletes the account, and it is part of your data export (`blocks.json`).
Through the API: `me.blocks.list`, `me.blocks.ids`, `me.blocks.add` and `me.blocks.remove`, for
signed-in sessions only (apps and access tokens cannot read or change it).
