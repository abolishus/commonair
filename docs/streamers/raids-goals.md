<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Raids and goals

Two channel features for streamers: sending your audience to another live channel at the end of
a stream (a raid), and goal bars on your stream through the overlay. The rules come from
[ADR 0026](../decisions/0026-interactivity-policies.md) (decisions 4 and 5). Both are in the
studio at `/interact` and in the API under `interact.raids` and `interact.goals`.

## Raids

### Starting a raid

You start a raid from your channel to another channel's name. A countdown of **30 seconds**
starts, and everyone in your chat sees it. When it ends, your viewers' players move to the other
channel, and that channel's chat and alert overlay announce your arrival with the number of
viewers you brought. You can cancel during the countdown.

A raid cannot start when:

| Code                  | Why                                                                      |
| --------------------- | ------------------------------------------------------------------------ |
| `raid_source_offline` | You are not live.                                                        |
| `raid_target_offline` | The other channel is not live.                                           |
| `raid_suspended`      | Your channel or the other one is suspended.                              |
| `raid_refused`        | The other channel does not accept raids from you (see the policy below). |
| `raid_cooldown`       | You raided (or canceled a raid) less than 10 minutes ago.                |

A second raid while one is counting down is refused too (the studio shows `raid_pending`). You
cannot raid your own channel.

Everything is checked again when the countdown ends: if either channel went offline or was
suspended, or the other channel changed its policy and no longer accepts you, the raid is
canceled instead, with the reason shown in the studio.

### The viewer count

The number a raid carries is the count of **verified viewers** of your channel when the countdown
ends: viewers whose playback the integrity system has verified (the same rule that decides who
counts anywhere on the platform), counted once per account, or per device for viewers who are
not signed in. Viewers it could not judge, and sessions it excluded as automated, do not count. No
raid ever shows a raw number of connections, so a raid cannot be inflated with bots.

### Who may raid your channel

Your raid policy, in the studio:

- **Anyone** (the default): any live channel.
- **Channels I follow**: only channels you follow.
- **Nobody**: raids are refused.

### Cooldown

After a raid completes or is canceled, your channel can start the next one 10 minutes later. The
studio shows when the cooldown ends.

## Goals

A goal is a bar with a title and a target, shown by the goals overlay (`/overlay/goals`, the URL
the studio gives you with your overlay token). You can have **one open goal of each type** at a
time:

| Type          | Counts                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------ |
| Followers     | New followers **during this goal**: follows after you started it, not your follower total.       |
| Subscriptions | New subscriptions during this goal, gifted ones included (each gifted subscription counts once). |
| Tips          | The sum of tips during this goal, in your instance's currency (enter the target in it).          |

A goal starts at 0 when you create it, and the overlay moves as events arrive. When the count
reaches the target the goal ends by itself and is marked achieved. You can also end it yourself;
a goal ended below its target is marked not achieved. The channel's goal list shows the open goals,
then the ten most recently ended.

Follows that the integrity system excludes are not announced and do not count. Unfollowing does
not lower a goal.

## For developers

- Raids: `POST /api/channels/{channel}/raids` (`to`), `DELETE` the same path to cancel,
  `GET` for the pending or last raid with the cooldown and policy, `PUT .../raids/policy`. Scope
  `channel:manage:raids`. Refusals are `412 PRECONDITION_FAILED` with `data.requirement` set to
  one of the codes above; a pending raid is `409 CONFLICT`.
- Goals: `GET /api/channels/{channel}/goals` (public), `POST` to create (`type`, `title` up to 60
  characters, `target` above 0; tips in minor units), `POST .../goals/{id}/end`.
- Events: `channel.raid` on the receiving channel (with `viewers`, the verified count),
  `channel.goal.begin`, `channel.goal.progress`, `channel.goal.end` (`is_achieved`). Goal
  progress is counted from the event outbox, exactly once per follow, subscription and tip.
- Overlay stream: `goal` events carry the `Goal` object on every goal change of the token's
  channel; raids arrive as `alert` events of type `raid` when the raid alert is on.
