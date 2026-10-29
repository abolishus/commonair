<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E8-points: channel points accrual, balance, leaderboard and moderator adjust

You are implementing unit E8-points for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, PLAN.md and docs/architecture.md first, then `.claude/briefs/next/E8-interactivity-bot.md`,
`.claude/briefs/e8/contract-step.md` (all of it; §1.2, §2, §2.5, §14 especially),
`docs/decisions/0026-interactivity-policies.md` (decisions 1 and 2),
`docs/decisions/0015-verified-watch-signal.md`, `docs/testing/e8-selectors.md` ("Channel bot"
points rows, scenario `channel-bot` step 4) and `.claude/briefs/_done-means.md`. Do not look
outside the repository. Work in your own git worktree on a branch named `e8/points`, created from
the commit the orchestrator gives you (after the E8, E9 and N2 contract steps) (run `git merge main` first if main
moved). Wave 1: you write no web strings.

## Why

Predictions, point-bought poll votes and bot commands spend channel points, but nothing earns
them and `bot.points.*` answers 501. ADR 0026 decides points accrue only for gate-eligible
(verified, fetch-judged) watch time, so a viewbot swarm earns nothing, and that points are a
ledger enforced by the database.

## You own (write only these)

- `services/api/src/routes/bot/points.ts` (stubs from the contract step: `balance`,
  `leaderboard`, `adjust`) and `services/api/src/points/**` (new)
- `packages/interact/src/accrual.ts` and `packages/interact/tests/accrual*.test.ts`
- `services/worker/src/jobs/points-accrue.ts` (stub) and `services/worker/src/interact/points/**`
- `services/worker/src/exports/collectors.ts`: only one new account `ExportFile` (`interact.json`,
  an object) with sections for the user's `loyalty_balances` (channel slug, points),
  `loyalty_transactions` (id, channel slug, delta, reason, time), and the other E8 personal data
  nobody else exports: their `poll_votes` (channel slug, poll id, choice id, votes, points spent,
  time), `prediction_bets` (channel slug, prediction id, outcome id, points, payout, time) and
  `song_requests` (channel slug, url, status, time). Explicit `fields`, filtered by the
  requester's id, as the file's header requires; its cases in
  `services/worker/tests/export-collectors.test.ts`. Propose the `docs/testing/e6-selectors.md`
  "Data export" row (orchestrator-owned) in your final message.
- Tests: `services/api/tests/points*.test.ts`, `services/worker/tests/points-accrue*.test.ts`
- Harness: `harness/src/e8/points.ts` (`stepViewbots`), `harness/tests/e8/points.test.ts`
- Docs: `docs/streamers/channel-points.md` (new: how points are earned, the cap, no cash value,
  that a viewer behind an unjudged CDN path earns nothing yet)

Read-only, in particular: `packages/contracts/**`, `packages/db/**` (`postPointsInTx`,
`pointsBalance`, `InsufficientPointsError`; the 0034 trigger writes `loyalty_balances`, you never
do), `packages/integrity/**` (`GATE_ELIGIBLE`; `thresholds.ts:29-60` is the pattern for reading a
governance setting outside the API), `packages/interact/src/{index,outbox}.ts`,
`services/api/src/routes/bot.ts` and the other `routes/bot/*.ts`, `services/api/src/lib/settings.ts`
(API-only: the worker cannot import it), `harness/src/e8/{steps,kit,selectors}.ts`, `harness/src/viewbot.ts`,
`harness/src/integrity-viewers.ts`, `harness/scenarios/channel-bot.ts`. Anything else is a
**contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- Router `bot.points` (`router.ts:1640-1675` after the contract step): `balance({ channel,
  username })` and `leaderboard({ channel, limit 1-100 })` public → `LoyaltyBalance`
  (`channelSlug`, `user { id, username }`, `points`, `pointsName`, `enabled`: the channel's points
  are on; E8-viewer hides its chip when false); `adjust({ channel, username,
  delta ±1,000,000, reason: POINTS_ADJUST_REASONS })` moderator, `channel:manage:points`.
- `PointsAccrualSetting` (`shapes.ts`) and the governance key `interact.points.accrual`
  (default 10 points per 5 minutes, 1,000 per UTC day per viewer per channel; the harness stack
  uses `blockMinutes: 1`); database range check in 0034.
- `BotConfig.loyalty` = `{ enabled, pointsName }` (defaults when the channel has no `bot_configs`
  row). Off: no accrual in that channel.
- Tables: `loyalty_transactions` (append-only; `reason` `watch` > 0, `moderator_adjust` ≠ 0),
  `loyalty_balances` (trigger-written, `CHECK points >= 0`, leaderboard index),
  `loyalty_accruals` (per viewer and channel: `carrySeconds`, `day`, `dayPoints`),
  `loyalty_accrual_sessions` (per session `countedSeconds`), `playback_sessions`
  (`playback_sessions_points_idx` on `scored_at` for signed-in verified rows).
- Event `channel.points.change` for the adjust (never for `watch`: "not by passive accrual").
- `INTERACT_JOBS.pointsAccrue` (every 60 s, `QUEUES.interact`), the test hook.

## What is there today (verified at `c0c16fd`; recheck against your base)

- `GATE_ELIGIBLE` (`packages/integrity/src/jobs.ts:35-49`): verified, scored at least once, no
  `fetch_unjudged`. The scorer re-scores live sessions each pass (`scored_at` moves forward) and
  stops after they end; `watch_seconds` grows with heartbeats.
- Stream-hour eligibility is the model for "signed-in verified watch" queries
  (`markEligibleStreamHours` in `packages/integrity/src/jobs.ts`; the harness mirror is in
  `harness/scenarios/integrity-basic.ts:114-145`).
- `audit()` (`services/api/src/events/audit.ts:40-52`) returns nothing; it refuses unsafe details.

## Build

1. **Accrual math (`packages/interact/src/accrual.ts`, pure).** Given the setting, a viewer's
   state (`carrySeconds`, `day`, `dayPoints`), the new eligible seconds and `now`: reset
   `dayPoints` when the UTC day changed (keep the carry), add the seconds, credit whole blocks up
   to the cap, keep the remainder (at the cap the remainder is still kept, the blocks over the cap
   are dropped). Exhaustive tests: block boundary, exactly at the cap, over the cap, day rollover
   with carry, cap 0, one-minute blocks.
2. **`points-accrue` job.** Read the setting each run with a `readPointsAccrual(db)` you add to
   `packages/interact/src/accrual.ts` (a direct `governance_settings` select as
   `packages/integrity/src/thresholds.ts` does; `PointsAccrualSetting.safeParse`, defaults plus an
   error log if invalid; cap 0 → return at once). Candidates: `playback_sessions ps` with
   `user_id` not null, `scored_at >= now - 6 h` (the partial index), `GATE_ELIGIBLE`,
   `watch_seconds > coalesce(counted_seconds, 0)` from `loyalty_accrual_sessions`; skip the
   channel's own owner, bot accounts, platform-suspended users and channels whose
   `config->'loyalty'->>'enabled'` is `false`. **Skip demo data** (decided 2026-10-29): a channel
   whose owner is a demo user, and a demo viewer on any channel, earn nothing. A demo user is one
   that carries both fixture anchors: use `anchoredUser()` (exported from `@commonair/db` by the
   contract step; the same rule `demo:clear` uses, `packages/db/src/demo/anchors.ts`) in a
   `not exists` over `users` for the channel owner and for the viewer. Why: points ledger rows are
   append-only and `restrict`, so one `watch` row on a demo channel or for a demo viewer would make
   `bun run --filter @commonair/db demo:clear` fail as a whole (e8/contract-step.md §2.3 point 4). Group by (channel, viewer). **Concurrent sessions of
   one viewer on one channel count once:** credit at most the wall-clock seconds since that
   viewer's previous run for the channel (`loyalty_accruals.updated_at`; first run: the largest
   single session's new seconds). Per (channel, viewer), one transaction: lock or create the
   `loyalty_accruals` row, apply the math, one `postPointsInTx` with reason `watch` and `refId`
   null when points > 0 (no event), and set every contributing session's `countedSeconds` to its
   `watch_seconds` (the high-water mark that makes the job idempotent). No clawback: points stay
   when a verdict later changes (ADR 0026). Return `{ viewers, points }`. Batch the candidate
   query; bound a run's work (e.g. 5,000 viewers) and log when it stops early.
3. **API.** `balance`: unknown channel or user → `NOT_FOUND`; no row → 0; `pointsName` and `enabled` from the
   channel's bot config (defaults `points`, `true`). `leaderboard`: by points desc, then user id; skip
   pseudonymized (deleted) accounts. `adjust`: `delta` 0 → `BAD_REQUEST`; target must exist and
   not be a bot; one transaction: `postPointsInTx` reason `moderator_adjust`, audit
   `points.adjust` (`details: { transactionId, delta, reason }`, reason the enum code), and
   `channel.points.change` (`pointsChangePayload`); `InsufficientPointsError` →
   `PRECONDITION_FAILED` `insufficient_points` (ADR 0026: map the database refusal, never a 500).
   Keep handlers thin; logic in `services/api/src/points/**`.
4. **Data export.** The account export lists the user's balances and transactions per channel.
5. **Harness `stepViewbots(run)`.** As e8-selectors.md `channel-bot` step 4: one signed-in viewer
   watches the live streamer through the normal player path until its session is scored
   verified (use the helpers `integrity-basic` uses), while a viewbot swarm (`harness/src/viewbot.ts`)
   watches too. **The swarm must be signed in**, or the step proves nothing (anonymous sessions
   earn nothing by rule): `ViewbotSwarm` calls its `ApiFactory` once per plan (`viewbot.ts:72`,
   `:89-91`) and the factory is synchronous, so sign up one account per session first
   (`harness/src/users.ts` `UserFactory`) and have the factory hand out the next account's
   signed-in client with the plan's address and user agent; `viewbot.ts` itself is read-only for
   you; after three minutes and `run.hooks.tick("points-accrue")`
   the viewer's balance is a positive multiple of 10 and no swarm account has a balance (also check
   `loyalty_transactions` for them is empty).

## Tests you must add

- Unit: the accrual math above.
- Worker integration (`createTestDatabase()`): a verified scored session earns; pending,
  excluded, `fetch_unjudged`, anonymous, owner-on-own-channel and points-off channels earn
  nothing; a demo channel (its owner has both anchors: a `demo_` username and an
  `@demo-seed.invalid` email, `DEMO_FIXTURES` in `@commonair/contracts/fixtures`) earns its viewers
  nothing and writes no `loyalty_transactions` row, a demo viewer earns nothing on a real channel,
  and a user with only one anchor still earns; two concurrent sessions earn as one; a second run without new watch time credits
  nothing; the daily cap and rollover; no `channel.points.change` row for `watch`; a verdict that
  turns excluded after a credit keeps the points.
- API integration: balance 0 for a stranger; leaderboard order and limit; adjust credit and debit,
  overdraw → `insufficient_points` with nothing written, audit details carry no free text, event
  payload validates, viewer without the role → `FORBIDDEN`, app token without
  `channel:manage:points` refused.
- Export: the new file's output for a user with transactions, votes, bets and song requests in
  two channels, and nothing of another user's.

## Done means

Follow `.claude/briefs/_done-means.md`. CI on main is the gate: run only targeted checks
(`bun --bun vp test run` and `bun run test:int` in `packages/interact`, `services/api`,
`services/worker`, one package's `test:int` at a time; `bunx tsc -p` for each; `vp lint
--deny-warnings` and `vp fmt` on your paths; `bun --bun vp test run` in `harness`). Never run
`bun run verify`, `verify:full`, a harness scenario against a stack, `podman compose` or
`scripts/infra.ts`. `git status` shows only your paths. Commit in your worktree (`git commit -s`,
Conventional Commits, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
Final message: what you built, test counts per package, branch and sha, contract requests (exact
diffs), proposed README/PROGRESS text, anything left undone, and the commands the user runs live:
`bun harness/src/cli.ts run channel-bot --set steps=4` on the harness stack.
