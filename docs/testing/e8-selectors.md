<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E8 web ↔ harness contract (interactivity and the channel bot)

The E8 units (polls and predictions, raids and goals, channel points, the channel bot, the studio
pages and the viewer cards and overlays) and their harness scenarios agree on these routes and
`data-testid` values. Changing one is a contract change: update this file, the web app and the
scenarios together. Tests select by `data-testid` (never by visible text, which is translated).
`harness/src/e8/selectors.ts` lists the ids and `harness/tests/e8/selectors.test.ts` checks them
against this file.

## Rules

- Tests select by `data-testid`, never visible text. Option items follow `<field>-<value>`.
- Numbers on elements are plain integers in `data-*` (points, votes, minor units).
- Test hook: `POST /internal/interact/tick` (`{ job }` from `INTERACT_JOBS`, behind
  `INTERNAL_API_SECRET`, only while `INTERACT_TEST_HOOKS=true`, otherwise 404): the API enqueues
  the job, waits (30 s) and returns its counts. Nothing shortens a poll, a countdown or a cooldown.
- The harness stack seeds `interact.points.accrual` with `blockMinutes: 1`
  (`harness/compose.e5-coop.yaml`).

## Routes

| Route            | Purpose                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `/interact`      | New, studio: polls, predictions, raids (and the raid policy), goals                                                 |
| `/bot`           | New, studio: bot on/off, filters, points, song requests, commands, timers, variables, points leaderboard and adjust |
| `/$channel`      | Chat panel: poll and prediction cards, the points chip, the outgoing-raid banner and the follow                     |
| `/overlay/goals` | Was a placeholder: goal bars from `overlays.state` and the `goal` SSE event                                         |
| `/overlay/chat`  | Was a placeholder: the channel's chat, read-only, transparent                                                       |

## Test ids

### Studio nav

`studio-interact-link`, `studio-bot-link`.

### Polls (`/interact`)

| Test id     | Element / meaning                                                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interact`  | Page wrapper; `interact-load-error` with `interact-retry`                                                                                                                                       |
| `poll-form` | `poll-title`, `poll-choice-<n>` (n = 1–5; 1 and 2 always shown), `poll-add-choice`, `poll-duration` (seconds), `poll-extra-cost` (0 = no bought votes), `poll-start`                            |
| `poll-live` | The current poll: `data-poll-id`, `data-status`, `data-ends-at`; one `poll-live-choice` per choice (`data-choice-id`, `data-votes`); `poll-end` (`ConfirmDialog`), `poll-archive` (ended polls) |

### Predictions (`/interact`)

| Test id                          | Element / meaning                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `prediction-form`                | `prediction-title`, `prediction-outcome-<n>` (n = 1–10), `prediction-add-outcome`, `prediction-window` (seconds), `prediction-start`         |
| `prediction-live`                | `data-prediction-id`, `data-status`, `data-locks-at`; `prediction-live-outcome` per outcome (`data-outcome-id`, `data-points`, `data-users`) |
| `prediction-lock`                | Lock now (status `active`)                                                                                                                   |
| `prediction-resolve-<outcomeId>` | Resolve to that outcome (`ConfirmDialog`; status `locked`)                                                                                   |
| `prediction-cancel`              | Cancel and refund (`ConfirmDialog`)                                                                                                          |

### Raids (`/interact`)

| Test id        | Element / meaning                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `raid-form`    | `raid-target` (slug), `raid-start`; `raid-error` with `data-code` (the API's precondition code, `raid_pending` for the pending-raid `CONFLICT`) when refused |
| `raid-pending` | `data-raid-id`, `data-to`, `data-execute-at`; `raid-cancel`                                                                                                  |
| `raid-last`    | The last raid: `data-raid-id`, `data-status`, `data-viewers`, `data-cancel-reason` (empty when none); `raid-cooldown` with `data-until` while cooling down   |
| `raid-policy`  | Select, items `raid-policy-anyone`, `raid-policy-followed`, `raid-policy-off`                                                                                |

### Goals (`/interact`)

| Test id     | Element / meaning                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goal-form` | `goal-type` (items `goal-type-followers`, `goal-type-subscriptions`, `goal-type-tips`), `goal-title`, `goal-target` (tips in the currency's major units, sent as minor units), `goal-start` |
| `goal-row`  | `data-goal-id`, `data-type`, `data-current`, `data-target`, `data-ended` (`true`/`false`); `goal-end`                                                                                       |

### Channel bot (`/bot`)

| Test id              | Element / meaning                                                                                                                                                                                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bot`                | Page wrapper; `bot-load-error` with `bot-retry`                                                                                                                                                                                                                             |
| `bot-settings`       | `bot-enabled` (switch), `bot-account` (`data-username`, empty before first enable), `bot-display-name`, `bot-filter-spam`, `bot-filter-links`, `bot-filter-caps`, `bot-filter-timeout`, `bot-points-enabled`, `bot-points-name`, `bot-sr-enabled`, `bot-sr-max`, `bot-save` |
| `command-row`        | `data-name`, `data-uses`, `data-enabled`, `data-cost`; `command-edit`, `command-remove` (`ConfirmDialog`); `command-empty`                                                                                                                                                  |
| `command-form`       | `command-new` opens it; `command-name`, `command-aliases` (comma-separated), `command-response`, `command-level` (items `command-level-<level>`), `command-cooldown`, `command-cost`, `command-enabled`, `command-save`; `command-error`                                    |
| `timer-row`          | `data-timer-id`, `data-enabled`; `timer-edit`, `timer-remove`; `timer-empty`                                                                                                                                                                                                |
| `timer-form`         | `timer-new` opens it; `timer-name`, `timer-message`, `timer-interval` (minutes), `timer-min-lines`, `timer-enabled`, `timer-save`                                                                                                                                           |
| `variable-row`       | `data-name`; `variable-form`: `variable-name`, `variable-value`, `variable-save`                                                                                                                                                                                            |
| `sr-row`             | `data-id`, `data-status`; `sr-played`, `sr-skip`; `sr-empty`                                                                                                                                                                                                                |
| `points-leaderboard` | `points-row` (`data-username`, `data-points`); `points-adjust-open` opens `points-adjust`: `points-adjust-user`, `points-adjust-delta`, `points-adjust-reason` (items `points-adjust-reason-<reason>`), `points-adjust-submit`                                              |

### Viewer (`/$channel` chat panel)

| Test id                                   | Element / meaning                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chat-poll`                               | Pinned above the log while a poll is active or just ended: `data-poll-id`, `data-status`; `chat-poll-choice` buttons (`data-choice-id`, `data-votes`); `chat-poll-extra` (number, shown when `pointsPerExtraVote > 0`); `chat-poll-voted` (`data-choice-id`, `data-votes`)     |
| `chat-prediction`                         | `data-prediction-id`, `data-status`; `chat-prediction-outcome` (`data-outcome-id`, `data-points`, `data-users`); `chat-prediction-amount`; `chat-prediction-bet-<outcomeId>`; `chat-prediction-my-bet` (`data-outcome-id`, `data-points`, `data-payout`, empty until resolved) |
| `chat-points`                             | Signed-in viewers when the channel's points are on: `data-points`, `data-name`                                                                                                                                                                                                 |
| `raid-banner`                             | Outgoing raid countdown: `data-raid-id`, `data-to`, `data-execute-at`; on `completed` the page navigates to `/<to>`                                                                                                                                                            |
| `chat-event` (`data-type="channel.raid"`) | Incoming raid in the target's chat: `data-user` (raider login), `data-viewers`                                                                                                                                                                                                 |

### Overlays

| Test id         | Element / meaning                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `overlay-goals` | Wrapper (`data-state`: `loading`, `live`, `refused`); `overlay-goal` per open goal (`data-goal-id`, `data-type`, `data-current`, `data-target`) |
| `overlay-chat`  | Wrapper (`data-state` as above); `overlay-chat-message` (`data-id`, `data-username`)                                                            |

## Scenarios

- **`interact` step 1 (poll, E8-polls).** The streamer starts a 20 s poll with three choices and
  `pointsPerExtraVote` 0; three viewers vote (two on choice 1); after `endsAt` + one `interact-tick`
  it is `completed` with votes 2/1/0; the outbox has `channel.poll.begin`, at least one
  `progress`, and `end` with the same counts. A vote after `endsAt` is refused.
- **step 2 (prediction, E8-polls).** Viewers get points by moderator adjust (`reward`); a
  prediction with two outcomes; bets 100 + 300 on A, 200 on B; lock; resolve A: payouts 150 and
  450 (`largestRemainder` over 600), sum of payouts = pool, balances and `channel.prediction.end`
  match; a second prediction resolved to an outcome nobody bet on refunds every bet.
- **step 3 (raid, E8-raids-goals).** Both streamers live, two signed-in chat clients and one
  verified HTTP viewer in the source; `raids.start` → `raid` frame `pending` in the source room;
  after the countdown and `raids-execute` the frame is `completed` with `to` = target, the
  target's outbox has `channel.raid` with `viewers` equal to the source's gate-eligible count, and
  the target's chat shows the inline event. With the target's policy `off`, `start` is refused
  (`raid_refused`); a second start inside the cooldown is refused (`raid_cooldown`).
- **step 4 (goal, E8-raids-goals).** A followers goal of 2 on the streamer; the overlay SSE stream
  (`harness/src/e6/sse.ts`) gets `goal` frames 0 → 1 → 2 as two viewers follow; at 2 the goal is
  ended and achieved (`channel.goal.end` `is_achieved: true`).
- **step 5 (studio, E8-studio).** Steps 1 and 3 driven from `/interact` (`poll-form`,
  `raid-form`), plus a goal from `goal-form`.
- **step 6 (viewer, E8-viewer).** A viewer on `/$channel` votes on `chat-poll`, bets on
  `chat-prediction`, sees `chat-points` drop by the bet, sees `raid-banner` and lands on the target
  channel page; `/overlay/goals?token=` shows the goal bar advancing.
- **`channel-bot` step 1 (commands, E8-bot-engine).** The streamer enables the bot and adds
  `!hello` (response `Hi ${user}!`, cooldown 30 s) over the API; a viewer's `!hello` gets one bot
  reply from the channel's bot account; a second `!hello` inside the cooldown gets none; a
  `moderator`-level command from a viewer gets none.
- **step 2 (points cost).** A `!hug` costing 50: a viewer with 0 points gets no effect and the
  bot says they lack points; after adjust `reward` +100 the command answers and the balance is 50
  (`channel.points.change` with reason `command`).
- **step 3 (timer).** A timer every 1 minute with `minChatLines` 3: no post after a minute of
  silence; after three messages it posts once.
- **step 4 (viewbots earn nothing, E8-points).** One verified signed-in viewer and a viewbot swarm
  (`harness/src/viewbot.ts`) watch for three minutes; after `points-accrue` the viewer has points
  (whole 1-minute blocks of 10) and no swarm account has any.
- **step 5 (song requests).** `!sr https://example.org/song` queues it (`bot.songRequests.list`);
  `!sr not-a-link` is refused; `setStatus played` moves it.
- **step 6 (studio, E8-studio).** Steps 1 and 3 set up on `/bot` instead of the API.
