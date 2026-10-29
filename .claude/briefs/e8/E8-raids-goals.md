<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E8-raids-goals: raids, goals, the raid alert and the goals overlay stream

You are implementing unit E8-raids-goals for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, PLAN.md and docs/architecture.md first, then `.claude/briefs/next/E8-interactivity-bot.md`,
`.claude/briefs/e8/contract-step.md` (all of it; §0, §1.4, §1.6, §2, §6.3, §14 especially),
`docs/decisions/0026-interactivity-policies.md` (decisions 4 and 5),
`docs/decisions/0021-*.md` (overlay tokens), `docs/testing/e6-selectors.md` ("Overlays and
alerts"), `docs/testing/e8-selectors.md` ("Raids", "Goals", scenario `interact` steps 3-4) and
`.claude/briefs/_done-means.md`. Do not look outside the repository. Work in your own git worktree
on a branch named `e8/raids-goals`, created from the commit the orchestrator gives you (after the E8, E9
and N2 contract steps) (run `git merge main` first if main moved). Wave 1: you write no web strings.

## Why

`interact.raids.*` and `interact.goals.*` answer 501, `overlays.state` returns `goals: []`
(`services/api/src/routes/interact.ts` before the split), the raid alert type exists
(`ALERT_TYPES`) but nothing maps `channel.raid` to it, and the goals overlay URL handed to OBS
shows a placeholder.

## You own (write only these)

- `services/api/src/routes/interact/raids.ts`, `services/api/src/routes/interact/goals.ts`,
  `services/api/src/routes/interact/overlays.ts` (only the `state` handler's `goals` and imports;
  the token handlers stay as they are)
- `services/api/src/interact/raids/**`, `services/api/src/interact/goals/**` (new)
- `services/api/src/overlay/**` (contract step §14): in practice `stream.ts` (the `goal` SSE
  event) and `alerts.ts` (map `channel.raid` → `raid` with `${user}` = the raider's display name
  and `${viewers}`)
- `packages/interact/src/raids.ts`, `packages/interact/src/goals.ts`,
  `packages/interact/tests/{raids,goals}*.test.ts`
- `services/worker/src/jobs/raids-execute.ts` (stub from the contract step),
  `services/worker/src/interact/raids/**`, `services/worker/src/interact/goals/**` (including the
  `outbox-hook.ts` stub the relay already calls)
- Tests: `services/api/tests/interact-raids*.test.ts`, `services/api/tests/interact-goals*.test.ts`,
  the overlay cases you add to `services/api/tests/overlay-hub.test.ts`,
  `services/api/tests/overlay-alerts.test.ts` and `services/api/tests/overlay.int.test.ts` (it
  asserts `goals: []` today, :205), `services/worker/tests/interact-raids*.test.ts`,
  `services/worker/tests/interact-goals*.test.ts`
- Harness: `harness/src/e8/raids.ts` (`stepRaid`), `harness/src/e8/goals.ts` (`stepGoal`),
  `harness/tests/e8/raids.test.ts` for pure helpers
- Docs: `docs/streamers/raids-goals.md` (new)

Read-only, in particular: `packages/contracts/**`, `packages/db/**`, `packages/integrity/**`
(`GATE_ELIGIBLE`, `raidIntegrity`), `packages/interact/src/{index,outbox}.ts`,
`services/api/src/routes/interact.ts`, `routes/interact/{alerts,polls,predictions}.ts`,
`services/api/src/lib/control.ts` (`publishControl`), `services/worker/src/outbox.ts` (it calls
your hook), `harness/src/e8/{steps,kit,selectors}.ts`, `harness/src/e6/sse.ts`,
`harness/scenarios/interact.ts`. Anything else is a **contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- Router `interact.raids` (`router.ts:1800-1821` plus the contract step's `current` and
  `setPolicy`): owner (or editor) of the source, `channel:manage:raids`. `start({ channel, to })`
  → `RaidView`; `cancel` → `Ok`; `current` → `RaidState`; `setPolicy({ policy })` → `RaidState`.
- Router `interact.goals` (:1859-1893): `list` (public), `create` (owner; `type`, `title` ≤ 60,
  `target` > 0), `end`. `interact.overlays.state` (overlay token) returns `goals`.
- Enums: `RAID_STATUSES`, `RAID_POLICIES`, `RAID_CANCEL_REASONS`, `RAID_RULES`
  (`countdownSeconds` 30, `cooldownSeconds` 600), `GOAL_TYPES`, `ALERT_TYPES`.
- Events (§1.4): `channel.raid` (outbox `channelId` = the **target**; `viewers` = the verified
  count), `channel.goal.begin|progress|end`. Chat control frame `raid` (§1.6) on
  `BUS.chatControl(<source channel id>)` via `publishControl`, after commit.
- SSE: `OVERLAY_EVENTS_PATH` gains event `goal` with data `Goal` JSON (contract step comment).
- Tables: `raids` (after 0033: `canceledAt`, `cancelReason`, `raids_from_pending_uq`,
  `raids_from_idx`, `raids_due_idx`, `raids_cancel_ck`), `channels.raid_policy`, `follows`,
  `goals` (`goals_channel_open_uq`: one open goal per type), `playback_sessions` (with
  `GATE_ELIGIBLE`), `alert_configs`.
- `INTERACT_JOBS.raidsExecute` (every 2 s), `applyGoalProgress(tx, events, ctx)` signature
  (`services/worker/src/interact/goals/outbox-hook.ts`).

## What is there today (verified at `c0c16fd`; recheck against your base)

- `raids` has `viewerCount` "verified viewers carried over" (`schema/interactive.ts:233-234`);
  `raidIntegrity(claimed, verified)` (`packages/integrity/src/channel.ts:151-160`) caps a count at
  the verified one; `GATE_ELIGIBLE` (`packages/integrity/src/jobs.ts:47`) is SQL on alias `ps`.
- Chat relays `channel.raid` inline to the room of the event's `channelId`
  (`services/chat/src/events.ts:28-37`); the chat service forwards any control frame it does not
  special-case to the room (`services/chat/src/core.ts:349`), so the new `raid` frame reaches
  every socket in the source's room without chat changes.
- The overlay hub (`services/api/src/overlay/stream.ts:188-216`, `onMessage`) maps `BUS.events`
  to `alert` frames through `alertForEvent` (`overlay/alerts.ts:161-172`), which takes its source
  from `alertSourceOf` (`:109-152`; a switch with no `channel.raid` case yet, and it already drops
  events whose `channelId` is not the stream's, so a raid alert keyed on the target just works).
  The sample for a test raid alert already sets `viewers` (`:188`). `OpenStream.send` is typed for
  `"alert"` only (`:55`); the SSE writer is `:318`.
- The outbox relay calls your stub `applyGoalProgress(tx, valid, ctx)` inside its claim
  transaction, before publishing (`services/worker/src/outbox.ts:~124`).

## Build

1. **Raids, start.** In one transaction (lock the source channel row): source ≠ target
   (`BAD_REQUEST`); target exists (`NOT_FOUND`); source live (`liveBroadcastId`) else
   `PRECONDITION_FAILED` `raid_source_offline`; target live else `raid_target_offline`; neither
   suspended (`suspendedAt`) else `raid_suspended`; target's `raid_policy`: `off` →
   `raid_refused`, `followed` → the target's owner must follow the source (`follows`
   `followerId = target.ownerId`, `excludedAt is null`) else `raid_refused`; cooldown: the
   source's last raid with `coalesce(executed_at, canceled_at) > now - cooldownSeconds` →
   `raid_cooldown` (message with the seconds left); a pending raid → `CONFLICT` (map the
   `raids_from_pending_uq` violation the same way). Insert `pending` with `executeAt = now +
   countdownSeconds`, audit `raid.start` (ids only). After commit publish the `raid` frame
   (`pending`). Precondition codes are part of the contract: throw them with
   `precondition(code, message)` (`services/api/src/lib/errors.ts:30`, sent as
   `error.data.requirement`); the studio shows `raid-error` with `data-code`, and a pending raid's
   `CONFLICT` carries no requirement (the studio maps it to `data-code="raid_pending"`).
2. **Raids, cancel, current, setPolicy.** `cancel`: the pending raid → `canceled`, `owner`,
   `canceledAt`; audit `raid.cancel`; frame `canceled`; no pending raid → `NOT_FOUND`. `current`:
   the pending raid, else the most recent one; `cooldownEndsAt` when cooling down; the channel's
   policy. `setPolicy`: update `channels.raid_policy`, audit `raid.policy` (`{ policy }`).
3. **`raids-execute` job.** Every 2 s, due `pending` raids (`raids_due_idx`, `FOR UPDATE SKIP
   LOCKED`), one transaction each. Re-check at execute (ADR 0026: the setting can change in the
   countdown): either side suspended → cancel `suspended`; source offline → `source_offline`;
   target offline → `target_offline`; target policy refuses → `target_refused`. Otherwise count the
   source's gate-eligible viewers now: `playback_sessions` of the source with `ended_at is null`,
   a heartbeat in the last 60 s and `GATE_ELIGIBLE`, distinct by `coalesce(user_id::text,
   device_hash)`; `viewerCount = raidIntegrity(liveSessions, verified).allowedViewers` (no surface
   shows a raw count); set `completed`, `executedAt`; `channel.raid` event on the target. After
   commit publish the frame (`completed` or `canceled`) on the source's chat control
   (`ctx.valkey.publish(BUS.chatControl(id), …)` with a `ChatControlMessage`-valid body). Return
   `{ executed, canceled }`.
4. **Raid alert.** `alertSourceOf`: `channel.raid` → type `raid` for the target channel when its
   `raid` alert is enabled; `${user}` = `from_broadcaster_user_name`, `${viewers}` = `viewers`.
   Test in `overlay-alerts.test.ts`.
5. **Goals API.** `create`: one open goal per type (`CONFLICT`; map the unique violation);
   `target` for `tips` is minor units; `current` starts at 0 and counts events after `startedAt`
   ("new followers during this goal", documented in your streamer doc); audit `goal.create`;
   `begin` event. `end`: open goal → `endedAt`; `end` event with `is_achieved = current >= target`;
   audit `goal.end`. `list` (public): open goals, then the ten most recent ended ones.
   `overlays.state`: the open goals.
6. **Goal progress in the outbox relay (`applyGoalProgress`).** From the batch's valid events:
   `channel.follow` (+1, followers), `channel.subscribe` (+1 per row, gifted ones included; never
   count `channel.subscription.gift`, which summarises those rows), `channel.tip` (+
   `amount.value`, tips; the instance has one currency). No relevant event → return 0 without a
   query. Otherwise one query for the open goals of those channels and types, one
   `update … set current = current + $n … returning` per goal, a `progress` event for each, and
   when `current >= target` set `endedAt` and write `end` (`is_achieved: true`) in the same
   transaction. Keep it fast and bounded: it runs inside the relay's claim. The relay's rollback
   rolls your updates back, so each event counts once.
7. **Goals overlay stream.** In the hub, on `channel.goal.*` for a channel with open streams,
   send SSE `goal` with the `Goal` DTO built from the payload (`description` → `title`,
   `ended_at` → `endedAt`). Widen `OpenStream.send` to `"alert" | "goal"`. Extend the hub tests.
8. **Harness.** `stepRaid(run)` and `stepGoal(run)` exactly as e8-selectors.md "Scenarios" steps 3
   and 4, over the API, two chat clients (`harness/src/chat-client.ts`) in the source room and an
   HTTP viewer verified through the existing integrity path; execute with
   `run.hooks.tick("raids-execute")` after `executeAt`; the goal through the overlay SSE client
   (`harness/src/e6/sse.ts`) with a token from `interact.overlays.token`.

## Tests you must add

- Unit (`packages/interact`): verified-count query builder, cancel-reason selection, goal
  increments per event type (gift rows counted once, summary ignored), achievement at the boundary.
- API integration: every start refusal (self, offline either side, suspended, policy `off`,
  `followed` without and with the follow, cooldown boundary, second pending under concurrency);
  cancel; current/setPolicy; goals create/end/list, second open goal of a type refused,
  `overlays.state.goals`.
- Worker: execute with a verified, an excluded and a `fetch_unjudged` session (count 1); cancel on
  each re-check; two concurrent runs execute once; the hook advances a goal once per event, ends
  it at the target, writes no query for unrelated batches, and rolls back with the batch.
- Overlay: `goal` frames reach only the goal's channel; raid alert text.

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
`bun harness/src/cli.ts run interact --set steps=3,4` on the harness stack.
