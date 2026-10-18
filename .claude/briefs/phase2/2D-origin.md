<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit 2D: Origin HLS edge (`services/origin`)

## You own

- `services/origin/**` (new package `@commonair/origin`)

## Contracts (read-only)

- `packages/contracts/src/tokens.ts` (PlaybackClaims, TTL), `internal.ts` (MEDIA_INTERNAL_USER, mediaPath/renditionPath, KEYS.renditions, KEYS.relays, STREAMS.segments + SegmentFetch), `enums.ts` (DELIVERY_SOURCES, RENDITIONS).
- `@commonair/tokens` (importSigningKey → derive public key from PLAYBACK_SIGNING_KEY, verifyPlaybackToken, sha256Hex, timingSafeEqual).
- DB: relay_nodes (tokenHash, status), relay_issuance, egress_samples, broadcasts, channels.
- Env: playbackEnv, mediaEnv (MEDIAMTX_HLS_URL), internalEnv, databaseEnv, valkeyEnv, servicePorts.ORIGIN_PORT.

## Build

The only path viewers (and relays and CDNs) use to get video. MediaMTX is never exposed publicly.

1. **Viewer routes**: `GET /hls/live/<slug>/index.m3u8?t=<token>` and everything under `/hls/live/<slug>/...` (media playlists, `.mp4`/`.m4s`/`.ts` segments, LL-HLS parts, `init.mp4`). Verify the token (signature, expiry, `path` equals the requested path's channel path, `src` is `origin` or `cdn`) — 403 otherwise. Pass through LL-HLS blocking-reload query params (`_HLS_msn`, `_HLS_part`, `_HLS_skip`) to MediaMTX and stream the response; keep connection limits sane (long-polling playlist requests must not exhaust upstream sockets — use a per-playlist **request coalescing** layer so N viewers waiting on the same `_HLS_msn` cause one upstream request).
2. **Playlist rewriting**: fetch from `MEDIAMTX_HLS_URL/<path>/...` with basic auth `MEDIA_INTERNAL_USER`/INTERNAL_API_SECRET. Rewrite every URI (variants, segments, parts, `EXT-X-MAP`, `EXT-X-PRELOAD-HINT`, `EXT-X-RENDITION-REPORT`) to carry `t=<token>` and to point at the session's delivery base: origin (relative), relay (`<relay publicUrl>/hls/...` when `src=relay`), CDN (`CDN_BASE_URL/...` when `src=cdn`). When `KEYS.renditions(channelId)` lists renditions, synthesize the **multivariant playlist** combining source + `live/<slug>/<rendition>` paths with correct BANDWIDTH/RESOLUTION/CODECS (read from the rendition playlists or a JSON the media service stores alongside — coordinate via the keys contract only: if you need more data in KEYS.renditions, file a contract request and meanwhile derive from playlists) and an audio-only rendition.
3. **Segment caching**: in-memory LRU (size-bounded by `playbackEnv.ORIGIN_CACHE_MB`) keyed by upstream path; coalesce concurrent misses; immutable segments get long `cache-control`, playlists `no-cache`/short max-age per LL-HLS rules. This is what keeps origin egress to MediaMTX at ~1× per segment.
4. **Accounting**: for every playlist/segment/part served, `XADD STREAMS.segments` a SegmentFetch (sid, cid, src, rid?, kind, bytes, at) — batch with pipelining, never block the response. Track egress bytes by source in-process and flush per-minute aggregates to `egress_samples` (upsert, add) for the broadcast.
5. **Relay pull**: `GET /relay-pull/live/<slug>/...` authenticated by `Authorization: Bearer <relay token>` (sha256 lookup in relay_nodes, status active/degraded, cached 30 s). Relays get raw upstream content (playlists un-rewritten except URIs made relative). For relay-assigned viewer sessions, the origin is the one rewriting playlists... decide and document: **viewers assigned to a relay fetch playlists from the relay too** (the relay rewrites URIs to itself and verifies viewer tokens), so the origin's job for relays is serving relay-pull and recording **issuance**: each relay-pull of a new media segment that the relay then serves is unknowable to the origin, so issuance is computed from what the origin _issued_: for each relay, per minute, count the playback sessions assigned to it that heartbeat (from `playback_sessions` where relayId = R and active) × segments produced in that minute × segment size — implement this computation as a function in `src/issuance.ts` that a worker (or this service on a 60 s timer) runs and upserts into `relay_issuance` (sessions, segmentTokens, bytesIssued). Make the formula explicit and unit-tested; it is the ground truth for receipt cross-checks.
6. **CDN origin-pull**: `GET /cdn/live/<slug>/...` authorized by a shared header `x-cdn-auth: <INTERNAL_API_SECRET-derived HMAC>` (document it) so a CDN can pull; viewer tokens are still checked at the CDN edge only if it supports it — document that CDN mode trades token enforcement for burst capacity and therefore excludes CDN-delivered sessions from viewer-hours unless they heartbeat.
7. **Security and headers**: CORS `*` for GETs on `/hls` (players on embeds), no cookies, `cross-origin-resource-policy: cross-origin` for media. Strict path validation (no `..`, only known extensions). Return 404 for offline channels quickly (cache negative lookups 2 s).
8. Metrics: requests by kind/source, cache hit ratio, upstream latency, egress bytes by source.

## Dependencies you may add

none required (use `fetch`, `Bun.serve`).

## Tests

- Unit: playlist rewriting (fixtures for MediaMTX LL-HLS multivariant + media playlists incl. parts/preload hints/rendition reports; relay and CDN bases; token appended exactly once), multivariant synthesis, path validation, LRU + coalescing, issuance formula.
- Integration: run a real MediaMTX container on random host ports (`podman run --rm -d --name origin-test-<rand> -p ...:8888 -p ...:8554 docker.io/bluenviron/mediamtx:1.21.2` with a minimal config allowing internal auth — or `authMethod: internal` with the internal user), publish a short ffmpeg test pattern (`ffmpeg -re -f lavfi -i testsrc2=size=640x360:rate=30 -f lavfi -i sine -c:v libx264 -g 30 -c:a aac -f rtsp rtsp://internal:<secret>@127.0.0.1:<port>/live/test`), then through the origin: playlist with a valid token returns rewritten URIs, segments stream, invalid/expired/wrong-path tokens 403, SegmentFetch entries land in Valkey (unique stream key prefix in tests — make the stream name configurable for tests), egress_samples rows written, 100 concurrent playlist requests cause ≤ 2 upstream requests. Always stop/remove the container in afterAll.

## Done means

See common rules. `services/origin/README.md` explains the request flow, caching and accounting.
