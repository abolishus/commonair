<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W0-clock: one media clock for every rendition and the VOD

You are implementing unit W0-clock for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/W0-prerequisites.md`,
`docs/product/feature-wins.md` §4.3 "Timeline Spine" (design point 1) and §5 "Wave 0",
`.claude/briefs/w0/contract-step.md`, and
[ADR 0012](../../../docs/decisions/0012-media-clock.md) (part 1). Do not look outside the
repository. Work in your own git worktree on a branch named `w0/clock`, starting from the W0
contract-step commit.

Matches ADR 0012 part 1 as accepted on 2026-10-27 (its "Decisions at acceptance" section): the
media clock is the ingest wall clock (decision 1), rungs carry it through the transcoder (option A,
decided by your one-day spike; if A fails you stop and the orchestrator re-briefs for B,
decision 3), and the recorder is re-anchored by keyframe match (R1, decision 4). The pass
statistic is p95; the audio-only rung is not measured by `clock-skew`; `selfhost.sh` only warns on
an unsynced host; no production rung-skew gauge is required (the recorder offset gauge and the
harness suffice until DVR).

## Why

The Timeline Spine (W1), DVR and captions (W2) locate media by `EXT-X-PROGRAM-DATE-TIME` (PDT).
Today every output stamps its own PDT with "when I saw it": each ladder rung is restamped by
MediaMTX after its own decode/scale/encode delay, and the recorder's PDT is anchored when its
ffmpeg muxer starts and then drifts. One frame therefore has a different PDT on each rendition and
in the VOD. Targets: **cross-rendition skew < 100 ms, live-to-VOD skew < 250 ms** (p95, measured
by the new `clock-skew` scenario).

## You own (write only these)

- `services/media/src/ffmpeg/args.ts`
- `services/media/src/clock/**` (the contract step creates `clock/anchor.ts` with the
  `ClockAnchor` interface and `IDENTITY_CLOCK`; keep the interface, add the implementation)
- `services/media/src/service.ts`: only the line that sets `clock` on the context (contract step
  sets `IDENTITY_CLOCK`, about :168) and the start/stop of your anchor (with the service's own
  `start`/`stop`)
- `infra/mediamtx/mediamtx.yml`
- `harness/src/testing/mediamtx.ts`: only the rendition-path settings of `mediamtxConfig` (:44)
- `harness/scenarios/clock-skew.ts` (stub from the contract step) and new `harness/src/clock-skew*.ts`
- Tests: `services/media/tests/args.test.ts` (edit), new `services/media/tests/clock*.test.ts`
  and `clock*.int.test.ts`, new `harness/tests/clock-skew*.test.ts`

Not yours: `services/media/src/vod/**`, `clips.ts`, `lifecycle.ts`, `recovery.ts`, `jobs.ts`
(W0-media-exposure), `services/origin/**`, `scripts/selfhost.sh` and `compose.yaml` (P1-turn owns
them this wave), `harness/src/http-viewer.ts` and `harness/src/timestamp-strip.ts` (shared; import
them, do not edit), `harness/src/platform.ts` and `harness/src/proxy.ts` (P1's contract step edits
them this wave), `services/media/src/main.ts` and `packages/service/**`. Need a change outside your
paths? Do not make it: put the exact change in your final message as a contract request. The selfhost bundle already ships `infra/mediamtx/mediamtx.yml`
(`infra/quadlet/commonair-mediamtx.container:30`), so self-hosters get your MediaMTX change with no
selfhost edit.

## Contracts you must honor (read-only for you)

- `ClockAnchor` (`services/media/src/clock/anchor.ts`, contract step):
  `offsetMs(broadcastId, runId): number`, milliseconds added to the recorder's ffmpeg PDT for that
  run (`sourcePDT − recorderPDT`). The recorder already calls it everywhere a wall-clock time leaves
  it (contract step, `vod/recorder.ts` `pollOnce`/`localWindow`/`upload`). It must be synchronous
  and cheap: compute offsets in the background and return the latest (0 until the first match). If
  the seam is not enough, report a contract request; do not edit `recorder.ts`.
- Path names: `mediaPath`, `renditionPath`, `sourceAacPath` (`packages/contracts/src/internal.ts:31-42`).
  `MEDIAMTX_HLS_URL` (`compose.yaml:54`) is how media reaches MediaMTX's LL-HLS internally.
- The ingest path (`mediamtx.yml:103`, `~^live/[a-z0-9_]{3,25}$`) keeps receipt stamping and never
  gets `useAbsoluteTimestamp` (ADR decision 1: a streamer must not be able to move media time).
- Origin, relay and CDN pass PDT through unchanged (`services/origin/src/playlist.ts:78-90`,
  `relay/internal/hls/rewrite_test.go:48-63`). Keep it that way; option B (origin correction) is
  not this brief.
- Logs never carry the internal RTSP secret (`args.ts:19-28`, `ffmpeg/redact.ts`).

## What is there today (verified at `9c51c93`)

- MediaMTX `1.21.2-ffmpeg` (`compose.yaml:227`, `infra/quadlet/commonair-mediamtx.container:11`),
  LL-HLS with 1 s segments and 200 ms parts (`mediamtx.yml:58-68`), `hlsAlwaysRemux: true` (:62).
  `pathDefaults` (:88-93) and both path blocks (:103-116, :121-122) set no `useAbsoluteTimestamp`.
- The ladder: one ffmpeg reads the source over RTSP (`RTSP_IN`, `args.ts:19`), splits and scales
  once, encodes each rung and publishes it back to MediaMTX as `live/<slug>/<rung>` over RTSP
  (`ladderArgs`, `args.ts:105-128`). Encoder flags and the forced keyframes are in
  `videoEncoderFlags` (about :70-95; `-force_key_frames expr:gte(t,n_forced*2)` near :76-78).
  The WHIP AAC copy is `aacCopyArgs` (:134-163). The ladder starts and stops on viewer hysteresis
  (`services/media/src/transcode/controller.ts:88-118`, 30 s start delay `settings.ts:49`).
- The recorder: `recorderArgs` (:177-207) copies the source into 4 s fMP4 HLS (`settings.ts:55`)
  with `-hls_flags independent_segments+program_date_time+temp_file` (:203-204); each restart is a
  new `runId` (`vod/recorder.ts:102-106`) and segment files are `${runId}_%06d.m4s` (:202).
  `vod/playlist.ts` parses PDT (:37-39) and re-emits it (:71); clips are cut by those wall-clock
  windows (`recorder.ts:133-146`, `playlist.ts:95-117`).
- Measurement exists: simulated streamers burn the capture epoch ms into every frame
  (`harness/src/timestamp-strip.ts:4-17`, `decodeStrip` :121, geometry proportional so any rung
  decodes, :38-43); `HttpViewer` decodes it from downloaded segments (`decodeStripEvery`,
  `harness/src/http-viewer.ts:42-43`, :360-376) and reads each segment's `programDateTime`.
- Media's only HTTP surface is `/healthz` and `/readyz` (`services/media/src/main.ts:21`), served by
  `runService` from `@commonair/service` (`packages/service/src/server.ts:60-72`): the payload shape
  is fixed there, and each entry of `media.checks` (`service.ts:268`) throws when unhealthy, so a
  check fails `/readyz`. Metrics use OpenTelemetry instruments from `meter()` in
  `@commonair/observability` (pattern: `services/media/src/moderation/metrics.ts`).

## Build

0. **Spike first (time-box one working day).** Before writing production code, settle ADR 0012
   decision 3's four points with the media image's ffmpeg
   (`infra/containers/service.Containerfile:87`) and MediaMTX 1.21.2, using a throwaway local
   MediaMTX via the existing test helper (`harness/src/testing/mediamtx.ts`), not `podman compose`:
   1. MediaMTX sends RTCP sender reports to RTSP readers that carry its receipt clock for the
      source path;
   2. ffmpeg's RTSP output under `-copyts` can anchor its sender reports to that source clock
      (through `start_time_realtime` or whatever the CLI exposes; find out exactly);
   3. MediaMTX honours `useAbsoluteTimestamp: true` for an RTSP publisher and stamps HLS PDT from it;
   4. a ladder started mid-broadcast yields rung PDT equal to source PDT within a frame.
      Write the findings (commands, versions, measured numbers) into `services/media/src/clock/README.md`.
      **If any point fails, stop, commit the README and report**: do not start option B. The
      orchestrator re-briefs this unit for B (it needs `services/origin/src/playlist.ts` and a
      Valkey key, outside your paths, and where that origin change lands is decided then).
1. **Rungs carry the source clock** (`ladderArgs`, `aacCopyArgs`): `-copyts` and the sender-report
   anchoring the spike found, for every video rung, the audio rung and the AAC copy. Fix the
   keyframe expression so `-copyts` does not force every frame (ADR consequence: make it relative to
   the first frame or use `prev_forced_t`); keyframes then fall on source-time multiples of 2 s,
   which also aligns segment boundaries across rungs started at different times. Leave
   `recorderArgs` copying as it is unless the spike shows a flag that removes the start error
   cleanly (R3 alone is not the fix).
2. **MediaMTX**: `useAbsoluteTimestamp: true` on the rendition path block (`mediamtx.yml:121-122`)
   only, with a comment saying why the ingest block must never have it. Mirror it in
   `harness/src/testing/mediamtx.ts` so integration tests run the same config.
3. **Recorder anchor (R1)** in `services/media/src/clock/`: implement `ClockAnchor`. For each live
   broadcast with a recorder, fetch the source path's recent LL-HLS parts from MediaMTX
   (`MEDIAMTX_HLS_URL`, internal network; the source muxer always runs), find the recorder run's
   keyframes (the recorder copies, so slice data are byte-identical), hash the largest NAL unit of
   each keyframe on both sides, and record `offset = sourcePDT − recorderPDT` per `runId`. Re-match
   every few minutes (drift) and on every new run. Audio-only sources match on AAC frames. Bound
   memory and requests (only the newest parts; give up a match attempt after N parts; never block
   the recorder). Log counts and offsets only, never URLs with credentials. Start and stop it with
   the broadcast session from `service.ts` context wiring (not `session.ts`, which stays as is; if
   you need a per-broadcast start hook that is not in `service.ts`, report it).
4. **Gauge**: export the recorder offset as an OpenTelemetry instrument from `meter()` (new
   `services/media/src/clock/metrics.ts`), `media_clock_recorder_offset_ms` (no ids in attributes; a
   histogram of `|offset|` is fine), and a counter of failed matches. This is
   the production skew gauge ADR 0012 asks for; rung skew stays in the harness (no production
   rung-skew gauge, accepted answer 6).
5. **Host clock signal**: the health payload cannot carry an informational field (see "What is
   there today"), and a readiness check would fail `/readyz`. Instead, if the container can read the
   kernel's NTP sync status without new privileges or dependencies, export it as an observable gauge
   `media_clock_host_synchronized` (1 or 0; not reported when unreadable) from your metrics module,
   and log a warning once when it reads 0. Never fail health on it. If it is unreadable, say so in
   your final message; if you think it belongs in `/healthz`, send the `packages/service` change as
   a contract request.
6. **`selfhost.sh` NTP check** (ADR decision 2): not your file this wave (P1-turn owns it). Put
   the exact lines in your final message as a contract request, applied after P1-turn merges: a
   `timedatectl show -p NTPSynchronized --value` check in the install preflight that **warns and
   continues** (accepted answer 5: never refuse), names the operator guide's time-sync
   requirement, stays silent when the value is `yes`, says it could not check when `timedatectl`
   is absent, and needs no override flag since it never blocks.
7. **`clock-skew` scenario** (ADR decision 5) in `harness/scenarios/clock-skew.ts`, helpers in new
   `harness/src/clock-skew*.ts`:
   - A strip-burning streamer (`p.streamerFor`, as `integrity-basic.ts:41` does) publishes over
     RTMP, then a second run over WHIP (which adds the AAC copy). Hold enough HTTP viewers to cross
     `transcodeThreshold` so the ladder runs; force one ladder stop/start (drop below the threshold,
     wait out hysteresis, rise again) and one recorder restart mid-broadcast (find a way the harness
     already has to restart a media process; if none exists, report the hook you need).
   - One `HttpViewer` per video rendition (source and each rung) through the origin, with
     `decodeStripEvery: 1`; for each decoded segment `e = PDT − strip`. The audio-only rung is
     not measured (no strip in audio; no tone markers); its flags are covered by `args.test.ts`.
   - Cross-rendition skew per capture instant = `max(e) − min(e)` across renditions paired by
     strip time. Pass: p95 < 100 ms with every rendition present for ≥ 2 minutes, including the
     minute after the ladder restart.
   - Live-to-VOD skew = `|e_vod − e_source|` for the same strip times, read from the published VOD
     playlist and its segments after the broadcast ends, across the recorder restart. Pass: p95 <
     250 ms.
   - Metrics `crossRenditionSkewP95Ms`, `liveToVodSkewP95Ms` (and max); `--set assert=false` records
     them without asserting (the user's baseline run against `main` before your change).
   - Leave `inFull: false`; the orchestrator flips it and adds the scenario to `FULL_REQUIRED` on merge.

## Tests you must add

- `args.test.ts`: `-copyts` and anchoring flags on every ladder rung, the audio rung and the AAC
  copy; the keyframe expression with a large starting `t` (one forced keyframe per 2 s, not per
  frame); the recorder args unchanged unless you changed them on purpose; the ingest path
  untouched.
- A config test (new `services/media/tests/clock-config.test.ts`) that reads
  `infra/mediamtx/mediamtx.yml` and asserts `useAbsoluteTimestamp` is set
  on the rendition block and absent from `pathDefaults` and the ingest block.
- `clock` unit tests: NAL extraction and hashing on fMP4 fixtures (generate them with ffmpeg in
  the test or commit tiny fixtures under `services/media/tests/fixtures`), the anchor arithmetic,
  drift re-anchoring, a new run getting its own offset, no match → offset 0 and the failure counter,
  audio-only match, bounded work.
- An integration test (`clock*.int.test.ts`) against the test MediaMTX: publish a short strip
  stream, run the recorder path and the anchor, assert the anchored recorder PDT is within one
  frame of the source PDT.
- Scenario pure parts (pairing by strip time, p95, rendition coverage windows) in
  `harness/tests/clock-skew*.test.ts`.

## Done means

Follow `.claude/briefs/_done-means.md`, with this batch's rule: the orchestrator runs the gate; you
run targeted checks only and never run the gate, `podman`/`podman compose`, `scripts/infra.ts` or
harness scenarios. Run `bun run test` and `bun run test:int` in `services/media`, the new harness
tests (`bun --bun vp test run harness/tests/clock-skew*`), `bunx tsc -p services/media --noEmit`,
`bunx tsc -p harness --noEmit`, `vp lint --deny-warnings` and `vp fmt` on your paths. Commit in your
worktree (`git commit -s`, Conventional Commits, message ending with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Final
message: the spike findings (or why you stopped), the flags chosen and why, test counts per
package, branch and sha, contract requests (the `selfhost.sh` lines, any recorder-seam change, any
harness hook), what is left, and the exact commands the user should run live:
`bun harness/src/cli.ts run clock-skew --set assert=false` on `main` (baseline) and
`bun harness/src/cli.ts run clock-skew` on your branch.

## Contract step as landed

- Your base is main after the P1 contract step merge (`223b192`), which contains all of E7 and the W0 and P1 contract steps. Recheck line numbers against it.
- The migrations taken are `0028_enforcement_statements` and `0029_w0_protections`.
- The next free migration number is 0030.
- `0029_snapshot` is a copy of 0028.
- `MediaContext.clock` is set at `services/media/src/service.ts:207`, not around :168.
- `ClockAnchor` and `IDENTITY_CLOCK` are in `services/media/src/clock/anchor.ts`.
- The recorder already calls `ctx.clock.offsetMs(broadcastId, runId)` synchronously in `stamp()` (`recorder.ts:146`). It is used in three places:
  - `localWindow` (:153) re-stamps every local segment on each call.
  - `pollOnce` (:181) stamps `recordingStartedAt` when it first sees a segment (:189-191).
  - `upload` (:213) renders the VOD playlist from stamped segments.
- `runId` is created at `recorder.ts:117`. Segments resumed from storage have `runId: null`, so they are not stamped a second time.
- The playlist is re-rendered on every poll and uploaded only when its text changes. A side effect: a failed playlist upload is retried on the next poll.
- **Must fix (review finding 1): the crash-recovery path ignores the anchor.**
  - In `services/media/src/recovery.ts`, `recoverRecording` (:110) puts segments read from storage, whose times are already stamped, together with raw local run segments that it never stamps. It then orders and renders them with `segmentsToRecover` (:43).
  - `RecoveryDeps` has no `ClockAnchor`.
  - Fix: pass the anchor in and stamp the local run segments by `runId` before ordering and rendering, so a recovered VOD's times are not out of order. If recovery should stay raw instead, document why.
- **Must fix (review finding 2): `recordingStartedAt` is stamped once and never updated.**
  - The anchor interface allows a run to be re-anchored. After that happens, `localWindow` compares re-stamped segment times against a stale start time.
  - Fix: either derive `recordingStartedAt` in `localWindow` from the stamped segments, or store the raw value with its `runId` and stamp it when read.
- A `harness/scenarios/clock-skew.ts` stub exists with `inFull: false`.

## P1 contract step (merged before wave 2)

- `harness/src/proxy.ts` and `harness/src/platform.ts` changed additively: the tracker proxy, `ViewerMix.p2p` and `trackerProxyUrl`.
- `HARNESS_OVERRIDES` gained `harness/compose.p2p.yaml`.
- Any new harness override that sets api environment must also be mirrored in `compose.multi-instance.yaml`'s api-2, or `multi-compose.test` fails.
