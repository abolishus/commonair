<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W2-rehearsal: private test broadcasts with a simulated audience

You are implementing unit W2-rehearsal for CommonAir (repo: /Users/joshe/Repos/bcon). Read
AGENTS.md, PLAN.md and docs/architecture.md first, then `.claude/briefs/batch6/README.md`
(decisions (f), (g), (h), (p), path ownership, shared rules: binding),
`.claude/briefs/w2/contract-step.md` (§1.1 `BROADCAST_KINDS`, §1.3 `stream.rehearsal.*`, §1.4
`rehearsal.armed` / `rehearsal.ended` and `KEYS.rehearsalArmed`, §2.1–2.2 rehearsal, §4 rehearsal
gate, §5, §6), `docs/product/feature-wins.md` §4.11, `docs/testing/w2-selectors.md` (rehearsal ids
and steps) and `.claude/briefs/_done-means.md`. Do not look outside the repository. Own git
worktree, branch `w2/rehearsal`, from the contract step's sha (`git merge main` first if main
moved). Wave 1, beside five other units; you share no file. Checked at `8fc2c974`; recheck lines.

## Why

Creators have no way to test a setup before going live: Twitch has no private test broadcast, and
YouTube's unlisted streams have no audience to exercise chat filters. A rehearsal runs the real
ingest, transcode, health and moderation on the normal stream key, shows it to at most five named
followers, drives a simulated chat through the real filters, and ends with a checklist: "ingest
green, filter held 4 messages, bitrate dip at 12:04". Private live video is a classic abuse
pattern, so invitees are named, scanned as live and audit-logged, and nothing counts as a broadcast.

## You own (write only these)

- `packages/sim/**` (new, AGPL-3.0-or-later; `src/`, `tests/`)
- `services/api/src/stream/rehearsal.ts`, `services/api/src/routes/rehearsal.ts` (stubs from the
  contract step), new `services/api/tests/rehearsal*.test.ts`
- `services/worker/src/jobs/rehearsal-driver.ts` (stub, registered by the contract step), new
  `services/worker/tests/rehearsal-driver*.test.ts`
- `apps/web/src/routes/_studio/rehearse.tsx` (content), `apps/web/src/components/rehearsal/**`,
  new `apps/web/tests/rehearsal*.test.tsx`
- `apps/web/src/i18n/locales/{en,es}/w2-rehearsal.json` (prefix `rehearsal.`)
- `harness/scenarios/rehearsal.ts` (stub), `harness/src/w2/rehearsal/**`, new
  `harness/tests/w2/rehearsal*.test.ts`

Read-only, in particular: `services/api/src/media/hooks.ts` (the gate), `services/api/src/routes/{playback,stream}.ts`,
`services/api/src/moderation/live.ts` (`kickPublisher`),
`services/media/**`, `services/chat/**`, `packages/chat-filter/**`, `packages/interact/**`,
`services/worker/src/{outbox.ts,jobs/index.ts}`, `harness/src/bots/**`, `harness/src/w2/steps.ts`.
Anything else is a **contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- `broadcasts.kind` (`live` / `rehearsal`), `rehearsal_invitees` (≤ 5), the triggers refusing
  rehearsal rows in `stream_hours`, ledger postings, patronage inputs, `integrity_attestations` and
  `channels.live_broadcast_id` (`0043_w2_protections.sql`).
- The gate (decision (f)): `mediaAuth` accepts the normal key while `KEYS.rehearsalArmed(channelId)`
  exists; `mediaReady` inserts `kind = 'rehearsal'`, sets no `liveBroadcastId`, writes no
  `stream.online`; `mediaDone` no `stream.offline`; simulcast skipped. You build on it, never edit it.
- Reconnects (contract-step review fix): `mediaReady` writes `KEYS.rehearsalSession(channelId)`
  (the arm, TTL cap + `REHEARSAL_RULES.sessionGraceSeconds`) and `mediaAuth` treats it as an arm,
  so a reconnect after the arm lapsed still rehearses. **`disarm` must delete it with the arm.**
  Whoever ends a rehearsal with a kick sets `KEYS.rehearsalKicked(channelId)` (`EX
  REHEARSAL_RULES.kickCooldownSeconds`) **before** kicking, and `mediaAuth` refuses the channel's
  publishes while it exists: your cap kick and `disarm` must set it (the API's
  `afterBroadcastEnded` already does for moderation ends).
- Invitee tokens (contract-step review fix, closes most of contract request 1): `PlaybackClaims.rb`
  (the rehearsal broadcast id, origin-only, `live/` path; mirrored in the relay's Go parser). The
  origin serves `live/<slug>` for an `rb` token from that open rehearsal only
  (`ChannelDirectory.lookupRehearsal`); every other token, relay and CDN pull sees the channel as
  offline. `signFor(..., rehearsal)` in `services/api/src/routes/playback.ts` mints one, and the
  heartbeat re-mints with `rb` carried forward.
- A rehearsal VOD stays private (`vods.update` refuses another visibility) and is never clipped
  (`clips.create`): PRECONDITION_FAILED `rehearsal`.
- `stream.rehearsal.{arm, disarm, status, invite, report}` shapes, events `rehearsal.armed` /
  `rehearsal.ended` (internal, never offered to apps), test ids in `w2-selectors.md`.
- Limits (decision (g)): arm TTL 10 min, duration cap 30 min, ≤ 5 invitees who follow the
  channel (`follows`, `excluded_at is null`), VOD kept 24 h, no captions, DVR or simulcast. Alert
  checks (goals, raids) stay deferred: no goal or raid code path is exercised.

## Build

1. **Arm (`stream/rehearsal.ts`, `routes/rehearsal.ts`).** Channel owner only (session; app
   tokens refused). `arm` refuses when the channel is live, suspended, already armed or rehearsing
   (`PRECONDITION_FAILED` with a code each); sets `KEYS.rehearsalArmed` (JSON: arm id, owner id,
   armed at) with a 600 s TTL; writes `rehearsal.armed` and an `audit_log` row
   (`rehearsal.arm`, ids only) in one transaction. `disarm` deletes the key, ends a running
   rehearsal (kick the publisher, `rehearsal.ended`, audit). `status` returns armed / rehearsing /
   idle with the remaining TTL or cap. Re-arming after the TTL lapses is allowed.
2. **Invitees.** `invite` adds or removes by username: must follow the channel, not the owner, not
   suspended or deleted; the sixth is refused (`invitee_limit`), idempotent re-add. Each change
   writes an `audit_log` row (`rehearsal.invitee.add` / `.remove`, invitee by id). The list is per
   arm and carries over into the broadcast the arm produces.
3. **Invitee playback.** Invitees watch through an invitee-gated path, never `liveBroadcastId`:
   resolve the open `kind = 'rehearsal'` broadcast, check the caller is the owner or an invitee,
   mint an origin-only token (no relay, CDN or P2P assignment, `exp` ≤ the cap) with the existing
   signer. Signed-out callers, non-invitees, embeds and `playback.start` on the channel are all
   refused (the latter already, since nothing is live). See contract request 1.
4. **Driver (`jobs/rehearsal-driver.ts`).** Starts on `rehearsal.armed`, waits for the rehearsal
   broadcast, then: runs `packages/sim` at ~3 msg/s with one spam burst (50 messages in 5 s mixing
   duplicates, links and a filtered word); samples ingest health every 5 s (bitrate, fps, keyframe
   interval, dropped frames, from what `services/media` already publishes); records moderation
   samples taken and any T1/T2 flag; enforces the 30 min cap (kick, `rehearsal.ended`, audit
   `rehearsal.cap`); stops on disarm or publisher end; writes the report every 5 s (see contract
   request 3). Idempotent: a restarted job resumes the same report, never double-sends a burst.
5. **`packages/sim`.** Pure and clock-injected: `chatScript({seed, rate, burst})` yields timed
   messages (varied bodies, emotes, one repeated body, links, words from the channel's own filter
   list); `viewers({count})` yields synthetic presence only (never heartbeats, never
   `playback_sessions`, never counted). Written fresh for rehearsal (decision (h)); the harness
   keeps its bots. No new dependency (decision (o)).
6. **Report.** `report` (owner only, kept 24 h): accepted / held / rejected counts by rule
   (word filter, link, duplicate, rate limit), the held messages' ids, ingest checks with timed
   dips ("bitrate below 50% of target at 12:04"), moderation sampling counts, invitees who
   watched. A T0 hit suspends the channel as live and the report says only "ended by safety".
7. **Web (`_studio/rehearse.tsx`, `components/rehearsal/**`).** Arm button with the TTL countdown,
   the stream key reminder (never shown in full), invitee picker from followers (≤ 5), live
   checklist (polling `status`/`report` every 5 s, `aria-live="polite"`), a player for the owner,
   and an invitee watch view. `ConfirmDialog` for disarm, `toast.*`, `EmptyState`, `Skeleton*`,
   `RelativeTime`; 320 px, dark and light, `prefers-reduced-motion`. Every string in
   `w2-rehearsal` en **and** es (decision (p)).

## Tests you must add

- Unit: `packages/sim` (rate within ±10% over 60 s, burst shape, seed determinism, no personal
  data in bodies); arm state machine (TTL lapse, double arm, arm while live, disarm idempotent);
  invitee rules (sixth, non-follower, excluded follow, owner, deleted); report assembly and dip
  detection with an injected clock.
- Integration (`createTestDatabase()`, real Valkey): arm/disarm/invite with audit rows and events
  in the same transaction; a rehearsal broadcast inserted the way the gate does leaves no
  `stream_hours`, ledger, patronage or attestation row (direct inserts refused by the triggers);
  invitee token minted, non-invitee and signed-out refused; driver cap and resume.
- Web: rehearse page states (idle, armed, rehearsing, ended), invitee limit, 320 px.
- Harness (`harness/scenarios/rehearsal.ts`, steps in `harness/src/w2/rehearsal/**`): arm,
  publish with the normal key; no directory entry; no `stream.online` (outbox, EventSub delivery,
  go-live inbox, Discord); no `stream_hours` or ledger row, no goal progress; direct inserts
  refused; simulated chat and the spam burst filtered or held and present in the report; an
  invitee plays, a signed-out viewer, a non-invitee and the embed are refused; the VOD expires at
  24 h and is not public; audit rows for arm and the invitee.

## Done means

Follow `.claude/briefs/_done-means.md`. Targeted checks only: `bun --bun vp test run` in
`packages/sim`, `apps/web`, `harness`; `bun run test` and `bun run test:int` in `services/api`
then `services/worker` (one at a time); `bunx tsc -p` for each; `vp lint --deny-warnings` and `vp
fmt` on your paths; `vp build` and `bun run i18n:check && bun --bun vp test run
tests/i18n.test.ts` in `apps/web`; `reuse lint`. Never `bun run verify`, a harness scenario,
`podman compose` or `scripts/infra.ts`. `git status` shows only your paths. Commit with `git
commit -s`. Final message per `_done-means.md`, and the live commands for the user: `bun
harness/src/cli.ts run rehearsal`, then `/studio/rehearse` with OBS on the normal key and an
invitee in a second browser, at 320 px under `en`, `es` and `en-XA`, dark and light.

## Contract requests to send if still open at your base

1. **Invitee watch route**: `stream.rehearsal.watch({channel})` → `{playlistUrl, token, expiresAt}`
   (session callers), and `playback.heartbeat` ignoring a rehearsal token's `sid` without error.
2. **Chat dry run**: an internal `services/chat` entry that runs the full send pipeline against
   the channel's state with a synthetic sender and returns accepted / held / rejected + notice
   code, never broadcasting or persisting. Simulated messages must not appear in the channel's
   public chat or its replay. Until it lands, run `packages/chat-filter` filters only and say so.
3. `KEYS.rehearsalReport(broadcastId)` (worker writes, api reads, 24 h TTL).
4. **VOD**: `services/media/src/lifecycle.ts:205` creates rehearsal VODs `visibility: "private"`;
   `services/media/src/vod/finalize.ts:303` sets `expiresAt = now + 24 h` for `kind = 'rehearsal'`.
5. `packages/sim/package.json` and tsconfig, and `@commonair/sim` in `services/worker/package.json`
   (package files are orchestrator-only).
