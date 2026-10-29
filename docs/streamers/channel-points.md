<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Channel points

Channel points reward the people who actually watch your channel. Viewers earn them by watching
and spend them on bot commands, extra poll votes and predictions. The rules below are the same on
every channel of an instance; they come from
[ADR 0026](../decisions/0026-interactivity-policies.md) (decisions 1 and 2).

## No cash value

Channel points have no cash value. Nobody can buy, sell, transfer or cash them out, and nothing
on the platform turns money into points or points into money: a subscription, a tip or a gift
never earns points faster. The [terms](../../packages/db/src/legal/terms.md) ("Channel points
and predictions") say the same to your viewers.

## How viewers earn

- **Verified watch time only.** A viewer earns while they are signed in and watching your live
  stream, and only for time the integrity system has verified (the same rule that decides
  whether a viewer counts toward your stream hours, ADR 0015). A viewbot swarm, a session that
  never downloads video, or a viewer the scorer has not verified yet earns nothing.
- **Whole blocks.** Points come in blocks: by default **10 points for every 5 minutes** watched.
  Time that does not fill a block yet is kept and counted toward the next one, even across days.
- **A daily cap.** A viewer earns at most **1,000 points a day on each channel** (days are UTC).
  Time watched after the cap still fills the carried-over part of a block, but earns nothing more
  until the next day.
- **One viewer, one stream.** A viewer with your stream open in two tabs or on two devices earns
  as one viewer, not two.
- **Every minute or so.** Points are credited by a job that runs every 60 seconds, so a balance
  moves in steps, not continuously.

The rate and the cap are an instance setting (`interact.points.accrual`), changed only by a
co-op decision; there is no per-channel rate, multiplier or bonus.

### Who never earns

- You, on your own channel (you earn on other channels like anyone else).
- Bot accounts, including your channel bot.
- Suspended and deleted accounts.
- Anonymous viewers.
- Everyone on a channel whose points are turned off.
- Demo data: viewers of the instance's demo channels, and demo accounts anywhere.

### Viewers behind a CDN

When your stream is busy, some viewers may be sent to a content delivery network instead of the
instance's own servers. The instance cannot yet see what a viewer downloads from a CDN, so it
cannot verify their watch time the way it does on its own servers: such a viewer is marked
`fetch_unjudged` and **earns no points for that session yet**, even though they still count as a
viewer. They earn normally on any session delivered by the instance itself. This is a deliberate,
conservative default until CDN delivery can be judged.

## Turning points off and naming them

In the channel bot settings you can turn points off (no earning, no spending, `!points` stays
silent, predictions and point-bought votes are refused) and give them your own name, up to 20
characters (for example "beans"). Balances stay where they are while points are off, and time
watched while they are off never earns, even after you turn them back on. The same goes for time a
viewer watches while their account is suspended.

## Adjusting a viewer's points

You and your moderators can grant or deduct points for a viewer (`bot.points.adjust`, scope
`channel:manage:points` for apps). Each adjustment needs a reason code (`correction`, `reward`,
`penalty` or `other`), never free text. A deduction cannot take a balance below zero: the
database refuses it and nothing changes. Every adjustment is recorded in the audit log and
announced to EventSub subscribers as `channel.points.change`; passive earning is not announced.

Points are a ledger: every change is a row that is never edited or deleted. A credit stays even
if the integrity system later changes its mind about the session that earned it; correct a
mistake with an adjustment.

## Balances, the leaderboard and data exports

Anyone can read a viewer's balance on your channel and the channel's leaderboard (most points
first). Deleted accounts are left out of the leaderboard. Each viewer's account data export
contains their balances and full points history on every channel, with their poll votes,
prediction bets and song requests (`interact.json`).
