<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit 2E: Media pipeline (`services/media`, `infra/mediamtx`)

## You own

- `services/media/**` (new package `@commonair/media`)
- `infra/mediamtx/**` (MediaMTX config used by compose)

## Contracts (read-only)

- `packages/contracts/src/internal.ts` (MediaMtxAuthRequest, MediaReadyHook, INTERNAL_ROUTES, MEDIA_INTERNAL_USER, mediaPath, renditionPath, LiveEvent on `BUS.live`, KEYS.renditions, KEYS.simulcastStatus, KEYS.viewers/viewerCount, QUEUES.clips, QUEUES.vodFinalize), `events.ts` (BUS), `enums.ts`.
- DB: broadcasts, broadcast_health_samples, stream_hours (write only `liveSeconds` here; eligibility is computed by integrity later — leave `eligible`/`verifiedOtherViewers` untouched), vods, clips, simulcast_targets, simulcast_sessions, hash_match_results, channels.
- `@commonair/tokens` (`decryptSecret(AUTH_SECRET, "simulcast", …)`), `@commonair/storage` (S3), `@commonair/service`.
- Env: mediaEnv, storageEnv, databaseEnv, valkeyEnv, internalEnv, authEnv.AUTH_SECRET, servicePorts.MEDIA_PORT.

## Build

1. **MediaMTX config** `infra/mediamtx/mediamtx.yml` for `docker.io/bluenviron/mediamtx:1.21.2-ffmpeg` (alpine-based; has `wget` and `ffmpeg`): RTMP :1935, RTSP :8554 (TCP only), HLS :8888 with **LL-HLS** (`hlsVariant: lowLatency`, 1 s segments, 200 ms parts, `hlsSegmentCount` ≥ 7, `hlsAlwaysRemux: yes` for paths under `live/`), WebRTC/WHIP :8889 with ICE UDP :8189 (host ports ≥ 1024, rootless), API :9997 (internal), metrics :9998. `authMethod: http` → `http://api:3001/internal/media/auth` (MediaMTX cannot add custom headers to auth requests: the API authenticates internal callers by user/password in the body, so this is fine). `paths: live/~^[a-z0-9_]{3,25}$` with `runOnReady`/`runOnNotReady` using `wget -q -O- --header "x-internal-secret: $INTERNAL_API_SECRET" --header "content-type: application/json" --post-data '{"path":"$MTX_PATH","sourceType":"$MTX_SOURCE_TYPE","sourceId":"$MTX_SOURCE_ID","query":"$MTX_QUERY"}' http://api:3001/internal/media/ready` (verify the exact env var names and auth request JSON fields against MediaMTX 1.21.2 docs/source; INTERNAL_API_SECRET must come from the container environment, not the file). Rendition paths `live/<slug>/<rendition>` publishable only by internal user. A second minimal config `infra/mediamtx/mock-rtmp-target.yml` for a **mock simulcast target** (accepts any RTMP publish on `:1936`, records nothing) used by the harness.
2. **Live lifecycle**: subscribe to `BUS.live`; on `online` start per-broadcast workers; on `offline` stop them (and on service restart, reconcile from `broadcasts where ended_at is null` + MediaMTX API `/v3/paths/list`).
3. **Health sampling** every 5 s from MediaMTX API (`/v3/paths/get/<path>`, `/v3/rtmpconns/list` or `/v3/webrtcsessions/list` for bytesReceived → bitrate) and every 30 s an `ffprobe` of the RTSP source for codec/resolution/fps/keyframe interval (probe ~4 s of packets, measure keyframe spacing). Write `broadcast_health_samples` with warnings: bitrate > 8000 kbps or < 1000 kbps for resolution, keyframe interval ≠ 2 s (±0.5), fps drop > 10%, B-frames with WHIP, audio missing, codec not H.264/AAC (or Opus for WHIP). Dropped frames: from RTMP stats if available, else derived from fps deficit. Update `stream_hours.liveSeconds` per clock hour.
4. **Adaptive transcoding**: passthrough by default. When the channel's viewer count (`KEYS.viewerCount` or count of `KEYS.viewers` members fresher than 30 s) exceeds `TRANSCODE_VIEWER_THRESHOLD` (default 50) for 30 s, start an ffmpeg ladder reading `rtsp://internal:<secret>@mediamtx:8554/live/<slug>` and publishing RTSP to `live/<slug>/1080p|720p|480p|audio` (skip rungs above the source resolution; audio-only AAC 96k). Stop when below 80% of threshold for 2 minutes (hysteresis). Hardware: probe at startup — `TRANSCODE_HWACCEL=auto` uses `h264_nvenc` if `ffmpeg -encoders` lists it AND a 1-frame test encode succeeds, else `libx264 -preset veryfast -tune zerolatency`; `nvenc` forces (fail loudly if unavailable); `none` forces CPU. Keyframes aligned with the source (`-force_key_frames "expr:gte(t,n_forced*2)"`), 2 s GOP. Set `KEYS.renditions(channelId)` JSON and `broadcasts.transcodeActive`, publish `LiveEvent` renditions. Supervise processes: restart with backoff on crash, kill on stop, parse ffmpeg `-progress` for health.
5. **Simulcast**: on online, for each enabled `simulcast_targets` row start `ffmpeg -c copy` from RTSP to `rtmpUrl/streamKey` (decrypt key), reconnect with exponential backoff (max 60 s), status in `simulcast_sessions` and `KEYS.simulcastStatus(broadcastId)` (`connecting` → `live` once ffmpeg reports progress, `error` with last stderr line on failure, `stopped` on offline). Never log the stream key (redact from ffmpeg args in logs).
6. **VOD recording** (when `channels.vodEnabled`): `ffmpeg -c copy` to fMP4 HLS segments in a local temp dir, uploading each finished segment and the playlist to `S3_BUCKET_MEDIA` under `vods/<vodId>/` as they complete (so a crash loses at most one segment); on offline enqueue `QUEUES.vodFinalize` (you also implement its consumer here: write final playlist with `#EXT-X-ENDLIST`, set duration/size/status `ready`, `expiresAt = now + vodRetentionDays`). Use BullMQ (`bullmq` from catalog, connection from VALKEY_URL).
7. **Clips**: consumer for `QUEUES.clips` jobs `{clipId}`: cut `durationSeconds` from the VOD segments (or, for live clips with no VOD, from a rolling 90 s local segment buffer you keep per live broadcast) with ffmpeg to MP4 + thumbnail; upload to `clips/<clipId>.mp4`; set status.
8. **Thumbnails** every 60 s per live broadcast (`ffmpeg -frames:v 1` from RTSP, 640×360 WebP) → `thumbnails/<broadcastId>/latest.webp` + timestamped copy; update `broadcasts.thumbnailKey`.
9. **CSAM hash-match hook**: interface `HashMatcher { name; check(image: Uint8Array, ctx): Promise<{matched: boolean; details}> }` with the default `NoopHashMatcher` and a `StubVendorMatcher` (configured by `mediaEnv.HASH_MATCH_PROVIDER=stub` with `HASH_MATCH_LIST_FILE`; matches images whose SHA-256 is in an operator-provided list file — for the harness). Run it on every thumbnail and on VOD finalize (sample frames); record `hash_match_results`; on match: end the broadcast via MediaMTX API kick, suspend the channel (`channels.suspendedAt`), write `audit_log`, and **do not** store or log the image. Document that real vendor integration requires an application (non-goal).
10. HTTP health on `MEDIA_PORT` (`runService`), readiness checks MediaMTX API, Postgres, Valkey, S3.

## Dependencies you may add

`bullmq` (catalog: add `"bullmq": "6.3.16"` to your package.json directly since it is not in the root catalog yet; report it).

## Tests

- Unit: ladder selection by source resolution, hysteresis state machine, hwaccel probe parsing, ffmpeg argument builders (incl. key redaction), health warning rules, keyframe-interval computation from ffprobe output fixtures, hash-matcher decision.
- Integration (real MediaMTX container on random ports with YOUR config, real ffmpeg; clean up containers): RTMP publish with a test pattern → ffprobe-based health sample written; transcode start/stop on a simulated viewer count (write the ZSET yourself) producing `live/<slug>/720p`; simulcast to a second MediaMTX acting as the mock target shows `live` status then `stopped` on offline; VOD recording uploads segments (use a local S3: if Garage isn't up in compose yet, run `docker.io/dxflrs/garage:v2.4.1` yourself in the test with a generated config, or skip with a clear message when `S3_ENDPOINT` is unreachable — prefer running it); clip job produces an MP4.

## Done means

See common rules. `services/media/README.md`.
