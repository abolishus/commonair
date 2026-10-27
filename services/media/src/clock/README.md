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
- MediaMTX **1.21.2** (`docker.io/bluenviron/mediamtx:1.21.2@sha256:c754…f886`, the harness
  helper's image). It ran in a throwaway container on a private podman network with permissive
  internal auth, LL-HLS (1 s segments, 200 ms parts) and `hlsAlwaysRemux`, as in
  `harness/src/testing/mediamtx.ts`.
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
`AVFormatContext.start_time_realtime`. Each RTSP session gets its own F. Three reader sessions
2.5 s apart gave `strip − pts` = …637144, …643261 and …653844 ms, which differ by whole seconds.

## Point 2: ffmpeg's RTSP output anchors to the source clock under `-copyts` (fails)

- The only control the CLI exposes is the output format option `-start_time_realtime <µs>`. Its
  help text reads "wall-clock time when stream begins (PTS==0)". `rtpenc` sends sender reports
  that map PTS p to wall clock `start_time_realtime + p`. Without the option, `rtspenc` uses
  `av_gettime()` at `write_header`.
- The CLI does **not** copy the input's `start_time_realtime` to the output: neither ffmpeg 7.1.5
  nor 9.0.2 does. With `-copyts` and no option, the rung lags the source by the time from input
  open to output header, which is mostly probing:

  | Run (`-copyts`, rung path with `useAbsoluteTimestamp`)          | rung − source       |
  | --------------------------------------------------------------- | ------------------- |
  | x264 rung, ffmpeg 7.1.5                                         | +2773 ms (constant) |
  | `-c copy` rung, ffmpeg 7.1.5                                    | +3025 ms            |
  | `-c copy` rung, ffmpeg 9.0.2                                    | +1556 ms            |
  | `-c copy`, `-start_time_realtime` = spawn time, 7.1.5 in podman | −950 ms             |

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
  starting `t` keys every frame until `n_forced` catches up. The following expression gave one
  keyframe per 2 s, aligned with the source's 2 s GOP, so rung segments paired with source
  segments by strip value:

  ```
  expr:if(isnan(prev_forced_t),1,gte(t-prev_forced_t,1.999))
  ```

## Variant A2: the ladder reads SRT (measured, not implemented)

MediaMTX serves SRT readers MPEG-TS whose PTS is the path's own stream timeline. That timeline is
**the same for every reader session**. Three `-copyts` SRT sessions, 10 s apart, gave
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
  publishing `live/<slug>` over SRT would need the stream key like RTMP. Redaction covers the
  secret in `streamid` by value (`ffmpeg/redact.ts`).
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

## Reproduce

The scripts were throwaway, kept in the session scratchpad and not committed. The core commands
were:

```sh
# MediaMTX on a private network (config as above, plus a path regex with useAbsoluteTimestamp: yes)
podman network create clockspike
podman run -d --rm --name mtxup --network clockspike -v $PWD/mediamtx.yml:/mediamtx.yml:ro \
  -p 127.0.0.1:19350:1935 -p 127.0.0.1:18888:8888 docker.io/bluenviron/mediamtx:1.21.2@sha256:c754…
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
