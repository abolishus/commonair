<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0012: One media clock (part 1: alignment and skew targets)

- Status: accepted. Part 1 accepted 2026-10-27 (the six questions answered by the maintainer, see
  [Decisions at acceptance](#decisions-at-acceptance-2026-10-27)); amendment 1 (part 2, Timeline
  Spine) accepted 2026-10-27 (the maintainer accepted the recommended answers, see
  [Amendment 1 decisions at acceptance](#amendment-1-decisions-at-acceptance-2026-10-27))
- Date: 2026-10-27 (code checked at `9c51c93`)
- Scope: the first half of the ADR 0012 candidate in
  [feature-wins.md §7](../product/feature-wins.md#7-decisions-needed), which gates W0-clock
  ([W0-prerequisites](../../.claude/briefs/next/W0-prerequisites.md)). The second half (the
  `media_ts` clamp, presentation defaults, IRC behaviour, chat retention and replay) is
  [deferred to W1](#deferred-to-w1-part-2-timeline-spine).

## Context

The Timeline Spine (feature-wins §4.3), DVR (§4.12) and captions all locate media by wall clock,
through `EXT-X-PROGRAM-DATE-TIME` (PDT). That only works if one frame has one PDT on every
rendition and in the VOD. Today each output stamps its own PDT with "when I saw it":

- **Source path.** MediaMTX 1.21.2 (`compose.yaml:227`) serves LL-HLS with 1 s segments and
  200 ms parts (`infra/mediamtx/mediamtx.yml:58-68`) and stamps PDT from its own clock at receipt.
  `useAbsoluteTimestamp` is set nowhere (`pathDefaults`, `mediamtx.yml:88-93`; no hit in the repo).
  `hlsAlwaysRemux: true` (`mediamtx.yml:62`) means the source muxer always runs.
- **Ladder rungs.** One ffmpeg decodes the source over RTSP, splits, scales, encodes each rung and
  publishes it back to MediaMTX as its own path (`services/media/src/ffmpeg/args.ts:105-128`,
  `mediamtx.yml:118-122`). MediaMTX stamps each rung when the encoded frame arrives, so rung PDT is
  source receipt plus that rung's decode/scale/encode delay, which differs per rung. The WHIP
  AAC-copy path is the same shape (`args.ts:130-163`). The ladder starts and stops mid-broadcast on
  viewer hysteresis (`services/media/src/transcode/controller.ts:88-118`, start after 30 s,
  `services/media/src/settings.ts:49`). Forced keyframes are every 2 s of ffmpeg output time
  (`args.ts:76-78`), which starts at 0 per ladder run.
- **Recorder.** A separate `-c copy` ffmpeg writes 4 s fMP4 HLS (`args.ts:177-207`,
  `settings.ts:55`) with ffmpeg's `program_date_time` flag (`args.ts:204`): PDT is the recorder
  process's clock when its muxer starts (after probing the input), plus summed segment durations.
  The media service parses it (`services/media/src/vod/playlist.ts:37-39`), re-emits it into the
  VOD playlist (`playlist.ts:71`) and cuts clips by those wall-clock windows
  (`services/media/src/vod/recorder.ts:132-146`, `playlist.ts:95-117`). Every restart is a new run
  with a new anchor (`recorder.ts:102-106`). Summed durations follow the encoder's clock, so the
  anchor also drifts from wall clock over a long broadcast.
- **Delivery passes PDT through untouched.** The origin rewrites only URIs
  (`services/origin/src/playlist.ts:78-90`, called at `services/origin/src/handler.ts:142`); the
  relay is tested to do the same (`relay/internal/hls/rewrite_test.go:48-63`). The player reads it
  (`apps/web/src/player/controller.ts:161-171`).
- **Measurement exists.** Simulated streamers burn the capture epoch ms into every frame
  (`harness/src/timestamp-strip.ts:4-17`, geometry proportional so it decodes from any rung,
  `:38-43`), and the HTTP viewer can decode it from downloaded segments
  (`harness/src/http-viewer.ts:42-43`, `:367-374`).

No skew is measured today, so the baseline is unknown. All services run on one host (ADR 0025),
so the containers share one kernel clock; at S1 stage 2+ (ADR 0032) they will not. Nothing in
`scripts/selfhost.sh` or `infra/` checks time sync.

## Decision

### 1. The media clock is the ingest wall clock

**Context.** Three clocks could define "when a frame happened": the encoder's (RTCP sender reports
for WHIP; RTMP carries none), MediaMTX's at receipt on the source path, or a later hop's.

**Options.** (a) Ingest receipt at MediaMTX on `live/<slug>`. (b) The encoder's clock via
`useAbsoluteTimestamp` on the ingest path. (c) The origin's clock.

**Recommendation: (a).** It is the PDT the source rendition already carries, it is on a host we
run, and it exists for both RTMP and WHIP. (b) trusts an unsynced home PC, is absent for RTMP and
would let a streamer move their own media time. (c) is after the transcode, so it inherits the
per-rung error this ADR removes.

**Consequences.** The ingest path regex (`mediamtx.yml:103`) keeps receipt stamping and never gets
`useAbsoluteTimestamp`. Every other output (rungs, AAC copy, recorder, later captions and DVR) is
defined as correct when its PDT for a frame equals the source path's PDT for that frame.

### 2. Host clocks are NTP-disciplined and checked

**Context.** (a) holds on one host for free. Once MediaMTX, media and origin run on different hosts,
their clocks must agree to well under the 100 ms budget.

**Options.** (a) Require chrony (or systemd-timesyncd) and check sync at install and in health.
(b) Measure per-host offsets in the application. (c) Do nothing until multi-host.

**Recommendation: (a).** `selfhost.sh` warns at install, and does not refuse, when the host
reports no NTP sync (`timedatectl show -p NTPSynchronized`); the operator guide requires sync, and
the media service reports the host's sync state (a metric and a logged warning, never a failed
health check). Budget: host offset < 10 ms, an order of magnitude inside
the skew target. (b) re-implements NTP; (c) leaves a silent failure for self-hosters who split
hosts first.

**Consequences.** A small `selfhost.sh` change outside W0-clock's paths: W0-clock sends the exact
lines as a contract request, and the orchestrator applies them after P1-turn (which owns
`selfhost.sh` in that wave) merges. Monitoring alarms on unsynced hosts with the S1 host metrics
(ADR 0032 §6).

### 3. Rungs carry the source clock (spike-gated)

**Context.** Rung PDT is restamped at MediaMTX after a variable, per-rung pipeline delay. The fix
has to keep LL-HLS (the origin depends on MediaMTX's LL-HLS, `services/origin/src/llhls.ts`).

**Options.**

- **A. Carry source time through the transcoder.** The ladder (and AAC copy) keeps source
  timestamps (`-copyts`), its RTSP output's sender reports map them to the source's wall clock,
  and the rendition paths set `useAbsoluteTimestamp: true` so MediaMTX stamps PDT from those
  reports instead of arrival. All in W0-clock's paths (`args.ts`, `mediamtx.yml`).
- **B. Measure and correct.** `services/media/src/clock` measures each rung's offset from the
  source and publishes it (Valkey); the origin subtracts it from rung PDT when it rewrites
  playlists. Needs an origin change (not W0-clock's path), every relay and CDN pull sees the
  corrected text only through the origin, and production measurement needs frame correspondence
  across a re-encode (for example PDQ matching of sampled frames, which `packages/moderation`
  already implements), which is approximate on low-motion content.
- **C. One muxer for all rungs.** ffmpeg writes every rung as HLS from one process
  (`-var_stream_map`), so PDT is aligned by construction. Rejected: ffmpeg has no LL-HLS parts, so
  this gives up the 200 ms parts and blocking reloads.

**Recommendation: A, decided by a one-day spike at the start of W0-clock; B if the spike fails.**
If any point below fails, W0-clock stops after the spike and the orchestrator re-briefs the unit
for B (and decides then where the origin change lands). A adds no moving parts at runtime and fixes the error where it is created. The spike must show, with
the media image's Debian ffmpeg (`infra/containers/service.Containerfile:87`) and MediaMTX 1.21.2:

1. MediaMTX sends sender reports to RTSP readers that carry its receipt clock for the source path.
2. ffmpeg's RTSP output can anchor its sender reports to the input's source clock under
   `-copyts` (libavformat derives them from the muxer's `start_time_realtime`; whether the CLI
   carries the input's value across, or media must pass it, is what the spike settles).
3. MediaMTX 1.21.2 honours `useAbsoluteTimestamp` for an RTSP publisher and stamps HLS PDT from it.
4. The `clock-skew` scenario (decision 5) passes on a ladder started mid-broadcast.

**Consequences.**

- `-copyts` changes what `t` means in `-force_key_frames expr:gte(t,n_forced*2)` (`args.ts:78`):
  with a large starting `t` it forces a keyframe on every frame until `n_forced` catches up. The
  expression must become relative to the first frame (or use `prev_forced_t`), with a unit test.
  Keyframes then fall on source-time multiples of 2 s, which also aligns segment boundaries across
  rungs started at different times.
- A ladder restart no longer moves rung PDT: the anchor is the source's, not the run's.
- The audio rung and the AAC-copy path get the same flags and must be covered by the same unit
  tests even though the scenario cannot read a strip from audio.

#### Spike result and choice: variant A2 (2026-10-27)

The spike ran on 2026-10-27 with the media image's ffmpeg 7.1.5 and MediaMTX 1.21.2; commands,
versions and numbers are in [`services/media/src/clock/README.md`](../../services/media/src/clock/README.md).

- **Option A as written fails on point 2, so point 4 fails.** Points 1 and 3 hold (MediaMTX sends
  sender reports to RTSP readers; it honours `useAbsoluteTimestamp` for an RTSP publisher, −1 ms on
  every segment). But each RTSP reader session gets its own time origin (the first sender report
  that session received), the ffmpeg CLI does not carry it to the output, and nothing prints it.
  `-copyts` alone left rungs 1.5 s to 3 s late; guessing `-start_time_realtime` from the spawn time
  gave +5 to −72 ms on an idle host and −950 ms in a container. Neither is anchoring.
- **Variant A2 passes.** The ladder reads the source over **SRT** instead of RTSP. MediaMTX gives
  SRT readers MPEG-TS on the path's own stream timeline, which is the same for every reader
  session, and its LL-HLS muxer writes `tfdt` from that timeline plus a fixed 10 s. Media computes
  the source's wall-clock epoch from one LL-HLS segment,
  `W0 = PDT(segment) − (tfdt(segment) / timescale − 10 s)`, reads with `-copyts`, and passes
  `-start_time_realtime W0·1000` on every RTSP output; the rendition paths set
  `useAbsoluteTimestamp`. Measured: rung − source = **+12 ms on every segment**, the same across
  three ladder starts.
- **The maintainer chose A2 on 2026-10-27.** Option B is not needed. Points 1 to 3 above stay true
  of A2 except that the anchor comes from W0, not from the reader's sender reports.

**Consequences of A2** (in addition to the ones above, which still apply):

- **SRT on, unpublished.** `mediamtx.yml` sets `srt: yes` (today `srt: false`). The SRT port (8890/udp)
  stays unpublished in `compose.yaml` and the Quadlet unit, so only the internal network reaches it.
  The auth hook is protocol-agnostic (`services/api/src/media/auth.ts`): reads need the internal
  credentials, and publishing `live/<slug>` over SRT would need the stream key, as RTMP does.
  Media needs the SRT address as configuration (`MEDIAMTX_SRT_URL`, beside `MEDIAMTX_RTSP_URL`).
- **The internal secret moves into the SRT `streamid`** (`streamid=read:live/<slug>:internal:<secret>`).
  `redact()` masks URL userinfo by pattern but not a `streamid`; the redaction pattern learns that
  form, and a test asserts it is masked even when the caller does not list the secret.
- **Version coupling.** A2 depends on two MediaMTX internals: one MPEG-TS timeline shared by all SRT
  reader sessions, and the 10 s offset between that timeline and LL-HLS `tfdt`. An integration test
  against the pinned MediaMTX image asserts both, so an upgrade that changes either fails the gate.
- **PTS wrap.** MPEG-TS PTS wraps at 2^33 / 90 kHz (about 26.5 h). ffmpeg unwraps within one
  session, but W0 is rebased (computed modulo the wrap period) for every ffmpeg start, so a ladder
  started after a wrap is still anchored. Covered by unit tests on both sides of the wrap.
- **Latency.** SRT adds its receive latency (default 120 ms, configurable on the internal network)
  to rung latency. It does not move PDT.
- **Opus over MPEG-TS is untested.** WHIP sources carry Opus; the AAC copy and the audio rung would
  read it over SRT. W0-clock proves it before relying on it; if Opus does not survive, the unit
  stops and the choice is revisited.
- **The recorder can be exact without keyframe matching.** A recorder reading SRT with `-copyts`
  writes fMP4 whose `tfdt` is the shared timeline, so its exact PDT is `W0 + tfdt`. This may
  simplify or replace R1 (decision 4); the W0-clock brief decides which.

### 4. The recorder is re-anchored to the source clock

**Context.** The recorder's PDT is wrong at start (anchored after input probing) and drifts. The
live-to-VOD budget is 250 ms.

**Options.**

- **R1. Keyframe match.** Because the recorder copies (`-c copy`), its first video sample in a run
  is byte-identical in its slice data to the same sample in the source path's always-on LL-HLS
  muxer. `services/media/src/clock` fetches the source's recent parts from MediaMTX over the
  internal network, hashes the largest NAL unit of each keyframe, finds the recorder's keyframe and
  records `offset = sourcePDT − recorderPDT`. It re-matches every few minutes to remove drift and
  on every new run. The recorder applies the offset to `startedAt` before it renders the VOD
  playlist. Exact to the frame; audio-only sources match on AAC frames instead.
- **R2. MediaMTX native recording** (`record: true`, fMP4) on the source path, whose segment times
  come from the same clock as the source PDT. Removes a process, but rewrites the recorder,
  clip lookup and VOD upload around MediaMTX's file layout. Better considered with DVR (ADR 0016).
- **R3. Tune ffmpeg** (`-fflags nobuffer`, small `-probesize`/`-analyzeduration`) to shrink the start
  error. Narrows the error but bounds neither it nor the drift.

**Recommendation: R1.** It is deterministic, uses data the stack already produces, lives in
W0-clock's `clock/**`, and leaves the recorder's file handling alone.

**Consequences.** R1 needs one hook in `recorder.ts` (apply the offset as segments are discovered,
`recorder.ts:160-177`), and `recorder.ts` belongs to W0-media-exposure in this wave. The contract
step lands the hook (an injected `ClockAnchor` with an identity default) so both units stay on
disjoint files. Segments uploaded before the first match are re-stamped when the playlist is next
rendered (`renderPlaylist` rewrites the whole playlist, `playlist.ts:53-76`). Existing VODs keep
their old PDT; nothing is migrated.

**Update with A2 (2026-10-27).** The W0-clock brief replaces R1 with the exact derivation A2 makes
possible (call it R4): the recorder reads SRT with `-copyts` like the ladder, and each run's
offset is `W0 + tfdt(first sample) − recorderPDT(first segment)`, applied through the same
`ClockAnchor` seam, with no keyframe hashing and no drift re-matching. The brief's first step
checks that the recorder's `tfdt` really is the shared timeline; if not, R1 stays the plan as
written above. The recorder, recovery and finalize files are W0-clock's in its wave, so the hook
is no longer split across units.

### 5. Targets and how they are measured

**Targets** (from W0-prerequisites): **cross-rendition skew < 100 ms**, **live-to-VOD skew
< 250 ms**.

**Measurement: the new `clock-skew` harness scenario.**

- A simulated streamer with the timestamp strip publishes over RTMP, then over WHIP (which adds
  the AAC-copy path). The scenario holds viewers over the transcode threshold so the ladder runs,
  then forces one ladder stop/start and one recorder restart mid-broadcast.
- An HTTP viewer per video rendition (source and each rung) fetches through the origin, so it sees
  PDT exactly as players do, and decodes the strip from the first frame of each segment. For each
  sample, `e = PDT − strip`. The streamer's clock offset cancels, because every comparison is a
  difference of `e` for the same capture instant.
- **Cross-rendition skew** at a capture instant = `max(e) − min(e)` across renditions, pairing
  samples by strip time. Pass: p95 < 100 ms, every rendition present for at least 2 minutes,
  including the minute after the ladder restart.
- **Live-to-VOD skew** = `|e_vod − e_source|` for the same strip times, read from the published VOD
  playlist after the broadcast ends, across the recorder restart's discontinuity. Pass: p95
  < 250 ms.
- The statistic is p95, not every sample: one late frame right after a restart does not fail
  the gate.
- The audio-only rung is not measured (it carries no strip). Its flags, and the AAC-copy path's,
  are covered by unit tests (decision 3).
- Resolution is one frame (33 ms at 30 fps), well inside both budgets.
- Unit tests in `services/media` cover the keyframe-expression fix, the anchor arithmetic, drift
  re-anchoring and the audio-only match. The scenario also records today's baseline on its first
  run against `main` before the fix, so the change is measured, not assumed.

## Consequences

- W0-clock's paths stay as planned (`args.ts`, `clock/**`, `mediamtx.yml`) plus two requests
  outside them: the `recorder.ts` hook (contract step) and the `selfhost.sh` sync check (R0/S1
  owner). If the spike picks B, W0-clock also needs `services/origin/src/playlist.ts`, which moves
  the origin into W0's file plan. With A2 (decision 3, 2026-10-27) the origin stays out; W0-clock
  also needs the SRT reader inputs in the transcode and recorder code, and a `MEDIAMTX_SRT_URL`
  setting from the config owner.
- The Spine, DVR and captions can treat PDT as authoritative media time. Clip cuts by wall clock
  (`recorder.ts:132`) become accurate to the source.
- Relays and the CDN need no change: they pass PDT through.
- A production skew gauge (feature-wins §6) is cheap for the recorder (the R1 offset is the gauge)
  and costly for rungs (frame matching across a re-encode). This ADR asks only for the recorder
  gauge; the harness carries rung skew. No production rung-skew gauge is required before W1; it is
  reconsidered with DVR (ADR 0016).

## Deferred to W1 (part 2: Timeline Spine)

Settled in an amendment to this ADR before the W1 contract step, not here: the `media_ts` clamp
(`startedAt` bound, 60 s window, DVR null), presentation-queue defaults, IRC and bot behaviour
without `mediaTs`, and **chat retention and replay** (the retention period, replay exclusions and
blocks, the disclosure that live chat is replayed). W1-spine starts after both halves are accepted.

## Decisions at acceptance (2026-10-27)

The maintainer accepted part 1 with the recommended answers. Where an answer differs from the
draft, the text above was updated to match.

1. **Spike-gated choice.** Accepted: option A, decided by a one-day spike at the start of
   W0-clock. If the spike fails, the unit stops and the orchestrator re-briefs it for B.
2. **Where B's origin change goes.** Not decided now: it is settled in that re-brief, if B is
   needed.
3. **Statistic.** p95, as drafted.
4. **Audio-only rung.** Left out of `clock-skew`; no tone markers. Unit tests cover its flags.
5. **`selfhost.sh` on an unsynced host.** Warns, does not refuse. This differs from the draft,
   which had it refuse; decision 2 now says warn. The check arrives as a contract request from
   W0-clock, applied after P1-turn merges.
6. **Production rung-skew gauge.** Not required before W1. The harness and the recorder offset
   gauge suffice until DVR.

The `ClockAnchor` hook in `services/media/src/vod/recorder.ts` (decision 4) lands in the W0
contract step, as drafted.

## Amendment 1: part 2, Timeline Spine

- Status: accepted (2026-10-27; the maintainer accepted the recommended answers, see
  [Amendment 1 decisions at acceptance](#amendment-1-decisions-at-acceptance-2026-10-27))
- Date: 2026-10-27 (code checked at `ccf9c17`)
- Scope: what [Deferred to W1](#deferred-to-w1-part-2-timeline-spine) lists: the `media_ts` clamp,
  presentation-queue defaults, IRC and bot behaviour without `mediaTs`, and chat retention and
  replay. It gates the W1 contract step and W1-spine
  ([W1-quick-wins](../../.claude/briefs/next/W1-quick-wins.md), feature-wins §4.3).

**Counsel has not reviewed the retention periods or the disclosure text.** The privacy policy is a
draft "pending lawyer review" (`packages/db/src/legal/privacy.md:6`), and this amendment adds to
that draft. Acceptance covers the mechanism (what is kept, for how long, what replay hides), not
legal sufficiency. This is not legal advice.

### Context

Part 1 makes PDT the ingest wall clock on every rendition and in the VOD. Part 2 decides how chat
is placed on that clock. What the code has at `ccf9c17`:

- **Chat rows carry receive time only.** `chat_messages` has `created_at`, `broadcast_id`,
  `held_at`, `deleted_at` and indexes on `(channel_id, created_at)` and `(user_id, created_at)`
  (`packages/db/src/schema/chat.ts:11-38`). The chat core stamps `createdAt` from `receivedAt` and
  copies `channel.liveBroadcastId` into `broadcastId` (`services/chat/src/core.ts:130-144`), so
  chat sent while a channel is offline has a null broadcast. Rows are written in batches by
  `services/chat/src/persistence.ts`.
- **The wire has no media time.** The client `send` frame is channel, body, reply, action and nonce
  (`packages/contracts/src/chat.ts:18-25`); the server `message` frame carries a `ChatMessage`
  (`chat.ts:87-93`, `packages/contracts/src/api/entities.ts:321`). The IRC gateway builds the same
  `send` frame with no room for a timestamp (`services/irc/src/session.ts:408`).
- **The player can already read media time.** `latencySeconds()` uses `hls.playingDate` and
  Safari's `getStartDate()` (`apps/web/src/player/controller.ts:161-171`). It subtracts PDT from the
  viewer's own `Date.now()`, so the heartbeat's `latencySeconds`
  (`packages/contracts/src/api/entities.ts:292`, stored as `playback_sessions.latency_ms` at
  `services/api/src/routes/playback.ts:244`, column at `packages/db/src/schema/delivery.ts:87`)
  includes the viewer's clock error. The PDT itself does not.
- **Broadcast start** is `broadcasts.started_at` (`packages/db/src/schema/media.ts:48`).
- **Moderation state on rows.** A moderator delete sets `deleted_at` and `deleted_by`
  (`services/chat/src/moderation.ts:274`); approving a held message clears `held_at`
  (`services/api/src/chat/held.ts:121`). `/clear` writes a `mod_actions` row and broadcasts a
  `clear` frame but changes no message rows (`moderation.ts:298-303`). Bans and timeouts do not
  touch message rows either.
- **Retention.** Nothing deletes chat today except account deletion, which deletes the user's rows
  (`services/worker/src/deletion/account-deletion.ts:285-288`). The privacy draft keeps "content"
  until the user deletes it (`privacy.md:70`), and chat is listed as content (`privacy.md:20`).
  A report on a chat message copies the body into the report's evidence
  (`services/api/src/routes/safety.ts:79-80`), so a report survives the message. No "report
  window" constant exists in code; this amendment defines one for chat.
- **VOD lifetime.** A VOD gets `expires_at = now + channels.vod_retention_days`
  (`services/media/src/vod/finalize.ts:288`), default 14 days
  (`packages/db/src/schema/channels.ts:55`), at most 60 (`packages/contracts/src/api/router.ts:72`).
  `vod-retention` deletes expired VODs unless the owner is under a legal hold
  (`services/worker/src/housekeeping.ts:102`, `:142`). Clips store `start_offset` from the
  broadcast start and may outlive their VOD (`clips.vod_id` is `set null`,
  `packages/db/src/schema/media.ts:171-196`).
- **No user blocks.** There is no table, procedure or UI for one user blocking another anywhere in
  the repository (no hit for a blocks table in `packages/db/src/schema/`, `packages/contracts` or
  `apps/web`). The accepted replay rule about blocks needs one (decision 8).

### Decisions

#### 1. `mediaTs` and `playbackMode` on the wire; `media_ts` on the row

The W1 contract step adds optional `mediaTs` (ISO 8601 with offset) and `playbackMode`
(`live | dvr`) to the client `send` frame, and `mediaTs` (nullable) to `ChatMessage`; a migration
adds nullable `chat_messages.media_ts timestamptz` and an index on `(broadcast_id, media_ts)`.

**Why.** `mediaTs` is the PDT under the sender's playhead (`playheadWallclock()`, a new player
seam W1-spine adds to `controller.ts` on top of the existing `hls.playingDate` read), which part 1
makes the same on every rendition, so it does not depend on the sender's clock.
`playbackMode` lands now so DVR (ADR 0016, W2) needs no second contract change. The index leads on
`broadcast_id`, not `channel_id` as feature-wins §4.3 drafted it, because replay always asks for
one broadcast's chat (a VOD and a clip each belong to one broadcast).

#### 2. The clamp: receive time stays authoritative, `media_ts` is a bounded hint

New `services/chat/src/clamp.ts`, pure, called by the pipeline before the row is queued:

- **Live mode, live channel:** `media_ts = clamp(mediaTs, max(receive − 60 s, startedAt), receive)`,
  where `startedAt` is the live broadcast's `started_at`. A value in the future becomes receive
  time; a value before the window becomes its lower edge.
- **Channel not live** (no live broadcast): the hint is dropped (`media_ts` null). The message is
  still accepted; offline chat is ordinary chat. (Feature-wins §4.3 says the hint is "rejected for
  non-live channels"; this reads that as rejecting the hint, not the message.)
- **DVR mode:** `media_ts` is null whatever the client sent. Replay places the message at its
  receive time with a "said while catching up" label.
- **Missing `mediaTs`** in live mode (IRC, bots, the HTTP chat API, old clients): decision 4.

**Why.** Report evidence, rate limits, retention and moderation all keep using `created_at`; the
clamp only limits how far a sender can move their own line in replay. 60 s covers LL-HLS at its
worst plus a slow mobile network; a larger window lets a sender plant a line next to a moment they
never saw. The `startedAt` bound stops a line landing before the broadcast exists.

#### 3. Presentation queue defaults

New `apps/web/src/chat/presentation.ts` holds an item until `playheadWallclock()` reaches its
media time:

- **On by default for overlays and alerts** (polls, follows, tips): the alert fires when the
  viewer's playhead reaches the moment, not when the server sends it.
- **Off by default for chat lines.** Live chat renders on arrival, as today. A per-device opt-in to
  sync chat to the video may ship if the usability test in feature-wins §4.3 supports it; it is
  stored in `localStorage` (wrapped in try/catch) and defaults off.
- **Own messages echo instantly**, whatever the setting.
- **The creator dashboard shows real time**: the streamer is at the ingest, so holding anything
  back for them would only add delay.
- **Bounded hold.** An item is held at most 60 s (the clamp window), then shown. In `dvr` mode the
  queue does not hold live alerts at all; they go to the alert history only, because they belong
  to the live edge the viewer is not watching.

**Why.** Debate item 10 resolved hold-back as overlays-only. Delaying chat lines by default hides
the conversation from the people having it.

#### 4. IRC, bots and HTTP senders: receive time minus the channel's median latency

When a live-mode message has no `mediaTs`, `media_ts = clamp(receive − L, …)` with the same bounds
as decision 2, where `L` is the channel's median viewer latency from a new
`KEYS.chatLatency(channelId)` (STRING, seconds, TTL 60 s). With no key, `L = 0`.

- **Writer.** The integrity worker, on each scoring pass (every 15 s,
  `services/worker/src/integrity/jobs.ts:42`), computes the median of `latency_ms` over the
  channel's live, gate-eligible sessions (`GATE_ELIGIBLE`, `packages/integrity/src/jobs.ts:47`),
  capped to [0, 60] s, and writes the key only when at least 3 such sessions report a latency.
  It lives in a new `services/worker/src/integrity/chat-latency.ts`.
- **Why the median of gate-eligible sessions.** Each sample carries the viewer's clock error
  (Context), and bots could report any latency they like. The median of verified, fetch-judged
  sessions ignores both; the cap and the clamp bound the rest.
- **`services/irc` does not read or send `mediaTs`.** IRC has no field for it, and an IRCv3 client
  tag would reach almost no clients. The gateway keeps building the frame it builds today.
- **Bot replies are not special-cased.** A bot that answers a command gets the channel median like
  any other sender without a playhead. Inheriting the triggering message's `media_ts` is a possible
  later refinement, not needed for v1.

#### 5. Live chat is replayed alongside VODs and clips

Replay procedures `vods.chat` and `clips.chat` return a broadcast's chat ordered by
`coalesce(media_ts, created_at)`, paged by a media-time cursor (at most 500 messages a page). A
VOD's window is its recording span; a clip's is the wall-clock window it was cut from (the
recorder clock, aligned by part 1). Handlers live in a new `services/api/src/chat-replay/`; the
procedures attach to the VOD and clip routes (the W1 plan lifts the old "E6 owns" restriction).

**Why.** Replay is most of the Spine's value: synced chat is what makes a VOD or clip read like
the live moment, and a clip without its chat loses the reaction that made it worth clipping.

#### 6. Retention: 30 days, or as long as the VOD, never more than 60 days

A message is deleted when **it is older than `CHAT_RETENTION_DAYS` (default 30) and its broadcast
has no VOD that still exists**, or when **it is older than `CHAT_REPLAY_MAX_DAYS` (default 60)**,
whichever comes first.

- Chat attached to a VOD lives as long as that VOD, capped at 60 days. A VOD that expires at 14
  days leaves its chat to the 30-day rule. Chat with no VOD (VOD off, VOD deleted, or sent while
  offline) is deleted at 30 days.
- Both are operator settings in `packages/config` (new), with `.env.example` and
  `docs/self-hosting/configuration.md` entries. Config validation requires
  `CHAT_REPLAY_MAX_DAYS >= CHAT_RETENTION_DAYS`. The 60-day default matches the per-channel VOD
  retention ceiling (`router.ts:72`), so no VOD outlives its chat by default.
- **Clips follow the message rule.** A clip keeps no chat of its own: once the messages in its
  window age out, `clips.chat` returns none and the UI says chat is no longer kept.
- **The job.** A new `chat-retention` worker job (`services/worker/src/jobs/chat-retention.ts`)
  deletes in batches under a run lock, like `vod-retention`, and skips messages whose author is
  under a legal hold (the `ownerHeld` pattern, `housekeeping.ts:102`). A new index on
  `chat_messages (created_at)` keeps the scan cheap.
- **30 days is the chat report window.** A message can be reported while it exists; a filed report
  already keeps the body as evidence (`safety.ts:79-80`), so deleting the row later loses nothing
  the report needs.
- **No clean-up migration.** There is no public instance and no self-hoster, so the first run of
  the job simply applies the rule to whatever chat staging has.

**Why.** GDPR data minimisation (Art. 5(1)(c), (e)): keep chat as long as it serves the purpose
viewers can see, replay, and no longer. Unbounded retention of every chat line had no purpose
written down anywhere.

#### 7. What replay hides

Replay returns only what the live room could still see and what this viewer chose to see:

- **Deleted and moderated messages are excluded:** `deleted_at` set (author or moderator, or a
  report resolution), `held_at` still set (never approved), messages sent before a `/clear` in the
  same broadcast (`mod_actions` `clear_chat`), and messages by a user who was banned or timed out in
  the channel during that broadcast, sent before the ban (what live viewers saw purged).
- **Accounts:** messages by a platform-suspended user are hidden while the suspension lasts;
  messages by a user under a permanent channel ban are hidden on all of that channel's replays.
  Deleted accounts' messages are already gone (Context).
- **Blocked users are hidden from the viewer who blocked them** (decision 8). Replay for a
  signed-in viewer is therefore filtered per viewer and never shared-cached.
- **Removed or restricted media:** replay is served exactly when the VOD or clip itself is
  playable to this viewer (status, removal, visibility and the 18+ gate, as its playback path checks
  them). A removed VOD has no replay; a `subscribers` VOD's replay is for subscribers.

**Why.** Replay must not undo moderation, and a block that stopped at live chat would be a block
in name only.

#### 8. Blocks need a block feature

No user-block feature exists (Context). The W1 contract step adds the minimum replay needs: a
`user_blocks (user_id, blocked_user_id, created_at)` table (personal data, deleted with either
account, never in append-only columns) and `me.blocks.{list,add,remove}`. Hiding blocked users in
live chat and the block action in the chat user card belong with it in one W1 unit, so a viewer
can make a block that replay then honours. Until that ships, replay's block filter is written
against the table and tested with seeded rows.

**Why.** The accepted rule cannot be met without blocks. Building replay first and blocks later
would ship a disclosure that promised something the product could not do.

#### 9. Disclosure

- **Privacy policy.** The draft's "What you publish" and "How long we keep it" sections say that
  live chat is saved with the broadcast, replayed beside the VOD and its clips, and deleted after
  `CHAT_RETENTION_DAYS`, or with the VOD and at most after `CHAT_REPLAY_MAX_DAYS`; and that deleted
  and moderated messages are never replayed. The edit takes a new `PRIVACY_SEED_VERSION`
  (`packages/db/src/legal/index.ts:31`), so signed-in users accept it again, as the P2P section did.
- **Chat UI.** A short line in the chat panel, `chat.replayDisclosure` in the web catalog
  (`apps/web/src/i18n/`), says chat is saved with the VOD, with a link to the privacy policy. It is
  shown in the chat input area, not as a modal.

**Why.** Someone chatting live should not learn from a VOD that their words were kept.

### Consequences

- **W1 contract step (orchestrator):** the `send` frame and `ChatMessage` fields, the
  `chat_messages.media_ts` migration with the `(broadcast_id, media_ts)` and `(created_at)` indexes,
  `KEYS.chatLatency`, the `user_blocks` table and `me.blocks.*` procedures, the `vods.chat` and
  `clips.chat` contracts, the `CHAT_RETENTION_DAYS` and `CHAT_REPLAY_MAX_DAYS` settings, and the
  `chat-retention` and chat-latency registrations in `services/worker/src/jobs/{index,names}.ts`.
- **W1-spine** owns `clamp.ts`, `persistence.ts` (writing `media_ts`), `presentation.ts`, the player
  seam, `chat-replay/**`, and needs two worker files its row in feature-wins §5 does not list:
  `services/worker/src/jobs/chat-retention.ts` and `services/worker/src/integrity/chat-latency.ts`.
- **Tests.** Clamp unit tests: window edges, before `startedAt`, future values, offline channel,
  DVR null, missing `mediaTs` with and without `KEYS.chatLatency`. Replay integration tests: every
  exclusion in decision 7, including a block, a `/clear`, a mid-broadcast ban and a restricted VOD.
  Retention integration tests: VOD alive past 30 days, VOD expired at 14 days, the 60-day cap,
  offline chat, a legal hold. Harness `timeline-sync`: two Chromium viewers at forced latencies on
  different rungs; replay order matches media time within 1 s.
- **Legal.** The privacy draft changes and is re-accepted. Counsel reviews the periods and the
  disclosure with the rest of the privacy draft before launch (L1).
- **Storage.** Chat stops growing without bound. Replay queries read one broadcast's rows through
  the new index.

### Alternatives considered

- **Client-supplied `mediaTs` unclamped.** Exact for honest clients, but any sender could place a
  line anywhere in the broadcast. Rejected; receive time stays authoritative.
- **Hold chat lines back by default.** Matches the video better, but delays the conversation for
  everyone in it (debate item 10). Rejected; overlays only.
- **Keep chat as long as the account (today's behaviour).** Simplest, but has no stated purpose
  past replay and moderation. Rejected on data minimisation.
- **Keep chat only as long as the VOD, with no floor.** A 14-day VOD would take its chat with it
  before the 30-day report window closes. Rejected; the 30-day floor stays.
- **Snapshot chat into the VOD's object storage.** Replay would survive message deletion, which is
  exactly what decision 7 forbids, and moderation after the fact would have to rewrite objects.
  Rejected; replay reads the live table with its exclusions.
- **Index `(channel_id, media_ts)`** as feature-wins drafted. Works, but every replay query is per
  broadcast. Replaced by `(broadcast_id, media_ts)`.

### Amendment 1 decisions at acceptance (2026-10-27)

The maintainer accepted part 2 with the recommended answers. **Counsel has not reviewed the
retention periods or the disclosure**; acceptance covers the mechanism.

1. **Replay.** Live chat is replayed alongside VODs (and their clips), decision 5.
2. **Retention.** Chat attached to a VOD is kept as long as that VOD exists, capped at 60 days;
   chat with no VOD is deleted after 30 days (the report window). Both are operator settings
   (decision 6).
3. **Exclusions.** Deleted and moderated messages are excluded from replay; users a viewer blocked
   stay hidden from that viewer in replay (decision 7). Because no block feature exists, the W1
   contract step adds the minimum one (decision 8).
4. **Disclosure.** The privacy policy says chat is saved with the VOD, and a line in the chat UI
   says so through an i18n key (decision 9).
5. **Why.** Replay is most of the Spine's value; bounded retention follows GDPR data minimisation.

Technical items (decisions 1 to 4) follow feature-wins §4.3 and the W1 plan, with two changes made
while checking the code: the replay index leads on `broadcast_id`, and the median latency is taken
over gate-eligible sessions only.

## History

- 2026-10-27: part 1 proposed and accepted (see [Decisions at acceptance](#decisions-at-acceptance-2026-10-27)).
- 2026-10-27: decision 3 amended after the W0-clock spike: option A as written failed (RTSP
  readers have per-session time origins); the maintainer chose variant A2 (SRT input, W0 from
  LL-HLS `tfdt`). Decision 4 notes that the W0-clock brief replaces R1 with the exact W0 + `tfdt`
  derivation, keeping R1 as the fallback.
- 2026-10-27: amendment 1 (part 2, Timeline Spine) proposed and accepted: the `media_ts` clamp,
  presentation defaults, IRC and bot behaviour, chat replay, retention, exclusions and disclosure
  (see [Amendment 1 decisions at acceptance](#amendment-1-decisions-at-acceptance-2026-10-27)).
