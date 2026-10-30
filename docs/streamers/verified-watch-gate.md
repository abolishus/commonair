<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# The verified-watch gate and the surge guard

Hate raids are usually accounts that join a chat without watching the stream. The verified-watch
gate asks for a little real watching before an account may chat, and the surge guard turns that
on by itself for a while when a channel is botted. You set both on the **Chat safety** page of
the studio (`/chat`) or through the API (`chat.updateSettings`, scope `moderator:manage:chat`).
Why it works the way it does: [ADR 0015](../decisions/0015-verified-watch-signal.md).

> **Off on the instance until it is generally available.** Both features sit behind instance
> flags (`CHAT_WATCH_GATE`, `CHAT_SURGE_GUARD`), off by default. While a flag is off, the studio
> page shows that the instance has not enabled the feature, the API refuses to switch it on, and
> a channel's saved setting is ignored. The gate's flag turns on by default only once ADR 0015's
> GA criteria are met (including CDN fetch-judging, which S1 stage 4 delivers); the surge guard
> stays off by default after that.

## What the gate requires

- **Watching this broadcast, signed in.** A viewer needs the set number of seconds (60 to 3600;
  0 turns the gate off) of watching that the integrity checks verified, on the broadcast that is
  live now. A new broadcast starts everyone from zero.
- **Watch signed in.** Watching while signed out does not count, and chatting from somewhere
  else (an IRC client, a bot) without watching here does not unlock chat. The chat box says so.
- **Verified watching only.** Sessions the integrity checks could not judge (for example ones
  served entirely by a CDN) do not count. While the gate is on, the platform keeps signed-in
  viewers of the channel off the CDN so their watching can be judged.
- **One household, a few accounts.** At most five accounts are unlocked per network address per
  broadcast, first come first counted. Viewers behind a privacy relay (many unrelated people
  share those addresses) are not capped; their account must be at least seven days old instead.
  The operator's governance settings set both numbers.
- **The same answer for everyone.** A refused message always gets the same notice ("This chat is
  for viewers who have been watching for a little while"), whatever the reason, and nobody sees
  a countdown. Repeated tries are slowed down after six a minute.

## Who is never gated

You, your moderators, your VIPs and verified bot accounts. Subscribers too, unless you turn
**Subscribers skip the gate** off.

## The surge guard

With the guard on (off by default), the platform watches for a rush: in two minutes, at least 20
new viewing sessions, or three times the channel's usual rate if that is higher, of which a set
share (default 50 %) are not verified after a minute, or a burst of suspicious follows. Then **surge mode** starts:
chat needs a minute of verified watching (or your own gate, if it is longer) until the cooldown
(default 10 minutes) passes with no new rush.

- People who chatted in the channel before the surge began, your team and subscribers (with the
  setting on) are not affected.
- Your moderators see a banner in chat saying why and until when, and can end surge mode (or
  start it) with one click. Ending it pauses the guard for one cooldown so it does not start again
  at once.
- Every start and end is recorded in the moderation audit log.

## If something goes wrong

If the platform cannot read the watching data, chat stays open to everyone rather than silencing
real viewers, and moderators see that the check is unavailable. If the guard stops running, surge
mode ends on its own a minute after its end time.
