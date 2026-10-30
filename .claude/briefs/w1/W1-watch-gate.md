<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W1-watch-gate: the verified-watch chat gate and the surge guard

You are implementing unit W1-watch-gate for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, PLAN.md and docs/architecture.md first, then `.claude/briefs/next/W1-quick-wins.md`,
`.claude/briefs/w1/contract-step.md` (all of it; §0, §1.2, §1.3 `chat.surge`, §1.4 (`msg_verified_watch`,
the `surge` frame), §1.5, §1.6, §4.1, §4.4, §5, §6, §7, §8.1, §10 `surge-guard` especially),
`docs/product/feature-wins.md` §4.4, **`docs/decisions/0015-verified-watch-signal.md` (all of it:
it is your spec)**, `packages/integrity/README.md` (gate eligibility), `docs/testing/w1-selectors.md`,
`apps/web/src/i18n/README.md` and `.claude/briefs/_done-means.md`. Do not look outside the
repository. Work in your own git worktree on a branch named `w1/watch-gate`, created from the
commit the orchestrator gives you (after the W1 and N1 contract steps; run `git merge main` first if
main moved). Wave 1. Checked against `a43aa6b`; recheck line numbers against your base.

**Rollout (decided by the user, 2026-10-30):** ADR 0015 GA criterion 1 ("CDN fetch-judging")
is owned by **S1 stage 4** (`.claude/briefs/next/S1-scaling.md`), not this unit. You ship the gate behind `CHAT_WATCH_GATE=off` (default)
and the surge guard behind `CHAT_SURGE_GUARD=off`; the harness turns both on
(`harness/compose.w1.yaml`). GA (the flag's default flipping to `on`) waits for S1 stage 4 plus the
other three criteria of decision 8; nothing in this unit flips it.

## Why

Hate-raid bots chat without watching; no Twitch control asks whether a chatter is actually loading
the video (feature-wins §4.4). The integrity pipeline already decides which sessions are verified
and fetch-judged (`gateEligible`); this unit turns that into a per-user signal chat can read in one
`GET`, a channel setting that requires N seconds of it, and a surge guard that applies it for a
while when a channel is botted. A false positive silences a real person, so every choice fails
toward letting people talk, and the denial never tells an attacker why.

## You own (write only these)

- `services/chat/src/rules.ts` (the gate in `checkGates`) and `services/chat/src/watch-gate.ts`
  (stub: `WatchGate`), with `services/chat/tests/{rules-watch,watch-gate}*.test.ts` (and the
  existing `services/chat/tests/permissions.test.ts`/pipeline tests only where `rules.ts` changes
  require it)
- `services/worker/src/integrity/verified-watch.ts` (stub: `writeVerifiedWatch`),
  `services/worker/src/jobs/chat-surge-guard.ts` (stub), `services/worker/src/chat-gate/**` (new:
  trigger, hysteresis, override writes) and `services/worker/tests/{verified-watch,surge-guard}*.test.ts`
- `services/api/src/chat/surge.ts` (stub: `chatSurge`) and `services/api/tests/chat-surge*.test.ts`
- Web: `apps/web/src/routes/_studio/chat.tsx` (placeholder route: fill it), `apps/web/src/components/chat-gate/**`
  (new: the settings form), `apps/web/src/chat/surge-banner.tsx` (stub; the contract step mounts it
  in `chat-panel.tsx`; it also renders the viewer's `chat-gate-hint`)
- i18n: `apps/web/src/i18n/locales/en/w1-watch-gate.json`, `keys/w1-watch-gate.gen.ts` (prefixes
  `chatGate.`, `surge.`)
- Tests: `apps/web/tests/{chat-gate,surge-banner}*.test.tsx`
- Harness: `harness/src/w1/surge.ts` (steps 1–7), `harness/tests/w1/surge.test.ts`
- Docs: `docs/streamers/verified-watch-gate.md` (new: what it requires, who is exempt, the
  privacy-relay rule, that viewers must watch signed in, that it is off on the instance until GA)

Read-only, in particular: `services/chat/src/{core,server,pipeline,types,directory,limiter,metrics,cache}.ts`
(the contract step wired `WatchGate.load`/`denied` into `core.ts` and added `Standing.verifiedWatch`;
`cache.ts` is the generic `TtlCache`, use it, do not change it), `services/worker/src/integrity/jobs.ts`
(calls your writer after each scoring pass), `services/worker/src/moderation/records.ts` (`emit`,
`audit` helpers), `packages/integrity/**` (`GATE_ELIGIBLE`, `IntegrityThresholds` with
`gateUnlocksPerAddress` and `gateFallbackAccountAgeDays`, `channel.ts` `follow_burst`),
`services/api/src/routes/{chat,playback,instance}.ts` (the contract step did `updateSettings`'s flag
check, `avoidCdn` and `features`), `services/api/src/lib/control.ts` (`publishControl`),
`services/api/src/metrics.ts` (`apiMetrics.surgeOverrides`), `packages/contracts/**`,
`packages/db/**`, `apps/web/src/chat/{chat-panel.tsx,connection.ts,messages.ts}`,
`harness/src/w1/{steps,kit,selectors}.ts`, `harness/src/integrity-viewers.ts`,
`harness/src/viewbot.ts`, `harness/scenarios/{surge-guard,integrity-basic}.ts`. Anything else is a
**contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- `ChannelChatSettings.minVerifiedWatchSeconds` (0 or 60–3600), `verifiedWatchExemptSubscribers`
  (default true), `surgeGuard { enabled, triggerUnverifiedRatio (0.5), cooldownMinutes (10) }`.
- `KEYS.verifiedWatch(channelId, userId)` → `VerifiedWatchValue { b, s, f }`, TTL
  `VERIFIED_WATCH_TTL_SECONDS` (600); `KEYS.surgeOverride(channelId)` → `SurgeOverride { state,
  since, until, by }`, TTL `until − now + 60 s`; `VERIFIED_WATCH_JITTER`; `WATCH_GATE_ATTEMPTS`.
- `WatchGateState` on `Standing.verifiedWatch` (null when no gate applies), `WatchGate.load` and
  `WatchGate.denied` signatures (contract step §5); `NOTICE_CODES` `msg_verified_watch`.
- `ServerFrame` `surge` (`state: off|on|suppressed`, `until`), on `BUS.chatControl(channelId)`.
- `SurgeBanner` props `{ channel, canModerate, signedIn, settings, surge, gateDenied }` (contract step
  §8.1); `WatchGate.invalidate(channelId)`; `WatchGate.surge(channel, now)` (stub returning
  `off`), which the contract step's join handler puts in the `joined` frame's `surge` (§1.4,
  decided 2026-10-30 so a mid-surge joiner sees the hint at once).
- `chat.surge.state` / `chat.surge.override({ action: start|end })` → `SurgeState`, moderator,
  `moderator:manage:chat`.
- Internal events `chat.surge.begin` (`trigger`, `until`, `by_user_id`) and `chat.surge.end`
  (`reason`, `by_user_id`); `audit_log` rows `chat.surge.begin`, `chat.surge.end`,
  `chat.surge.override` (details: ids, enums, numbers only).
- Flags `CHAT_WATCH_GATE` / `CHAT_SURGE_GUARD` (`chatEnv`; `features.watchGate`/`surgeGuard` in
  `instance.info`); job `chat-surge-guard` on `QUEUES.moderation`, every 30 s, ops-tickable.
- Test ids and `surge-guard` steps in `docs/testing/w1-selectors.md`.

## What is there today (verified at `a43aa6b`; recheck against your base)

- `checkGates` order (`services/chat/src/rules.ts:41-80`): login, platform ban, channel suspended,
  channel ban/timeout, verified email (bots skip), account age, followers-only, subscribers-only,
  emote-only. `canChatHint` (:112-122) must keep ignoring the gate (decision 4).
- `gateEligible` / `GATE_ELIGIBLE` (`packages/integrity/src/score.ts:97`, `jobs.ts:47`): verified,
  scored, no `fetch_unjudged`. Sessions: `playback_sessions` (`user_id`, `broadcast_id`,
  `ip_hash` (HMAC of the full address), `datacenter` = `privacy_relay:<label>` for privacy relays,
  `watch_seconds`, `started_at`, `verdict`, `verdict_reasons`, `scored_at`).
- Scoring every 15 s (`services/worker/src/integrity/jobs.ts:42`); after the contract step it calls
  `writeVerifiedWatch(ctx)` at the end of each pass.
- `follow_burst` flags (`packages/integrity/src/channel.ts:117`); integrity flags table for its
  recency.
- Channel roles (`channel_roles`: moderator, vip), subscriptions, verified bots
  (`UserProfile.botVerified`) as the chat service loads them (`directory.ts`).
- The `household` (3 honest viewers on one address) and the CDN-bot cases in
  `harness/scenarios/integrity-basic.ts`; the CDN step runs only when the stack has the CDN adapter
  configured (`CDN_PROVIDER=origin-pull`), otherwise it is skipped with a reason.

## Build

1. **Writer (`verified-watch.ts`, ADR 0015 decisions 1, 3, 4, 5).** When `CHAT_WATCH_GATE` or
   `CHAT_SURGE_GUARD` is on: for live channels whose settings have `minVerifiedWatchSeconds > 0`
   (counted only while `CHAT_WATCH_GATE` is on) or `surgeGuard.enabled` (only while
   `CHAT_SURGE_GUARD` is on), sum `watch_seconds` per (user, live broadcast) over `GATE_ELIGIBLE` signed-in
   sessions; exempt roles (broadcaster, moderators, VIPs, verified bots) get no key and do not count
   toward the cap. **Cap:** per exact `ip_hash`, rank users by the start of their first
   gate-eligible session on the broadcast and write keys for the first `gateUnlocksPerAddress`
   only; users whose counted session is on a `privacy_relay:` address are not capped and get
   `f: 1`. **Jitter:** `s = max(0, seconds − j)`, `j = HMAC-SHA256(INTERNAL_API_SECRET,
   "vw-jitter-v1:" + broadcastId + ":" + userId) mod 31` (fixed per user and broadcast). One
   pipelined `SET … EX 600` per user. Return `{ channels, keys }`. Read the thresholds with
   `loadThresholds` each run.
2. **Reader (`watch-gate.ts`).** `load(channel, userId, now)`: null when both flags are off, or the
   channel's gate is 0 and surge mode is off. Otherwise read `KEYS.surgeOverride(channel.id)` (cache
   a few seconds per channel with `TtlCache`) and `KEYS.verifiedWatch(channel.id, userId)` (cache ≤ 5 s
   per user; a value whose `b` is not `channel.liveBroadcastId` is null); `requiredSeconds =
   max(enabled.watchGate ? minVerifiedWatchSeconds : 0, enabled.surgeGuard && state === "on" ? 60 : 0)`
   (a channel's saved gate is ignored while the instance flag is off; `load` returns null when this
   is 0); drop the cached override on `invalidate(channelId)` (the contract step calls it when a
   `surge` frame arrives); `surge(channel, now)`: `{ state, until }` from the same cached override
   read (`off` when `CHAT_SURGE_GUARD` is off, the key is absent, or Valkey fails: fail open);
   `surgeExempt` (surge on only) = the user
   has a non-deleted message in the channel created before `since` (one indexed query, cached for
   the surge's life). Valkey errors → `unavailable: true` and `metrics.watchGateUnavailable()` plus a
   warning (rate-limited log). `denied(channelId, userId, r, now)`: count against
   `KEYS.rateLimit("chat-gate", userId + ":" + channelId)` through the chat `Limiter`; past
   `WATCH_GATE_ATTEMPTS.perMinute` return `{ code: "msg_ratelimit", … }` for the rest of the minute.
3. **Rule (`rules.ts`, decision 7).** After followers-only, before subscribers-only: when
   `standing.verifiedWatch` is set, not `unavailable`, `requiredSeconds > 0`, the user is not
   broadcaster, moderator, VIP or a verified bot, not an exempt subscriber
   (`verifiedWatchExemptSubscribers && subscriberTier !== null`), and not `surgeExempt` while the
   requirement comes from surge mode: refuse with `msg_verified_watch` and one generic English text
   (the browser shows its catalog string) unless `verified` exists with `seconds >= requiredSeconds`
   and, when `verified.fallback`, the account is at least `fallbackAccountAgeDays` old
   (`WatchGateState.fallbackAccountAgeDays`, which `load` fills from `integrity.thresholds`, cached
   per minute). One code for every denial: never, not yet, capped, unjudged, fallback (decision 4).
   `canChatHint` unchanged. Update the pipeline's header comment order (in `pipeline.ts`: contract
   request, one line) if you change the order wording.
4. **Surge guard job (`chat-surge-guard.ts` + `services/worker/src/chat-gate/**`, decision 6).**
   Only when `CHAT_SURGE_GUARD` is on, for live channels with `surgeGuard.enabled`. Trigger: in the
   last 2 minutes at least `max(20, 3 × trailing 15-minute rate per 2 minutes)` new sessions and,
   among those older than 60 s, the non-gate-eligible share ≥ `triggerUnverifiedRatio`; or a
   `follow_burst` flag on the channel in the last 2 minutes. Not active → write `on` with `until =
   now + cooldownMinutes`, emit `chat.surge.begin`, audit `chat.surge.begin`, publish the `surge`
   frame. Active and triggered → extend `until` (no new event). Active, not triggered, `until`
   passed → delete the key, `chat.surge.end` `reason: "cooldown"`. Key gone without an end event
   (worker died) → emit `end` `reason: "expired"` on the next run (keep a small per-channel marker
   in Valkey to know a begin had no end). `suppressed` → never re-trigger before `until`. The outbox
   and audit rows go in one transaction; publish after commit. Pure hysteresis logic in its own
   module with a clock parameter. Return `{ channels, begun, ended }`.
5. **API (`chat/surge.ts`).** `state`: the override key (`off` when absent; `unavailable` on a
   Valkey error) with `by` resolved to a username. `override`: `start` → `on` for the channel's
   `cooldownMinutes`; `end` → `suppressed` until now + `cooldownMinutes`; refuse when
   `CHAT_SURGE_GUARD` is off (`PRECONDITION_FAILED` `surge_guard_off`); one transaction: audit
   `chat.surge.override` (`details: { action }`) and the begin/end event (`trigger: "moderator"` /
   `reason: "moderator"`, `by_user_id`); then the key and the `surge` frame (`publishControl`);
   `apiMetrics.surgeOverrides.add(1, { action })`. Also refuse (`PRECONDITION_FAILED`
   `surge_guard_disabled`) when the channel's `surgeGuard.enabled` is false: the job only scans
   enabled channels, so a manual `on` elsewhere would never get its cooldown `end` event.
6. **Web.** Studio `/chat` (`_studio/chat.tsx` → `components/chat-gate/**`): the gate seconds (off,
   60–3600 with presets 60, 300, 900), exempt subscribers, the surge-guard switch, ratio and
   cooldown; each control shown only when its `features` flag is on, otherwise an `EmptyState`
   explaining the instance has not enabled it; text that the gate needs viewers to watch signed in
   and does not apply to the broadcaster, moderators or VIPs; saves through
   `chat.updateSettings`. `SurgeBanner`: for moderators, `surge-banner` while surge mode is on or
   suppressed with why and until when, plus `surge-end` / `surge-start`. The contract step feeds the banner
   through props, so no polling and no edit outside your files is needed: `settings` (the room's
   `ChannelChatSettings` from the `joined`/`settings` frames), `surge` (the latest `surge` frame, null
   until one arrives) and `gateDenied` (a `msg_verified_watch` notice arrived). For moderators,
   read `chat.surge.state` once on mount, then follow `surge`. For viewers render `chat-gate-hint`
   above the input when `features.watchGate && settings.minVerifiedWatchSeconds > 0`, or
   `features.surgeGuard && surge?.state === "on"`, or `gateDenied` ("This chat is for viewers who
   have been watching for a little while. Watch signed in to join in."), never a countdown. Read
   `features` from `instance.info` once; any failed read renders nothing (existing chat-panel tests,
   which W1-calm-chat owns, render the banner without a server).
7. **Harness `surge.ts`.** Steps 1–7 exactly as `docs/testing/w1-selectors.md` "`surge-guard`"
   and ADR 0015 "Consequences" say. The channel turns the gate on (`minVerifiedWatchSeconds: 60`)
   through the API. Step 2 starts signed-in bot sessions on the CDN **before** the gate is turned on
   (so `avoidCdn` does not apply) and skips with a reason when the stack has no CDN adapter, as
   `integrity-basic` does. Step 3 uses six accounts behind one address (the harness proxy) and
   expects exactly one refused. Step 5 is an audio-only viewer driven through the accessibility
   tree (Playwright `getByRole`) that verifies and chats; it opens `/$channel?rendition=audio`
   (W1-player's diagnostic parameter; the kit forces the ladder, so the `audio` rung exists), so
   the step stays pending until W1-player has merged as well (data mode's Audio preset is wave 2:
   do not depend on it). Step 6 scripts a burst of new HTTP sessions,
   ticks `chat-surge-guard` through the ops hook, sees the `surge` frame `on`, the outbox and audit
   rows, a moderator `end` → `suppressed`, and the gate back to the channel's own setting.

## Tests you must add

- Unit: gate order and every exemption (broadcaster, moderator, VIP, verified bot, subscriber with
  and without the setting), the single denial code for each cause, `unavailable` fails open, surge
  `requiredSeconds` and `surgeExempt`, the fallback account age; jitter determinism (same user and
  broadcast → same j; differs across broadcasts; within 0–30); the cap's ranking (first-session
  order, privacy-relay uncapped, exempt roles not counted); hysteresis (trigger, extend, cooldown
  end, suppressed blocks re-trigger, expired-without-end emits `expired`).
- Integration against real Valkey and Postgres: the cached read and TTL expiry; `surge()` for an
  `on`, a `suppressed` and an absent key and with the flag off; a `fetch_unjudged`
  session writes nothing; the cap at 5 with six users on one `ip_hash`; a key for another broadcast
  ignored; the attempt limit turns the 7th denial in a minute into `msg_ratelimit`; the job writes
  the override, the outbox and audit rows in one transaction and publishes the frame; the API
  override audited and refused with the flag off.
- Web: the settings form hides controls per flag, validates 60–3600, saves; the banner for a
  moderator vs a viewer; `i18n:check` and `logical-css` pass.

## Done means

Follow `.claude/briefs/_done-means.md`. CI on main is the gate: run only targeted checks
(`bun --bun vp test run` and `bun run test:int` in `services/chat`, `services/worker`,
`services/api`, one package's `test:int` at a time; `bunx tsc -p` for each and `apps/web`; `vp lint
--deny-warnings` and `vp fmt` on your paths; `vp build`, `bun run i18n:check` in `apps/web`; `bun
--bun vp test run` in `harness`; `reuse lint`). Never run `bun run verify`, `verify:full`, a harness
scenario against a stack, `podman compose` or `scripts/infra.ts`. `git status` shows only your
paths. Commit in your worktree (`git commit -s`, Conventional Commits, ending with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Final message: what you built, test
counts per package, branch and sha, contract requests (exact diffs), proposed PROGRESS text
(including the GA status: criterion 1 waits for S1 stage 4), anything left undone, and the commands
the user runs live: `bun harness/src/cli.ts run surge-guard` on the harness stack (with
`harness/compose.w1.yaml`), and a manual check of `/chat` and the banner.
