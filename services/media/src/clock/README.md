<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Media clock spike (ADR 0012 decision 3, option A)

Run on 2026-10-27 for W0-clock. Result: **option A as specified (RTSP input) fails on point 2**,
so point 4 fails too. Points 1 and 3 hold. A variant that reads the ladder input over SRT instead of
RTSP passed the same measurement (+12 ms, stable across ladder restarts). It is described at
the end for the orchestrator to decide on. Per the brief, W0-clock stopped here: nothing in
`args.ts`, `mediamtx.yml` or the anchor is implemented.

## Setup

- ffmpeg **7.1.5-0+deb13u1**, from the media image (`localhost/commonair/media:dev`, Debian 13.7,
  `infra/containers/service.Containerfile:87`). One control run used Homebrew ffmpeg 9.0.2 on the
  host.
- MediaMTX **1.21.2** (`docker.io/bluenviron/mediamtx:1.21.2@sha256:c7540465f868a02652118bea5a0daab12a29ac0f6cb8485abd535939ecddf886`, the harness
  helper's image). It ran in a throwaway container on a private podman network with permissive
  internal auth, LL-HLS (1 s segments, 200 ms parts) and `hlsAlwaysRemux`, as in
  `harness/src/testing/mediamtx.ts`. The spike started the container with `podman run` instead of
  that helper because the helper cannot express what the spike needed: it hardcodes `srt: no`,
  has a single `all_others` path (no `useAbsoluteTimestamp` path), and publishes every port on
  random host ports with no shared network, while the ladder had to run in the media image and
  reach MediaMTX by container name, as it does in compose.
- Source: the harness streamer (`buildStreamerArgs`: 640x360 at 30 fps, 2 s GOP, x264 high, AAC,
  RTMP), which burns the timestamp strip into every frame.
- Measurement: each path's LL-HLS playlist was polled. For each new segment the script fetched it
  with its init section, decoded the strip from the first frame (`decodeStrip`), and computed
  `e = PDT − strip`. For a rung, the reported number is `e_rung − e_source` for the same strip
  value, so the streamer's clock cancels out. Numbers in parentheses below are raw `e_rung`
  values that could not be paired because the rung's keyframes did not line up with the
  source's.
- Ladder commands are the `ladderArgs` shape (`-rtsp_transport tcp -i rtsp://…/live/s`,
  `split`/`scale`, libx264 `veryfast`/`zerolatency`, `-bf 0`, AAC, `-f rtsp -rtsp_transport tcp`).
  Each ran in the media image on the same podman network.

## Point 1: MediaMTX sends sender reports to RTSP readers (holds)

`ffprobe -rtsp_transport tcp -show_packets rtsp://…/live/s` shows `Producer Reference Time` side
data on packets from the first few hundred ms onward. libavformat's `rtpdec` attaches that side data
only after an RTCP sender report has arrived, so MediaMTX does send sender reports to RTSP
readers.

The catch is how rtpdec uses them. The reader's input timestamps are `NTP(packet) − F`, where F is
the NTP time in the first sender report **this session** received. The demuxer stores F as
`AVFormatContext.start_time_realtime`. Each RTSP session gets its own F. Three reader sessions gave
`strip − pts` = …637144, …643261 and …653844 ms, which differ by 6.1 s and 10.6 s.

Those gaps are not the 2.5 s an earlier summary gave. The sessions ran one after another, each in
a fresh `podman run` of the media image, with a 2.5 s pause after each one **finished**. So the
start-to-start interval was 2.5 s plus container start, connect and probe, and it was not
measured. If F is the first sender report's NTP time, the gaps should equal those intervals;
several seconds each is plausible but unconfirmed. The mechanism is from reading `rtpdec`, and the
exact gap is unexplained. Either way the origin differs per session, which is all point 2 needs.

## Point 2: ffmpeg's RTSP output anchors to the source clock under `-copyts` (fails)

- The only control the CLI exposes is the output format option `-start_time_realtime <µs>`. Its
  help text reads "wall-clock time when stream begins (PTS==0)". `rtpenc` sends sender reports
  that map PTS p to wall clock `start_time_realtime + p`. Without the option, `rtspenc` uses
  `av_gettime()` at `write_header`.
- The CLI does **not** copy the input's `start_time_realtime` to the output: neither ffmpeg 7.1.5
  nor 9.0.2 does. With `-copyts` and no option, the rung lags the source by the time from input
  open to output header, which is mostly probing:

  | Run (`-copyts`, rung path with `useAbsoluteTimestamp`) | rung − source       |
  | ------------------------------------------------------ | ------------------- |
  | x264 rung, ffmpeg 7.1.5                                | +2773 ms (constant) |
  | `-c copy` rung, ffmpeg 7.1.5                           | +3025 ms            |
  | `-c copy` rung, ffmpeg 9.0.2                           | +1556 ms            |

- So media would have to pass F. F exists only inside the ffmpeg process, after its input
  connects, and differs per session (point 1). The outputs need it at startup. No CLI flag carries
  it over, and no CLI output prints it: `-loglevel trace` logs nothing about RTCP or NTP, and
  ffprobe prints only the side data's type, not its value.
- A guess of `-start_time_realtime = spawn time` was tested with ffmpeg spawned directly on the
  host (no container start), two x264 rungs from one process, idle machine. Three runs gave rung −
  source = **+5, −1 and −72 ms**. Both rungs in a run matched each other exactly. The error is the
  connection setup time plus jitter in MediaMTX's report clock. It changes on every ladder start,
  and on a loaded host it grows with the MediaMTX auth hook round trip. That is not anchoring, and
  it spends most of the 100 ms budget on an idle machine.
- The same guess in the realistic deployment shape, ffmpeg 7.1.5 run in the media image under
  podman (`-c copy` rung, spawn time taken just before `podman run`): rung − source = **−950 ms**.
  Container start lands between the guessed time and the input connecting, so the guess is
  early by roughly the container start time. In compose the media service spawns ffmpeg inside
  its own running container, so this overstates that case, but it shows the guess has no bound:
  anything between the spawn and the first sender report becomes error.
- `-write_prft pts` in the mp4 muxer writes the packet PTS, not the RTP-derived wall clock
  (checked: `prft` NTP = 0, 2000, 4000 ms). There is no CLI path from rtpdec's producer reference
  time to any output.

## Point 3: MediaMTX honours `useAbsoluteTimestamp` for an RTSP publisher (holds, exact)

ffmpeg 7.1.5 published the strip source over RTSP with `-start_time_realtime` set to the strip's
start epoch (`S·1000`, strip = S + pts), on a path with `useAbsoluteTimestamp: yes`.

- HLS `PDT − strip` = **−1 ms** on every segment.
- The same publisher on a path without the setting: −3120 ms. Receipt stamping ignores the
  sender report there; S was set 3 s in the future on purpose.

## Point 4: a ladder started mid-broadcast gets rung PDT = source PDT (fails with RTSP input)

- Today's flags (no `-copyts`, no `useAbsoluteTimestamp`, one 240p rung): **+302 ms**. This is
  the decode/scale/encode delay.
- Today's flags with `useAbsoluteTimestamp` on the rung path: +2697 ms. With RTSP input, every
  combination is off by seconds or by an uncontrolled tens of ms; see point 2.
- Keyframe expression: `-force_key_frames expr:gte(t,n_forced*2)` under `-copyts` with a large
  starting `t` keys every frame until `n_forced` catches up. The spike then used:

  ```
  expr:if(isnan(prev_forced_t),1,gte(t-prev_forced_t,1.999))
  ```

  It gave one keyframe per 2 s, and rung segments paired with source segments by strip value.
  **Do not copy it as "works".** It counts 2 s from the ladder's first frame, not from source-time
  multiples of 2 s. It lined up only because the harness streamer has a 2 s GOP and the read
  began on a source keyframe. With another GOP, or a ladder restart at another phase, rung
  boundaries drift from the source's and from earlier ladder runs. Build step 1 needs keyframes on
  2 s boundaries of the shared timeline, for example (not measured):

  ```
  expr:if(isnan(prev_forced_t),1,gte(floor(t/2),floor(prev_forced_t/2)+1))
  ```

  That is only stable across restarts when `t` is a timeline shared across reader sessions (A2
  below). With RTSP input each session's `t` has its own origin (point 1), so no expression can
  phase-lock to the source.

## Variant A2: the ladder reads SRT (measured, not implemented)

MediaMTX serves SRT readers MPEG-TS whose PTS is the path's own stream timeline. That timeline is
**the same for every reader session**. Three `-copyts` SRT sessions, run like the RTSP ones in
point 1 (fresh container each, 2.5 s pause between), gave
`strip − pts` = …737395 ms each time, exactly equal.

MediaMTX's LL-HLS muxer builds `tfdt` from the same timeline plus a fixed 10 s offset: segment
`tfdt / 90000 − 10 s` equals the SRT PTS of the same frame, exactly. Media can therefore compute
the source's wall-clock anchor from one LL-HLS segment before it starts the ladder:

```
W0 = PDT(segment) − (tfdt(segment) / timescale − 10 s)
```

It then passes `-copyts -i srt://mediamtx:8890?streamid=read:live/<slug>:internal:<secret>` and
`-start_time_realtime W0·1000` on every RTSP output.

- Measured with ffmpeg 7.1.5 in the media image, two x264 rungs and audio: rung − source =
  **+12 ms** on every segment. Three separate ladder starts with the same W0 all gave +12 ms.
- The 12 ms residual is under half a frame and was not investigated further.

A2 is outside this brief. What it changes and risks:

- **MediaMTX config:** `srt: yes` (today `srt: false`, `mediamtx.yml` "Protocols we do not
  serve"). The SRT port stays unpublished in `compose.yaml` and quadlet. The auth hook is
  protocol-agnostic (`services/api/src/media/auth.ts`): reads need the internal credentials, and
  publishing `live/<slug>` over SRT would need the stream key like RTMP.
- **Secret in the input URL:** the internal secret moves from RTSP userinfo into the SRT
  `streamid` query (`streamid=read:live/<slug>:internal:<secret>`). `redact()`
  (`ffmpeg/redact.ts`) masks userinfo passwords by pattern, but that regex does not match
  `streamid`. It is masked only when the caller passes the secret in `secrets`. If A2 is adopted,
  `args.test.ts` must assert that `redactArgs` masks the `streamid` secret, and the redaction
  pattern should learn the `streamid` form so it does not depend on the caller.
- **Version coupling:** it depends on MediaMTX internals, namely the shared MPEG-TS timeline for
  SRT readers and the 10 s HLS DTS offset. An integration test against the pinned MediaMTX image
  would catch a change on upgrade.
- **PTS wrap:** MPEG-TS PTS wraps at 2^33 / 90 kHz (26.5 h). ffmpeg unwraps within a session, but
  a ladder started after the wrap must rebase W0.
- **Latency:** SRT adds its receive latency (default 120 ms; internally it can be set lower) to rung
  latency. It does not affect PDT.
- **Same input for every reader:** the AAC copy and the audio rung would read SRT the same way.
  Opus in MPEG-TS is supported by both MediaMTX and ffmpeg, but this spike did not test it.
- **Recorder (R4):** a recorder reading SRT with `-copyts` would write fMP4 whose `tfdt` is the
  stream timeline. Its exact PDT would be `W0 + tfdt`, with no keyframe hashing. That would
  simplify or replace R1 if A2 is adopted.

### Untested alternative: read over RTMP

MediaMTX's RTMP readers may also get a timeline shared across sessions (RTMP timestamps are
relative to the path's stream, not to the reader session). If so, the ladder could read
`rtmp://mediamtx:1935/live/<slug>` with the same W0 approach and MediaMTX would need no `srt: yes`.
This was **not measured**. Before choosing it: run the shared-timeline check (three `-copyts`
sessions, compare `strip − pts`), find the offset between the RTMP timeline and LL-HLS `tfdt`,
check 32-bit millisecond timestamp wrap (about 49.7 days, but some muxers wrap at 2^31), and
check that Opus can travel over RTMP at all (enhanced RTMP only), since the audio rung is Opus.
RTMP reads also carry credentials in the URL query, so the same redaction test applies.

## Reproduce

The scripts were throwaway, kept in the session scratchpad and not committed. The core commands
were:

```sh
# MediaMTX on a private network (config as above, plus a path regex with useAbsoluteTimestamp: yes)
podman network create clockspike
podman run -d --rm --name mtxup --network clockspike -v $PWD/mediamtx.yml:/mediamtx.yml:ro \
  -p 127.0.0.1:19350:1935 -p 127.0.0.1:18888:8888 \
  docker.io/bluenviron/mediamtx:1.21.2@sha256:c7540465f868a02652118bea5a0daab12a29ac0f6cb8485abd535939ecddf886
# strip source: ffmpeg $(buildStreamerArgs({protocol:"rtmp", url:"rtmp://127.0.0.1:19350/live/s", …}))
# a rung, as the media service would run it:
podman run --rm --network clockspike --entrypoint ffmpeg localhost/commonair/media:dev \
  -copyts -rtsp_transport tcp -i rtsp://mtxup:8554/live/s \
  -filter_complex '[0:v:0]split=2[v0][v1];[v0]scale=-2:240[o0];[v1]scale=-2:180[o1]' \
  -map '[o0]' -c:v libx264 -preset veryfast -tune zerolatency \
  -force_key_frames 'expr:if(isnan(prev_forced_t),1,gte(t-prev_forced_t,1.999))' -bf 0 \
  -map 0:a:0? -c:a aac -start_time_realtime <µs> -f rtsp -rtsp_transport tcp rtsp://mtxup:8554/live/s/abs …
# SRT variant: replace the input with -i 'srt://mtxup:8890?streamid=read:live/s' (MediaMTX srt: yes)
```

Each path's LL-HLS playlist was followed, and the strip of each segment's first frame was decoded
with `harness/src/timestamp-strip.ts` (as `HttpViewer.decodeLatency` does).

## A2 implementation checks (2026-10-27)

Build step 0 of the second W0-clock run, before production code. Each check is a kept integration
test: `services/media/tests/clock-mediamtx.int.test.ts` (production `mediamtx.yml` on the compose
image `mediamtx:1.21.2-ffmpeg`, SRT readers in a container sharing MediaMTX's network namespace)
and `harness/tests/clock-srt.int.test.ts` (the harness MediaMTX, WHIP source). ffmpeg was the
media image's 7.1.5 (`localhost/commonair/media:dev`) for the readers, Homebrew 9.0.2 for the
sources. A frame is 33 ms; every pass bound below is one frame.

1. **Shared timeline and the 10 s offset: hold, with and without B-frames.** Three sequential
   `-copyts` SRT sessions of an RTMP strip source gave the same `strip − pts` to the millisecond,
   for `-bf 0` and for `-bf 2`; so did a WHIP source. A source LL-HLS segment's
   `(tfdt + cto) / timescale − 10 s` equals the SRT PTS of the frame with the same strip within
   one frame. W0 read three times 1.5 s apart from a B-frame source was identical; the first
   sample's composition offset (`trun`, 2993–3015 ticks, one frame) is needed: without it W0 is a
   frame late. PDT on MediaMTX's video playlist refers to the video track (`clock.test.ts` pins the
   track choice: video, else audio).
2. **Opus over SRT: survives.** A WHIP (Opus) source read over SRT has `Audio: opus`; ffmpeg
   re-encodes it to AAC (235 packets ≈ 5 s, under `-copyts` counted with `-frames:a`, not `-t`,
   since output times start at the source timeline, not 0). The AAC copy built by `aacCopyArgs`
   with W0 published `live/<slug>/aac` with PDT **−1 ms** from the source on every segment.
3. **Recorder over SRT: holds, with one muxer flag.** By default the HLS muxer's MP4 rebases each
   track so the first fragment's `tfdt` is 0, which loses the timeline. With
   `-hls_segment_options movflags=+frag_discont` `tfdt` stays absolute, and the first sample time
   of every segment equals the SRT PTS of that frame within one frame (both sources), so R4 is
   implemented and R1 is not needed. ffmpeg's own PDT is a constant offset from `W0 + time` within
   a run. Two more findings: AAC arrives in MPEG-TS with ADTS headers that the nested MP4 muxer
   does not rewrap itself (`Malformed AAC bitstream`, muxing fails), so the recorder adds
   `-bsf:a aac_adtstoasc` when MediaMTX reports AAC (never for Opus, which the filter refuses);
   and the MP4 muxer logs `Packet duration: -16 / -30 … is out of range` at fragment starts (RTMP
   millisecond timestamps rounded to 90 kHz; it nudges that one packet's DTS by under 1 ms).

**Keyframes (Build step 2): the brief's expression alone is not phase-locked.** ffmpeg (6.1+,
`forced_kf_apply`) evaluates `t` relative to the first frame the encoder sees (`ref_pts`), even
under `-copyts`. Measured on a B-frame source: rung keyframes landed 67 ms after every 2 s
boundary of the timeline, the same on both ladder starts only because both started on a source
keyframe. The ladder now starts its filter graph with
`select='gte(t,2*ceil((start_t-0.001)/2)-0.001)'` (filter `t` and `start_t` are absolute), so
the encoder's first frame is the first one on a 2 s boundary and
`expr:if(isnan(prev_forced_t),1,gte(floor(t/2),floor(prev_forced_t/2)+1))` then cuts on every
later boundary. Measured: keyframes at 960.000, 962.000, 964.000 s; in the integration test, rung
segments start within one frame of a 2 s boundary on two ladder starts at different phases, for
both sources. Cost: a new ladder drops up to 2 s of video before its first frame.

**Ladder (Build steps 1–2).** Rung PDT − source PDT, same strip: **−1 ms** on every segment of
two ladder starts (B-frame source), and within one frame for both sources in the test (the spike
measured +12 ms; the difference was not investigated).

**SRT latency.** Capture-to-decode of a B-frame source over SRT on the local network, median of
90 frames: default 931–934 ms, `latency=120 ms` 948, `40 ms` 916–1001, `20 ms` 970–996; over
RTSP 964–966 ms. The run-to-run noise (±40 ms) is larger than any effect: SRT negotiates the
larger of both peers' latencies, so the receiver's setting cannot go below MediaMTX's own. The
readers set `latency=40000` (µs) explicitly; SRT added no measurable latency over RTSP.

**Host clock.** `adjtimex(2)` with `modes = 0` through Bun's FFI returns `TIME_OK` (0) inside the
media image without extra capabilities, so `media_clock_host_synchronized` is reported there.

## WHIP: W0 read before MediaMTX's PDT settles (2026-10-28)

**Failure.** On the live stack `clock-skew` passed for RTMP (cross-rendition p95 12 ms,
live-to-VOD 8 ms) and failed for WHIP with a constant ~1.0 s: the AAC copy (served as the source
rendition for WHIP) disagreed with the rungs and the VOD, which agreed with each other.
`media_clock_w0_drift_ms` had one sample in (1000, 2500] ms. The AAC copy had fetched its W0
right after publish; the ladder ~90 s later.

**Cause: W0 itself, not the AAC copy's output.** Reproduced in
`services/media/tests/clock-whip.int.test.ts` (harness MediaMTX 1.21.2, WHIP source with a
2 s GOP, W0 of each new LL-HLS segment read from publish to 45 s). For a WebRTC path MediaMTX
stamps PDT from an estimate that starts off and slews toward its steady value; the stream
timeline does not move (`strip − pts` was constant to the millisecond in every segment). W0 of
each new segment, minus the settled value, at seconds after publish:

| t (s)  | 2.6  | 4.8 | 6.5 | 8.7 | 10.3 | 12.5 | 14.3 | 16  | 18.2 | 19.8 | 22.2 | 23.9 | ≥ 26 |
| ------ | ---- | --- | --- | --- | ---- | ---- | ---- | --- | ---- | ---- | ---- | ---- | ---- |
| ΔW0 ms | 1537 | 962 | 875 | 780 | 676  | 586  | 492  | 397 | 296  | 194  | 105  | 6    | 0–6  |

So a W0 is about 95 ms (≈5 %) per 2 s segment off while settling, then stable. (Corrected
below: the movement is the publisher catching up, not MediaMTX slewing.) The pre-fix
`fetchW0` accepted the first one (+1521 ms in the old-code run), and an AAC copy started with it
published PDT **+1520 ms** from the source on every segment: all of the copy's error came from its W0.
RTMP paths do not slew (the RTMP clock checks pass unchanged with the guard).

**Fix.** `fetchW0` also reads an older complete segment of the same init section (the oldest,
or the second oldest when the playlist has three or more) and refuses W0 with
`W0Error("unsettled")` unless the two W0 agree within `4 ms + 0.5 %` of the PDT span between
them (`w0Settled`), and refuses a playlist with one segment. The media clock polls an unsettled
path every second for up to 45 s per `w0()` call (no supervisor backoff growth), and after
120 s unsettled for one broadcast takes the newest W0 anyway with a `W0_UNSETTLED` warning, so a
source that never settles still gets a ladder and an AAC copy. The ladder, the AAC copy and the
recorder all go through it; the recorder still never waits on W0 (its fetch is in the
background). With the fix the first W0 was accepted at 25.6 s, 6 ms from the settled value, and
the AAC copy started on it was **+5 ms** from the source on every segment.

The same poll covers a playlist that is not ready yet: HTTP 500/503 while MediaMTX's muxer
restarts (`W0Error("not_ready")`; MediaMTX waits 10 s after a muxer crash, e.g. a WHIP source
whose first video arrived before its SPS) and no complete segment yet (`"playlist"`). Left to the
supervisor's 1-2-4-8 s backoff, that 10 s restart once held a WHIP AAC copy, and with it the
first frame of a viewer waiting for it, for 18 s on CI.

**Cost.** The AAC copy of a WHIP broadcast starts ~25 s after publish instead of at once (live
~9 s after that); a ladder requested in that window waits the same way.

## Why PDT moves, CI, and the AAC copy's start (2026-10-28, second pass)

**The movement is the publisher's, not MediaMTX's.** MediaMTX 1.21.2 stamps a WebRTC or RTMP
path's PDT with its NTP estimator (`internal/ntpestimator`): the arrival time of the first packet
plus the media time since, re-anchored to the arrival time whenever that would put a packet in
the future or more than 5 s in the past. The harness streamer's ffmpeg starts its `-re` clock
before the WHIP handshake finishes (~1.5 s), then catches up at `-readrate_catchup`'s default
1.05×, so every packet for ~30 s arrives "early" and re-anchors PDT: −5 % against the timeline.
Measured with the same WHIP source on the harness MediaMTX, W0 of each new segment against the
first: default catch-up −87, −180, … −955 ms over 24 s, then constant; with
`-readrate_catchup 1`, −500 ms at the second segment and constant (±3 ms) from there on. The
first segment's W0 is off on every source (its PDT predates the start-up burst), which is why a
playlist's only segment never gives W0. A publisher that falls more than 5 s behind is
re-anchored the other way: PDT jumps by ~5 s.

**CI (GitHub run 40634131663).** The strip-burning RTMP sources of `clock-mediamtx.int.test.ts`
cost about a fifth of a core each in `geq` alone (60 s rendered in 13 s here); on a 4-vCPU runner
running every package's integration tests at once they fell behind real time. Both estimator
effects then showed: `W0 not settled (moved −58 / −94 / −100 ms over ~1.9 s)` is a source
catching up at 1.05×, and rung/recorder PDT **5040–5052 ms** off a source `PDT − strip` read a
minute earlier is a source re-anchored after falling 5 s behind (W0 moved with it; the stale
reference did not). Neither is the media clock. The test now takes W0 as the service does
(polled until settled), reads the source's `PDT − strip` over the same window as each rung or
recorder measurement, and repeats a measurement once if the source moved under it, then fails
naming the runner. The same effect in production needs a publisher that runs off real time; a
stall of more than 5 s re-anchors the source path's PDT while rungs and the VOD keep the W0 they
started with (reported, not handled here).

**AAC copy start.** The copy still waits for a settled W0 (a steady publisher settles at its
third segment, ~6 s with a 2 s GOP). It now probes its input for one source segment plus 0.5 s
instead of ffmpeg's 5 s (`probeMicros`, from `MediaClock.sourceSegmentMs`): ffmpeg waits the whole
`-analyzeduration` on this input (first frame 1 s + the setting, measured 5.9 s at the default,
3.0 s at 2.5 s), but needs only a keyframe, since the copied video's size comes from the SPS
(0.3 s and 1 s on a 2 s GOP fail with `Could not write header`).

**Not done: starting the copy before W0 settles.** Tried and measured, then left out, because it
trades ADR 0012's live-to-VOD target for TTFF while the publisher catches up. The copy started on
a provisional W0 (the newest segment's once there are two, 3.5 s after it is requested) and was
restarted once on the settled W0 if they differed by more than 15 ms (`ingest-whip` and
`clock-skew` on the local stack, harness WHIP streamer):

| variant                  | Chromium TTFF      | WHIP cross-rendition p95 | WHIP live-to-VOD p95 |
| ------------------------ | ------------------ | ------------------------ | -------------------- |
| settled W0 (before)      | 23.4 s             | 1 ms (orchestrator run)  | pass                 |
| provisional W0 + restart | 15.5, 14.8, 16.1 s | 3 ms                     | **1028 ms** (fail)   |

The copy was restarted 1036 ms away 27 s after publish and live again 3.8 s later; the source
rendition's live samples from before the restart carry the provisional W0, ~15 % of the pairs.
With a publisher that does not catch up (`-readrate_catchup 1`) the second segment already has
the settled W0, so the two variants differ only by one segment (~2 s) of wait.

**What bounds WHIP TTFF, either way.** Measured on the copy's own path:

- Every `useAbsoluteTimestamp` path drops its publisher's first ~5 s of packets
  (`received RTP packet without absolute time, skipping it`; ~4,500 lines per ladder start on CI).
  The gap matches ffmpeg's RTP muxer, which sends a sender report with its first packet and the
  next one no sooner than 5 s later. Why MediaMTX drops the first one, and the fix, are in the
  next section. Before that fix, the copy's first LL-HLS
  segment comes ~8.3 s after its RTSP session opens (4.2 s on a path without
  `useAbsoluteTimestamp`).
- The player retries the origin's 503 `starting` with hls.js's exponential manifest backoff
  (1, 2, 4, 8 s): a copy that is ready just after the 7 s retry is picked up at 15 s.

**WHIP VOD stuck in `processing`.** A local `clock-skew` run timed out waiting for the WHIP VOD:
`vod-finalize` failed every attempt with "no frame decoded from a VOD chunk". The scenario's
recorder restart ended run 1 after 45 four-second segments and a 0.2 s one, so the 60 s scan
chunks left that tail alone, and ffmpeg's fps filter emits nothing for a 0.2 s clip at the
moderation interval (0 frames at 1/2, 1/1 and 1/0.5 fps; 2 at 1/0.1; also with timestamps from 0,
so not the recorder's absolute `tfdt`). A short chunk is now sampled at half its length
(`scanStepSeconds`); an earlier WHIP VOD stuck the same way (05:10 that day, before these changes)
finalized once the fix was deployed.

## The first sender report, and the relay in front of MediaMTX (2026-10-28, third pass)

**Root cause.** ffmpeg's RTP muxer (`libavformat/rtpenc.c`, 7.1 in the media image, unchanged on
master) writes a sender report immediately before a stream's first RTP packet, then the next one
only once 5 s have passed. gortsplib v5.6.7 (MediaMTX 1.21.2; unchanged on main) hands a sender
report to a format by the remote SSRC (`serverSessionMedia.readPacketRTCP` →
`findFormatByRemoteSSRC`), and a recording session learns that SSRC only from the format's first
RTP packet (`serverSessionFormat.readPacketRTP`). The first report arrives before that, matches
nothing and is dropped; `rtpreceiver` itself would have kept it. Until the second report, every
packet on a `useAbsoluteTimestamp` path has no absolute time and is skipped. The report's content
is not the problem: its RTP time is `base + (now − start_time_realtime)` and the packets' are
`base + pts` under `-copyts`, the same mapping as every later report.

Measured on a scratch MediaMTX 1.21.2 (path with `useAbsoluteTimestamp`, ffmpeg testsrc publisher
over RTSP/TCP): 1,028 skipped packets over 5 s and the first LL-HLS playlist 7.6 s after start;
the same publisher through the relay below: one skipped packet per track, playlist after 1.5 s,
and identical PDTs on both paths.

**Fix: `ffmpeg/rtsp-publish-proxy.ts` + `ffmpeg/sr-primer.ts`.** The ladder and the AAC copy publish
to a loopback TCP relay (one per service, started at boot) instead of MediaMTX's RTSP port. The
relay forwards every byte, except that before an SSRC's first RTP packet it sends a copy of that
packet one sequence number earlier (MediaMTX learns the SSRC from it and skips it, as it still has
no absolute time) and then the sender report it saw before it (now routed). The original packet
is the first one MediaMTX keeps, so nothing is lost and no sequence gap appears. Anything it cannot
parse switches it to plain pass-through. Readers still go to MediaMTX directly. Neither ffmpeg nor
MediaMTX has a setting for this (`rtpflags` only has `skip_rtcp`/`send_bye`; the 5 s interval is
hard-coded), and the fix changes no ADR 0012 decision: the same reports, the same W0.

Effect on the local stack (harness WHIP streamer): the copy's first LL-HLS segment comes ~1.0 s
after its RTSP session opens (9.0 s before), and its first segment's PDT is the probe backlog's
(~1.2 s before the session) instead of ~6.8 s after it. Ladder rungs publish the same way and log
one skipped packet per track instead of ~5 s of them.

**What still bounds `ingest-whip`.** The harness player (`harness/player/player.ts`) does not cap
hls.js's manifest backoff the way `apps/web` does since a917c21 (`manifestLoadingMaxRetryTimeout`),
so a 503 `starting` is retried 1, 3, 7 and 15 s after the player starts. The copy is advertised
~8.7 s after the player starts (W0 settles at the third segment, then a 2.5 s probe), so Chromium
plays at the 15 s retry whatever the copy does (15.3–15.5 s with the relay). With that cap
(simulated without editing the harness): Chromium 10.4–10.5 s, WebKit 11.3–11.8 s; without the
relay but with the cap: 18.5 and 26.1 s.
