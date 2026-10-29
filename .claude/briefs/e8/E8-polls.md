<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E8-polls: polls and predictions

You are implementing unit E8-polls for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/E8-interactivity-bot.md`,
`.claude/briefs/e8/contract-step.md` (all of it; §1, §2, §3, §14 especially),
`docs/decisions/0026-interactivity-policies.md` (decisions 2 and 3), `docs/testing/e8-selectors.md`
("Polls", "Predictions", scenario `interact` steps 1-2) and `.claude/briefs/_done-means.md`. Do
not look outside the repository. Work in your own git worktree on a branch named `e8/polls`,
created from the commit the orchestrator gives you (after the E8, E9 and N2 contract steps) (run `git merge main` first if
main moved). Wave 1: you write no web strings.

## Why

`interact.polls.*` and `interact.predictions.*` answer 501. Streamers expect Twitch-style polls
and channel-point predictions, chat already relays `channel.poll.*`/`channel.prediction.*` frames
(`services/chat/src/events.ts:36-37`) and E9 delivers them to apps, but nothing emits them.

## You own (write only these)

- `services/api/src/routes/interact/polls.ts`, `services/api/src/routes/interact/predictions.ts`
  (the contract step created them with stubs)
- `services/api/src/interact/polls/**`, `services/api/src/interact/predictions/**` (new: handlers'
  logic, DTO mapping)
- `packages/interact/src/polls.ts`, `packages/interact/src/predictions.ts` and
  `packages/interact/tests/{polls,predictions}*.test.ts` (shared with the worker: end, lock,
  views, payload builders, payout)
- `services/worker/src/jobs/interact-tick.ts` (stub from the contract step) and
  `services/worker/src/interact/polls/**` (new)
- Tests: `services/api/tests/interact-polls*.test.ts`, `services/api/tests/interact-predictions*.test.ts`,
  `services/worker/tests/interact-tick*.test.ts`
- Harness: `harness/src/e8/polls.ts` (`stepPoll`), `harness/src/e8/predictions.ts`
  (`stepPrediction`), `harness/tests/e8/polls.test.ts` for pure helpers
- Docs: `docs/streamers/polls-predictions.md` (new; what streamers and viewers can do, the
  no-cash-value rule, payout rounding)

Read-only, in particular: `packages/contracts/**`, `packages/db/**` (use `postPointsInTx`,
`InsufficientPointsError`, `pointsBalance` from `@commonair/db`; never write `loyalty_balances`),
`packages/interact/src/{index,outbox}.ts` (use `emitEvent`, `broadcasterFields`, `userFields`,
`pointsChangePayload`), `services/api/src/routes/interact.ts`, every other
`routes/interact/*.ts`, `services/api/src/moderation/chat-bans.ts` (`isActiveBan`),
`harness/src/e8/{steps,kit,selectors}.ts`, `harness/scenarios/interact.ts`. Anything else is a
**contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- Router `interact.polls` (`packages/contracts/src/api/router.ts:1679-1732`): `current` (public;
  the caller's `myVote`/`myVotes` when signed in), `create` (moderator, `channel:manage:polls`;
  title ≤ 60, 2-5 choices ≤ 25, `durationSeconds` 15-1800, `pointsPerExtraVote` 0-1,000,000),
  `vote` (user, `write` bucket; `choiceId`, `extraVotes` 0-100), `end` (`terminated` | `archived`).
- Router `interact.predictions` (:1733-1799): `current`, `create` (title ≤ 45, 2-10 outcomes,
  `windowSeconds` 30-1800), `bet` (user, `write`; `points` 1-250,000), `lock`, `resolve`
  (`winningOutcomeId`), `cancel`.
- Entities `PollView`, `PredictionView` as changed by the contract step (§1.3): `endedAt`,
  `myVotes`, `lockedAt`, `myBet.payout`.
- Enums: `POLL_STATUSES`, `PREDICTION_STATUSES`, `POLL_RULES.maxExtraVotesPerUser`, `LOYALTY_REASONS`.
- Events (§1.4 final payloads): `channel.poll.begin|progress|end`,
  `channel.prediction.begin|progress|lock|end`, `channel.points.change`. Write each through
  `emitEvent` in the transaction that made the change; `progress` only from `interact-tick`.
- Tables: `polls`, `poll_votes`, `predictions`, `prediction_bets` (`packages/db/src/schema/interactive.ts`
  after 0033: `changedAt`, `progressAt`, `lockedAt`; `polls_channel_active_uq` (one active poll),
  `predictions_channel_open_uq` (one active-or-locked prediction), the due indexes); points via
  `loyalty_transactions` (reasons `poll_vote`, `prediction_bet`, `prediction_payout`,
  `prediction_refund`; sign checked by the database) and the 0034 trigger.
- `INTERACT_JOBS.tick` (every 2 s, `QUEUES.interact`), the test hook `POST /internal/interact/tick`.
- `docs/testing/e8-selectors.md` scenario lines for `interact` steps 1 and 2.

## What is there today (verified at `c0c16fd`; recheck against your base)

- All ten handlers are `notImplemented` (moved by the contract step into your two route files).
- `predictions` has `resolvedAt` (no `endedAt`): set it on resolve **and** cancel, and map it to
  `PredictionView.endedAt` and the `end` event's `ended_at`. `predictions.outcomes` (jsonb
  `PredictionOutcome[]`, `points`/`users`) is a cache: refresh it from `prediction_bets` under the
  row lock, never increment it outside one.
- Precondition codes (`insufficient_points`, `points_disabled`) go through `precondition(code)`
  (`services/api/src/lib/errors.ts:30`): the web reads them from `error.data.requirement`.
- `polls.choices` is `jsonb` of `PollChoice` (`id`, `title`, `votes`); `poll_votes` has PK
  `(poll_id, user_id)` with `votes` and `pointsSpent`; `prediction_bets` PK
  `(prediction_id, user_id)`, `points`, nullable `payout`.
- `largestRemainder(total, items)` in `@commonair/ledger` (`packages/ledger/src/math.ts:54`):
  integer split that sums exactly; ties go to the earlier item, so order bettors by user id.
- Access (`services/api/src/lib/access.ts:67-105`): for `access: "moderator"` procedures that
  carry `{channel}` the middleware admits the owner, editors and moderators and checks the scope
  of app tokens; suspended callers cannot write. **`vote`, `end`, `bet`, `lock`, `resolve` and
  `cancel` are addressed by id (`/polls/{id}/…`, `/predictions/{id}/…`), so the middleware lets
  them through (`:93-94`) and your handler must load the row's channel and check
  `channelAuthority(caller, channel, roles)` (`:108-117`; roles via the channel-roles lookup the
  middleware uses, `resolveChannel` in `lib/orpc.ts`) for the moderator ones.** Missing poll or
  prediction → `NOT_FOUND`.

## Build

1. **Shared domain (`packages/interact/src/{polls,predictions}.ts`).** Pure builders and
   transaction functions both the API and the worker call: `pollCounts(tx, pollId)` (sum of
   `poll_votes.votes` by choice and the bought part), `pollView(row, counts, mine)`,
   `pollEventPayload(kind, channel, poll, counts)`, `endPollInTx(tx, pollId, status, now)` (row
   lock, status check, final counts written into `choices`, `endedAt`, the `end` event; a no-op
   if already ended); `predictionTotals(tx, id)` (points and users per outcome, top 10 predictors
   per outcome by points then user id), `lockPredictionInTx`, `settlePredictionInTx(tx, id,
   winner | null, now)`. Never read-modify-write `choices` without the row lock.
2. **Polls API.** `create`: refuse while the channel has an active poll (`CONFLICT`; the partial
   unique index is the backstop, map its violation too); choice ids are `uuidv7()` strings;
   `endsAt = now + durationSeconds`; audit `poll.create` (ids, choice count, duration); `begin`
   event. `vote`: signed in, not platform-suspended, not banned or timed out in the channel
   (`isActiveBan`), poll active and `now < endsAt` (else `CONFLICT`); first call records 1 + `extraVotes`;
   a later call must name the same choice and adds `extraVotes ≥ 1` (a different choice →
   `CONFLICT`); total extra votes per user ≤ `POLL_RULES.maxExtraVotesPerUser`. Extra votes need
   `pointsPerExtraVote > 0` (else `BAD_REQUEST`) and the channel's points on
   (`bot_configs.config.loyalty.enabled`, defaults when no row): one `postPointsInTx` of
   `-(extraVotes × pointsPerExtraVote)` with reason `poll_vote` and `refId` = poll id, plus the
   `channel.points.change` event, in the vote's transaction; `InsufficientPointsError` →
   `PRECONDITION_FAILED` `insufficient_points`. Set `polls.changedAt`. No per-vote event. `end`:
   `terminated` ends an active poll now; `archived` hides an ended poll from `current` (an active
   one is ended and archived). Audit `poll.end` with the status. `current`: the active poll, else
   the most recent non-archived one.
3. **Predictions API.** `create`: one open per channel (`CONFLICT`); `locksAt = now +
   windowSeconds`; channel points must be on (`PRECONDITION_FAILED` `points_disabled`); audit,
   `begin`. `bet`: as `vote` for standing; status `active` and `now < locksAt`; one bet per viewer
   (PK; a second → `CONFLICT`); the owner, editors and moderators of the channel cannot bet
   (`FORBIDDEN`: they lock and resolve it); one `prediction_bet` row of `-points`, the bet row, `changedAt`,
   `channel.points.change`, all in one transaction. `lock`: `active` → `locked`, `lockedAt`,
   `lock` event. `resolve`: only from `locked` (`CONFLICT` otherwise). If no bet is on the
   winning outcome, settle as a cancel (ADR 0026 decision 3). Else pool = sum of all bets;
   winners split it with `largestRemainder(pool, winners ordered by user id, weight = stake)`
   (items are `{ key, weight: bigint }`, results `{ key, cents }`: the name says cents, the
   arithmetic is any integer unit);
   one `prediction_payout` row per winner (skip zero), `prediction_bets.payout` set for winners
   (and 0 for losers), `winningOutcomeId`, status `resolved`, `end` event with
   `channel_points_won` filled. `cancel` (from `active` or `locked`): one `prediction_refund` per
   bettor, status `canceled`, `end` event. Every settlement is one transaction under the
   prediction row lock, so a double resolve cannot pay twice; payouts sum to the pool exactly
   (assert it before commit). Audit `prediction.create|lock|resolve|cancel` (ids, counts, never
   free text). Each points move emits `channel.points.change` with the balance after it.
4. **`interact-tick` job.** Every 2 s: end active polls with `endsAt <= now` (status `completed`),
   lock active predictions with `locksAt <= now`, and for active polls and predictions with
   `changedAt > coalesce(progressAt, startedAt)` emit one `progress` event with fresh counts and
   set `progressAt` (so at most one progress per 2 s each, never per vote). One transaction per
   poll or prediction, `FOR UPDATE SKIP LOCKED` on the due rows so replicas never double-end. Return
   `{ pollsEnded, predictionsLocked, progress }`.
5. **Harness.** `stepPoll(run)` and `stepPrediction(run)` exactly as e8-selectors.md "Scenarios"
   steps 1 and 2, over the API (`run.via` = `api`; the web path is E8-studio's and E8-viewer's).
   End the poll with `run.hooks.tick("interact-tick")` after `endsAt`; read outbox rows through
   `run.db`. Step 2 grants points with `bot.points.adjust` (E8-points' handler: the orchestrator
   lifts step 2 from the pending list only once both of you merged).

## Tests you must add

- Unit (`packages/interact`): payout split sums to the pool for random stakes, one winner, all
  on the winner, ties ordered by user id, zero-weight never paid; payload builders validate
  against `EVENTS[…].payload`; top predictors order and cap of 10.
- API integration (`createTestDatabase()`): create/vote/end; vote after `endsAt`, second vote on
  another choice, extra votes without points, extra votes over the cap, banned viewer; extra
  votes debit points and emit `channel.points.change`; overdraw → `insufficient_points` and
  nothing written; predictions create/bet/lock/resolve/cancel; resolve with no winning bets
  refunds; broadcaster cannot bet; concurrent double resolve pays once; balances after payout
  equal stakes moved; one active poll per channel under concurrency; an editor or moderator
  cannot bet; a moderator-only route (`end`, `lock`, `resolve`, `cancel`) by a viewer of another
  channel is `FORBIDDEN` and by an unknown id `NOT_FOUND`; audit rows carry no free text.
- Worker: `interact-tick` ends due polls once across two concurrent runs, locks due predictions,
  emits one progress per changed item and none for an unchanged one.

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
`bun harness/src/cli.ts run interact --set steps=1,2` on the harness stack (with
`harness/compose.e8.yaml`).
