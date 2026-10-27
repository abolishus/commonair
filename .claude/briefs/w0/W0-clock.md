<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W0-clock: one media clock for every rendition and the VOD (variant A2)

You are implementing unit W0-clock for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/W0-prerequisites.md`,
`docs/product/feature-wins.md` §4.3 "Timeline Spine" (design point 1) and §5 "Wave 0",
[ADR 0012](../../../docs/decisions/0012-media-clock.md) (part 1, including decision 3's
"Spike result and choice" and decision 4's "Update with A2"), and the spike write-up
`services/media/src/clock/README.md`. Do not look outside the repository. Work in your own git
worktree on a branch named `w0/clock`, starting from current `main` (wave 3: it contains all of
wave 2, including the merged spike).

This is the second run of this unit. The first run did the one-day spike and stopped as briefed:
option A with an RTSP reader fails (each RTSP reader session has its own time origin), and variant
**A2** passed (+12 ms on every segment, stable across three ladder starts). The maintainer chose
A2 on 2026-10-27. You implement A2. Decisions already settled, do not reopen them: the media clock
is the ingest wall clock (decision 1); the pass statistic is p95; the audio-only rung is not
measured by `clock-skew`; `selfhost.sh` only warns on an unsynced host; no production rung-skew
gauge is required.

**Decisions this brief makes** (ADR 0012 left them to it):

- **The recorder uses R4, not R1.** It reads SRT with `-copyts` like the ladder, and each run's
  offset is derived exactly (`W0 + first sample time − recorder PDT`), with no keyframe hashing and
  no drift re-matching. R1 (ADR decision 4) is the fallback only if Build step 0 shows the
  recorder's fMP4 times are not on the shared timeline.
- **W0 is fetched fresh for every ffmpeg start** (ladder, AAC copy, recorder), through the
  supervisor's async `args()`, and rebased modulo the MPEG-TS wrap. No background W0 loop is needed
  for the ladder.
- **Media gets the SRT address from a new `MEDIAMTX_SRT_URL` setting**, which the orchestrator adds
  before launch (see "Contracts").

## Why

The Timeline Spine (W1), DVR and captions (W2) locate media by `EXT-X-PROGRAM-DATE-TIME` (PDT).
Today every output stamps its own PDT with "when I saw it": each ladder rung is restamped by
MediaMTX after its own decode/scale/encode delay (+302 ms measured for one 240p rung), and the
recorder's PDT is the recorder process's clock when its muxer starts, plus summed durations. One
frame therefore has a different PDT on each rendition and in the VOD. Targets: **cross-rendition
skew < 100 ms, live-to-VOD skew < 250 ms** (p95, measured by the new `clock-skew` scenario).

How A2 works, in one paragraph. MediaMTX serves SRT readers MPEG-TS whose PTS is the path's own
stream timeline, identical for every reader session. Its LL-HLS muxer writes `tfdt` from the same
timeline plus a fixed 10 s. So one LL-HLS segment of the source gives the wall-clock time of
PTS 0: `W0 = PDT(segment) − (tfdt(segment) / timescale − 10 s)`. A ladder that reads
`srt://…?streamid=read:live/<slug>:internal:<secret>` with `-copyts` and passes
`-start_time_realtime <W0 in µs>` on each RTSP output sends sender reports that map every frame
to the source's wall clock, and MediaMTX stamps rendition PDT from them (`useAbsoluteTimestamp`
on the rendition paths). A recorder reading the same SRT with `-copyts` writes fMP4 whose times
are on that timeline, so its exact PDT is `W0 + time`.

## You own (write only these)

- `services/media/src/ffmpeg/args.ts`
- `services/media/src/ffmpeg/redact.ts` (the `streamid` pattern)
- `services/media/src/clock/**` (`anchor.ts` holds `ClockAnchor` and `IDENTITY_CLOCK`; keep both,
  extend the module additively; `README.md` is the spike record: append, do not rewrite it)
- `services/media/src/context.ts`: only clock-related fields of `MediaContext` (the `clock` field
  and, if you add one, the SRT base URL)
- `services/media/src/service.ts`: only the clock wiring (the `clock:` line at :206-207, the SRT
  base on the context next to `rtspBase` at :187, passing the anchor into `recoverWorkDir` at :297,
  and starting/stopping your clock module with the service's own `start` :288 / `stop` :326)
- `services/media/src/transcode/controller.ts`: only the ladder input/args lines (:132-139)
- `services/media/src/transcode/audio-compat.ts`: only the AAC-copy input/args lines (:102-109)
- `services/media/src/vod/recorder.ts`, `services/media/src/recovery.ts`,
  `services/media/src/vod/finalize.ts` (free this wave; W0-media-exposure owns nothing now)
- `infra/mediamtx/mediamtx.yml`
- `harness/src/testing/mediamtx.ts`: additive SRT support in `mediamtxConfig` and `startMediaMtx`
  (`srt: yes`, a published UDP port, an `srtUrl` field) and a rendition path block with
  `useAbsoluteTimestamp`
- `services/media/tests/helpers/containers.ts`: additive only (publish 8888/tcp and 8890/udp from
  `startMediaMtx`)
- `harness/scenarios/clock-skew.ts` (the contract-step stub) and new `harness/src/clock-skew*.ts`
- Tests: `services/media/tests/args.test.ts`, `recorder-clock.test.ts`, `recorder-prefix.test.ts`
  (edit as needed), new `services/media/tests/clock*.test.ts` and `clock*.int.test.ts`, new
  `harness/tests/clock-skew*.test.ts` and `harness/tests/clock-srt*.int.test.ts`

Not yours: `apps/web/src/player/**` and everything else P1-player writes in parallel this wave
(do not touch `apps/web/**`, `harness/scenarios/viewers*`, `harness/src/p2p.ts` or
`harness/src/web/**`); `services/origin/**`; `scripts/selfhost.sh`, `compose.yaml`,
`harness/compose*.yaml`, `infra/quadlet/**`, `infra/selfhost/**`; `packages/**` (config,
contracts, observability, service); `harness/src/http-viewer.ts`, `harness/src/timestamp-strip.ts`,
`harness/src/streamer.ts`, `harness/src/ffmpeg.ts` (shared: import them, do not edit);
`harness/src/platform.ts`, `harness/src/proxy.ts`, `harness/src/registry.ts`;
`services/media/src/main.ts`, `session.ts`, `clips.ts`, `lifecycle.ts`, `jobs.ts`, `thumbnails.ts`,
`simulcast.ts`, `health/**`, `moderation/**`. Thumbnails, simulcast, probes and the moderation
sampler keep reading RTSP: they carry no PDT. Need a change outside your paths? Do not make it: put
the exact change in your final message as a contract request.

## Contracts you must honor (read-only for you)

- **`MEDIAMTX_SRT_URL`** (added by the orchestrator before launch): in `mediaEnv`
  (`packages/config/src/env.ts`, next to `MEDIAMTX_RTSP_URL` :239), default `srt://localhost:8890`;
  `srt://mediamtx:8890` in `compose.yaml`'s shared env (:53-55), `harness/compose.multi-instance.yaml`
  (:35-37) and the Quadlet units that set `MEDIAMTX_RTSP_URL`
  (`infra/quadlet/commonair-media.container:31` and the others); `.env.example` (:98-100) and
  `docs/self-hosting/configuration.md` (:295-297). If it is not on your base, stop and report.
- **SRT stays internal.** The SRT port (8890/udp) is never published in `compose.yaml` or the
  Quadlet unit (`commonair-mediamtx.container` publishes only 1935 and 8189/udp, :28-29), and
  `scripts/selfhost.sh` opens no port for it (its public list is at :323-353). The selfhost bundle
  already ships `infra/mediamtx/mediamtx.yml` (`commonair-mediamtx.container:30`), so self-hosters
  get your MediaMTX change with no selfhost edit. Confirm this in your final message.
- **Auth.** The MediaMTX auth hook is protocol-agnostic (`services/api/src/media/auth.ts`;
  `MediaMtxAuthRequest.protocol` already includes `srt`, `packages/contracts/src/internal.ts:56`):
  reads need user `internal` + `MEDIA_INTERNAL_PASSWORD`; publishing `live/<slug>` needs the stream
  key (an SRT publisher would pass it as `?key=`, as RTMP does). No API change.
- **`ClockAnchor`** (`services/media/src/clock/anchor.ts:11-21`):
  `offsetMs(broadcastId, runId): number`, milliseconds added to a raw recorder time of that run. It
  must stay synchronous and cheap. You may add methods or a sibling interface in `clock/**`; keep
  `IDENTITY_CLOCK` working for tests that do not care about the clock.
- Path names: `mediaPath`, `renditionPath`, `sourceAacPath` (`packages/contracts/src/internal.ts:31-42`).
  `MEDIAMTX_HLS_URL` (`compose.yaml:54`) is how media reaches MediaMTX's LL-HLS internally, with
  basic auth for the internal user (the origin does the same, `services/origin/src/upstream.ts:173`).
- The ingest path block (`mediamtx.yml:103-116`, `~^live/[a-z0-9_]{3,25}$`) keeps receipt stamping
  and never gets `useAbsoluteTimestamp` (ADR decision 1: a streamer must not be able to move media
  time).
- Origin, relay and CDN pass PDT through unchanged (`services/origin/src/playlist.ts:78-90`,
  `relay/internal/hls/rewrite_test.go:48-63`). Keep it that way.
- Logs, `lastError` columns and Valkey status never carry the internal secret (`ffmpeg/redact.ts`;
  the supervisor redacts args and errors, `ffmpeg/supervisor.ts:104-123`).

## What is there today (verified at `61263d6`)

- **MediaMTX** `1.21.2-ffmpeg` (`compose.yaml:227`, `infra/quadlet/commonair-mediamtx.container:11`).
  The port comment is `mediamtx.yml:9-12`; RTSP TCP-only :41-46; LL-HLS with 1 s segments and
  200 ms parts and `hlsAlwaysRemux: true` (:58-68); `srt: false` under "Protocols we do not serve"
  (:84); `pathDefaults` (:88-93); the ingest block (:103-116); the rendition block
  `~^live/[a-z0-9_]{3,25}/(1080p|720p|480p|audio|aac)$` (:118-122). No `useAbsoluteTimestamp`
  anywhere. `compose.yaml:233` comments which MediaMTX ports stay internal (SRT not listed).
- **args.ts.** `RTSP_IN` (:18-19); `internalRtspUrl` puts the secret in URL userinfo (:21-28).
  `videoEncoderFlags` (:74-95) forces keyframes with `expr:gte(t,n_forced*2)` (:76-78), `-bf 0`,
  `-sc_threshold 0` (x264) or `-forced-idr 1` (NVENC). `ladderArgs` (:105-128): one RTSP input,
  `split`/`scale`, per rung `-map … -f rtsp -rtsp_transport tcp -pkt_size 1200 <url>` (:125); the
  audio rung is AAC with no video (:118-119). `aacCopyArgs` (:130-163): video copy, audio to AAC
  48 kHz, RTSP out. `recorderArgs` (:177-207): `-c copy` to 4 s fMP4 HLS, segments
  `${runId}_%06d.m4s` (:202), `-hls_flags independent_segments+program_date_time+temp_file` (:204).
- **redact.ts.** Masks listed secrets (and their URL-encoded form), then any URL userinfo password
  by pattern (:16-23). It does not recognise an SRT `streamid`.
- **Supervisor** (`ffmpeg/supervisor.ts`): `args: () => string[] | Promise<string[]>` (:42), called
  on every (re)start; if it throws, that counts as a failed start and is retried with backoff
  (:104-109).
- **Callers.** The ladder builds its input and outputs in `transcode/controller.ts:132-139` and
  starts on viewer hysteresis (30 s start, 120 s stop, `settings.ts:49-50`). The AAC copy builds
  its input/output in `transcode/audio-compat.ts:102-109`. The recorder builds its input in
  `vod/recorder.ts:118-119` and a new `runId` per ffmpeg start (:123-128).
- **Recorder** (`vod/recorder.ts`). `stamp()` applies `ctx.clock.offsetMs(broadcastId, runId)`
  (:153-158). It is used in `localWindow` (:160-175, re-stamps every local segment per call), in
  `pollOnce` for `recordingStartedAt` (:199-201, stamped **once** when the segment is first seen)
  and in `upload` (:285-290, the VOD playlist is re-rendered from stamped segments every poll and
  uploaded only when the text changes). Segments resumed from storage have `runId: null` and are
  not re-stamped (:243). `prune` uses raw times against `Date.now()` (:301-321).
- **Recovery** (`recovery.ts`). `recoverRecording` (:106-135) reads the published playlist (already
  stamped) and the local run playlists (`readRuns` :86-94, raw), orders them with
  `segmentsToRecover` (:44-63, by start time) and renders the union (:129). `RecoveryDeps`
  (:65-75) has no clock, so a recovered VOD mixes stamped and raw times. Called from
  `service.ts:297` before anything else starts.
- **Finalize** (`vod/finalize.ts:266`) re-renders the final playlist from the published one, so it
  inherits whatever stamping the recorder and recovery did.
- **The clock seam.** `service.ts:206-207` sets `clock: IDENTITY_CLOCK`. Tests:
  `services/media/tests/recorder-clock.test.ts` (fake anchors through the recorder).
- **Test MediaMTX helpers.** `services/media/tests/helpers/containers.ts:75-94` runs the **production**
  `infra/mediamtx/mediamtx.yml` on the compose image (`MEDIAMTX_IMAGE`, :12-13) with a fake API,
  publishing 1935, 8554 and 9997 only. `harness/src/testing/mediamtx.ts` runs a permissive config
  (`mediamtxConfig` :44-85, `srt: no` :69, one `all_others` path :82) on
  `mediamtx:1.21.2` (non-ffmpeg build, :15-16); `startMediaMtx` publishes random host ports
  (:125-147, looked up at :159-165) and supports WHIP.
- **Measurement.** Simulated streamers burn the capture epoch ms into every frame
  (`harness/src/timestamp-strip.ts`, `decodeStrip` :121, geometry proportional so any rung decodes,
  :42-47). `HttpViewer` decodes it from downloaded segments (`decodeStripEvery`,
  `harness/src/http-viewer.ts:43`, :367-376) and reads each segment's `programDateTime`. The harness
  streamer (`harness/src/ffmpeg.ts:200-233`) uses x264 `zerolatency` (no B-frames), a 2 s GOP, AAC
  over RTMP and Opus over WHIP.
- **Scenario stub.** `harness/scenarios/clock-skew.ts`: `inFull: false`, `needs` includes `whip`,
  15 min timeout, throws. `FULL_REQUIRED` is `harness/src/registry.ts:33`.
- **Metrics** use OpenTelemetry instruments from `meter()` in `@commonair/observability`
  (pattern: `services/media/src/moderation/metrics.ts`). Media's health payload is fixed by
  `@commonair/service` (`packages/service/src/server.ts:60-72`); every entry of `media.checks`
  (`service.ts:271`) fails `/readyz` when it throws.

## Build

0. **Gate checks before production code (half a day).** Each is an integration test you keep
   (see "Tests"), so write them first and run them. Append what you measured to
   `services/media/src/clock/README.md` under a dated "A2 implementation checks" heading.
   1. **Shared timeline and the 10 s offset** on the pinned image, for an RTMP source with and
      without B-frames.
   2. **Opus over SRT.** A WHIP source (Opus) read over SRT keeps an Opus track that ffmpeg
      decodes and re-encodes to AAC, on the shared timeline. **If Opus does not survive, stop,
      commit the tests and README, and report**: do not build a mixed RTSP/SRT path.
   3. **Recorder over SRT.** `recorderArgs` with an SRT input and `-copyts` writes fMP4 whose first
      sample time per segment equals the SRT PTS of that frame. If it does not, implement R1 as ADR
      0012 decision 4 describes instead of step 4 below, and say so.
1. **SRT input** (`args.ts`). Add `internalSrtUrl(base, path, secret)` producing
   `srt://host:port?streamid=read:<path>:internal:<secret>` (prove in a test how the secret must be
   encoded so MediaMTX receives it intact, with the reserved characters of the `args.test.ts`
   `SECRET` fixture), plus bounded connect/read timeouts and an explicit SRT receive `latency` for
   the internal network (measure; the default is 120 ms; report the value chosen and the added rung
   latency). Use it for the ladder, the AAC copy and the recorder only.
2. **Rungs carry the source clock** (`ladderArgs`, `aacCopyArgs`). `-copyts` on the input;
   `-start_time_realtime <W0 µs>` before **every** RTSP output (each video rung, the audio rung and
   the AAC copy). Replace the keyframe expression with the phase-locked one:

   ```
   expr:if(isnan(prev_forced_t),1,gte(floor(t/2),floor(prev_forced_t/2)+1))
   ```

   Under `-copyts`, `t` is the shared timeline, so keyframes fall on its 2 s boundaries: every rung
   and every ladder run (including after a restart) cuts at the same instants. The spike's
   `gte(t-prev_forced_t,1.999)` counts from the ladder's first frame and only lined up by luck; do
   not use it. The first frame is always forced (`isnan`). Measure the expression in the
   integration test (keyframe PTS modulo 2 s across two ladder starts at different phases) before
   relying on it.

3. **W0** (`clock/`). A function that fetches the source path's LL-HLS (multivariant, then the media
   playlist, the init section and the newest complete segment) from `MEDIAMTX_HLS_URL` with the
   internal user's basic auth, parses the init (`mdhd` timescale per track) and the segment
   (`tfdt`, plus the first sample's composition offset from `trun`, so a B-frame source uses the
   first sample's **presentation** time), and returns
   `W0 = PDT − ((pts / timescale − 10 s) mod WRAP)` with `WRAP = 2^33 / 90000 s`. Pin in a test which
   track MediaMTX's PDT refers to (video when present; audio-only sources use the audio track).
   Write a tiny box parser in `clock/` (no new dependency). Wire it through the supervisors' async
   `args()` in the ladder, the AAC copy and the recorder, so every ffmpeg start (and restart) uses a
   fresh W0, which also handles a wrap between starts (a session started after the wrap reads small
   PTS; the modulo gives the matching W0; ffmpeg unwraps within the session). Bound the fetch
   (timeout, size, newest segment only); never log URLs with credentials. On failure: the ladder and
   the AAC copy throw from `args()` (the supervisor retries with backoff; an unanchored rung would
   be seconds off under `useAbsoluteTimestamp`); the recorder **never** waits on it: it starts with
   W0 unknown, and the run is stamped once W0 is known (step 4).
4. **Recorder (R4).** The recorder reads SRT with `-copyts` (keep `-c copy`, the fMP4 layout and
   file names). Per run, persist a sidecar `${runId}.clock.json` in the broadcast work dir with the
   W0 used and, once the run's first segment exists, the run's offset
   `offset = W0 + firstSamplePts / timescale − rawPDT(first segment)` (ffmpeg's `program_date_time`
   is the process clock plus summed media durations, so the offset is constant within a run). Your
   anchor serves `offsetMs` from memory (0 only while a run's offset is unknown). Compute the offset
   in `pollOnce` before the run's first segment is pushed, so stamped times never leave the recorder
   unanchored when W0 is known. Check each later segment against `W0 + its own first sample time`
   and export the residual (step 6). Then fix the two review findings, adapted to A2:
   - **Recovery must stamp local run segments via the anchor.** `recoverRecording` mixes stamped
     published segments with raw local ones. Pass a clock into `RecoveryDeps` and stamp each local
     run's segments from its sidecar (pure: sidecar + local files, no network; the broadcast may have
     ended) **before** `segmentsToRecover` orders them and before rendering. A run with no sidecar
     offset (crashed before W0 was known, or recorded before this change) stays raw: log a count and
     document why in a comment.
   - **`recordingStartedAt` must not go stale.** An offset can still change after a segment is seen
     (W0 arrives late, or is corrected). Derive `recordingStartedAt` from the stamped segments in
     `localWindow` (or store it raw with its `runId` and stamp it when read); never stamp it once and
     keep it.

   Leave `finalize.ts` alone unless a test shows it needs a change (it re-renders the already
   stamped playlist).

5. **MediaMTX** (`mediamtx.yml`). `srt: yes`, `srtAddress: :8890`, moved out of "Protocols we do not
   serve", with a comment that it is the internal reader path for the ladder, the AAC copy and the
   recorder (ADR 0012 A2) and is never published; add `8890/udp SRT (internal)` to the port list at
   :9-12. `useAbsoluteTimestamp: true` on the rendition block (:118-122) **only**, with a comment
   saying why the ingest block must never have it. Mirror both in `harness/src/testing/mediamtx.ts`
   (a rendition path block with `useAbsoluteTimestamp` before `all_others`, `srt: yes`, a published
   UDP port, `srtUrl`) and publish 8888/tcp and 8890/udp in `services/media/tests/helpers/containers.ts`.
6. **Metrics** (new `services/media/src/clock/metrics.ts`, `meter()`; no ids in attributes):
   `media_clock_recorder_offset_ms` (histogram of `|offset|` per run),
   `media_clock_recorder_residual_ms` (histogram of `|stamped − (W0 + sample time)|` per segment;
   this is the production live-to-VOD gauge ADR 0012 asks for), `media_clock_w0_failures_total`
   (counter, attribute `consumer`: ladder, aac, recorder), and `media_clock_w0_drift_ms` (histogram
   of how far a fresh W0 moved from the previous one for the same broadcast; nonzero means MediaMTX's
   PDT is not a fixed offset from its timeline, which would break A2's assumption).
7. **Host clock signal.** If the container can read the kernel's NTP sync status without new
   privileges or dependencies, export `media_clock_host_synchronized` (1 or 0; not reported when
   unreadable) from your metrics module and log one warning when it reads 0. Never fail health on
   it. If it is unreadable, say so; if you think it belongs in `/healthz`, send the
   `packages/service` change as a contract request.
8. **`selfhost.sh` NTP check** (ADR decision 2): not your file. Put the exact lines in your final
   message as a contract request: a `timedatectl show -p NTPSynchronized --value` check in the
   install preflight that **warns and continues** (never refuses), names the operator guide's
   time-sync requirement, stays silent on `yes`, says it could not check when `timedatectl` is
   absent, and needs no override flag.
9. **`clock-skew` scenario** (ADR decision 5) in `harness/scenarios/clock-skew.ts`, helpers in new
   `harness/src/clock-skew*.ts`:
   - A strip-burning streamer (`p.streamerFor`, as `harness/scenarios/integrity-basic.ts:159` does)
     publishes over **RTMP**, then a second broadcast over **WHIP** (which adds the AAC copy and
     Opus over SRT). Hold enough HTTP viewers to cross the stack's transcode threshold so the ladder
     runs (see `ladderViewers` in `harness/src/load/sweep.ts`).
   - Force **one ladder restart** (drop below the threshold, wait out the 120 s stop hysteresis,
     rise again) and **one recorder restart** mid-broadcast. For the recorder, use a way the harness
     already has to end the recorder's ffmpeg so its supervisor starts a new run (for example
     `podman exec` into the media container and signal the process whose args contain the recorder
     playlist); if the harness has none that works under compose and Quadlet, report the hook you
     need as a contract request and run the rest.
   - One `HttpViewer` per video rendition (source and each rung) through the origin, with
     `decodeStripEvery: 1`; per decoded segment `e = PDT − strip`. The audio-only rung is **not**
     measured (no strip in audio); its flags are covered by `args.test.ts`.
   - Cross-rendition skew per capture instant = `max(e) − min(e)` across renditions, pairing each
     rung sample with the source sample of the same strip time (or the nearest within one segment;
     `e` is constant between restarts). Pass: **p95 < 100 ms**, every rendition present for ≥ 2
     minutes, including the minute after the ladder restart.
   - Live-to-VOD skew = `|e_vod − e_source|` for the same strip times, read from the published VOD
     playlist and its segments after the broadcast ends, across the recorder restart. Pass: **p95 <
     250 ms**.
   - Metrics `crossRenditionSkewP95Ms`, `liveToVodSkewP95Ms` (and max), per protocol;
     `--set assert=false` records them without asserting (the user's baseline run against `main`).
   - Leave `inFull: false`. Adding the scenario to `FULL_REQUIRED` (and a shard) is a contract
     request the orchestrator applies on merge: put the exact lines in your final message.

## Tests you must add

- `args.test.ts`: the SRT input on the ladder, the AAC copy and the recorder (and RTSP still on
  thumbnails, simulcast and probes); `-copyts` on those three inputs; `-start_time_realtime` with
  the given W0 before **every** RTSP output (each video rung, the audio rung, the AAC copy) and on
  no other output; the phase-locked keyframe expression on every video rung (x264 and NVENC); the
  recorder's `-c copy` fMP4 layout unchanged apart from the input and `-copyts`.
- **Redaction**: `redactArgs` masks the secret in an SRT `streamid` (plain and URL-encoded) **with
  an empty `secrets` list**, so the pattern does not depend on the caller; an ffmpeg error line
  echoing the SRT URL is masked; the RTSP userinfo cases still pass.
- A config test (new `services/media/tests/clock-config.test.ts`) that reads
  `infra/mediamtx/mediamtx.yml` and asserts `srt: yes` on `:8890`, `useAbsoluteTimestamp: true` on
  the rendition block, and its absence from `pathDefaults` and the ingest block; and that
  `harness/src/testing/mediamtx.ts`'s config has the same rendition setting.
- `clock` unit tests: the box parser on small committed fixtures (`services/media/tests/fixtures`,
  generated once with ffmpeg; include a B-frame segment); the W0 formula, including the 10 s offset
  and the composition offset; the **PTS-wrap rebase** on both sides of 2^33 / 90 kHz and for a
  `tfdt` that MediaMTX may or may not wrap itself; the run offset from a sidecar; a run with no W0
  (offset 0, counter); W0 drift reporting; bounded fetch (timeout, oversize, newest segment only).
- Recorder and recovery: `recorder-clock.test.ts` gains the stale-`recordingStartedAt` case (an
  offset that changes after the first segment moves the live-clip window); a recovery test that a
  crash with stamped published segments plus raw local runs renders a monotonic, fully stamped
  playlist from sidecars, and leaves a sidecar-less run raw.
- **MediaMTX pin** (new `services/media/tests/clock-mediamtx.int.test.ts`, on
  `tests/helpers/containers.ts`, i.e. the production config and the compose image; assert that
  `MEDIAMTX_IMAGE` there equals `compose.yaml`'s `mediamtx` image so an upgrade cannot skip it):
  with a strip source over RTMP (no B-frames, then `-bf 2`), three sequential `-copyts` SRT reader
  sessions give the same `strip − pts` within one frame (**shared timeline**); a source LL-HLS
  segment's `pts / timescale − 10 s` equals the SRT PTS of the same strip value within one frame
  (**the 10 s offset**); a ladder built by `ladderArgs` with the computed W0, started twice at
  different phases, yields rung PDT within one frame of source PDT and keyframes on the same 2 s
  boundaries; the recorder over SRT yields anchored PDT within one frame of source PDT.
- **Opus over SRT** (new `harness/tests/clock-srt.int.test.ts`, on `harness/src/testing/mediamtx.ts`
  with SRT on, WHIP streamer): the SRT read has an Opus audio track, ffmpeg re-encodes 5 s of it to
  AAC with packets, and the shared-timeline check above also holds for a WHIP source. Assert the
  helper image's MediaMTX version equals the compose image's.
- Scenario pure parts (pairing by strip time, p95, rendition coverage windows, per-protocol
  grouping) in `harness/tests/clock-skew*.test.ts`.

## Done means

Follow `.claude/briefs/_done-means.md`: the user runs the gate (`bun run verify`), image rebuilds,
harness scenarios and every live check; you run targeted checks only and never run the gate,
`podman compose`, `scripts/infra.ts` or harness scenarios (the integration tests' throwaway
MediaMTX containers via the existing helpers are fine). Run `bun run test` and `bun run test:int`
in `services/media`, `bun --bun vp test run harness/tests/clock-skew*` and the harness
`clock-srt` integration test, `bunx tsc -p services/media --noEmit`, `bunx tsc -p harness --noEmit`,
`vp lint --deny-warnings` and `vp fmt` on your changed paths. Do not run several packages'
`test:int` at once. `git status` shows only your paths. Commit in your worktree on branch
`w0/clock` with `git commit -s` (Conventional Commits), message ending with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

Final message: the step 0 results (or why you stopped), the flags chosen and why (SRT latency, the
`streamid` encoding), test counts per package, branch and sha, contract requests (the
`selfhost.sh` NTP lines; `FULL_REQUIRED` and the shard for `clock-skew`; any recorder-restart
harness hook; confirmation that `compose.yaml`, `infra/quadlet` and `scripts/selfhost.sh` need no
SRT change beyond `MEDIAMTX_SRT_URL`, or the exact lines if they do), what is left, and the exact
commands the user should run live: `bun harness/src/cli.ts run clock-skew --set assert=false` on
`main` (baseline) and `bun harness/src/cli.ts run clock-skew` on your branch after rebuilding the
media image.

## Base and earlier steps

- Your base is current `main` (wave 2 merged, `61263d6` or later). Recheck every line number above
  against it.
- The W0 contract step landed the `ClockAnchor` seam, `IDENTITY_CLOCK`, the recorder's `stamp()`
  calls and the `clock-skew` stub; the first W0-clock run landed only `clock/README.md` (the spike).
- The next free migration number is 0031 if `0030_scoring_idx_unscored` has merged; you should need
  no migration.
- The P1 contract step changed `harness/src/proxy.ts` and `harness/src/platform.ts` additively and
  added `harness/compose.p2p.yaml` to `HARNESS_OVERRIDES`. Any new harness override that sets api
  environment must be mirrored in `compose.multi-instance.yaml`'s api-2, or `multi-compose.test`
  fails (you should need none).
