<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E8: interactivity and the channel bot (PLAN 3D)

**Goal.** A streamer runs polls, predictions, raids and goals, viewers earn and spend channel
points, and a built-in bot answers commands and posts timers, all visible in chat, overlays and
EventSub events.

## State

- Contracts declared (`packages/contracts/src/api/router.ts` ~1449 bot, ~1577-1830 interact);
  entities `PollView`, `PredictionView`, `RaidView`, `Goal`, `LoyaltyBalance`, `BotCommand`,
  `BotTimer`, `BotSettings`; scopes `channel:manage:{polls,predictions,raids,bot,points}`.
- Tables exist for every stub: `polls`, `poll_votes`, `predictions`, `prediction_bets`, `raids`,
  `goals`, `loyalty_balances`, `loyalty_transactions` (`schema/interactive.ts`); `bot_configs`,
  `bot_commands`, `bot_timers`, `bot_variables`, `song_requests`.
- Events in the public catalog (`events.ts`): `channel.poll.*`, `channel.prediction.*`,
  `channel.goal.*`, `channel.raid`, `channel.points.change`. Nothing emits them yet.
- The chat service's `MessageMiddleware`/`PluginHost.say` (`services/chat/src/pipeline.ts:44-62`)
  is the bot's extension point; `services/chat/src/plugins/` has only `noop.ts`.
- Built already: alerts and overlay tokens (`interact.alerts.*`, `interact.overlays.*`),
  `overlay.alerts.tsx`. `overlay.goals.tsx` and `overlay.chat.tsx` are placeholders.
- 29 stubs: `interact.ts` 15 (`:49-64`, `:141-143`), `bot.ts` 14 (`:9-29`).

## Decisions first: ADR 0026 (interactivity policies)

- **Points accrue on verified watch only** (integrity verdict `verified`), per minute, capped
  per day, so viewbots cannot farm. Spending: bot commands with `costPoints`, predictions.
- **Predictions use channel points only, never money** (no gambling exposure); refund on cancel;
  payout is proportional, with largest-remainder rounding (`packages/ledger/src/math.ts:54`).
  Points have no cash value, stated in the terms.
- **Raids:** one at a time per channel, a cooldown, a target can turn raids off or allow only
  followed channels, suspended channels cannot raid or be raided, the count shown is the verified
  count. Raid-surge protection on the target is W3.
- **Goals:** types from `GOAL_TYPES`; progress from the outbox (follows, subs, tips), not polled.
- **Bot:** templates are variable substitution only (`${user}`, `${count}`, `${var:name}`),
  never code; timers need `intervalMinutes` and `minChatLines`; the bot speaks as a per-channel
  bot account (`users.accountType = "bot"`, `botOwnerId`) and its messages skip middlewares
  (already how `say` works). Song requests stay a link queue: no playback, no fetching titles.
- Whether points are a ledger (append-only `loyalty_transactions` with a trigger-checked
  balance) the way money is: recommended yes, enforced in SQL (AGENTS.md rule 9).

## Contract step

Points trigger in a protections migration, any missing columns (poll/prediction `ends_at`,
raid opt-out on channel settings), worker job names, the `interact` and `channel-bot` selectors
docs, event payload shapes for each catalog entry, `BUS` topics the overlays subscribe to.

## Units

| Unit           | Owns                                                                                                                                                          | Builds                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| E8-polls       | `routes/interact.ts` (polls, predictions), `services/api/src/interact/{polls,predictions}.ts`, worker `jobs/interact-end.ts`                                  | create/vote/bet/lock/resolve/cancel, auto-end at `ends_at`, events                          |
| E8-raids-goals | `routes/interact.ts` (raids, goals), `services/api/src/interact/{raids,goals}.ts`, worker `jobs/raid-execute.ts`, goal progress consumer                      | raid countdown and execute (viewers' players follow), goal progress, raid alert type        |
| E8-points      | `routes/bot.ts` (points), `packages/ledger`-style points module `services/api/src/points/**`, worker `jobs/points-accrue.ts`                                  | accrual from verified watch, balance, leaderboard, moderator adjust (audit row)             |
| E8-bot-engine  | `services/chat/src/plugins/bot/**`, `services/chat/src/plugins/index.ts`                                                                                      | commands, aliases, cooldowns, user levels, variables, timers, `!points`, song-request queue |
| E8-bot-api     | `routes/bot.ts` (settings, commands, timers, variables, songRequests)                                                                                         | CRUD with the shapes above; changes reach the chat service over the bus                     |
| E8-web         | `apps/web/src/routes/_studio/{interact,bot}*.tsx`, chat-panel poll/prediction cards, `overlay.goals.tsx`, `overlay.chat.tsx`, `packages/ui` blocks via shadcn | studio pages, viewer cards in chat, the two overlays                                        |

E8-polls and E8-raids-goals share `routes/interact.ts`: split it in the contract step into
`routes/interact/{polls,predictions,raids,goals}.ts` re-exported from `interact.ts`, so each
unit owns its own files.

## Harness

- `interact`: streamer opens a poll, three viewers vote, it ends on time; a prediction locks,
  resolves, points pay out and sum exactly; a raid moves the signed-in viewers' players to the
  target; a follower goal fills on the overlay; EventSub test subscriber gets each event.
- `channel-bot`: `!hello` answers, a cooldown refuses, a points-cost command debits, a timer
  posts only after N lines, a viewbot swarm earns no points.

## Done means

Both scenarios in `full`; `interact.ts` and `bot.ts` have no `notImplemented`; verify green.
