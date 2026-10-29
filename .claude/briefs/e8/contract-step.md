<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E8 contract step (orchestrator)

The orchestrator does this on `main` before any E8 or E9 unit starts, commits it (`feat(e8):
contract step`), pushes, lets CI go green (CI is the gate; no local `verify`). **E8's step lands
before E9's**: E9's contract step is applied on top of this commit and takes the next migration
numbers (§2.4), then N2's contract step on top of E9's (order in `e9/contract-step.md` "Waves").
The wave-1 E8 units branch from the sha after all three contract steps (the N2 step's sha), not
from this commit alone. Everything below was checked
against `c0c16fd` (2026-10-29); line numbers are from that commit. Plan:
`.claude/briefs/next/E8-interactivity-bot.md`. ADR: `docs/decisions/0026-interactivity-policies.md`.
Units: `.claude/briefs/e8/E8-*.md`.

## 0. Where the code differs from the plan (corrections)

| Plan / ADR says                                                            | Code at `c0c16fd`, and what this step does                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts at router.ts "~1449 bot, ~1577-1830 interact"                    | `bot:` is `router.ts:1512-1676`, `interact:` is `:1678-1951` (polls `:1679-1732`, predictions `:1733-1799`, raids `:1800-1821`, alerts `:1822-1858`, goals `:1859-1893`, overlays `:1894-1950`)                                                                                                                                                                                                                                                               |
| "29 stubs: interact.ts 15 (`:49-64`, `:141-143`), bot.ts 14 (`:9-29`)"     | Correct (`routes/interact.ts:49-64` and `:141-143`; `routes/bot.ts:8-30`, 14 handlers)                                                                                                                                                                                                                                                                                                                                                                        |
| `pipeline.ts:44-62` is the extension point                                 | `MessageMiddleware` is `services/chat/src/pipeline.ts:44-53`, `PluginHost` `:56-67`; plugins are a static array with no access to the database, Valkey or the bus (`plugins/index.ts:11`), so the bot cannot load commands or count lines. §5 extends `PluginHost`                                                                                                                                                                                            |
| Points rate and cap are an instance setting (ADR 0026 decision 1)          | `BotConfig.loyalty` (`packages/contracts/src/shapes.ts:172-185`) still carries per-channel `perFiveMinutes`, `subscriberMultiplier`, `followBonus`. A subscriber multiplier turns money into points faster (ADR 0026 decision 3 forbids any money → points path). §1.2 removes all three; `loyalty` keeps `enabled` and `pointsName` only                                                                                                                     |
| Goal progress: "a consumer reads `BUS.events`" (ADR 0026 decision 5)       | `BUS.events` is Valkey pub/sub: a consumer that is down misses events, and every API/worker replica would count each event once. §6.3 hooks goal progress into the outbox relay transaction (`services/worker/src/outbox.ts:69-…`) instead: still from the outbox, exactly once, the progress event written in the same transaction (decided 2026-10-29; ADR 0026 Amendment 1)                                                                                |
| Raids: "viewers' players follow"                                           | Nothing carries an outgoing raid to the source's viewers: `channel.raid` is keyed on the target (`events.ts:170-183`, condition `to_broadcaster_user_id`). §1.6 adds a `raid` chat control frame on the source's `BUS.chatControl`                                                                                                                                                                                                                            |
| `bot.points.adjust` reason is "a reason code" (ADR 0026 decision 2)        | Input is `reason: z.string().max(200)` (`router.ts:1668-1672`): free text bound for an audit row. §1.3 makes it an enum                                                                                                                                                                                                                                                                                                                                       |
| `channel.points.change` reason                                             | `reason: z.string()` (`events.ts:437-449`). §1.4 makes it `z.enum(LOYALTY_REASONS)`                                                                                                                                                                                                                                                                                                                                                                           |
| Song requests "stay a link queue"                                          | `song_requests.query` is free text (`schema/interactive.ts:141`) and the API has only a list (`router.ts:1621-1639`); a streamer cannot mark a request played. §1.3 adds `setStatus`, §2 renames the column to `url`                                                                                                                                                                                                                                          |
| `polls.endsAt`, `predictions.locksAt` exist                                | Correct (`schema/interactive.ts:163`, `:200`). Missing for the units: `predictions.lockedAt`, raid cancel time and reason, the one-open-per-channel indexes, due indexes, throttled-progress markers (§2)                                                                                                                                                                                                                                                     |
| Unit table: E8-web owns studio pages, chat cards and both overlays         | Split into **E8-studio** (studio pages) and **E8-viewer** (chat cards, raid follow, overlays): disjoint files, each a full unit of work, and both must wait for N2-core (wave 2)                                                                                                                                                                                                                                                                              |
| `/bot` and `/interact` studio routes                                       | `bot` is reserved (`services/api/src/auth/identity.ts:14-…`), `interact` is not: a channel named `interact` would be shadowed. §4.3 reserves it                                                                                                                                                                                                                                                                                                               |
| The bot account "named by `bot_configs.botUserId`" passes chat gates       | Bots skip only the verified-email gate (`services/chat/src/rules.ts:56`); followers-only, subscribers-only and account-age would refuse it. The bot is made a channel moderator when it is first enabled (E8-bot-api), which also lets the bot's filters time out                                                                                                                                                                                             |
| The channel bot "does not count against `MAX_BOTS_PER_OWNER`" (E8-bot-api) | `me.bots.create` counts every `users` row with `botOwnerId = caller` (`services/api/src/routes/me.ts:347-351`), so the channel bot would take one of the owner's ten slots. §2.5 excludes channel bots from that count                                                                                                                                                                                                                                        |
| The channel bot's username is `<slug>_bot` (E8-bot-api)                    | Account deletion pseudonymizes the owner's `users` and `channels` rows but never touches bots they own (`services/worker/src/deletion/account-deletion.ts`; no `botOwnerId` there), so the old slug would survive in the bot's username after the owner deletes their account. §2.5 pseudonymizes the deleted owner's channel bot                                                                                                                             |
| Plan harness: "EventSub test subscriber gets each event"                   | No E8 unit can: EventSub delivery is E9 (E9-ws, E9-subs, wave 2). E8's scenarios assert the outbox rows (payloads validated by `emit`); delivery of the E8 types over EventSub is E9's scenario's job. Covered: E9's `developer-platform` step 5 (E9-ws, wave 2, after E8's wave 1 merged) subscribes `channel.poll.begin` and `channel.points.change` over the EventSub WebSocket and expects one notification each (e9/contract-step.md §8; batch 3 README) |

Already right, do not redo: `PluginHost.say` skips middlewares (`services/chat/src/server.ts:526-541`);
chat already relays `channel.poll.*`, `channel.prediction.*` and `channel.raid` inline as
`{op:"event"}` frames (`services/chat/src/events.ts:28-37`); the overlay hub already subscribes to
`BUS.events` (`services/api/src/overlay/stream.ts:170-203`); `largestRemainder`
(`packages/ledger/src/math.ts:54`, exported from `@commonair/ledger`); `GATE_ELIGIBLE`
(`packages/integrity/src/jobs.ts:47`, exported); `raidIntegrity` (`packages/integrity/src/channel.ts:151`).
No new rate-limit bucket: votes and bets use `write` (E9 adds `app` to `DEFAULT_RATE_LIMITS`).

### Decided 2026-10-29

The user accepted these defaults; the sections and briefs below implement them. Do not reopen them.

| Decision                                                                                                                                          | Where                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Goal progress is counted inside the outbox relay transaction, not by a `BUS.events` consumer. This amends ADR 0026 decision 5 (its "Amendment 1") | §6.3, E8-raids-goals      |
| The per-channel accrual knobs (`perFiveMinutes`, `subscriberMultiplier`, `followBonus`) are removed; rate and cap are the instance setting only   | §1.2, E8-points           |
| The channel bot is a channel moderator (made one when first enabled)                                                                              | E8-bot-api, E8-bot-engine |
| A goal counts from zero at its start (events after `startedAt` only)                                                                              | E8-raids-goals            |
| The broadcaster, editors and moderators of a channel cannot bet on its predictions                                                                | E8-polls, E8-viewer       |
| The raid countdown is 30 s (`RAID_RULES.countdownSeconds`)                                                                                        | §1.1, E8-raids-goals      |
| One viewer's concurrent sessions on a channel accrue once                                                                                         | E8-points                 |
| The channel bot is pseudonymized with its owner on account deletion                                                                               | §2.5                      |
| `points-accrue` skips demo channels and demo viewers, so `demo:clear` keeps working                                                               | §2.3, §2.5, E8-points     |
| `me.bots.createToken` refuses the channel bot (`PRECONDITION_FAILED` `channel_bot`)                                                               | §2.5                      |
| The terms clause and a privacy paragraph both land here (`TERMS_SEED_VERSION`, `PRIVACY_SEED_VERSION`); drafts, counsel not reviewed              | §12                       |

## 1. Contracts (`packages/contracts`)

### 1.1 `src/enums.ts`

Append after `SONG_REQUEST_STATUSES` (:215):

```ts
/** Why points moved (`loyalty_transactions.reason`, ADR 0026 decision 2). The sign is checked by the database. */
export const LOYALTY_REASONS = [
  "watch",
  "command",
  "prediction_bet",
  "prediction_payout",
  "prediction_refund",
  "poll_vote",
  "moderator_adjust",
] as const;
/** `bot.points.adjust`: a reason code for the audit row, never free text (ADR 0026 decision 2). */
export const POINTS_ADJUST_REASONS = ["correction", "reward", "penalty", "other"] as const;
/** Who may raid a channel (`channels.raid_policy`, ADR 0026 decision 4). */
export const RAID_POLICIES = ["anyone", "followed", "off"] as const;
/** Why a raid ended without executing. */
export const RAID_CANCEL_REASONS = [
  "owner",
  "target_offline",
  "target_refused",
  "suspended",
  "source_offline",
] as const;
/**
 * Raid timing (ADR 0026 decision 4: "an instance constant in the API config"). The countdown
 * runs from `start` to `executeAt`; a channel can start another raid `cooldownSeconds` after its
 * last raid completed or was canceled.
 */
export const RAID_RULES = { countdownSeconds: 30, cooldownSeconds: 600 } as const;
/** Poll limits beyond the router's per-call input bounds. */
export const POLL_RULES = { maxExtraVotesPerUser: 100 } as const;
/** Command names the bot engine answers itself; `bot.commands.upsert` refuses them and their use as aliases. */
export const BOT_BUILTIN_COMMANDS = ["points", "sr", "commands"] as const;
/** What a `BotControlMessage` tells the chat service to reload. */
export const BOT_CONTROL_SCOPES = ["config", "commands", "timers", "variables"] as const;
```

### 1.2 `src/shapes.ts`

- `BotConfig.loyalty` (:172-185) becomes (ADR 0026 decisions 1 and 3; rates live in
  `interact.points.accrual`):

```ts
  loyalty: z
    .object({
      /** Off: no accrual, no spending, `!points` silent, predictions and point-bought votes refused. */
      enabled: z.boolean(),
      pointsName: z.string().min(1).max(20),
    })
    .default({ enabled: true, pointsName: "points" }),
```

- After `PayoutRulesSetting` (:225-231):

```ts
/**
 * `interact.points.accrual` governance setting (ADR 0026 decision 1, ordinary decision). Range-checked
 * by the database (`commonair_validate_points_accrual`, migration 0034).
 */
export const PointsAccrualSetting = z.object({
  pointsPerBlock: z.number().int().min(1).max(1000),
  blockMinutes: z.number().int().min(1).max(60),
  /** Per viewer per channel per UTC day; 0 turns accrual off instance-wide. */
  dailyCapPerChannel: z.number().int().min(0).max(100_000),
});
export type PointsAccrualSetting = z.infer<typeof PointsAccrualSetting>;
```

### 1.3 `src/api/entities.ts` and `src/api/router.ts`

Entities (replace in place; `BotCommand` :571-581, `BotTimer` :582-589, `BotSettings` :590,
`PollView` :591-600, `PredictionView` :601-617, `RaidView` :618-625):

```ts
const BotCommandName = z.string().regex(/^[a-z0-9_]{1,25}$/);
export const BotCommand = z.object({
  id: Id,
  name: BotCommandName,
  aliases: z.array(BotCommandName).max(5),
  /** Variable substitution only (ADR 0026 decision 6): `${user}`, `${count}`, `${var:name}` and the bot engine's documented built-ins. */
  response: z.string().min(1).max(500),
  userLevel: z.enum(E.USER_LEVELS),
  cooldownSeconds: z.number().int().min(0).max(3600),
  costPoints: z.number().int().min(0).max(1_000_000),
  enabled: z.boolean(),
  useCount: z.number().int(),
});
export const BotTimer = z.object({
  id: Id,
  name: z.string().min(1).max(50),
  message: z.string().min(1).max(500),
  intervalMinutes: z.number().int().min(1).max(1440),
  /** At least 1: a timer never talks to an empty room (ADR 0026 decision 6). */
  minChatLines: z.number().int().min(1).max(1000),
  enabled: z.boolean(),
});
export const BotSettings = z.object({
  enabled: z.boolean(),
  config: BotConfig,
  /** The channel's bot account (`users.account_type = 'bot'`), created the first time the bot is enabled. */
  botUser: UserPublic.pick({ id: true, username: true }).nullable(),
});
export const SongRequest = z.object({
  id: Id,
  /** The link the viewer pasted; never fetched (ADR 0026 decision 6). */
  url: z.string(),
  requester: Slug,
  status: z.enum(E.SONG_REQUEST_STATUSES),
  createdAt: Timestamp,
});
export const PollView = z.object({
  id: Id,
  title: z.string(),
  choices: z.array(z.object({ id: z.string(), title: z.string(), votes: z.number().int() })),
  status: z.enum(E.POLL_STATUSES),
  startedAt: Timestamp,
  endsAt: Timestamp,
  endedAt: Timestamp.nullable(),
  pointsPerExtraVote: z.number().int(),
  myVote: z.string().nullable(),
  /** The caller's votes including bought extra votes; 0 when not voted or anonymous. */
  myVotes: z.number().int(),
});
export const PredictionView = z.object({
  id: Id,
  title: z.string(),
  outcomes: z.array(z.object({ id: z.string(), title: z.string(), points: z.number().int(), users: z.number().int() })),
  status: z.enum(E.PREDICTION_STATUSES),
  startedAt: Timestamp,
  locksAt: Timestamp,
  lockedAt: Timestamp.nullable(),
  endedAt: Timestamp.nullable(),
  winningOutcomeId: z.string().nullable(),
  myBet: z.object({ outcomeId: z.string(), points: z.number().int(), payout: z.number().int().nullable() }).nullable(),
});
export const RaidView = z.object({
  id: Id,
  from: Slug,
  to: Slug,
  toDisplayName: z.string(),
  /** Gate-eligible viewers of the source at execute time (0 while pending). */
  viewerCount: z.number().int(),
  status: z.enum(E.RAID_STATUSES),
  cancelReason: z.enum(E.RAID_CANCEL_REASONS).nullable(),
  createdAt: Timestamp,
  executeAt: Timestamp,
});
// `LoyaltyBalance` (:669-674) gains, after `pointsName`:
//   /** The channel's points are on (`BotConfig.loyalty.enabled`); viewers hide the chip and the spend controls when false. */
//   enabled: z.boolean(),
/** `interact.raids.current`: the pending or last raid, when the next may start, and who may raid this channel. */
export const RaidState = z.object({
  raid: RaidView.nullable(),
  cooldownEndsAt: Timestamp.nullable(),
  policy: z.enum(E.RAID_POLICIES),
});
```

Router:

- `bot.songRequests` (:1621-1639) becomes a namespace:
  - `list`: `mod.route({ method: "GET", path: "/channels/{channel}/bot/song-requests", summary: "Song request queue (links only; no playback)", ...tag("Channel bot") }).input(ChannelRef.extend({ status: z.enum(E.SONG_REQUEST_STATUSES).optional() })).output(z.array(D.SongRequest))`
  - `setStatus`: `mod.meta({ access: "moderator", scopes: ["channel:manage:bot"] }).route({ method: "PUT", path: "/channels/{channel}/bot/song-requests/{id}", summary: "Mark a song request played or skipped", ...tag("Channel bot") }).input(ChannelRef.extend({ id: Id, status: z.enum(["played", "skipped"]) })).output(D.SongRequest)`
- `bot.points.adjust` (:1659-1674): `reason: z.enum(E.POINTS_ADJUST_REASONS)`.
- `interact.raids` (:1800-1821) gains:
  - `current`: `owner.meta({ access: "owner", scopes: ["channel:manage:raids"] }).route({ method: "GET", path: "/channels/{channel}/raids", summary: "The pending or last raid, the cooldown and the raid policy", ...tag("Raids") }).input(ChannelRef).output(D.RaidState)`
  - `setPolicy`: `owner.meta({ access: "owner", scopes: ["channel:manage:raids"], rateLimit: "write" }).route({ method: "PUT", path: "/channels/{channel}/raids/policy", summary: "Who may raid this channel", ...tag("Raids") }).input(ChannelRef.extend({ policy: z.enum(E.RAID_POLICIES) })).output(D.RaidState)`
- No other input changes. Outputs pick up the new entity fields.

### 1.4 `src/events.ts` (public catalog; final shapes, E9 delivers them)

E9's EventSub WebSocket and webhook fan-out deliver these as written here; E8 units emit exactly
these payloads (validated by `emit`). Conditions are unchanged.

- `choice` (:45): `z.object({ id: z.string(), title: z.string(), votes: z.number().int(), channel_points_votes: z.number().int() })`
  (`votes` includes the bought ones; Twitch shape).
- `outcome` (:46-51) gains `top_predictors: z.array(predictor).max(10)` with, above it,
  `const predictor = z.object({ ...user, channel_points_used: z.number().int(), channel_points_won: z.number().int().nullable() });`
  (`user` is `:39`; ordered by points used desc, then user id; `channel_points_won` null until resolved).
- New `const pointsVoting = z.object({ is_enabled: z.boolean(), amount_per_vote: z.number().int() });`
- Payload tables (every one keeps `...broadcaster`, `id`, `version: "1"`, its current condition and scopes):

| Type                          | Payload after this step                                                                                                                     | Emitted                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `channel.poll.begin`          | `title, choices: choice[], channel_points_voting: pointsVoting, started_at, ends_at`                                                        | `polls.create`, same transaction                                                  |
| `channel.poll.progress`       | same as begin                                                                                                                               | `interact-tick` only, at most once per 2 s per poll, when votes changed           |
| `channel.poll.end`            | `title, choices, channel_points_voting, status: z.enum(["completed","terminated","archived"]), started_at, ended_at`                        | `polls.end` or `interact-tick` at `endsAt`                                        |
| `channel.prediction.begin`    | `title, outcomes: outcome[], started_at, locks_at`                                                                                          | `predictions.create`                                                              |
| `channel.prediction.progress` | same as begin                                                                                                                               | `interact-tick`, at most once per 2 s per prediction, when bets changed           |
| `channel.prediction.lock`     | `title, outcomes, started_at, locked_at`                                                                                                    | `predictions.lock` or `interact-tick` at `locksAt`                                |
| `channel.prediction.end`      | `title, outcomes, winning_outcome_id: string \| null, status: z.enum(["resolved","canceled"]), started_at, ended_at`                        | `resolve` / `cancel` (a resolve nobody bet on is `canceled`, ADR 0026 decision 3) |
| `channel.goal.begin`          | `type: z.enum(GOAL_TYPES), description, current_amount, target_amount, started_at` (replace the inline enum with `GOAL_TYPES`, same values) | `goals.create`                                                                    |
| `channel.goal.progress`       | same as begin                                                                                                                               | outbox-relay hook (§6.3), once per goal per relay batch                           |
| `channel.goal.end`            | `type, description, current_amount, target_amount, is_achieved, started_at, ended_at`                                                       | `goals.end`, or the hook when `current >= target`                                 |
| `channel.raid`                | unchanged (`from_*`, `to_*`, `viewers`); `channelId` of the outbox row is the **target**                                                    | `raids-execute`                                                                   |
| `channel.points.change`       | `...user, delta, balance, reason: z.enum(LOYALTY_REASONS)`; description stays "not by passive accrual" (no `watch` rows are emitted)        | every non-`watch` `loyalty_transactions` insert, same transaction                 |

Tips goals count `amount.value` in the currency's minor units; `current_amount`/`target_amount`
of a `tips` goal are minor units. Import `GOAL_TYPES` and `LOYALTY_REASONS` at `:12-30`. Update
any catalog snapshot the contract tests keep (`packages/contracts/tests/contract.test.ts`); the
sorted type list does not change (no new types).

- `BUS` (:801-818) gains:

```ts
  /** Channel-bot config changes (JSON `BotControlMessage`), published by the API after commit; every chat instance reloads that part. */
  botControl: "bus:bot-control",
```

- The `OVERLAY_EVENTS_PATH` comment (:820-826): add "`goal` (data: `Goal` JSON) on every
  `channel.goal.*` event of the token's channel".

### 1.5 `src/internal.ts`

- `INTERNAL_ROUTES` (:69-92): `/** Interactivity test hook (served only while INTERACT_TEST_HOOKS=true, otherwise 404). POST an InteractTickBody: the API enqueues that INTERACT_JOBS job, waits (30 s) and returns its InteractJobResult. */ interactTick: "/internal/interact/tick",`
- `KEYS` (:136-210), with comments:

```ts
  /** INCR on every accepted chat message of the channel (the bot's timers count lines). */
  botLines: (channelId: string) => `bot:lines:${channelId}`,
  /** The `botLines` value when the timer last fired. */
  botTimerMark: (timerId: string) => `bot:timer-mark:${timerId}`,
  /** SET NX PX lock: exactly one chat instance fires a due timer. */
  botTimerLock: (timerId: string) => `bot:timer-lock:${timerId}`,
  /** SET NX EX: a command's cooldown (per channel and command, not per user). */
  botCooldown: (channelId: string, command: string) => `bot:cooldown:${channelId}:${command}`,
```

- `QUEUES` (:274-292): `/** Interactivity (E8, ADR 0026): INTERACT_JOBS. */ interact: "interact",`
- At the end of the file, after the E6 "Data export and operations" block (:517-544; the co-op
  block is :483-516):

```ts
// Interactivity (E8, ADR 0026, docs/testing/e8-selectors.md) -------------------------------

/** Jobs on `QUEUES.interact`; all scheduled by the worker, enqueued by the API only on the test hook. */
export const INTERACT_JOBS = {
  /** Every 2 s: end due polls, lock due predictions, emit throttled `*.progress` events. */
  tick: "interact-tick",
  /** Every 2 s: execute or cancel raids whose countdown ended. */
  raidsExecute: "raids-execute",
  /** Every 60 s: credit gate-eligible watch time (ADR 0026 decision 1). */
  pointsAccrue: "points-accrue",
} as const;
export type InteractJobName = (typeof INTERACT_JOBS)[keyof typeof INTERACT_JOBS];
export const INTERACT_JOB_NAMES = Object.values(INTERACT_JOBS) as [InteractJobName, ...InteractJobName[]];
export const InteractJob = z.object({});
export type InteractJob = z.infer<typeof InteractJob>;
export const InteractTickBody = z.object({ job: z.enum(INTERACT_JOB_NAMES) });
export type InteractTickBody = z.infer<typeof InteractTickBody>;
export const InteractJobResult = z.record(z.string(), z.number().int());
export type InteractJobResult = z.infer<typeof InteractJobResult>;
```

### 1.6 `src/chat.ts`

- `chat.ts` imports nothing from `./enums.ts` today (:9-12): add
  `import { BOT_CONTROL_SCOPES, RAID_STATUSES } from "./enums.ts";`.
- `ServerFrame` (:72-136): add before `pong` (:127):

```ts
  /**
   * An outgoing raid of this channel (E8): `pending` when it starts (countdown to `executeAt`),
   * then `completed` (players follow to `to`) or `canceled`. Sent on the source's chat control.
   */
  z.object({
    op: z.literal("raid"),
    channel,
    raidId: z.uuid(),
    status: z.enum(RAID_STATUSES),
    to: z.string(),
    toDisplayName: z.string(),
    executeAt: z.string(),
  }),
```

- `CONTROL_OPS` (:163): add `"raid"`. `ChatCore.onControl` (`services/chat/src/core.ts:323-350`)
  already forwards any other control frame to the room (`:349`); no chat change.
- After `ChatFanout`: `export const BotControlMessage = z.object({ channelId: z.uuid(), scope: z.enum(BOT_CONTROL_SCOPES) }); export type BotControlMessage = z.infer<typeof BotControlMessage>;`
- `services/irc/src/session.ts` (:528): add `case "raid": return; // an outgoing raid countdown has no Twitch IRC line` (the incoming raid is the `channel.raid` USERNOTICE it already maps).

## 2. Database (follow `.claude/skills/schema-change/SKILL.md`)

There is no points, poll, prediction, raid, goal or bot data anywhere (every handler is 501):
these are clean replacements with no back-compat path (ADR 0026, "Consequences").

### 2.1 `packages/db/src/schema/_shared.ts` (after `songRequestStatus`, :84)

```ts
export const loyaltyReason = pgEnum("loyalty_reason", E.LOYALTY_REASONS);
export const raidPolicy = pgEnum("raid_policy", E.RAID_POLICIES);
export const raidCancelReason = pgEnum("raid_cancel_reason", E.RAID_CANCEL_REASONS);
```

### 2.2 Schema changes

`channels.ts` `channels` (:31-75): `raidPolicy: raidPolicy().notNull().default("anyone"),` after
`vodRetentionDays` (comment: "ADR 0026 decision 4; checked at raid start and again at execute");
add `raidPolicy` to the `./_shared.ts` import (:19).

`delivery.ts` `playbackSessions` (:98-112): add
`index("playback_sessions_points_idx").on(t.scoredAt).where(sql\`${t.userId} is not null and ${t.verdict} = 'verified'\`)`
(comment: "points accrual reads signed-in verified sessions scored recently").

`interactive.ts`:

- `botConfigs` (:36-43): `enabled` default **false**; add
  `botUserId: uuid().unique().references(() => users.id, { onDelete: "restrict" }),`
  (comment: "the channel's bot account; null until the bot is first enabled").
- `loyaltyBalances` (:98-111): both FKs `onDelete: "restrict"`; table options add
  `check("loyalty_balances_points_nonneg", sql\`${t.points} >= 0\`)`and`index("loyalty_balances_leaderboard_idx").on(t.channelId, t.points)`. Comment: "written only by
  the `loyalty_transactions` trigger (migration 0034); the CHECK makes an overdraw fail the
  inserting transaction".
- `loyaltyTransactions` (:113-129): both FKs `restrict`; `reason: loyaltyReason().notNull()`;
  `refId` comment "the poll, prediction, command or audit row"; checks:

```ts
    check("loyalty_tx_delta_nonzero", sql`${t.delta} <> 0`),
    check(
      "loyalty_tx_sign_ck",
      sql`(${t.reason} in ('watch', 'prediction_payout', 'prediction_refund') and ${t.delta} > 0)
       or (${t.reason} in ('command', 'prediction_bet', 'poll_vote') and ${t.delta} < 0)
       or ${t.reason} = 'moderator_adjust'`,
    ),
```

- New, after `loyaltyTransactions`:

The two accrual tables are mutable working state, not ledger history, so they **cascade** (ADR
0026's `restrict` applies to `loyalty_transactions` and `loyalty_balances` only). `restrict` here
would break `demo:clear` (`packages/db/src/demo/clear.ts` deletes `playback_sessions` and
channels of demo users; its "children before RESTRICT parents" test would need new steps) for
rows that carry no value.

```ts
/** Points accrual state per viewer and channel (worker `points-accrue` only; mutable, no history). */
export const loyaltyAccruals = pgTable(
  "loyalty_accruals",
  {
    channelId: uuid()
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Gate-eligible seconds not yet worth a whole block. */
    carrySeconds: integer().notNull().default(0),
    /** The UTC day `dayPoints` counts. */
    day: date({ mode: "string" }).notNull(),
    dayPoints: integer().notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.channelId, t.userId] })],
);

/** High-water mark per playback session: watch seconds already turned into carry or points. */
export const loyaltyAccrualSessions = pgTable("loyalty_accrual_sessions", {
  sessionId: uuid()
    .primaryKey()
    .references(() => playbackSessions.id, { onDelete: "cascade" }),
  countedSeconds: integer().notNull().default(0),
  updatedAt: updatedAt(),
});
```

- `songRequests` (:131-146): rename `query` → `url` (comment "a link; never fetched"); add
  `index("song_requests_requester_idx").on(t.channelId, t.requesterId, t.status)`.
- `polls` (:148-167): add `changedAt: ts()` ("last vote"), `progressAt: ts()` ("last
  `channel.poll.progress`"); options add
  `uniqueIndex("polls_channel_active_uq").on(t.channelId).where(sql\`${t.status} = 'active'\`)`,
  `index("polls_due_idx").on(t.endsAt).where(sql\`${t.status} = 'active'\`)`.
- `predictions` (:186-204): add `lockedAt: ts()`, `changedAt: ts()`, `progressAt: ts()`; options add
  `uniqueIndex("predictions_channel_open_uq").on(t.channelId).where(sql\`${t.status} in ('active', 'locked')\`)`,
  `index("predictions_due_idx").on(t.locksAt).where(sql\`${t.status} = 'active'\`)`.
- `raids` (:223-241): add `canceledAt: ts()`, `cancelReason: raidCancelReason()`; options add
  `uniqueIndex("raids_from_pending_uq").on(t.fromChannelId).where(sql\`${t.status} = 'pending'\`)`(one at a time),`index("raids_from_idx").on(t.fromChannelId, t.createdAt)`(cooldown),`index("raids_due_idx").on(t.executeAt).where(sql\`${t.status} = 'pending'\`)`,
  `check("raids_cancel_ck", sql\`(${t.status} = 'canceled') = (${t.cancelReason} is not null)\`)`.
- `goals` (:261-275): options add
  `uniqueIndex("goals_channel_open_uq").on(t.channelId, t.type).where(sql\`${t.endedAt} is null\`)`
  (the hook advances "the channel's open goal of the matching type").

Imports: `check`, `date` from `drizzle-orm/pg-core`; `playbackSessions` from `./delivery.ts`;
the three enums.

### 2.3 Migrations

1. `cd packages/db && bunx drizzle-kit generate --name e8_interactivity` → **`0033_e8_interactivity.sql`**.
   drizzle-kit asks whether `song_requests.url` renames `query`: answer **rename**. Then edit
   the generated SQL so the reason change casts (`ALTER TABLE "loyalty_transactions" ALTER COLUMN
   "reason" SET DATA TYPE "public"."loyalty_reason" USING "reason"::"public"."loyalty_reason";`;
   Postgres refuses the cast without `USING` even on an empty table). Check: three enums, the
   two tables, four FK replacements, the column adds and the rename, the default change on
   `bot_configs.enabled`, eleven indexes, four checks.
2. `bunx drizzle-kit generate --custom --name e8_protections` → **`0034_e8_protections.sql`**,
   SPDX header, header comment listing the rules, `--> statement-breakpoint` separators:

```sql
-- 1. loyalty_transactions is append-only (ADR 0026 decision 2).
CREATE TRIGGER loyalty_transactions_append_only BEFORE UPDATE OR DELETE ON public.loyalty_transactions
  FOR EACH ROW EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER loyalty_transactions_no_truncate BEFORE TRUNCATE ON public.loyalty_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 2. loyalty_balances is written by this trigger only (owner rights, as 0002's history writers).
--    The upsert locks the balance row, so concurrent spends serialize; the CHECK fails an overdraw.
CREATE FUNCTION commonair_loyalty_apply() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  INSERT INTO public.loyalty_balances (channel_id, user_id, points, updated_at)
  VALUES (NEW.channel_id, NEW.user_id, NEW.delta, clock_timestamp())
  ON CONFLICT (channel_id, user_id)
  DO UPDATE SET points = public.loyalty_balances.points + EXCLUDED.points, updated_at = EXCLUDED.updated_at;
  RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION commonair_loyalty_apply() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER loyalty_transactions_apply AFTER INSERT ON public.loyalty_transactions
  FOR EACH ROW EXECUTE FUNCTION commonair_loyalty_apply();
--> statement-breakpoint
CREATE FUNCTION commonair_loyalty_balance_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT public.commonair_is_owner(TG_RELID) THEN
    RAISE EXCEPTION 'loyalty balances are written by the database only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
--> statement-breakpoint
CREATE TRIGGER loyalty_balances_guard BEFORE INSERT OR UPDATE OR DELETE ON public.loyalty_balances
  FOR EACH ROW EXECUTE FUNCTION commonair_loyalty_balance_guard();
--> statement-breakpoint
CREATE TRIGGER loyalty_balances_no_truncate BEFORE TRUNCATE ON public.loyalty_balances
  FOR EACH STATEMENT EXECUTE FUNCTION commonair_forbid_mutation();
--> statement-breakpoint

-- 3. interact.points.accrual is shape- and range-checked (same bounds as PointsAccrualSetting).
CREATE FUNCTION commonair_validate_points_accrual() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v jsonb := NEW.value;
BEGIN
  IF jsonb_typeof(v->'pointsPerBlock') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v->'blockMinutes') IS DISTINCT FROM 'number'
     OR jsonb_typeof(v->'dailyCapPerChannel') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'interact.points.accrual needs numeric pointsPerBlock, blockMinutes, dailyCapPerChannel'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (v->>'pointsPerBlock')::numeric NOT BETWEEN 1 AND 1000
     OR (v->>'blockMinutes')::numeric NOT BETWEEN 1 AND 60
     OR (v->>'dailyCapPerChannel')::numeric NOT BETWEEN 0 AND 100000
     OR (v->>'pointsPerBlock')::numeric <> trunc((v->>'pointsPerBlock')::numeric)
     OR (v->>'blockMinutes')::numeric <> trunc((v->>'blockMinutes')::numeric)
     OR (v->>'dailyCapPerChannel')::numeric <> trunc((v->>'dailyCapPerChannel')::numeric) THEN
    RAISE EXCEPTION 'interact.points.accrual values out of range' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER governance_settings_points_accrual_ck BEFORE INSERT OR UPDATE ON public.governance_settings
  FOR EACH ROW WHEN (NEW.key = 'interact.points.accrual') EXECUTE FUNCTION commonair_validate_points_accrual();
--> statement-breakpoint
```

Then `CREATE OR REPLACE FUNCTION commonair_configure_app_role(r name)`: the body of
`0029_w0_protections.sql:48-73` unchanged, plus
`-- E8 (0034): points are a ledger; balances are trigger-written.`
`EXECUTE format('REVOKE UPDATE, DELETE ON public.loyalty_transactions FROM %I', r);`
`EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.loyalty_balances FROM %I', r);`
and keep `REVOKE EXECUTE ON FUNCTION commonair_configure_app_role(name) FROM PUBLIC;`
(`infra/postgres/app-role.sql` re-applies it after migrations). 3. Tests: new `packages/db/tests/e8.int.test.ts` (`createTestDatabase()`, as the app role): a
`loyalty_transactions` row cannot be updated or deleted; a credit creates the balance; a spend
beyond it fails with SQLSTATE `23514` on `loyalty_balances_points_nonneg` and leaves the
balance unchanged; the sign check refuses a positive `command` and a negative `watch`; direct
INSERT/UPDATE/DELETE on `loyalty_balances` refused; two concurrent spends of a balance worth
one succeed once; the accrual setting refuses `blockMinutes: 0` and accepts the default;
`raids_from_pending_uq`, `polls_channel_active_uq`, `predictions_channel_open_uq`,
`goals_channel_open_uq` refuse a second open row. 4. `demo:clear`: points ledger rows are RESTRICT and append-only like money, so a demo user or
channel with any `loyalty_transactions` row makes the clear fail as a whole (as money does).
Say so in the doc comment of `packages/db/src/demo/clear.ts` (:4-11) and add `loyalty` to the
forbidden-table regex in `packages/db/tests/demo.test.ts` ("never touches append-only…",
:139-142). The accrual tables cascade (§2.2) and need no clear step. So that watching the demo
never creates such a row, `points-accrue` skips demo channels and demo viewers (E8-points, with
`anchoredUser` exported in §2.5; decided 2026-10-29).

### 2.4 Numbering for E9

E8 takes **0033** (`e8_interactivity`) and **0034** (`e8_protections`). **E9 takes 0035 (and
0036 if it needs a separate protections migration) if E8 took 0033 and 0034.** If this step had
to add a third migration, E9 shifts by one; the orchestrator states the final numbers in E9's
base sha message.

### 2.5 Seed and shared DB helpers

- `packages/db/src/seed.ts` `DEFAULT_GOVERNANCE_SETTINGS` (:15-148): after `moderation.thresholds`:
  `{ key: "interact.points.accrual", protected: false, description: "Channel points: points per block of verified watch time, block length in minutes, and the daily cap per viewer per channel (ADR 0026).", value: { pointsPerBlock: 10, blockMinutes: 5, dailyCapPerChannel: 1000 } }`.
- **`packages/db/src/points.ts`** (new, exported from `src/index.ts` like `account-actions.ts`).
  API, worker and chat all move points; the rules live here once:

```ts
export class InsufficientPointsError extends Error {
  /* name = "InsufficientPointsError" */
}
/** SQLSTATE 23514 on loyalty_balances_points_nonneg (the CHECK the 0034 trigger trips). */
export function isInsufficientPoints(err: unknown): boolean;
/**
 * Insert one ledger row inside a SAVEPOINT (so the caller's transaction survives a refusal) and
 * return the balance after it. Throws InsufficientPointsError on an overdraw; never writes
 * loyalty_balances itself (the trigger does).
 */
export async function postPointsInTx(
  tx: Executor,
  p: { channelId: string; userId: string; delta: number; reason: LoyaltyReason; refId: string | null; at?: Date },
): Promise<{ id: string; balance: number }>;
export async function pointsBalance(db: Executor, channelId: string, userId: string): Promise<number>; // 0 when no row
```

Tests in `packages/db/tests/e8.int.test.ts`: savepoint keeps the outer transaction usable after
an overdraw; balance after credit and spend; `refId` stored.

- **`services/api/src/channels/roles.ts`** (new): move the transaction body of `changeRole`
  (`services/api/src/routes/channels.ts:303-340`, with `ROLE_ACTIONS` :31-…) into
  `changeRoleInTx(tx, { channel, target: { id, username, name }, role, op, actorId }): Promise<boolean>`
  (role row, mod action, audit `channel.role.<op>`, `channel.moderator.*` event); `changeRole`
  keeps the checks and `publishControl` after commit. No behaviour change. (E8-bot-api makes the
  bot a moderator with it.)
- **`services/api/src/auth/bot-account.ts`** (new): move the insert of `me.bots.create`
  (`services/api/src/routes/me.ts:353-373`, inside `me.bots.create` :341-374, with `BOT_EMAIL_DOMAIN` :39 re-exported from me.ts)
  into `insertBotAccount(tx, { ownerId, username, displayName }): Promise<UserRow>` (throws the
  unique violation; the caller maps it). `me.bots.create` keeps its owner check and
  `MAX_BOTS_PER_OWNER`, but its count (`me.ts:347-351`) excludes channel bots
  (`not exists (select 1 from bot_configs where bot_user_id = users.id)`), so the channel bot never
  takes one of the owner's slots. Test: an owner with a channel bot can still create ten bots.
  **`me.bots.createToken` refuses the channel bot** (decided 2026-10-29): after the owner check
  (`me.ts:386-408`), if `bot_configs.bot_user_id = input.botId` exists, throw
  `precondition("channel_bot", "The channel bot cannot have tokens")` (`PRECONDITION_FAILED`,
  `data.requirement` `channel_bot`; the existing code and the pattern of `bot_limit`, so no new
  contract error). It speaks only through the bot engine; a token would let anyone holding it
  speak and moderate as the channel's moderator bot. It is the only path that mints a token for
  a bot: bots have no session, so they never reach OAuth consent or device activation (E9-oauth).
  Name the requirement in the `createToken` route's `summary`/description so the OpenAPI document
  shows it. Test in the `me` integration tests: a channel bot → `channel_bot` and no
  `oauth_tokens` row; an ordinary bot of the same owner still gets a token. Run the `me` tests.
- **Demo data for the accrual job** (`packages/db/src/index.ts`): export `anchoredUser` from
  `./demo/anchors.ts` (today only the `demo/` modules use it and `@commonair/db` does not export
  it), so `points-accrue` (E8-points) can skip demo channels and demo viewers with the same
  two-anchor rule `demo:clear` uses (§2.3 point 4: a demo user or channel with a points ledger row
  makes `demo:clear` fail). No other change in `demo/`.
- **Account deletion and the channel bot** (`services/worker/src/deletion/account-deletion.ts`):
  when the deleted user owns a channel whose `bot_configs.bot_user_id` is set, pseudonymize that
  bot user in the same transaction as the owner (username and display username `deleted_<hex>`,
  `name` the same, as the owner's row gets), because its username is derived from the old slug
  (E8-bot-api). Its id, role and ledger rows stay (ADR 0004). Test in the worker's account-deletion
  integration tests.

## 3. `packages/interact` (new workspace package)

Domain code both the API and the worker need (ending a poll, locking a prediction, cancelling a
raid, ending a goal, payload builders). The worker cannot import `services/api`.

- `package.json`: `@commonair/interact`, private, `AGPL-3.0-or-later`, scripts as
  `packages/ledger/package.json` except that `test:int` also takes `--passWithNoTests` (until the
  units add `*.int.test.ts` files the package has none, and `vp test run .int.test` fails on no
  files), dependencies `@commonair/contracts`, `@commonair/db`,
  `@commonair/integrity`, `@commonair/ledger` (`workspace:*`), `drizzle-orm`, `zod` (`catalog:`);
  `tsconfig.json`, `README.md` (one paragraph: what lives here and who owns which file), SPDX
  headers. Add `"@commonair/interact": "workspace:*"` to `services/api`, `services/worker` and
  `services/chat` `package.json`; `bun install`; commit `bun.lock`. No external dependency.
- `src/outbox.ts` (written here, read-only for units): `emitEvent(tx, type, channelId, payload, at?)`
  (body of `services/api/src/events/outbox.ts:12-25`), `broadcasterFields`, `userFields`
  (`:28-40` of that file), and
  `pointsChangePayload(channel: { ownerId; slug; displayName }, user: { id; username; name }, p: { delta; balance; reason }): EventPayload<"channel.points.change">`.
- Stub modules (units fill them; each exports nothing yet but a comment naming its owner):
  `src/polls.ts`, `src/predictions.ts` (E8-polls), `src/raids.ts`, `src/goals.ts`
  (E8-raids-goals), `src/accrual.ts` (E8-points).
- `src/index.ts` (written here, read-only): `export * from` each of the six files.
- `tests/` empty but for a `.gitkeep`; each unit adds `tests/<its-file>.test.ts` and
  `tests/<its-file>.int.test.ts`.

## 4. API scaffolding (`services/api`)

### 4.1 Split the shared route files (so every unit owns disjoint files)

- `routes/interact.ts` becomes a composer: `export const interact = { polls, predictions, raids, alerts, goals, overlays }`
  imported from new `routes/interact/{polls,predictions,raids,alerts,goals,overlays}.ts`. Move the
  E6 code unchanged: `alerts` (:66-140) to `alerts.ts`, `overlays` (:145-…) plus `overlayUrls`,
  `trimSlash` and `overlayEventsUrl` (:30-46, still exported for existing importers) to
  `overlays.ts`. The four stub groups go to their files with the new stubs:
  `raids.current`, `raids.setPolicy` → `notImplemented`.
- `routes/bot.ts` becomes a composer over `routes/bot/{settings,commands,timers,variables,song-requests,points}.ts`
  (`settings` holds `settings` and `updateSettings`; `song-requests.ts` exports `{ list, setStatus }`),
  every handler `notImplemented`.
- `services/api/src/router.ts` unchanged (same namespaces).

### 4.2 Test hook

`services/api/src/interact/hooks.ts` (written here, complete; nobody edits it): a copy of
`services/api/src/coop/hooks.ts` for `QUEUES.interact` / `InteractTickBody` / `InteractJobResult`
(`interactTickRunner`, `isInteractHookPath`, `interactHook`, `interactHealth` →
`{ interactTestHooks }`). Mount in `services/api/src/http.ts` next to the ops hook (:223-228,
same 404-before-secret order) and add `...interactHealth(built.deps)` to `services/api/src/main.ts:36`.
Test: `services/api/tests/interact-hooks.test.ts` (off → 404, bad body → 400).

### 4.3 Reserved names

`services/api/src/auth/identity.ts` `RESERVED_USERNAMES`: add `"interact"` (the studio route).

## 5. Chat scaffolding (`services/chat`)

- `PluginHost` (`src/pipeline.ts:56-67`) gains:

```ts
  /** The chat service's database (app role) and Valkey (key prefix applied), for plugins with state. */
  db: Database;
  valkey: ValkeyClient;
  /** Subscribe to a pub/sub channel (a `BUS` name; the service's bus prefix is applied). */
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  /** Rooms with at least one member on this instance: timers only fire where someone listens. */
  hostedChannels(): Array<{ id: string; slug: string }>;
```

- `src/server.ts` `initPlugins` (:523-556) takes `{ chat, rooms, bus, db, valkey, logger }` and
  fills them (`subscribe` = `bus.acquire(prefix + channel, handler)`; `hostedChannels` from
  `rooms.all()`, `src/rooms.ts:138`). Call site :188.
- `src/plugins/bot/index.ts` (new stub, owned by E8-bot-engine): `export const botMiddleware: MessageMiddleware = { name: "channel-bot", async process() { return "continue"; } };`
  and `src/plugins/index.ts:11`: `[noopMiddleware, botMiddleware]`.
- Run the chat unit and integration tests.

## 6. Worker scaffolding (`services/worker`)

### 6.1 Job stubs

Register in `src/jobs/index.ts` (imports :9-46, `JOBS` :48-…), each a `defineJob` with the final
queue, name, data and schedule and a handler returning zeros:

- `src/jobs/interact-tick.ts`: `QUEUES.interact`, `INTERACT_JOBS.tick`, `InteractJob`, `schedule: { every: 2_000 }`, `attempts: 1` → `{ pollsEnded: 0, predictionsLocked: 0, progress: 0 }`.
- `src/jobs/raids-execute.ts`: `INTERACT_JOBS.raidsExecute`, `{ every: 2_000 }`, `attempts: 1` → `{ executed: 0, canceled: 0 }`.
- `src/jobs/points-accrue.ts`: `INTERACT_JOBS.pointsAccrue`, `{ every: 60_000 }`, `attempts: 1` → `{ viewers: 0, points: 0 }`.

### 6.2 Env

`services/worker/src/env.ts` spreads `interactEnv` (§7) like `coopEnv` (:42).

### 6.3 Goal-progress hook in the outbox relay

`src/interact/goals/outbox-hook.ts` (stub, owned by E8-raids-goals):
`export async function applyGoalProgress(tx: Executor, events: readonly BusEvent[], ctx: WorkerContext): Promise<number> { return 0; }`.
In `src/outbox.ts` `relayOutboxBatch`, after the validation loop and before
`const pipeline = ctx.valkey.pipeline()` (:124), add
`await applyGoalProgress(tx, valid, ctx);` with the comment "E8: goals advance in the relay
transaction, so each follow/subscribe/tip counts exactly once and the progress event is written
with it (ADR 0026 decision 5 as amended, Amendment 1; relayed in a later batch)". A rollback of the batch rolls the goal
update back too. Run `services/worker` tests.

## 7. Config

- `packages/config/src/env.ts` after `opsEnv` (:311-…):

```ts
/**
 * Interactivity (E8, ADR 0026). Harness only, never on a public instance: serves
 * `POST /internal/interact/tick` (run an interactivity job now). Services log a warning at every start while it is on.
 */
export const interactEnv = z.object({
  /** Harness only: serves `POST /internal/interact/tick`. Never on a public instance. */
  INTERACT_TEST_HOOKS: bool.default(false),
});
```

Add to `ALL_ENV_SCHEMAS` (:596-…) after `opsEnv`; spread into `services/api/src/env.ts` (as
`opsEnv`, :17, :53, :74) with the start-up warning the ops hook logs.

- `.env.example` after the operations block (:125-127):

```
# --- interactivity (ADR 0026) ---
# Harness only. Never on a public instance: serves POST /internal/interact/tick.
INTERACT_TEST_HOOKS=false
```

- `infra/selfhost/env/commonair-api.keys` and `commonair-worker.keys`: `INTERACT_TEST_HOOKS`, by
  regenerating with `bun scripts/selfhost/unit-env.ts` (never by hand: E9's and N2's steps
  regenerate the same files on top, and `--check` must stay green).
- `docs/self-hosting/configuration.md`: add `INTERACT_TEST_HOOKS` to the "Never set … on a public
  instance" sentence (:107-109) and regenerate the env table with `bun scripts/config-reference.ts`
  (its `--check` runs in CI and fails on a new variable otherwise).
- `harness/compose.e8.yaml` (new, CC0 header like `harness/compose.e6.yaml`): `api` and `worker`
  `INTERACT_TEST_HOOKS: "true"`; add it to `HARNESS_OVERRIDES` in `scripts/infra.ts:437-444`
  (before `compose.multi-instance.yaml`) and to `scripts/tests` expectations that count overrides.
  Also set it on the multi-instance replicas, which repeat every harness hook flag by hand
  (`harness/compose.multi-instance.yaml` `api-2` :95-100 and `worker-2` :155-160, with a
  `# harness/compose.e8.yaml` comment like the others). Add the file to the override lists in
  `harness/README.md` (:70 and :501), as E9's step does for `compose.e9.yaml` after this one.
- `harness/compose.e5-coop.yaml` `GOVERNANCE_BOOTSTRAP_JSON` (:26-32): add
  `"interact.points.accrual":{"pointsPerBlock":10,"blockMinutes":1,"dailyCapPerChannel":1000}`,
  **and** the same key in `E5_GOVERNANCE_BOOTSTRAP` (`harness/src/coop.ts:65-74`): the file's
  header says to keep them equal and `harness/tests/coop.test.ts:94-96` fails otherwise. The seed
  inserts a missing key with its override on any migrate run (`packages/db/src/seed.ts:153-161`,
  `onConflictDoNothing`), so an existing harness volume picks it up.

## 8. Web scaffolding (`apps/web`) — lands before N2-core starts

- Routes (placeholders, `component: () => <NotFoundState />` as E7 did, studio session guard as
  `_studio/overlays.tsx`): `src/routes/_studio/interact.tsx` (`/interact`),
  `src/routes/_studio/bot.tsx` (`/bot`). Regenerate and commit `src/routeTree.gen.ts`. **No unit
  adds, renames or removes a route file.** (E9's contract step regenerates the tree again on top.)
- Nav: `src/lib/nav.ts` `StudioEntry` (:53-57) ids `"interact" | "bot"`, `to` `"/interact" | "/bot"`;
  `studioNav` (:149-158) lists them after `overlays`. `src/routes/_studio.tsx` `studioItem`
  (:22-60): two cases, `data-testid="studio-interact-link"` / `"studio-bot-link"`, Hugeicons
  (`ChartBarLineIcon` or `Poll01Icon`, and `BotIcon`/`RoboticIcon`: check they exist in
  `@hugeicons/core-free-icons`). Keys `studio.interact` ("Polls & raids") and `studio.bot`
  ("Channel bot") inline in `src/i18n/en.ts` next to `studio.relays` (:50). Update
  `tests/nav.test.ts`. N2-core then converts these with everything else.
- **No E8 unit catalog is created here.** E8-studio and E8-viewer start after N2-core merges and
  add their own namespaces in N2-core's format (§10).

## 9. Harness scaffolding

- `harness/src/e8/selectors.ts`: `E8_TEST_IDS`, `E8_ID_PATTERNS` (`poll-choice-<n>`,
  `prediction-outcome-<n>`, `prediction-resolve-<outcomeId>`, `chat-prediction-bet-<outcomeId>`,
  option items), `E8_ROUTES`, `E8_ROUTE_PATTERNS` from §11, shape of `harness/src/e7/selectors.ts`;
  `harness/tests/e8/selectors.test.ts` against `docs/testing/e8-selectors.md` like
  `harness/tests/e7/selectors.test.ts`.
- `harness/src/e8/steps.ts` (pure, orchestrator-owned), in the shape of `harness/src/safety.ts:18-…`:
  `INTERACT_STEPS = { 1: "poll", 2: "prediction", 3: "raid", 4: "goal overlay", 5: "studio", 6: "viewer" }`,
  `BOT_STEPS = { 1: "commands", 2: "points cost", 3: "timer", 4: "viewbots earn nothing", 5: "song requests", 6: "studio" }`,
  `PENDING_INTERACT_STEPS = [1,2,3,4,5,6]`, `PENDING_BOT_STEPS = [1,2,3,4,5,6]`, `parseSteps`,
  prerequisites (none). **Only the orchestrator removes a step from a pending list, when it merges
  the unit that implements it.** Tests in `harness/tests/e8/steps.test.ts`.
- `harness/src/e8/kit.ts` (orchestrator-owned): `E8Run` = `{ ctx, api (admin), streamer, target (a
  second streamer), viewers: SignedInUser[] (3), via: "api" | "web", db, hooks: { tick(job): Promise<InteractJobResult> } }`
  and `newE8Run(ctx, opts)` reusing `harness/src/safety-run.ts` helpers (`newStreamer`,
  `waitLive`) and `harness/src/users.ts`; `hooks.tick` posts `INTERNAL_ROUTES.interactTick` with
  the internal secret (404 → an error naming `harness/compose.e8.yaml`).
- Step stubs, each `(run: E8Run) => Promise<void>` throwing `new Error("<unit> not merged")`:
  `harness/src/e8/{polls,predictions}.ts` (E8-polls), `{raids,goals}.ts` (E8-raids-goals),
  `points.ts` (E8-points: `stepViewbots`), `bot.ts` (E8-bot-engine: `stepCommands`,
  `stepPointsCost`, `stepTimer`, `stepSongRequests`), `studio.ts` (E8-studio: `stepInteractStudio`,
  `stepBotStudio`), `viewer.ts` (E8-viewer: `stepViewer`).
- Scenarios (orchestrator-owned; units never edit them): `harness/scenarios/interact.ts` and
  `harness/scenarios/channel-bot.ts`, `inFull: false`, `needs` as `e7-admin.ts` plus `chat`,
  steps dispatched from `steps.ts`, `--set steps=` and `--set via=`. Descriptions from §11. At the
  end of the milestone the orchestrator sets `inFull` true, adds both to `FULL_REQUIRED`
  (`harness/src/registry.ts:33-…`) and adds a shard `interact: ["interact", "channel-bot"]` to
  `harness/src/shards.ts:11-16` and the CI matrix (`.github/workflows/ci.yml:193`), updating
  tests that pin the shard list (`git grep -n FULL_SHARDS scripts harness/tests`).

## 10. i18n rule for this milestone (N2-core runs in wave 1)

- N2-core (batch 3, wave 1) moves catalogs to `apps/web/src/i18n/locales/<lang>/<namespace>.json`
  with typed keys and ICU plurals (ADR 0029). E8 units with web strings run in wave 2, on top of it.
- **Namespaces are created by N2-core, not by the units.** N2-core creates an empty namespace for
  every name in the "i18n namespaces" list of `.claude/briefs/batch3/README.md`, and its recipe
  ("How to add a namespace", `.claude/briefs/n2/N2-core.md`) forbids a unit to create one (it
  would change the shared `keys/index.gen.ts`). **The orchestrator adds `e8-studio` and
  `e8-viewer` to that list before N2-core starts** (beside E9's `e9-consent` and `e9-console`).
- **E8-studio** writes only `apps/web/src/i18n/locales/en/e8-studio.json` (keys `interact.*`,
  `bot.*`) and the regenerated `apps/web/src/i18n/keys/e8-studio.gen.ts`; **E8-viewer** only
  `apps/web/src/i18n/locales/en/e8-viewer.json` (keys `chatPoll.*`, `chatPrediction.*`,
  `chatPoints.*`, `chatRaid.*`, `raid.*`, `overlayGoals.*`, `overlayChat.*`) and
  `keys/e8-viewer.gen.ts`, plus deleting exactly `overlay.goalsLater` and `overlay.chatLater` from
  the namespace N2-core put them in (`ops`, from `ops.ts` :129, :131 today) and regenerating that
  namespace's `keys/<it>.gen.ts`. That deletion is a deliberate exception to N2-core's rule 5
  ("never edit another namespace"): N2's i18n test requires every key to be used, and E8-viewer
  removes their only use. Counts use ICU plurals (`{count, plural, one {# vote} other {# votes}}`).
  Neither edits any other namespace, `keys/index.gen.ts` or N2-core's loader; if `bun run
  i18n:gen` changes `keys/index.gen.ts`, that is a contract request.
- `packages/ui` blocks the two units add take every string as a prop: they add no `UiMessages`
  keys (N2-core: "E8/E9 units do not add `UiMessages`").
- Chat-side bot replies (`services/chat/src/plugins/bot/**`) are channel content in English
  defaults, like the chat service's notice texts today; N2 does not cover the chat service.
- No email strings in E8.

## 11. `docs/testing/e8-selectors.md` (write it; the units build against it)

Header and intro as `docs/testing/e7-selectors.md:1-11` ("E8 web ↔ harness contract
(interactivity and the channel bot)"). Sections `## Rules`, `## Routes`, `## Test ids` (bold
group labels below become `###`), `## Scenarios`.

### Rules

- Tests select by `data-testid`, never visible text. Option items follow `<field>-<value>`.
- Numbers on elements are plain integers in `data-*` (points, votes, minor units).
- Test hook: `POST /internal/interact/tick` (`{ job }` from `INTERACT_JOBS`, behind
  `INTERNAL_API_SECRET`, only while `INTERACT_TEST_HOOKS=true`, otherwise 404): the API enqueues
  the job, waits (30 s) and returns its counts. Nothing shortens a poll, a countdown or a cooldown.
- The harness stack seeds `interact.points.accrual` with `blockMinutes: 1`
  (`harness/compose.e5-coop.yaml`).

### Routes

| Route            | Purpose                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- |
| `/interact`      | New, studio: polls, predictions, raids (and the raid policy), goals                                                 |
| `/bot`           | New, studio: bot on/off, filters, points, song requests, commands, timers, variables, points leaderboard and adjust |
| `/$channel`      | Chat panel: poll and prediction cards, the points chip, the outgoing-raid banner and the follow                     |
| `/overlay/goals` | Was a placeholder: goal bars from `overlays.state` and the `goal` SSE event                                         |
| `/overlay/chat`  | Was a placeholder: the channel's chat, read-only, transparent                                                       |

### Test ids

**Studio nav**: `studio-interact-link`, `studio-bot-link`.

**Polls (`/interact`)**

| Test id     | Element / meaning                                                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interact`  | Page wrapper; `interact-load-error` with `interact-retry`                                                                                                                                       |
| `poll-form` | `poll-title`, `poll-choice-<n>` (n = 1–5; 1 and 2 always shown), `poll-add-choice`, `poll-duration` (seconds), `poll-extra-cost` (0 = no bought votes), `poll-start`                            |
| `poll-live` | The current poll: `data-poll-id`, `data-status`, `data-ends-at`; one `poll-live-choice` per choice (`data-choice-id`, `data-votes`); `poll-end` (`ConfirmDialog`), `poll-archive` (ended polls) |

**Predictions (`/interact`)**

| Test id                          | Element / meaning                                                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `prediction-form`                | `prediction-title`, `prediction-outcome-<n>` (n = 1–10), `prediction-add-outcome`, `prediction-window` (seconds), `prediction-start`         |
| `prediction-live`                | `data-prediction-id`, `data-status`, `data-locks-at`; `prediction-live-outcome` per outcome (`data-outcome-id`, `data-points`, `data-users`) |
| `prediction-lock`                | Lock now (status `active`)                                                                                                                   |
| `prediction-resolve-<outcomeId>` | Resolve to that outcome (`ConfirmDialog`; status `locked`)                                                                                   |
| `prediction-cancel`              | Cancel and refund (`ConfirmDialog`)                                                                                                          |

**Raids (`/interact`)**

| Test id        | Element / meaning                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `raid-form`    | `raid-target` (slug), `raid-start`; `raid-error` with `data-code` (the API's precondition code, `raid_pending` for the pending-raid `CONFLICT`) when refused |
| `raid-pending` | `data-raid-id`, `data-to`, `data-execute-at`; `raid-cancel`                                                                                                  |
| `raid-last`    | The last raid: `data-raid-id`, `data-status`, `data-viewers`, `data-cancel-reason` (empty when none); `raid-cooldown` with `data-until` while cooling down   |
| `raid-policy`  | Select, items `raid-policy-anyone`, `raid-policy-followed`, `raid-policy-off`                                                                                |

**Goals (`/interact`)**

| Test id     | Element / meaning                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goal-form` | `goal-type` (items `goal-type-followers`, `goal-type-subscriptions`, `goal-type-tips`), `goal-title`, `goal-target` (tips in the currency's major units, sent as minor units), `goal-start` |
| `goal-row`  | `data-goal-id`, `data-type`, `data-current`, `data-target`, `data-ended` (`true`/`false`); `goal-end`                                                                                       |

**Channel bot (`/bot`)**

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

**Viewer (`/$channel` chat panel)**

| Test id                                   | Element / meaning                                                                                                                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `chat-poll`                               | Pinned above the log while a poll is active or just ended: `data-poll-id`, `data-status`; `chat-poll-choice` buttons (`data-choice-id`, `data-votes`); `chat-poll-extra` (number, shown when `pointsPerExtraVote > 0`); `chat-poll-voted` (`data-choice-id`, `data-votes`)     |
| `chat-prediction`                         | `data-prediction-id`, `data-status`; `chat-prediction-outcome` (`data-outcome-id`, `data-points`, `data-users`); `chat-prediction-amount`; `chat-prediction-bet-<outcomeId>`; `chat-prediction-my-bet` (`data-outcome-id`, `data-points`, `data-payout`, empty until resolved) |
| `chat-points`                             | Signed-in viewers when the channel's points are on: `data-points`, `data-name`                                                                                                                                                                                                 |
| `raid-banner`                             | Outgoing raid countdown: `data-raid-id`, `data-to`, `data-execute-at`; on `completed` the page navigates to `/<to>`                                                                                                                                                            |
| `chat-event` (`data-type="channel.raid"`) | Incoming raid in the target's chat: `data-user` (raider login), `data-viewers`                                                                                                                                                                                                 |

**Overlays**

| Test id         | Element / meaning                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `overlay-goals` | Wrapper (`data-state`: `loading`, `live`, `refused`); `overlay-goal` per open goal (`data-goal-id`, `data-type`, `data-current`, `data-target`) |
| `overlay-chat`  | Wrapper (`data-state` as above); `overlay-chat-message` (`data-id`, `data-username`)                                                            |

### Scenarios

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

## 12. Legal: terms no-cash-value clause and privacy paragraph (drafts, counsel not reviewed)

Decided 2026-10-29 (user): this step bumps **both** the terms and the privacy policy. ADR 0026
decision 3 needs the terms clause; the privacy policy must say what the new features keep. Both
texts are drafts and **counsel has reviewed neither** (ADR 0026 header). The N2 step lands after
this one and bumps `COOKIES_SEED_VERSION` in the same `index.ts`; its text assumes both bumps here
are applied.

### 12.1 `packages/db/src/legal/terms.md`

Insert after "## 9. Payments" (:81-84) and renumber 10-12 to 11-13 (update in-document
references, if any):

```markdown
## 10. Channel points and predictions

Channels can give viewers channel points for watching and let them spend those points on chat
commands, extra poll votes and predictions. Channel points have no cash value. They cannot be
bought, sold, transferred to another person or channel, or exchanged for money, goods or
services, and we never pay out, refund or compensate them in money. Predictions stake channel
points only, never money. A channel or the co-op may change how points are earned, adjust or
remove points (for example to correct an error or abuse), or turn points off; points end when the
channel turns them off, when your account ends, or when the service ends. Points are not a
deposit, a currency or property of yours.
```

### 12.2 `packages/db/src/legal/privacy.md`

In "## What we keep", after the "**Support and safety reports.**" paragraph (:37), add:

```markdown
**Channel features.** If you use a channel's interactive features, we keep your channel points
balance and its history, your poll votes, your prediction bets and payouts, the links you submit
as song requests, and your interactions with the channel's bot (commands you use that cost
points, and your requests). We process them only to run those features. They are kept as
described under "How long we keep it" and included in your data export (see "Export and
deletion").
```

Both documents already open with the "Draft pending lawyer review" banner; nothing else in them
changes.

### 12.3 `packages/db/src/legal/index.ts` and the seed test

- Add `export const TERMS_SEED_VERSION = "2026-10-29-points-draft";` above `PRIVACY_SEED_VERSION`,
  with its own comment: the terms reached databases at `LEGAL_SEED_VERSION`; the channel points
  clause (ADR 0026) is a new version, so every signed-in user accepts the terms again; draft,
  counsel has not reviewed it. Set `version: TERMS_SEED_VERSION` on the `terms` entry of
  `SEED_META` (:76).
- Bump `PRIVACY_SEED_VERSION` from `"2026-10-27-p2p-draft"` to `"2026-10-29-interact-draft"`
  (sorts after it; signed-in users accept the privacy policy again). The shared comment at :25-30
  covers privacy and cookies: split it so `PRIVACY_SEED_VERSION` says it took its own version for
  the peer-to-peer sections (ADR 0005 amendment 1) and moved again for the channel-features
  paragraph (ADR 0026), and `COOKIES_SEED_VERSION` keeps the peer-to-peer sentence (the N2 step
  rewrites the cookies comment on top).
- `packages/db/tests/seed.int.test.ts`: add `terms: TERMS_SEED_VERSION` to the `own` map
  (:33-37), `expect(TERMS_SEED_VERSION > LEGAL_SEED_VERSION).toBe(true)` beside the privacy and
  cookies checks (:45-46), rename the test to name the terms too, and add
  `expect(body("terms")).toMatch(/no cash value/)` and
  `expect(body("privacy")).toMatch(/poll votes/)`. Fix any other test that pins the terms or
  privacy version (`git grep -n "LEGAL_SEED_VERSION\|PRIVACY_SEED_VERSION" -- packages services harness apps`).
- Record in PROGRESS.md "Legal seed follow-ups": the E8 terms clause and privacy paragraph are
  in, counsel has reviewed neither.

## 13. Docs touched here

- `docs/testing/e8-selectors.md` (§11).
- `docs/testing/e6-selectors.md`: `:80`, `:82`, `:87`, `:207-208`, `:237`: goals and the chat
  overlay are built in E8 (see e8-selectors.md); drop the `overlay-placeholder` id (:207) and its
  `data-kind` values (:208) (E8-viewer removes the component).
- `.claude/briefs/batch3/README.md` "i18n namespaces": `e8-studio`, `e8-viewer` (§10; before
  N2-core starts).
- PROGRESS.md "In flight": batch 3, E8 units and waves.

## 14. Shared-file rules for the milestone (every brief repeats its part)

| Shared thing                                                                                                                                                                                      | Resolution                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `packages/contracts/**`, `packages/db/**` (schema, migrations, `points.ts`, seed, legal), `packages/config/**`, `.env.example`, `infra/**`                                                        | Orchestrator only (E8 step, then E9 step on top). Units file contract requests                      |
| `packages/interact/src/{index,outbox}.ts`, `package.json`                                                                                                                                         | Orchestrator. Units own their own `src/<file>.ts` and tests (§3)                                    |
| `services/api/src/routes/{interact,bot}.ts` (composers), `router.ts`, `http.ts`, `main.ts`, `interact/hooks.ts`, `channels/roles.ts`, `auth/bot-account.ts`, `routes/channels.ts`, `routes/me.ts` | Orchestrator. Units own the split files (§4.1)                                                      |
| `services/api/src/routes/interact/alerts.ts`                                                                                                                                                      | Nobody (E6 code, moved unchanged)                                                                   |
| `services/api/src/overlay/**`, `routes/interact/overlays.ts`, `services/api/tests/overlay{-hub,-alerts,.int}.test.ts`                                                                             | E8-raids-goals (the `goal` SSE event, `state.goals`, the raid alert)                                |
| `services/worker/src/exports/collectors.ts`                                                                                                                                                       | E8-points only (one new account export file for points, votes, bets and song requests)              |
| `services/chat/src/{pipeline,server,core}.ts`, `plugins/index.ts`, `services/irc/**`                                                                                                              | Orchestrator (§5). E8-bot-engine owns `services/chat/src/plugins/bot/**`                            |
| `services/worker/src/jobs/index.ts`, `outbox.ts`, `env.ts`, `deletion/**`                                                                                                                         | Orchestrator (§6, §2.5). Units own their job files and `services/worker/src/interact/<area>/**`     |
| Route tree, nav, `_studio.tsx`, studio i18n keys, `tests/nav.test.ts`                                                                                                                             | Orchestrator (§8). Units fill their placeholder route files only                                    |
| i18n                                                                                                                                                                                              | §10                                                                                                 |
| Harness `scenarios/{interact,channel-bot}.ts`, `src/e8/{steps,kit,selectors}.ts`, `registry.ts`, `shards.ts`, compose overrides, CI                                                               | Orchestrator. Units own their step modules (§9)                                                     |
| `docs/testing/*`, PROGRESS.md, HANDOFF.md, ADRs, READMEs                                                                                                                                          | Orchestrator; units propose text in their final message. Units own their `docs/streamers/*.md` page |
| `apps/web/tests/selectors.test.ts`                                                                                                                                                                | Orchestrator adds the e8 check after E8-studio and E8-viewer merge                                  |

## 15. Waves (E8's part of batch 3)

At most six units at a time across the batch.

| Wave | E8 units                                                       | Beside                                  | Why                                                                                                                                               |
| ---- | -------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | E8-polls, E8-raids-goals, E8-points, E8-bot-engine, E8-bot-api | N2-core (6 in all)                      | API, worker and chat only: no web strings. Disjoint by §4.1, §5, §6. They need only this step (`points.ts`, the package skeleton, the PluginHost) |
| 2    | E8-studio, E8-viewer                                           | up to four E9 units (E9 drafter's call) | Web strings must be written in N2-core's format; both call the wave-1 handlers, so they build against working APIs and own the browser steps 5/6  |

The harness steps of wave-1 units run on the stack only when every unit a step touches has merged
(`channel-bot` steps 1-3 and 5 need E8-bot-api and E8-bot-engine; `interact` step 2 needs
E8-points' adjust): the orchestrator lifts a step from the pending list then.

## 16. Done means for the contract step

CI green on the pushed commit; locally, targeted: `bun --bun vp test run` (and `test:int` where
they exist, one package at a time) in `packages/contracts`, `packages/db`, `packages/config`,
`packages/interact`, `services/api`, `services/chat`, `services/irc`, `services/worker`,
`apps/web`, `harness`; `bunx tsc -p` for each; `vp build` in `apps/web`; `bun
scripts/config-reference.ts --check`. `grep -c
'.handler(notImplemented)'` over `services/api/src/routes/interact/*.ts` and
`services/api/src/routes/bot/*.ts` totals 17 + 15 (polls 4, predictions 6, raids 4, goals 3;
bot 15 with `songRequests.setStatus`). Then record the units under "In flight" in PROGRESS.md and
hand each unit its brief and the sha.

## 17. E8 milestone done means

- No `notImplemented` under `services/api/src/routes/interact/` or `routes/bot/`.
- `interact` and `channel-bot` pass on the harness stack with no pending steps, are in
  `FULL_REQUIRED` with `inFull` true and in the `interact` shard; CI green on main.
- `terms.md` carries the points clause and `privacy.md` the channel-features paragraph (drafts,
  counsel not reviewed), at `TERMS_SEED_VERSION` and the bumped `PRIVACY_SEED_VERSION`.
- The e8 selectors check is in `apps/web/tests/selectors.test.ts`.
