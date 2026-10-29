<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E8-bot-api: channel bot settings, commands, timers, variables and song requests (API)

You are implementing unit E8-bot-api for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/E8-interactivity-bot.md`,
`.claude/briefs/e8/contract-step.md` (all of it; §1.2, §1.3, §1.6, §2, §2.5, §14 especially),
`docs/decisions/0026-interactivity-policies.md` (decision 6), `docs/testing/e8-selectors.md`
("Channel bot") and `.claude/briefs/_done-means.md`. Do not look outside the repository. Work in
your own git worktree on a branch named `e8/bot-api`, created from the commit the orchestrator gives you (after the E8, E9
and N2 contract steps) (run `git merge main` first if main moved). Wave 1, beside E8-bot-engine
(the chat plugin that reads what you write).

## Why

`bot.*` answers 501, so a streamer cannot turn the bot on, give it an account, or manage commands,
timers, variables and the song-request queue. ADR 0026 decides the bot speaks as a per-channel
bot account created the first time the bot is enabled.

## You own (write only these)

- `services/api/src/routes/bot/{settings,commands,timers,variables,song-requests}.ts` (stubs
  from the contract step; `routes/bot/points.ts` is E8-points')
- `services/api/src/bot/**` (new: logic, DTO mapping, the bot-control publisher)
- Tests: `services/api/tests/bot*.test.ts`, `services/api/tests/bot*.int.test.ts`

Read-only, in particular: `packages/contracts/**`, `packages/db/**`, `services/api/src/routes/bot.ts`
(composer), `services/api/src/routes/bot/points.ts`, `services/api/src/auth/bot-account.ts`
(`insertBotAccount`), `services/api/src/channels/roles.ts` (`changeRoleInTx`),
`services/api/src/auth/identity.ts` (`usernameProblem`), `services/api/src/lib/{access,control,orpc}.ts`,
`services/api/src/routes/me.ts`, `services/chat/**`. Anything else is a **contract request** with
the exact diff.

## Contracts you must honor (read-only for you)

- Router `bot` (`router.ts:1512-1676` after the contract step): `settings`/`updateSettings`
  (owner, `channel:manage:bot`; input `{ enabled, config: BotConfig }`, output `BotSettings` with
  `botUser`); `commands.list` (public), `commands.upsert`/`remove` (moderator, `channel:manage:bot`;
  `BotCommand` without `id`/`useCount`); `timers.list|upsert|remove` (moderator); `variables.list|set`
  (moderator; name `^[a-z0-9_]{1,30}$`, value ≤ 500); `songRequests.list` (moderator, optional
  `status`) and `songRequests.setStatus` (`played` | `skipped`) → `SongRequest`.
- `BotConfig` (`shapes.ts`: `loyalty` is now `{ enabled, pointsName }`), `BotCommand`
  (aliases ≤ 5, `costPoints` ≤ 1,000,000), `BotTimer` (`minChatLines` 1-1000),
  `BOT_BUILTIN_COMMANDS`, `BOT_CONTROL_SCOPES`, `BUS.botControl` + `BotControlMessage`
  (`packages/contracts/src/chat.ts`).
- Tables: `bot_configs` (`enabled` default false, unique `botUserId`), `bot_commands`
  (`bot_commands_name_uq`), `bot_timers`, `bot_variables`, `song_requests` (`url`),
  `users` (`accountType = "bot"`, `botOwnerId`), `channel_roles`.

## What is there today (verified at `c0c16fd`; recheck against your base)

- `me.bots.create` (`services/api/src/routes/me.ts:341-374`) creates bot users; the contract step
  moved its insert into `insertBotAccount(tx, { ownerId, username, displayName })`. Bot emails are
  `bot+<id>@bots.invalid`; bots never sign in with a session (`lib/access.ts:75-77`). The
  contract step also makes `me.bots.createToken` refuse the channel bot (`PRECONDITION_FAILED`
  `channel_bot`; decided 2026-10-29): the bot you create speaks only through the bot engine, and
  no token can be minted for it.
- `changeRole` (`routes/channels.ts:303-…`) is now a thin wrapper over
  `changeRoleInTx(tx, { channel, target, role, op, actorId })` (role row, mod action, audit,
  `channel.moderator.add`); publish the `invalidate` control (`lib/control.ts`) after commit as
  `changeRole` does.
- `commands.list` is `base` (public): the middleware resolves no channel role for it; use
  `channelAuthority` (`lib/access.ts:108-117`) to decide whether to include disabled commands.

## Build

1. **Settings.** `settings`: the row or defaults (`enabled: false`, `BotConfig.parse({})`,
   `botUser: null`). `updateSettings`, one transaction: upsert `bot_configs`; the first time
   `enabled` is true and `botUserId` is null, create the bot account with `insertBotAccount`
   (owner = the channel owner, display name = `config.displayName`, username `<slug>_bot` cut to
   fit 25 characters; if taken or reserved, `<slug-prefix>_bot<3 digits>`, at most 5 tries; if the
   slug itself is refused by `usernameProblem` as reserved (e.g. a `mod_` prefix makes every
   derived name reserved), fall back to `channelbot_<6 hex>`; `CONFLICT` only when that is taken
   too), set `botUserId`, and make it a channel moderator with `changeRoleInTx` (ADR 0026: it
   speaks as itself; moderator so chat gates and filter timeouts work). Do not check
   `MAX_BOTS_PER_OWNER`: the contract step makes `me.bots.create`'s count skip channel bots, and
   account deletion pseudonymizes the channel bot with its owner (its username carries the old
   slug). Later `displayName` changes update the bot user's name
   (and publish `BUS.userControl` `invalidate` `profile_changed`). Disabling keeps the account and
   role. Audit `bot.settings.update` (`details: { enabled, botCreated }`). After commit:
   `BotControlMessage { channelId, scope: "config" }` on `BUS.botControl` and the role
   `invalidate` when the role was added.
2. **Commands.** `list`: everyone sees enabled commands; the owner, editors and moderators see all.
   `upsert` by `(channel, name)`: refuse built-in names and aliases (`BAD_REQUEST`), a name or alias
   that is another command's name or alias (`CONFLICT`), more than 200 commands per channel
   (`PRECONDITION_FAILED` `bot_command_limit`); keep `useCount` on update. `remove`:
   `NOT_FOUND` when absent. Audit `bot.command.upsert` / `bot.command.remove` (ids only: command
   text is streamer content and stays out of audit details). Publish scope `commands`.
3. **Timers.** `list`, `upsert` (no `id` → create, at most 20 per channel; with `id` → update a
   timer of this channel or `NOT_FOUND`), `remove`; audit `bot.timer.*`; scope `timers`.
4. **Variables.** `list`, `set` (upsert; empty value allowed; at most 100 per channel); audit
   `bot.variable.set`; scope `variables`.
5. **Song requests.** `list` (default `queued`, oldest first, at most 200, requester username);
   `setStatus` only from `queued` (`CONFLICT` otherwise), audit `bot.song_request.status`. URLs are
   returned as stored and never fetched.
6. Publish bot-control messages only after commit; a publish failure is logged, not fatal (the
   engine's 60 s TTL catches up). Keep handlers thin; logic in `services/api/src/bot/**`.

## Tests you must add

- Integration (`createTestDatabase()` and Valkey): first enable creates exactly one bot account
  with `accountType` bot, `botOwnerId` = owner, a moderator role and the audit/event rows; a second
  enable reuses it; a taken username falls back; disable keeps it; a viewer and an app token
  without `channel:manage:bot` are refused; command name/alias collisions and built-ins refused;
  limits; `useCount` survives an update; timers of another channel are `NOT_FOUND`; `minChatLines`
  0 refused by the contract; song request status transitions; every write publishes one
  `BotControlMessage` with the right scope (subscribe in the test).
- Unit: username derivation (long slugs, digits suffix), list visibility.

## Done means

Follow `.claude/briefs/_done-means.md`. CI on main is the gate: run only targeted checks
(`bun --bun vp test run` and `bun run test:int` in `services/api`; `bunx tsc -p services/api`;
`vp lint --deny-warnings` and `vp fmt` on your paths). Never run `bun run verify`, `verify:full`, a
harness scenario against a stack, `podman compose` or `scripts/infra.ts`. `git status` shows only
your paths. Commit in your worktree (`git commit -s`, Conventional Commits, ending with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Final message: what you built, test
counts, branch and sha, contract requests (exact diffs), proposed README/PROGRESS text, anything
left undone, and the commands the user runs live (`channel-bot` steps 1, 3, 5 once E8-bot-engine
has merged too).
