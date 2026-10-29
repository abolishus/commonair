<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Polls and predictions

Polls let your viewers vote on a question. Predictions let them stake channel points on how
something will turn out. Both appear in your chat panel. Apps subscribed to your channel receive
them as EventSub events (`channel.poll.*`, `channel.prediction.*`, `channel.points.change`).
Decisions: [ADR 0026](../decisions/0026-interactivity-policies.md).

## Who can do what

| Action                                      | Who                                                       |
| ------------------------------------------- | --------------------------------------------------------- |
| Start, end or archive a poll                | You, your editors and your moderators                     |
| Start, lock, resolve or cancel a prediction | You, your editors and your moderators                     |
| Vote in a poll                              | Any signed-in viewer not banned or timed out in your chat |
| Bet on a prediction                         | The same viewers, except you, your editors and moderators |

You and your team cannot bet on your own predictions, because you decide the outcome. Apps
need the `channel:manage:polls` or `channel:manage:predictions` scope to run them for you.
Suspended accounts cannot vote or bet.

## Polls

- One poll at a time per channel. A poll has a title of up to 60 characters, 2 to 5 choices of up
  to 25 characters each, and lasts from 15 seconds to 30 minutes.
- Each viewer votes once, for one choice. They cannot change their vote.
- **Extra votes.** If you set a price per extra vote, viewers can buy extra votes for the choice
  they voted for with channel points: up to 100 extra votes per viewer per poll. Leave the
  price at 0 to turn this off. Extra votes need channel points to be on.
- The poll ends on its own when the time runs out (within about two seconds). You can end it
  early. Ending sets the status to **completed** (time ran out) or **terminated** (ended early).
- An ended poll stays on screen until you start a new one or **archive** it. Archiving an active
  poll ends it and hides it.
- Vote counts update for viewers and apps at most every two seconds, not on every vote.

## Predictions

- One open prediction at a time per channel. A prediction has a title of up to 45 characters,
  2 to 10 outcomes, and a betting window of 30 seconds to 30 minutes. Channel points must be on.
- Each viewer places one bet, on one outcome, of 1 to 250,000 points. A bet cannot be changed or
  withdrawn. The points leave the viewer's balance when they bet.
- Betting closes when the window ends, or earlier when you **lock** it.
- After locking, you **resolve** it by picking the winning outcome, or **cancel** it. You can
  also cancel while betting is still open.

### Payouts

- Everything bet on every outcome is the **pool**. The viewers who bet on the winning outcome
  share the whole pool in proportion to their bets. If you bet 300 of the 400 points on the
  winning outcome and the pool is 600, you get 450.
- Points are whole numbers, so shares are rounded down. The points left over from rounding go one
  at a time to the bets with the largest remainders, and between equal remainders to the viewer
  with the lower account id. The payouts always add up to exactly the pool. Nothing is kept back.
- Viewers who bet on another outcome get nothing back.
- **Cancel refunds every bet.** If you resolve to an outcome nobody bet on, it counts as a cancel
  and every bet is refunded.
- Settling happens once. A second resolve or cancel is refused and pays nothing.

## Channel points have no cash value

Predictions use channel points only, never money. Channel points cannot be bought, sold,
transferred or exchanged for money, goods or services. We never pay out, refund or compensate
them in money. See the terms of service. If you turn channel points off for your channel, new
predictions and extra poll votes are refused. Predictions already open still pay out or refund.

## Records

Every poll and prediction you or your team start, end, lock, resolve or cancel is recorded in
your channel's audit log, by account id and with counts only (never titles or choices). Every bet,
payout, refund and extra-vote purchase is a row in the channel-points ledger, which cannot be
edited.
