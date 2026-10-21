<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# @commonair/media

The media pipeline behind MediaMTX: stream health, adaptive transcoding, simulcast, VOD
recording, clips, thumbnails and live moderation sampling (PDQ hash matching). It has no public HTTP surface; it
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
| Thumbnails | Every 60 s a 640×360 frame, PDQ-checked, then `thumbnails/<broadcastId>/latest.<ext>` and a timestamped copy (written to `broadcasts.thumbnailKey`).                                                                                                                                                                                    |

BullMQ consumers: `QUEUES.vodFinalize` (`{vodId}`; enqueued here on offline and by reconcile)
PDQ-checks frames over the whole recording, closes the playlist, sets duration/size/`ready` and
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
  `failed` with `failedReason = finalize_stalled` (see "VOD failure codes").
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

### VOD failure codes

A VOD in status `failed` carries a stable code in `vods.failed_reason` (never free text or personal
data; the web app maps codes to messages). `removed_reason` is only for removals (`deleted`, e.g.
`t0_hash_match`).

| Code               | Written by                         | Meaning                                                                |
| ------------------ | ---------------------------------- | ---------------------------------------------------------------------- |
| `no_segments`      | finalize (`src/vod/finalize.ts`)   | The broadcast ended without a single uploaded segment: nothing to keep |
| `finalize_stalled` | reconcile (`src/vod/reconcile.ts`) | Still `recording`/`processing` 24 h after the broadcast ended          |

Crash recovery never fails a VOD: it uploads what the dead process left and hands the VOD back to
finalize, which ends in `ready` or one of the codes above.

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

## Moderation

Media's half of automated moderation ([ADR 0006](../../docs/decisions/0006-automated-moderation.md),
spec [docs/testing/e4c-selectors.md](../../docs/testing/e4c-selectors.md)), in `src/moderation/`.
It cannot be switched off: there is no env var or setting that skips sampling or matching.

**Startup fails closed.** `EVIDENCE_PUBLIC_KEY` must import, both operator lists
(`MODERATION_HASHLIST_CSAM`, `MODERATION_HASHLIST_NCII`; an empty path is a valid empty list) must
parse and the database block list (`local_hash_list`, one list per category) must load, or the
service refuses to start. One log line lists each list's category, provider, version and size.
Operator files reload on SIGHUP and on change; the block list is re-checked every
`MODERATION_SAMPLE_SECONDS` with one aggregate query (version `local:<count>:<newest id>`). A
failed reload keeps the last good list and logs the category and line number.

**What is sampled, and when.** Per live broadcast: one frame as soon as the session starts (well
within 3 s of publish; a failed capture retries after 1 s), then one every
`min(MODERATION_SAMPLE_SECONDS, moderation.thresholds.sampleSeconds)` seconds, re-read before each
wait, independent of the 60 s thumbnail. One ffmpeg reader takes a single frame from the internal
RTSP source as PNG; `@commonair/moderation` decodes it to raw luma 512² (PDQ) and RGB 384²
(classifier) of the same frame. Media runs PDQ itself; frames below quality 50 are never matched
but are still classified. Every live thumbnail is PDQ-checked before it is written. Before a VOD
or clip is set `ready`, every frame sampled at the live interval (VODs, in chunks of at most 60 s
of segments) or every second (clips) is PDQ-checked, all of them, plus the thumbnail; a scan that
cannot complete throws and the job retries (nothing is published).

**What is stored.** Nothing for an unflagged frame: the RGB bytes go to Valkey
(`KEYS.moderationFrame`, TTL 60 s) and a `scan` job on `QUEUES.moderation` carries the ids, the
PDQ (null below quality 50) and the quality. Nothing is written to S3 or Postgres. If the
moderation queue holds more than 3 waiting jobs per live broadcast, the classifier job is dropped
(counted, warned once a minute); PDQ and matching still run on every frame.

**T0 (a list match), kick first.** On a live match media (1) adds the broadcast, channel and path to
an in-process tainted set and kicks the publisher through the MediaMTX API, (2) stops local workers
without finalizing the VOD, (3) encodes the matched frame's luma and RGB as PNG, seals both to the
evidence public key (the PDQ is recorded on the luma object) and enqueues `moderation.t0` with
`jobId = t0JobId("broadcast", id)`, retrying with backoff until it lands (`fatal` log after five
failures; the stream is off air regardless). A reconnect of a tainted channel or path is kicked
before any work starts until the worker's suspension makes the API refuse it. A VOD or clip match
enqueues `t0` for that VOD or clip (a failed enqueue fails the job, which retries) and marks it
`deleted` with `removed_reason = t0_hash_match`; a clip is never uploaded. A VOD or clip of a
broadcast with a T0 match (in this process, a T0 suspension, an open T0 case, or a T0 job on the
queue) is never published. Media writes no moderation table, never suspends and never moves or
deletes objects: the worker applies the T0 transaction, copies the media to the evidence bucket and
deletes the public copies.

**Logs** carry ids, categories, providers, list versions, distances and qualities only; ffmpeg
errors are logged by name (their text can contain the source URL).

**Metrics** (meter `media`): `moderation_frames_total{outcome=sampled|matched|low_quality|enqueued}`,
`moderation_classifier_dropped_total`, `moderation_capture_failures_total`,
`moderation_scan_enqueue_failures_total`, `moderation_t0_enqueue_failures_total`,
`moderation_t0_total{subject}`, `moderation_prepublish_frames_total{subject}`.

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
