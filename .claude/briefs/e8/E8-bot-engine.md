<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E8-bot-engine: the built-in channel bot in the chat service

You are implementing unit E8-bot-engine for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, PLAN.md and docs/architecture.md first, then `.claude/briefs/next/E8-interactivity-bot.md`,
`.claude/briefs/e8/contract-step.md` (all of it; §1.5, §1.6, §5, §14 especially),
`docs/decisions/0026-interactivity-policies.md` (decisions 2 and 6), `services/chat/README.md` if
present, `docs/testing/e8-selectors.md` (scenario `channel-bot` steps 1, 2, 3, 5) and
`.claude/briefs/_done-means.md`. Do not look outside the repository. Work in your own git worktree
on a branch named `e8/bot-engine`, created from the commit the orchestrator gives you (after the E8, E9 and N2
contract steps) (run `git merge main` first if main moved). Wave 1, beside E8-bot-api (the CRUD routes that
write what you read).

## Why

The chat service has a middleware extension point and a `say` that skips middlewares, but
`services/chat/src/plugins/` holds only a no-op. Streamers need commands with cooldowns, user
levels and point costs, timers that only talk when chat is active, `!points`, a link-only song
request queue and simple spam, caps and link filters (`BotConfig.filters`).

## You own (write only these)

- `services/chat/src/plugins/bot/**` (the contract step created `index.ts` exporting
  `botMiddleware`; keep that export name)
- Tests: `services/chat/tests/bot*.test.ts`, `services/chat/tests/bot*.int.test.ts`
- Harness: `harness/src/e8/bot.ts` (`stepCommands`, `stepPointsCost`, `stepTimer`,
  `stepSongRequests`), `harness/tests/e8/bot.test.ts`
- Docs: `docs/streamers/channel-bot.md` (new: template variables and built-ins, user levels,
  cooldowns, costs, timers, `!sr`, filters, what the bot never does)

Read-only, in particular: `services/chat/src/{pipeline,server,core,rules,content,types,rooms}.ts`,
`services/chat/src/plugins/index.ts`, `packages/contracts/**`, `packages/db/**` (`postPointsInTx`,
`pointsBalance`, `InsufficientPointsError`), `packages/interact/src/{index,outbox}.ts`
(`emitEvent`, `pointsChangePayload`), every `services/api/**` file, `harness/src/e8/{steps,kit,selectors}.ts`,
`harness/scenarios/channel-bot.ts`. Anything else is a **contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- `PluginHost` after the contract step (`services/chat/src/pipeline.ts:56-…`): `say`, `command`,
  `db`, `valkey` (key prefix applied), `subscribe(channel, handler)`, `hostedChannels()`.
  `MessageMiddleware`: `process` (before acceptance: may drop or transform), `onMessage`
  (accepted, non-held messages), `init`, `close`.
- `BUS.botControl` with `BotControlMessage { channelId, scope: BOT_CONTROL_SCOPES }`: E8-bot-api
  publishes one after every commit that changes config, commands, timers or variables.
- `KEYS.botLines`, `KEYS.botTimerMark`, `KEYS.botTimerLock`, `KEYS.botCooldown` (`internal.ts`).
- `BotConfig` (`shapes.ts:146-…` after the contract step: `displayName`, `filters { spam, links,
  caps, timeoutSeconds }`, `loyalty { enabled, pointsName }`, `songRequests { enabled, maxQueue }`),
  `BotCommand`, `BotTimer` (`minChatLines ≥ 1`), `USER_LEVELS`, `BOT_BUILTIN_COMMANDS`
  (`points`, `sr`, `commands`), `NOTICE_CODES` (`msg_links_blocked`, `msg_rejected`).
- Tables: `bot_configs` (`enabled`, `config`, `botUserId`), `bot_commands` (`useCount`),
  `bot_timers` (`lastFiredAt`), `bot_variables`, `song_requests` (`url`, `status`),
  `loyalty_transactions` via `postPointsInTx` (reason `command`, `refId` = command id).
- Event `channel.points.change` for a command spend, in the spend's transaction.
- ADR 0026 decision 6: templates are substitution only; unknown variables render literally; no
  expressions, no conditionals, no fetching URLs; the bot speaks as the channel's bot account; song
  requests are a link queue (never fetched, no titles, no playback).

## What is there today (verified at `c0c16fd`; recheck against your base)

- `say` submits with `skipMiddleware: true` (`services/chat/src/server.ts:526-541`), but
  **`ChatCore.submit` runs every middleware's `onMessage` for every accepted message, `say`'s
  included (`services/chat/src/core.ts:156`)**: ignore the channel bot's own messages in
  `onMessage`, or a response starting with `!` loops.
- `onMessage` runs once per accepted message, on the instance that accepted it; several chat
  instances host the same room, so anything counted across them lives in Valkey.
- `checkGates` (`services/chat/src/rules.ts:40-…`) exempts bots only from the email gate; E8-bot-api
  makes the channel bot a channel moderator when it is first enabled, so it passes followers-only,
  subscribers-only, account-age and slow mode, and `host.command(… "timeout" …)` works for it.
- `Standing` (`services/chat/src/types.ts:62-71`): `isBroadcaster`, `isModerator`, `isVip`,
  `followedAt`, `subscriberTier`. `containsLink` is `services/chat/src/content.ts:15`.

## Build

1. **Per-channel state.** Lazily load and cache per channel id: the `bot_configs` row (missing or
   `enabled = false` or no `botUserId` → the bot does nothing in that channel), enabled commands
   by name and alias, timers, variables. Subscribe to `BUS.botControl` in `init` and drop the
   named scope for that channel; keep a 60 s TTL as a backstop. Bounded cache (evict channels no
   longer hosted).
2. **Filters in `process`** (bot enabled; never for the broadcaster, moderators, VIPs or the bot
   itself): spam (a run of more than `maxRepeatedChars` identical characters), caps (length ≥
   `minLength` and uppercase share of letters > `maxRatio`), links (`containsLink`, unless the
   host is in `allowlist` (exact or subdomain) or `allowSubscribers` and the sender subscribes).
   Drop with `msg_rejected` (spam, caps) or `msg_links_blocked` (links) and an English text; when
   `timeoutSeconds > 0`, time the sender out as the bot (`host.command`, `timeout <user>
   <seconds>`), fire-and-forget with errors logged. Pure, bounded checks (no regex built from
   user input).
3. **Commands in `onMessage`.** `INCR KEYS.botLines(channelId)` for every accepted message that is
   not the bot's. A body `!name args…` resolves a built-in, then a command name, then an alias.
   Order: user level (`everyone < follower < subscriber < vip < moderator < broadcaster` by
   `USER_LEVELS`; insufficient → silent), cooldown (`SET NX EX` on `KEYS.botCooldown`; the
   broadcaster and moderators bypass it; in cooldown → silent), cost (`costPoints > 0` needs
   `loyalty.enabled`: one transaction `postPointsInTx(-cost, "command", refId = command id)` +
   `channel.points.change` + `useCount + 1`; `InsufficientPointsError` → the bot says the user
   lacks points and the cooldown slot is released), then respond. A free command increments
   `useCount` in its own statement (`update … returning use_count` gives `${count}`).
4. **Templates.** Variables: `${user}` (display name), `${touser}` (first argument without `@`,
   else the user), `${count}`, `${var:name}` (`bot_variables`), `${channel}`, `${uptime}` (since the
   live broadcast started; "offline" otherwise), `${points}` and `${pointsName}` (the caller's
   balance). Unknown variables render literally; substituted values are never expanded again; the
   result is cut to `CHAT_LIMITS.maxBodyLength`. A pure function with exhaustive tests.
5. **Built-ins.** `!points` → the caller's balance (silent when points are off). `!sr <url>` (song
   requests on): accept only `http:`/`https:` URLs that parse, ≤ 500 characters, no credentials,
   a host with a dot; queue full (`maxQueue` queued) or the requester already has 3 queued → the
   bot says so; insert `song_requests` (`queued`), reply with the queue position. Never fetch the
   URL. `!commands` → the enabled commands the caller's level can use, cut to one message.
6. **Timers.** Every 15 s (interval set in `init`, cleared in `close`), for each hosted channel
   whose bot is on and which is live: a timer is due when `intervalMinutes` passed since
   `lastFiredAt` and `botLines - botTimerMark ≥ minChatLines` (no mark yet → set it to the current
   line count and wait). Claim it across instances with a conditional
   `update bot_timers set last_fired_at = now where id = $1 and (last_fired_at is null or
   last_fired_at <= now - interval) returning id` (no row → another instance fired it), then `say`
   the rendered message and set the mark. `KEYS.botTimerLock` (`SET NX PX 10000`) guards the
   render-and-say so a slow instance cannot double-post.
7. **Speaking.** Every reply is `host.say({ channel: slug, userId: botUserId, body })`; a notice
   back (e.g. the bot was banned) is logged once per channel, never retried in a loop.
8. **Harness.** `stepCommands`, `stepPointsCost`, `stepTimer`, `stepSongRequests` exactly as
   e8-selectors.md `channel-bot` steps 1, 2, 3, 5, configuring through the API (`bot.updateSettings`,
   `bot.commands.upsert`, `bot.timers.upsert`, `bot.songRequests.list|setStatus`: E8-bot-api's
   handlers; `bot.points.adjust`: E8-points') and observing chat with
   `harness/src/chat-client.ts`. The orchestrator lifts these steps from the pending list once you,
   E8-bot-api and (step 2) E8-points have merged.

## Tests you must add

- Unit: templates (every variable, unknown, nested-looking input such as `${var:${user}}`, length
  cut), level ordering, filters (boundaries of `maxRepeatedChars`, `minLength`, `maxRatio`,
  allowlist subdomains, subscriber exemption), URL acceptance, `!name` parsing with aliases.
- Integration (real Postgres and Valkey, `startChatService` as the existing chat int tests do):
  a command answers once from the bot account; the bot's own `!`-response does not trigger it
  again; cooldown across two chat instances; a cost command debits once and emits the event;
  overdraw → reply, nothing debited, cooldown released; `BotControlMessage` makes a new command
  answer without restart; a timer fires once across two instances and not below `minChatLines`;
  `!sr` queues a link and refuses a non-link; a filter drop with a timeout.

## Done means

Follow `.claude/briefs/_done-means.md`. CI on main is the gate: run only targeted checks
(`bun --bun vp test run` and `bun run test:int` in `services/chat`; `bunx tsc -p services/chat`;
`vp lint --deny-warnings` and `vp fmt` on your paths; `bun --bun vp test run` in `harness`).
Never run `bun run verify`, `verify:full`, a harness scenario against a stack, `podman compose` or
`scripts/infra.ts`. `git status` shows only your paths. Commit in your worktree (`git commit -s`,
Conventional Commits, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
Final message: what you built, test counts, branch and sha, contract requests (exact diffs),
proposed README/PROGRESS text, anything left undone, and the commands the user runs live:
`bun harness/src/cli.ts run channel-bot --set steps=1,2,3,5` on the harness stack.
