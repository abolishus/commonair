<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0026: Interactivity policies (points, predictions, raids, goals, the channel bot)

- Status: accepted (2026-10-27; the maintainer accepted the recommended answers, see
  [Decisions at acceptance](#decisions-at-acceptance-2026-10-27)); decision 5 amended
  2026-10-29, see [Amendment 1](#amendment-1-goal-progress-in-the-outbox-relay-transaction-2026-10-29)
- Date: 2026-10-27 (code checked at `ccf9c17`)

**Counsel has not reviewed whether channel-point predictions fall outside gambling law in every
jurisdiction we may serve, nor the "no cash value" wording in the terms.** Acceptance covers the
mechanism (points that cannot be bought or cashed out, predictions that stake only points), not
its legal sufficiency. The terms clause is a draft until counsel reads it, alongside the rest of
`packages/db/src/legal/terms.md`. This is not legal advice.

## Context

Milestone E8 (`.claude/briefs/next/E8-interactivity-bot.md`, batch 3) wires polls, predictions,
raids, goals, channel points and the built-in channel bot. The contracts, tables and events
exist; the handlers do not, and several policies are not answered by the shapes. This ADR
answers them before the contract step.

What the code has today:

- **Every interactivity route is a stub.** `services/api/src/routes/interact.ts:49-64` (polls,
  predictions, raids) and `:141-143` (goals); `services/api/src/routes/bot.ts:9-29` (settings,
  commands, timers, variables, song requests, points).
- **Points are two plain tables with no protection.** `loyalty_balances`
  (`packages/db/src/schema/interactive.ts:98`) holds a mutable `points` column;
  `loyalty_transactions` (`:113`) has a signed `delta`, a free-text `reason` (`:124`) and an
  optional `refId`. Both cascade on channel and user delete (`:103`, `:106`, `:119`, `:122`).
  No trigger in `packages/db/drizzle/` touches either table. Money, by contrast, is append-only
  (`packages/db/drizzle/0001_protections.sql:99-103`) and balanced by a deferred constraint
  trigger (`:199`, `:225-226`).
- **Accounts are pseudonymized, not deleted**, so retained rows keep their ids
  (`services/worker/src/deletion/account-deletion.ts:8`). The cascades above therefore never fire
  for a deleted account today; they would fire only for a hard delete.
- **Watch time and its verdict live on `playback_sessions`**
  (`packages/db/src/schema/delivery.ts:57`): `userId` (null for anonymous, `:66`), `watchSeconds`
  (`:81`), `verdict` and `verdictReasons` (`:88-89`), `scoredAt`. Verdicts are `pending`,
  `verified`, `excluded` (`packages/contracts/src/enums.ts:50`). The integrity package already
  defines what "may earn something that needs verified watching" means: `gateEligible`
  (`packages/integrity/src/score.ts:97`) and its SQL form `GATE_ELIGIBLE`
  (`packages/integrity/src/jobs.ts:47`): verified, scored at least once, and not carrying
  `fetch_unjudged` (`packages/integrity/src/types.ts:37`).
- **Instance-wide knobs are governance settings**, seeded from `DEFAULT_GOVERNANCE_SETTINGS`
  (`packages/db/src/seed.ts:15`) and read by the API with a short cache
  (`services/api/src/lib/settings.ts:31`).
- **Predictions** stake `points` per bet with a nullable `payout`
  (`packages/db/src/schema/interactive.ts:206-222`); polls can sell extra votes for points
  (`pointsPerExtraVote`, `:160`). `polls.endsAt` (`:163`) and `predictions.locksAt` (`:200`)
  already exist. The ledger has an exact proportional splitter, `largestRemainder`
  (`packages/ledger/src/math.ts:54`): parts sum to the total, ties go to the earlier item.
- **Raids** record a `viewerCount` documented as "verified viewers carried over"
  (`packages/db/src/schema/interactive.ts:233-234`), and the integrity package caps a raid at the
  source's verified viewers (`raidIntegrity`, `packages/integrity/src/channel.ts:151`;
  `raid_overstated`, `packages/integrity/src/types.ts:39`). The `channel.raid` event says the
  viewers are integrity-verified (`packages/contracts/src/events.ts:170-183`). Channel
  suspension is `channels.suspendedAt` (`packages/db/src/schema/channels.ts:59`). There is no
  raid opt-out setting anywhere.
- **Goals** have three types, `GOAL_TYPES = ["followers", "subscriptions", "tips"]`
  (`packages/contracts/src/enums.ts:214`), and a mutable `current` counter
  (`packages/db/src/schema/interactive.ts:261-275`). The outbox already emits `channel.follow`,
  `channel.subscribe` and `channel.tip` (`packages/contracts/src/events.ts:104`, `:111`, `:150`).
- **The bot's extension point exists.** `PluginHost.say` sends as any user id and skips
  middlewares "to avoid loops" (`services/chat/src/pipeline.ts:56-63`); `services/chat/src/plugins/`
  holds only `noop.ts` and `index.ts`. Bot accounts exist: `users.accountType` and
  `users.botOwnerId` (`packages/db/src/schema/auth.ts:30`, `:34`), created through `me.bots.create`
  (`services/api/src/routes/me.ts:341`). `bot_configs` has no column naming the channel's bot
  user (`packages/db/src/schema/interactive.ts:36-43`).
- **Bot shapes.** `BotTimer.minChatLines` is `min(0)`
  (`packages/contracts/src/api/entities.ts:587`); `BotCommand.response` is a 500-character
  template (`:575`); `song_requests.query` is free text
  (`packages/db/src/schema/interactive.ts:141`).
- **`channel.points.change`** is documented as "not by passive accrual"
  (`packages/contracts/src/events.ts:437-449`).

There is no live data: no public instance, no self-hosters, and only our rc staging droplet. Every
schema change below is a clean replacement in the E8 migration, with no back-compat path.

## Decisions

### 1. Points accrue only for gate-eligible watch time, per minute, capped per day

A signed-in viewer earns points for a channel only from `playback_sessions` rows on that channel
that satisfy `GATE_ELIGIBLE`. A `pending` session earns nothing yet; an `excluded` session never
earns; a `verified` session that carries `fetch_unjudged` counts as unverified and earns nothing.
Anonymous sessions (`userId` null) earn nothing.

- **Rate and cap are instance settings**: a new governance setting `interact.points.accrual`
  (`{ pointsPerBlock, blockMinutes, dailyCapPerChannel }`), unprotected, seeded in
  `DEFAULT_GOVERNANCE_SETTINGS`. Defaults: **10 points per 5 minutes**, at most **1,000 points per
  day per viewer per channel**. The day is the UTC day.
- **How it is counted.** The worker job `jobs/points-accrue.ts` (new, E8-points) credits whole
  blocks of gate-eligible `watchSeconds` per (channel, viewer), carrying the remainder forward,
  and stops at the daily cap. One `loyalty_transactions` row per crediting run per (channel,
  viewer), reason `watch`, so the job is idempotent by a stored high-water mark rather than by
  re-reading old sessions.
- **No clawback.** If a session's verdict later moves away from verified, points already credited
  stay. Clawback would push balances below zero and points have no cash value; the moderator
  adjust (decision 2) handles a deliberate correction.

Why: viewbots are cheap, and a currency that bots can farm makes predictions and paid-for poll
votes a bot contest. Reusing `GATE_ELIGIBLE` means points, stream-hour eligibility, follow prior
viewing and the W1 watch gate all mean the same thing by "verified watching".

### 2. Points are an append-only ledger with a trigger-checked balance

AGENTS.md rule 9: integrity is enforced at the lowest layer that can enforce it. Points are not
money, but once predictions exist people care about them, and they become the fraud target.

- **`loyalty_transactions` is append-only**: `commonair_forbid_mutation()` on UPDATE, DELETE and
  TRUNCATE, as for `ledger_transactions` (`packages/db/drizzle/0001_protections.sql:99`, `:123`). A
  new protections migration in the E8 contract step.
- **`loyalty_balances` is written only by trigger.** An AFTER INSERT trigger on
  `loyalty_transactions` upserts the balance; a guard on `loyalty_balances` refuses direct writes
  from the app role, and a `CHECK (points >= 0)` makes an overdraw fail the inserting
  transaction. Spending (a bot command's `costPoints`, a prediction bet, an extra poll vote) is
  one insert with a negative delta: if the balance would go negative, the insert fails.
- **`reason` becomes an enum** (`watch`, `command`, `prediction_bet`, `prediction_payout`,
  `prediction_refund`, `poll_vote`, `moderator_adjust`), replacing free text. AGENTS.md: no
  personal data or free text in append-only columns. `refId` points at the poll, prediction,
  command or audit row.
- **Foreign keys stop cascading.** Both tables reference channels and users with `restrict`
  instead of `cascade`: accounts and channels are pseudonymized, not deleted, and a cascade would
  collide with the append-only trigger.
- **Moderator adjust** (`bot.points.adjust`) inserts a `moderator_adjust` row and an `audit_log`
  row in the same transaction (AGENTS.md: every moderator action writes an audit row). Any
  explanation goes in the audit row as a reason code, not free text.
- `channel.points.change` is emitted through the outbox for every non-accrual change, as the
  catalog already says.

### 3. Predictions stake channel points only, never money

- **No money path, in either direction.** No route converts money into points, and none converts
  points into money, goods or payouts. Points have no cash value; the terms say so in a new
  clause in `packages/db/src/legal/terms.md` (draft, counsel to review). Why: staking something
  that can be bought or cashed out is gambling in most places; staking a free, non-transferable
  loyalty balance is far less exposed, and it is the only form we ship. This also fixes the scope
  of W3-fair-predictions: it builds on points and does not reopen money.
- **Cancel refunds every bet** (`prediction_refund`, one row per bettor). A prediction that
  resolves to an outcome nobody bet on is treated as a cancel and refunds too.
- **Payout is proportional with largest-remainder rounding.** The pool is the sum of all bets;
  winners split it by their stake using `largestRemainder` (`packages/ledger/src/math.ts:54`),
  bettors ordered by user id so ties are deterministic. The parts sum to the pool exactly; the
  `interact` harness scenario (new, E8) asserts it. Each winner gets one `prediction_payout` row;
  `prediction_bets.payout` records it for display.
- One bet per viewer per prediction (the existing primary key), placed before `locksAt`.

### 4. Raids

- **One at a time per channel.** A channel has at most one `pending` raid (a partial unique index
  on `raids(from_channel_id) where status = 'pending'`, contract step). A cooldown applies
  after a raid completes or is cancelled before the channel can start another; the default is
  10 minutes, an instance constant in the API config (decided in drafting).
- **The target decides.** A new channel setting `raids: "anyone" | "followed" | "off"` (default
  `anyone`): `followed` accepts raids only from channels the target follows; `off` refuses all.
  The check runs at start and again at execute, since the setting can change in the countdown.
- **Suspended channels cannot raid or be raided**: `channels.suspendedAt` set on either side
  refuses the start, and cancels a pending raid at execute.
- **The count shown is the verified count.** `raids.viewerCount` and the `channel.raid` payload
  carry the source's gate-eligible viewers at execute time, capped through `raidIntegrity`; no
  surface shows a raw count.
- **Surge protection on the target is not E8.** W3-surge-raids adds it after `interact.raids`
  exists (`.claude/briefs/next/W3-feature-wave.md:17`).

### 5. Goals advance from the outbox, not by polling

(Amended 2026-10-29: the counting runs inside the outbox relay transaction, not in a
`BUS.events` consumer. See [Amendment 1](#amendment-1-goal-progress-in-the-outbox-relay-transaction-2026-10-29).)

Goal types are `GOAL_TYPES` only. A goal-progress consumer (E8-raids-goals) reads `BUS.events`,
which the outbox relay publishes, and advances the channel's open goal of the matching type on
`channel.follow`, `channel.subscribe` and `channel.tip` (tips in integer cents, AGENTS.md money
rule), emitting `channel.goal.progress` and, when `current` reaches `target`,
`channel.goal.end`. Why: the outbox is already the record of these changes and is written in the
same transaction; polling counts would race and add load.

### 6. The channel bot

- **Templates are variable substitution only, never code.** Supported forms are `${user}`,
  `${count}`, `${var:name}` and a fixed list of built-ins the bot engine documents (uptime and
  the like). Unknown variables render literally. No expressions, no conditionals, no fetching
  URLs. Why: a template language that runs code is a sandbox to maintain and an injection
  surface in a multi-tenant chat service.
- **Timers need both `intervalMinutes` and `minChatLines`.** A timer fires only when its interval
  has passed and at least `minChatLines` messages arrived since it last fired, so it never talks
  to an empty room. The contract's minimum for `minChatLines` rises from 0 to 1 in the contract
  step (decided in drafting; 0 would allow exactly the empty-room spam this rule prevents).
- **The bot speaks as a per-channel bot account**: a `users` row with `accountType = "bot"` and
  `botOwnerId` = the channel owner, created through the same path as `me.bots.create` the first
  time the bot is enabled. `bot_configs` gains a `botUserId` column (contract step). Chat shows
  it as a bot; its messages count as the bot's, not the streamer's.
- **Bot messages skip middlewares**, as `PluginHost.say` already does, so the bot cannot trigger
  itself or another plugin into a loop.
- **Song requests stay a link queue.** A request is a URL the viewer pastes; the bot validates
  that it is a URL and queues it. No playback, no fetching titles or thumbnails, no calls to any
  third-party service. Why: title lookup needs proprietary APIs and keys (AGENTS.md rule 3 wants
  none in the default path), fetching viewer-supplied URLs from our services is an SSRF surface,
  and playback rights are not ours to grant.

## Consequences

- E8's contract step adds: the points protections migration (append-only, trigger-maintained
  balance, `CHECK`, reason enum, `restrict` FKs), the `interact.points.accrual` setting, the
  `raids` channel setting, the one-pending-raid index, `bot_configs.botUserId`, and
  `BotTimer.minChatLines` min 1. It is a clean replacement: there is no points data to keep.
- `bot.points.adjust` and every spend path must handle the database refusing an overdraw and map
  it to a contract error, not a 500.
- A viewbot swarm earns nothing, which the `channel-bot` scenario (new, E8) asserts. A real viewer
  behind a CDN whose fetches cannot be judged also earns nothing until per-session accounting covers
  that path; this is the same trade W1's watch gate makes.
- The terms gain a "points have no cash value" clause, a draft until counsel reviews it.
- W3-fair-predictions and W3-surge-raids build on these rules rather than redefining them.

## Alternatives considered

- **Accrue on any watch, filter later.** Simpler, but every later filter is a clawback, and bots
  farm in the meantime.
- **Points as a plain counter with application checks.** Rejected under AGENTS.md rule 9: a bug
  or a race in one spend path could mint or overdraw points, and predictions make that worth
  attacking.
- **Points in the money ledger** (`ledger_transactions`, a points currency). Rejected: it would
  mix a no-value balance into the books the co-op reports and audits, and the double-entry
  accounts add nothing for a single-sided balance.
- **Predictions with money, or points that can be bought.** Rejected: gambling exposure, and no
  product gain worth it.
- **Scripted bot templates** (a small expression language, or JavaScript in a sandbox).
  Rejected: sandbox maintenance and injection risk for a feature substitution covers.
- **Song requests with playback or title lookup.** Rejected: needs third-party APIs and keys, and
  raises rights questions.

## Decisions at acceptance (2026-10-27)

The maintainer accepted the recommended answers:

1. **Accrual.** Points accrue only for verified watch time (integrity verdict verified;
   `fetch_unjudged` counts as unverified), per minute, capped per day. Rate and cap are instance
   settings, defaulting to 10 points per 5 minutes and at most 1,000 points per day per viewer
   per channel.
2. **Points ledger.** Yes: append-only `loyalty_transactions` with a balance checked by database
   trigger, the way money is (AGENTS.md rule 9), because points become the fraud target once
   predictions exist.
3. **Predictions.** Channel points only, never money; refund on cancel; proportional payout with
   largest-remainder rounding (`packages/ledger/src/math.ts:54`). Points have no cash value,
   stated in the terms.
4. **Raids.** One at a time per channel, a cooldown, the target can refuse raids or allow only
   followed channels, suspended channels cannot raid or be raided, the count shown is the
   verified count. Surge protection is W3.
5. **Goals.** Types from `GOAL_TYPES`; progress from the outbox, not polling.
6. **Bot.** Templates are variable substitution only, never code; timers need `intervalMinutes`
   and `minChatLines`; a per-channel bot account (`users.accountType` bot, `botOwnerId`); bot
   messages skip middlewares as `say` already does; song requests stay a link queue (no playback,
   no title fetching).

Decided in drafting within these answers (recorded so reviewers can check them): accrual has no
clawback; a prediction resolved to an outcome nobody bet on refunds like a cancel; the raid
cooldown default is 10 minutes; `minChatLines` must be at least 1; the points `reason` becomes an
enum and the points FKs become `restrict`.

## Amendment 1: goal progress in the outbox relay transaction (2026-10-29)

- Status: accepted (2026-10-29; the maintainer accepted the orchestrator's default while
  reviewing the batch 3 briefs)
- Amends: decision 5 ("A goal-progress consumer (E8-raids-goals) reads `BUS.events`")

**Context.** `BUS.events` is Valkey pub/sub. A consumer that is down when an event is published
misses it for good, and with more than one API or worker replica every replica would see each
event and count it once each. A goal counter fed that way can both lose and double-count
follows, subscriptions and tips.

**Decision.** Goal progress is counted inside the outbox relay's transaction
(`services/worker/src/outbox.ts`, `relayOutboxBatch`): after the batch's events are validated
and before they are published, `applyGoalProgress(tx, events, ctx)` (E8-raids-goals) advances the
channel's open goal of the matching type for each `channel.follow`, `channel.subscribe` and
`channel.tip`, and writes `channel.goal.progress` and, at the target, `channel.goal.end` as outbox
rows in the same transaction. A rolled-back batch rolls the goal update back with it, and a
relayed row is never relayed again, so each event counts exactly once. Progress still comes from
the outbox, never from polling counts, which is what decision 5 was for.

Decided with it (E8's contract step records them): a goal counts from zero at its start, so only
events after `startedAt` advance it; the progress events are relayed by a later batch of the same
relay.

**Consequences.** The relay transaction does a little more work per batch (one indexed update per
goal-bearing event). No goal state depends on Valkey delivery. Nothing else subscribes to
`BUS.events` for goals; the overlay hub still reads it to push `goal` frames to OBS.
