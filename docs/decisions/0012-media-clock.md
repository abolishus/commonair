<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0012: One media clock (part 1: alignment and skew targets)

- Status: accepted (2026-10-27; part 1 only, the six questions answered by the maintainer, see
  [Decisions at acceptance](#decisions-at-acceptance-2026-10-27))
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

## History

- 2026-10-27: part 1 proposed and accepted (see [Decisions at acceptance](#decisions-at-acceptance-2026-10-27)).
- 2026-10-27: decision 3 amended after the W0-clock spike: option A as written failed (RTSP
  readers have per-session time origins); the maintainer chose variant A2 (SRT input, W0 from
  LL-HLS `tfdt`). Decision 4 notes that the W0-clock brief replaces R1 with the exact W0 + `tfdt`
  derivation, keeping R1 as the fallback.
