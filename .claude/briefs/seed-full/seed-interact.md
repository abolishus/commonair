<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# seed-interact: bot, points, polls, predictions, raids, goals, alerts and overlays

You are implementing unit seed-interact for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, PLAN.md, docs/architecture.md, `.claude/briefs/seed-full/README.md` and
`.claude/briefs/seed-full/common.md` first. The shared rules, the read-only contract and the tests
every unit adds are in common.md and apply in full. Do not look outside the repository. Your branch
is `seed/interact`, from `main` after seed-social merges. You are in wave 1, alongside money, coop,
safety, platform and media.

## You own (write only these)

- `harness/src/seed/interact.ts`, `harness/src/seed/interact/**`
- `harness/tests/seed/interact*.test.ts`

## Contracts you must honor (read-only for you)

- `ctx.store.users` / `channels` from seed-social. Bot account: `store.extra.social.botUserId`.
- The interact procedures in `@commonair/contracts` (bot, loyalty, polls, predictions, raids,
  goals, alerts, overlays) and `services/api/src/routes/interact.ts` + `interact/**`. Read these to learn what is
  validated and what needs a live channel.
- Points: `services/worker/src/interact/points/accrue.ts`, `services/worker/src/jobs/points-accrue.ts`
  and `INTERACT_TEST_HOOKS` in `packages/config/src/env.ts`. The worker accrues for demo users only
  when `DEMO_SEED_FULL=true` is set on the worker.
- `harness/src/bots/**` and the e8 harness modules show the existing call patterns.

## Build

1. **Bot.** streamer1 gets a full setup: `bot_configs`, a dozen `bot_commands` (counters, variables,
   cooldowns, mod-only), `bot_timers` and `bot_variables`. streamer2 gets a minimal one. Write plain
   tables directly, or through the API where the API does the work (for example by computing
   derived fields).
2. **Points (protected).** Balances and transactions must come from the worker accrual and the API
   (redemptions, refunds, manual grants by the streamer if the API offers them). Never insert
   `loyalty_*` rows that the worker would write itself. `loyalty_accrual_sessions` is a plain table,
   so if accrual reads its candidates from it, insert sessions spread across viewers and channels
   and then wait for the worker (or trigger it through `INTERACT_TEST_HOOKS`) until the balances
   appear. Give viewer1 a large balance and some redemptions, and give many bulk viewers small
   balances. Check that the worker has `DEMO_SEED_FULL=true` and fail fast if accrual stays at zero.
   Name the flag in the error message.
3. **Song requests.** streamer1 gets queued, played and rejected requests.
4. **Polls and predictions.**
   - Polls: some open, some closed, and some with no votes. `poll_votes` come from bulk viewers.
   - Predictions: one open, one locked, one resolved (points paid out), and one cancelled (points
     refunded), all through the API so that bets move points.
   - If these need a live broadcast, add `media` to `after` and send seed-media a cross-unit request
     for a key such as `store.extra.media.liveWindow` (whatever the API needs). Otherwise run them
     standalone.
5. **Raids.** Use the API where it can (streamer2 receives raids from bulk streamers and streamer1
   sends one). Use direct inserts for the backdated history.
6. **Goals and alerts.** Every goal type, some complete and some in progress. Give streamer1 an
   `alert_configs` row for each alert type.
7. **Overlays.** Mint overlay tokens for streamer1 through the API and keep the raw token values.
   Publish `store.extra.interact.overlayChatQuery`, `overlayAlertsQuery` and `overlayGoalsQuery`.
   Each is the exact query string (without `?`) that `/overlay/chat|alerts|goals` expects, which you
   can find in `apps/web/src/routes/overlay.*.tsx`.

## Tests you must add

- The tests in common.md.
- Prediction states cover open, locked, resolved and cancelled. Poll states are all present.
- The overlay queries parse with the web route's search schema, if that schema is importable from
  `packages/**`. If it isn't, assert the key names.
- The bot command set includes every command type the contract defines.

## Routes you fill

`/interact`, `/bot`, `/overlays`, `/overlay/chat`, `/overlay/alerts` and `/overlay/goals`. You also
fill viewer1's points wherever they are shown.

## Done means

See "Done means" in common.md. In your report, list how long accrual took at `small`.
