<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W1-spine: media time on chat (server side), chat replay, retention, channel latency

You are implementing unit W1-spine for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/W1-quick-wins.md`,
`.claude/briefs/w1/contract-step.md` (all of it; §0, §1.3 `vods.chat`/`clips.chat` and
`ChatReplayPage`, §1.6 `KEYS.chatLatency`, §2.2, §4.1, §5, §6, §7, §10 `timeline-sync`
especially), `docs/product/feature-wins.md` §4.3, `docs/decisions/0012-media-clock.md` (part 1 for
the clock; **amendment 1 decisions 1–7 are your spec**), `docs/testing/w1-selectors.md`
(`timeline-sync` steps 1, 3, 4) and `.claude/briefs/_done-means.md`. Do not look outside the
repository. Work in your own git worktree on a branch named `w1/spine`, created from the commit the
orchestrator gives you (after the W1 and N1 contract steps; run `git merge main` first if main
moved). Wave 1. W1-player builds the browser half (player seam, presentation queue, sending
`mediaTs`) at the same time; you share no file. Checked against `a43aa6b`; recheck line numbers
against your base.

**Decided (2026-10-30):** the chat replay **UI is deferred to W2**; this unit ships the
`vods.chat` / `clips.chat` API and the `timeline-sync` harness steps only.

## Why

Chat rows carry only receive time, which drifts from the video by each viewer's latency, so VOD
replay is out of sync and clips carry no chat (feature-wins §4.3). ADR 0012 part 1 made PDT the same
ingest wall clock on every rendition; this unit places chat on that clock with a bounded,
receive-time-authoritative clamp, replays it beside VODs and clips without undoing moderation, and
stops chat from being kept forever.

## You own (write only these)

- `services/chat/src/clamp.ts` (stub: `clampMediaTs`) and `services/chat/src/chat-latency.ts`
  (stub: `ChannelLatency`), with `services/chat/tests/{clamp,chat-latency}*.test.ts` and
  `services/chat/tests/media-ts.int.test.ts` (new)
- `services/api/src/chat-replay/**` (stub `handlers.ts`: `vodChat`, `clipChat`; add your query and
  cursor modules beside it) and `services/api/tests/chat-replay*.test.ts`
- `services/worker/src/jobs/chat-retention.ts` (stub), `services/worker/src/chat/**` (new: the
  retention query), `services/worker/src/integrity/chat-latency.ts` (stub: `writeChatLatency`), and
  `services/worker/tests/{chat-retention,chat-latency}*.test.ts`
- Harness: `harness/src/w1/timeline.ts` (steps 1, 3, 4) and `harness/tests/w1/timeline.test.ts`
- Docs: `docs/streamers/chat-replay.md` (new: what replay shows and hides, how long chat is kept,
  the two operator settings)

Read-only, in particular: `services/chat/src/{core,server,types,directory,pipeline,persistence}.ts`
(the contract step wired `clampMediaTs` and `ChannelLatency` into `core.ts`/`server.ts`;
`persistence.ts` needs no change: `MessageRow` follows the schema), `services/api/src/routes/{vods,clips}.ts`
(composers), `services/api/src/media/visibility.ts`, `services/api/src/chat/messages.ts` (the
`ChatMessage` DTO builder: reuse it), `services/worker/src/integrity/jobs.ts`,
`services/worker/src/housekeeping.ts` (the `ownerHeld` legal-hold pattern, :102-…),
`packages/integrity/**` (`GATE_ELIGIBLE`), `packages/contracts/**`, `packages/db/**`,
`harness/src/w1/{steps,kit,selectors}.ts`, `harness/scenarios/timeline-sync.ts`. Anything else is a
**contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- `ClampInput` / `clampMediaTs(i): Date | null` (contract step §5), called by `core.ts` for every
  accepted message; `ChannelLatency.get(channelId): Promise<number | null>` called only when the
  message has no hint, is in `live` mode and the channel is live.
- `chat_messages.media_ts` (nullable) with `chat_messages_broadcast_media_idx (broadcast_id,
  media_ts)` and `chat_messages_created_idx (created_at)`; `ChatMessage.mediaTs`.
- `vods.chat` / `clips.chat` (`{ id, cursor?, limit 1–500 }` → `ChatReplayPage`: items with `at` and
  `catchingUp`, `nextCursor`, `retained`).
- `KEYS.chatLatency(channelId)`: STRING seconds, TTL 60 s. `user_blocks` (replay hides the
  caller's blocks).
- `CHAT_RETENTION_DAYS` (30), `CHAT_REPLAY_MAX_DAYS` (60) from `chatEnv` in the worker env;
  job `chat-retention` on `QUEUES.retention`, hourly, tickable through the ops hook.

## What is there today (verified at `a43aa6b`; recheck against your base)

- `core.ts` `submit` stamps `createdAt` from `receivedAt` and `broadcastId` from
  `channel.liveBroadcastId` (`services/chat/src/core.ts:76-170`); after the contract step it also
  calls your `clampMediaTs` with `channel.liveStartedAt` and, for hint-less live messages, your
  `ChannelLatency`.
- Moderation state: a delete sets `deleted_at`/`deleted_by` (`services/chat/src/moderation.ts:274`);
  held messages have `held_at` until approved (`services/api/src/chat/held.ts:121`); `/clear` writes a
  `mod_actions` row `clear_chat` and changes no message rows (`moderation.ts:298-303`); bans and
  timeouts are `chat_bans` rows (`packages/db/src/schema/chat.ts:40-…`) and touch no messages.
- Suspension: `users.banned`/`ban_expires`; channel bans `chat_bans` with `expires_at` null.
- VODs: `vods.broadcast_id`, `status`, `visibility`, `expires_at`, `removed_reason`
  (`packages/db/src/schema/media.ts:140-170`); clips: `broadcast_id`, `vod_id` (set null),
  `start_offset`, `duration_seconds` (`:171-196`); playability helpers in
  `services/api/src/media/visibility.ts` (`vodShown`, `vodVisible`, `viewerAudience`), and the
  `vods.get`/`clips.get` handlers show how they are applied.
- `vod-retention` is the model for a run-locked batch delete that skips legal holds
  (`services/worker/src/jobs/vod-retention.ts`, `housekeeping.ts:102-142`).
- Scoring runs every 15 s; `playback_sessions.latency_ms`, `GATE_ELIGIBLE`
  (`packages/integrity/src/jobs.ts:47`).

## Build

1. **Clamp (`clamp.ts`, pure; ADR 0012 decisions 2 and 4).** `dvr` → null. Channel not live
   (`liveStartedAt` null) → null. Live with a hint: `clamp(hint, max(receivedAt − 60 s,
   liveStartedAt), receivedAt)`. Live without a hint: `clamp(receivedAt − L, same bounds)` with
   `L = channelLatencySeconds ?? 0`. Export the 60 s window as a named constant.
2. **Channel latency reader (`chat-latency.ts`).** `GET KEYS.chatLatency` with a short in-process
   cache (default 5 s TTL, `TtlCache` from `cache.ts`); unparsable or missing → null; a Valkey error
   → null with a debug log (never block a send).
3. **Channel latency writer (`services/worker/src/integrity/chat-latency.ts`, decision 4).** After
   each scoring pass: per live channel, the median of `latency_ms` over live, `GATE_ELIGIBLE`
   sessions that report one, capped to [0, 60] s; write `SET KEYS.chatLatency <seconds> EX 60` only
   when at least 3 sessions report; one pipelined write; return `{ channels }`. Bound the query to
   channels with a live broadcast.
4. **Replay (`services/api/src/chat-replay/**`; decisions 5 and 7).**
   - Window: a VOD's broadcast from `broadcasts.started_at` to `ended_at` (or now while recording);
     a clip's from `started_at + start_offset` for `duration_seconds` (the recorder clock, aligned
     by part 1). Both read one broadcast's rows through the `(broadcast_id, media_ts)` index;
     order by `coalesce(media_ts, created_at), id`, cursor on that pair (opaque, base64url JSON),
     at most 500 per page.
   - Served exactly when the VOD or clip is playable to the caller (status, removal, visibility,
     the 18+ gate), reusing `media/visibility.ts` as `vods.get`/`clips.get` do; otherwise
     `NOT_FOUND` (or the existing mature-gate error where those handlers raise it).
   - Excluded: `deleted_at` set; `held_at` set; messages before the latest `clear_chat`
     `mod_actions` row of that channel in the broadcast window that precedes them; messages by a
     user banned or timed out in the channel during the broadcast, sent before that ban; messages
     by a user under a permanent channel ban (all replays of the channel); messages by a
     platform-suspended user while the suspension lasts; for a signed-in caller, messages by users
     in their `user_blocks`. Replay for a signed-in caller is per viewer: `cache-control: private,
     no-store` (anonymous: `private, max-age=30` at most).
   - Items reuse the `ChatMessage` DTO builder (`services/api/src/chat/messages.ts`), plus `at` and
     `catchingUp = mediaTs === null`. `retained: false` when the window is older than the
     retention rule allows and no rows remain.
5. **Retention job (`chat-retention`, decision 6).** Under a run lock, in batches (e.g. 5,000 rows
   per statement, time-budgeted like `vod-retention`): delete messages older than
   `CHAT_REPLAY_MAX_DAYS`; and messages older than `CHAT_RETENTION_DAYS` whose broadcast is null or
   has no VOD with `status <> 'deleted'` and `removed_reason is null`. Skip messages whose author is
   under an unreleased legal hold (the `ownerHeld` pattern, by `chat_messages.user_id`). Return
   `{ deleted, held }` (held = rows skipped for a hold). Reports keep their evidence copy
   (`safety.ts:79-80`), so nothing else needs to change.
6. **Harness.** `timeline.ts` steps 1, 3, 4 exactly as `docs/testing/w1-selectors.md`
   "`timeline-sync`" says (API chat clients and tmi.js through the IRC gateway for step 1; seeded
   rows and real moderation calls for step 3, a `user_blocks` row seeded directly until
   W1-calm-chat merges, then `me.blocks.add`; backdated test rows and the `chat-retention` ops
   tick for step 4).

## Tests you must add

- Clamp unit tests: window edges (exactly −60 s, exactly receive), before `started_at`, a future
  hint, offline channel, DVR null, missing hint with and without latency, latency above 60 s.
- Reader unit tests (cache hit, malformed value, Valkey error) and a writer integration test
  against real Postgres and Valkey: three gate-eligible sessions → median written; two → nothing;
  a `fetch_unjudged` or excluded session ignored; cap at 60.
- Replay integration tests: every exclusion of decision 7 (a block, a `/clear`, a mid-broadcast
  ban, a timeout, a suspension, a deleted and a held message, a restricted and a `subscribers` VOD
  for a stranger and a subscriber, a removed VOD), ordering by media time with null-`media_ts`
  messages placed at receive time and flagged, cursor paging across equal timestamps, the clip
  window, `retained: false`.
- Retention integration tests: VOD alive past 30 days kept to 60; VOD expired at 14 days → chat
  deleted at 30; the 60-day cap with a live VOD; offline chat at 30; a legal hold skipped; batching
  stops at the budget and resumes.
- A `services/chat` integration test (`services/chat/tests/media-ts.int.test.ts`) that a live message
  with a hint is stored and fanned out with the clamped `mediaTs`.

## Done means

Follow `.claude/briefs/_done-means.md`. CI on main is the gate: run only targeted checks
(`bun --bun vp test run` and `bun run test:int` in `services/chat`, `services/api`,
`services/worker`, one package's `test:int` at a time; `bunx tsc -p` for each; `vp lint
--deny-warnings` and `vp fmt` on your paths; `bun --bun vp test run` in `harness`; `reuse lint`).
Never run `bun run verify`, `verify:full`, a harness scenario against a stack, `podman compose` or
`scripts/infra.ts`. `git status` shows only your paths. Commit in your worktree (`git commit -s`,
Conventional Commits, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
Final message: what you built, test counts per package, branch and sha, contract requests (exact
diffs), proposed PROGRESS text and the "seam API" paragraph you want in `w1-selectors.md`, anything
left undone, and the commands the user runs live: `bun harness/src/cli.ts run timeline-sync --set
steps=1,3,4` on the harness stack.
