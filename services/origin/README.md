<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# @commonair/origin

The HLS edge in front of MediaMTX. It is the only path viewers, member relays and an
optional CDN use to get video; MediaMTX's HLS listener is never exposed publicly.

```
bun run --filter @commonair/origin start     # listens on ORIGIN_PORT (3003)
bun run --filter @commonair/origin test      # unit tests
bun run --filter @commonair/origin test:int  # MediaMTX in Podman + ffmpeg + Postgres + Valkey
```

Environment: `coreEnv`, `databaseEnv`, `valkeyEnv`, `internalEnv` (`INTERNAL_API_SECRET`, CDN HMAC only),
`mediaEnv` (`MEDIAMTX_HLS_URL`, `MEDIA_INTERNAL_PASSWORD`), `playbackEnv` (`PLAYBACK_SIGNING_KEY`, `ORIGIN_CACHE_MB`,
`CDN_PROVIDER`, `CDN_BASE_URL`) and `ORIGIN_PORT`. `/healthz` and `/readyz` (Postgres, Valkey,
MediaMTX reachable) come from `@commonair/service`.

## Routes

| Route                           | Who           | Auth                                                        | Playlist URIs                                      |
| ------------------------------- | ------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| `GET /hls/live/<slug>/…`        | viewers       | `?t=<playback token>`, `src` = `origin` or `cdn`            | per-viewer, `?t=` appended (relative, or CDN base) |
| `GET /relay-pull/live/<slug>/…` | member relays | `Authorization: Bearer <relay token>`                       | relative, no token                                 |
| `GET /cdn/live/<slug>/…`        | CDN pull      | `x-cdn-auth: <HMAC>` (only when `CDN_PROVIDER=origin-pull`) | relative, no token                                 |

`…` is `index.m3u8`, a media playlist, `init.mp4`, a segment or an LL-HLS part, optionally under
a rendition directory (`1080p`, `720p`, `480p`, `audio`). Paths are validated strictly: known
route, `live/<slug>` with a valid slug, at most one known rendition directory, one flat file
name with a known extension (`m3u8 mp4 m4s m4a m4v ts aac vtt`). Dot segments,
percent-encoding, backslashes and nested directories are rejected with 404 before anything
else happens.

## Request flow

1. **Parse** the raw path (not the normalized URL) and the LL-HLS directives `_HLS_msn`,
   `_HLS_part`, `_HLS_skip` (validated; every other query parameter is dropped).
2. **Authenticate.**
   - Viewers: the Ed25519 playback token is verified with the public half of
     `PLAYBACK_SIGNING_KEY` (signature, expiry with 30 s skew). Its `path` must equal the
     channel path `live/<slug>` (the same token covers every rendition) and `src` must be
     `origin` or `cdn`; anything else is 403. After the channel lookup, `cid` must match too.
   - Relays: the bearer must look like a relay token (`relay_` + 43 base64url chars) before any
     lookup; then `sha256(token)` is looked up in `relay_nodes.token_hash` with status `active` or
     `degraded`; results (including misses) are cached 30 s by hash. 401 otherwise. After 10
     failures per client IP per minute (X-Forwarded-For honoured only from `TRUSTED_PROXY_CIDRS`)
     further attempts get 429 without touching Postgres.
   - CDN: see [CDN mode](#cdn-mode).
3. **Channel lookup**: `channels` by slug. Unknown, offline (`live_broadcast_id` null) and
   suspended channels answer 404; that answer is cached 2 s, live answers 5 s.
4. **Fetch** through the content store (below) from
   `MEDIAMTX_HLS_URL/<path>/<file>` with basic auth `internal` / `MEDIA_INTERNAL_PASSWORD`.
5. **Rewrite playlists** for the puller and **respond**; accounting is recorded after the
   response body is built and never awaited.

### Decision: relay-assigned viewers fetch playlists from their relay

Viewers whose session is assigned to a relay (`src=relay`) load playlists _and_ segments from
`<relay publicUrl>/hls/…`. The relay rewrites URIs to itself and verifies viewer tokens with the
origin's public key; the origin refuses `src=relay` tokens at `/hls`. The origin's job for relays
is serving `/relay-pull` and computing **issuance** (below). The rewriter still supports an
absolute relay base (`<publicUrl>/hls/live/<slug>/…`) so a relay-assigned session could be
bootstrapped from the origin later without new code.

### MediaMTX sessions

MediaMTX 1.21 tracks HLS readers as sessions: the multivariant playlist returns URIs with
`?session=<id>`, everything else is 401 without a live session id, and sessions expire after
30–60 s idle. It also redirects a cookie-less multivariant request through `?cookieCheck=1`.
The origin is one reader per MediaMTX path: it obtains a session from the path's multivariant
(coalesced), renews it after 20 s idle, and retries once with a fresh session on 401. Session ids
are stripped from every URI served; cookies are never forwarded.

## Playlist rewriting

Every URI is rewritten: URI lines (variants, segments) and `URI="…"` on any tag (`EXT-X-MAP`,
`EXT-X-PART`, `EXT-X-PRELOAD-HINT`, `EXT-X-RENDITION-REPORT`, `EXT-X-MEDIA`, …). URIs are
resolved against the playlist's directory and must stay inside `live/<slug>/`; MediaMTX's
`session`, any stale `t` and `cookieCheck` are removed, and then `t=<the viewer's token>` is
appended exactly once. Bases by delivery source:

- `origin`: relative to the playlist (`video1_stream.m3u8?t=…`, `720p/video1_stream.m3u8?t=…`);
- `cdn`: `CDN_BASE_URL/live/<slug>/…` with **no token** (see [CDN mode](#cdn-mode));
- relay pulls and CDN pulls: relative, no token.

**Renditions.** When `KEYS.renditions(channelId)` lists renditions besides `source`, the
multivariant playlist is synthesized from the source path's multivariant and each rendition
path's own (`live/<slug>/<rendition>/index.m3u8`): `BANDWIDTH`, `AVERAGE-BANDWIDTH`,
`RESOLUTION`, `CODECS` and `FRAME-RATE` are MediaMTX's measurements of the real streams, audio
group ids are namespaced per rendition, video variants are sorted by bandwidth, and an
audio-only variant is added (the `audio` rendition if published, otherwise the source's audio
media playlist advertised at 192 kb/s). A rendition whose playlist is not available yet is left
out. The renditions key is cached 2 s.

## Caching and connection limits

The content store is an in-memory LRU bounded by `ORIGIN_CACHE_MB` (no object larger than 1/8 of
the budget is cached), keyed by upstream path plus LL-HLS directives, with **request
coalescing**: concurrent misses for a key share one upstream request. N viewers long-polling the
same `_HLS_msn`/`_HLS_part` cost one upstream request, and every segment and part is pulled from
MediaMTX about once.

| Object                          | Origin cache | `cache-control` to clients                                                      |
| ------------------------------- | ------------ | ------------------------------------------------------------------------------- |
| segment, part, init             | 120 s        | `private` (viewers) / `public` (relay, CDN), `max-age=86400, immutable`         |
| multivariant playlist           | 5 s          | `no-cache`                                                                      |
| media playlist, non-blocking    | 200 ms       | `no-cache`                                                                      |
| media playlist, blocking reload | 1 s          | `private`/`public`, `max-age=6` (the answer for a given msn/part never changes) |
| 404 and other client errors     | 2 s          | `no-store`                                                                      |

Upstream sockets come from two bounded pools: blocking reloads (128) and everything else (256),
so long-polls never starve segment fetches. Waiting for a socket is capped at 2 s (then 503 with
`retry-after: 1`). Each MediaMTX path may have at most 16 distinct blocking keys in flight.
Blocking directives are checked against the playlist's current end (RFC 8216bis §6.2.5.2):
`_HLS_msn` more than two past the last complete segment, `_HLS_part` beyond the parts a segment can
have, or beyond the Advance Part Limit answer 400 at once. A forwarded blocking reload waits at
most 3 × target duration (1.5–15 s), then 503. The HTTP idle timeout is above that maximum.
Other requests time out after 10 s; bodies are capped at 32 MiB; other upstream failures answer 502.

### Player contract: tokens

Playlist URIs carry the viewer's token. hls.js-based players replace it with the token each
heartbeat returns. Native HLS players (Safari, iOS) never change URIs, so when the presented token
has less than 60 s left, the origin embeds a freshly signed token (same claims, new `iat`/`exp`)
in rewritten playlists, as long as the playback session exists and has not ended (checked in
`playback_sessions`, cached 15 s). Ending the session (no heartbeats → the API ends it) therefore
ends playback within one token lifetime.

Viewer responses (`/hls`, `/cdn`) carry `access-control-allow-origin: *` (players on embeds),
`cross-origin-resource-policy: cross-origin`, and never set or read cookies. `OPTIONS` answers
CORS preflights.

## Accounting

- **SegmentFetch** (`STREAMS.segments`): one entry per playlist, segment or part served to a
  viewer (`sid, cid, src, rid?, kind, bytes, at`), buffered and XADDed in pipelined batches every
  250 ms (or every 500 entries) with `MAXLEN ~ 1e6`. While Valkey is down up to 100 000 entries
  are kept, then drops are counted in `origin.accounting.dropped`.
- **Egress** (`egress_samples`): **not written by the origin.** The worker is the single writer:
  it aggregates `STREAMS.segments` per broadcast × minute × source, which stays correct with any
  number of origin replicas. The origin keeps only in-process egress metrics
  (`origin.egress.bytes{source}`, which also covers relay and CDN pulls). Relay pulls and CDN
  pulls carry no viewer session, so they produce no SegmentFetch and therefore do not show up in
  `egress_samples`.
- **Relay issuance** (`relay_issuance`): computed every minute (10 s after the boundary, for the
  previous minute) by `src/issuance.ts`. The formula is documented there and unit-tested:
  sessions assigned to the relay that were alive in the minute × what MediaMTX produced in that
  minute (media objects — full segments, parts and init sections, as relays count them — and
  bytes, maximum over renditions). Production is kept in Valkey (`issuance:production:<epochMinute>`
  hashes, 20 min TTL), each object counted once across all replicas, so restarts lose nothing.
  Each tick recomputes the last 5 closed minutes (idempotent upserts) under a Valkey leader lock
  (`SET NX PX`), so with several replicas exactly one computes per tick, from everyone's production;
  a final tick runs on shutdown. `ORIGIN_ISSUANCE_ENABLED=false` opts a replica out. Until issuance
  moves to the worker, only origin replicas compute it.

## CDN mode

Off by default (`CDN_PROVIDER=none`, `/cdn` answers 404). With `CDN_PROVIDER=origin-pull` and
`CDN_BASE_URL`, configure the CDN to pull `CDN_BASE_URL/<path>` from `<origin>/cdn/<path>` and
to send the header

```
x-cdn-auth: <hex HMAC-SHA256(key = INTERNAL_API_SECRET, message = "cdn-origin-pull-v1")>
```

(`bun -e 'import {cdnAuthValue} from "@commonair/origin"; console.log(await cdnAuthValue(process.env.INTERNAL_API_SECRET))'`).
CDN pulls get shareable responses: relative URIs, no viewer tokens, `public` caching. Playlists
served to CDN-assigned viewers point at `CDN_BASE_URL` without `t=`, one URL per object, so the CDN
can cache it. Viewers
assigned to the CDN load the multivariant playlist from the origin (token checked) and
everything else from the CDN. Viewer tokens on CDN URLs are enforced only if the CDN edge can
verify them, so **CDN mode trades token enforcement for burst capacity**: CDN-delivered sessions
must not count toward verified viewer-hours unless they keep heartbeating to the API.

## Metrics

`origin.requests{route,kind,source,status}`, `origin.cache.lookups{result=hit|miss|coalesced,kind}`
(hit ratio = hit / all), `origin.upstream.duration{kind,status}` (ms),
`origin.egress.bytes{source}`, `origin.accounting.dropped{what}`.
