<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# @commonair/media

The media pipeline behind MediaMTX: stream health, adaptive transcoding, simulcast, VOD
recording, clips, thumbnails and the CSAM hash-match hook. It has no public HTTP surface; it
serves only `/healthz` and `/readyz` on `MEDIA_PORT` (readiness checks MediaMTX's API,
Postgres, Valkey and S3).

```
bun src/main.ts          # run (needs ffmpeg + ffprobe on PATH)
bun run test             # unit tests
bun run test:int         # integration: real MediaMTX, Garage, ffmpeg (needs podman)
```

## How it fits

MediaMTX (`infra/mediamtx/mediamtx.yml`) takes RTMP/WHIP ingest and asks the API
(`/internal/media/auth`) about every publish, read and API call. When a stream goes
online/offline its `runOnOnline`/`runOnOffline` hooks POST `MediaReadyHook` to the API, which
owns the `broadcasts` row and publishes `LiveEvent` on `BUS.live`. This service subscribes and
runs one **broadcast session** per live broadcast:

| Part       | What it does                                                                                                                                                                                                                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Health     | Every 5 s: ingest bitrate from MediaMTX's byte counter, live seconds into `stream_hours.liveSeconds` (per UTC hour; eligibility is integrity's). Every 30 s: ffprobe reads ~4 s of the source and measures codec, resolution, real fps, keyframe spacing and B-frames. One `broadcast_health_samples` row per poll, with warning codes. |
| Transcode  | Passthrough by default. Above `TRANSCODE_VIEWER_THRESHOLD` viewers for 30 s, one ffmpeg ladder publishes `live/<slug>/1080p\|720p\|480p\|audio` back over RTSP (no upscaling, 2 s keyframes aligned via `-force_key_frames`, no B-frames). Stops after 2 min below 80% of the threshold.                                                |
| Simulcast  | `ffmpeg -c copy` to every enabled target; reconnect backoff 1 s → 60 s. Status in `simulcast_sessions` and `KEYS.simulcastStatus`.                                                                                                                                                                                                      |
| Recorder   | `ffmpeg -c copy` to local fMP4 HLS segments: a rolling 90 s buffer for live clips, and, when the channel has VODs on, each finished segment then the playlist is uploaded to `vods/<vodId>/`.                                                                                                                                           |
| Thumbnails | Every 60 s a 640×360 frame, hash-checked, then `thumbnails/<broadcastId>/latest.<ext>` and a timestamped copy (written to `broadcasts.thumbnailKey`).                                                                                                                                                                                   |

BullMQ consumers: `QUEUES.vodFinalize` (`{vodId}`; enqueued here on offline and by reconcile)
closes the playlist, samples frames for the hash check, sets duration/size/`ready` and
`expiresAt = now + channels.vodRetentionDays`. `QUEUES.clips` (`{clipId}`, enqueued by the API)
cuts `durationSeconds` at `startOffset` seconds into the broadcast from the live buffer or the
VOD and uploads `clips/<clipId>.mp4` plus a thumbnail.

Every 30 s a reconcile compares `broadcasts where ended_at is null` with MediaMTX's path list:
it starts sessions missed while the service was down, stops sessions whose broadcast ended or
whose path has gone, and finalizes VODs orphaned by a crash. On SIGTERM sessions stop without
finalizing; the next process resumes the same VOD (with a discontinuity).

## Housekeeping and limits

- **Unfinished VODs.** The reconcile also looks at `recording` VODs whose broadcast ended and
  `processing` VODs. The finalize job id is the VOD id, so its BullMQ state tells whether a worker
  owns the VOD. Unowned VODs are re-queued (finalize is idempotent; a job that used up its retries
  is retried after 10 min). A VOD still unfinished 24 h after its broadcast ended is marked
  `failed` with `removedReason = finalize_stalled` (`no_segments` when nothing was recorded).
- **Crash recovery.** On startup, before any session or job runs, every `broadcasts/<id>/` in
  `MEDIA_WORK_DIR` is examined: completed segments of a still-open VOD that the dead process never
  uploaded are uploaded and appended to the VOD playlist, partial `.tmp` segments are dropped, and
  the directory is removed. Job scratch dirs (`clip-*`, `vod-*`) are deleted too.
- **Work-dir sweep.** Every 5 min, a broadcast directory no session owns (untouched for 15 min)
  is recovered like at startup and deleted only once its segments are safe: recovery succeeded,
  or its VOD is ready, failed or gone. A `processing` VOD keeps its directory until finalize ends.
  Job scratch dirs are deleted unless a running clip/finalize job registered them
  (`ActiveScratch`); age alone decides only at startup, when no job runs.
- **Disk budget.** New recordings and clip cuts are refused while the work dir holds more than
  `MEDIA_WORK_DIR_MAX_BYTES` (20 GiB) or its filesystem has less than
  `MEDIA_WORK_DIR_MIN_FREE_BYTES` (2 GiB) free. A refusal logs the `media.disk_budget_exceeded` event; a refused recording shows
  `recording_disk_budget` in stream health and starts by itself once space is back; a refused clip
  fails with `removedReason = disk_budget_exceeded`; VOD finalization retries later.
- **Transcode slots.** At most `TRANSCODE_MAX_LADDERS` ladders run per host (unset: 2 with NVENC,
  one per four CPU cores with libx264). Further broadcasts queue in
  arrival order, retry every poll and show `transcode_capacity` in stream health meanwhile.
- **Thumbnail history.** Only the newest 10 timestamped thumbnails per broadcast are kept.

## Health warning codes

`bitrate_high` (> 8000 kbps), `bitrate_low` (below 1000 kbps at ≥ 720p, 600 at ≥ 480p, 300
below), `keyframe_interval` (not 2 s ± 0.5 s), `fps_drop` (> 10% below the declared rate),
`b_frames_webrtc` (B-frames on a WHIP source), `audio_missing`, `video_missing`,
`video_codec_unsupported` (not H.264), `audio_codec_unsupported` (not AAC, or Opus for WHIP).
`droppedFrames` is the larger of MediaMTX's corrupt-frame counter and the fps deficit over the
interval (RTMP does not report encoder drops). Two codes describe the server, not the source:
`transcode_capacity` (the ladder is queued for a free slot) and `recording_disk_budget`
(recording paused, work dir over its disk budget).

## Hardware encoding

`TRANSCODE_HWACCEL=auto` uses `h264_nvenc` only when `ffmpeg -encoders` lists it **and** a
1-frame test encode succeeds; otherwise `libx264 -preset veryfast -tune zerolatency`. `nvenc`
refuses to start without a working NVENC; `none` always uses the CPU. Thumbnails are WebP when
ffmpeg has `libwebp` (the MediaMTX `-ffmpeg` image and Alpine's ffmpeg do) and JPEG otherwise.

## CSAM hash matching

`HashMatcher` is the integration point. `HASH_MATCH_PROVIDER=none` (default) checks nothing and
records nothing. `stub` matches exact SHA-256 digests listed in `HASH_MATCH_LIST_FILE` (one hex
digest per line, `#` comments) and exists so the harness can exercise enforcement. On a match
the image is discarded (never stored or logged), a `hash_match_results` row is written, the
channel is suspended (`suspendedReason = csam_hash_match`) with an `audit_log` row in the same
transaction, the publisher is kicked through the MediaMTX API and local work stops. A matching
VOD or clip is removed.

Real perceptual-hash services (PhotoDNA, NCMEC/IWF hash lists and similar) require an
application to and an agreement with the vendor, and often legal reporting obligations. Shipping
a vendor adapter is a non-goal of this repository; operators who are approved implement
`HashMatcher` against their vendor's API.

## Secrets

Simulcast keys are decrypted with `decryptSecret(AUTH_SECRET, "simulcast", …)` only when a
broadcast starts. The key is never logged: every ffmpeg argument list and stderr line is passed
through `redact()`, which removes the stream key, the whole target URL (as configured and as
actually spawned, query string included), the internal RTSP password and any URL userinfo.

**The stream key is in ffmpeg's argv, and the container is the boundary.** ffmpeg has no way to
take an output URL or an RTMP protocol option from a file (`-/option file` only covers ffmpeg's
own options; `-fpre` values never reach the protocol; verified with ffmpeg 9.0), so the publish
URL with the key is a process argument. Process arguments are visible only inside the process's
PID namespace: the media service runs in its own container (rootless Podman), where nothing but
the media service and its ffmpeg children runs, so no other local user or service can read them
with `ps` or `/proc/<pid>/cmdline`. Keep it that way: never run media with `--pid=host` or share
its PID namespace, and never add unrelated processes to its container.

**Simulcast targets are SSRF-checked** (`src/net/ssrf.ts`): only `rtmp:`/`rtmps:` URLs without
credentials (query strings are allowed). Right before every ffmpeg spawn (and so before every
reconnect) the host is resolved and refused if any address is loopback, private, link-local,
CGNAT, multicast, reserved, documentation or a cloud metadata address (IPv4 and IPv6, including
IPv4-mapped, NAT64 and 6to4 forms); an IPv4 address is preferred. For `rtmp:` ffmpeg is given
the vetted IP itself (with `-rtmp_tcurl` carrying the real host name), so DNS rebinding cannot
redirect it. For `rtmps:` the host name must stay in the URL for TLS SNI, so ffmpeg resolves it
again: a rebinding window of a few milliseconds between check and connect remains (and ffmpeg
does not verify server certificates by default). `OUTBOUND_ALLOW_PRIVATE_NETWORKS=true` (dev and
harness only) allows private targets. Streamers only see generic `lastError` codes
(`target_not_allowed`, `connection_failed`, `stream_key_unreadable`); details go to the logs.
