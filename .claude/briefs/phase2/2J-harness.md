<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit 2J: Simulation harness core (`harness/**`)

## You own

- `harness/**` (workspace package `@commonair/harness`; a placeholder `harness/package.json` exists — extend it)

## Contracts (read-only)

- `packages/contracts` (the oRPC `contract`, DTOs, events, chat protocol, internal ingest URL conventions in `internal.ts`), `packages/config` env, PLAN.md Phase 4 (the full scenario list — your framework must make every one of them expressible), AGENTS.md.

## Build

The harness is the test scene: it drives the running platform like real users would.

1. **CLI** `harness/src/cli.ts`: `run <scenario...> [--profile no-proprietary] [--report path]`, `list`, `load --streamers N --viewers M --duration 120s`. Scenarios are modules in `harness/scenarios/<name>.ts` exporting `{ name, description, needs: ("api"|"chat"|"irc"|"origin"|"media"|"relay"|"stripe"|"mail"…)[], run(ctx) }`; a registry; `full` composes all. Each scenario is individually runnable and idempotent against a running stack (unique usernames per run). Results: JSON + human summary in `harness/reports/` (gitignored) with timings, metrics and assertion outcomes; non-zero exit on failure.
2. **Context**: typed API client generated from the contract (`@orpc/client` with `RPCLink` against `/rpc`, cookie jar per simulated user), helpers to sign up users through the real auth flow (solve ALTCHA challenges with `altcha-lib`'s solver; read verification emails from Mailpit API), create channels, mint tokens, etc. Base URLs from env (`HARNESS_API_URL` default `http://localhost:3001`, `HARNESS_WEB_URL` default `http://localhost:3000`, Mailpit API `http://localhost:8025`, MediaMTX RTMP `rtmp://localhost:1935`, WHIP `http://localhost:8889`); waiters with timeouts; structured logging.
3. **Simulated streamers** `src/streamer.ts`: ffmpeg publishing synthetic video — `testsrc2` + sine audio + burned-in wall-clock timecode (drawtext) AND a machine-readable **timestamp strip**: a row of black/white blocks encoding epoch milliseconds drawn with the `geq` filter from frame time + start offset (so viewers can decode exact capture time from pixels) — over **RTMP** and **WHIP** (check the local ffmpeg build: `ffmpeg -muxers | grep whip`; ffmpeg ≥ 8 has a WHIP muxer; if unavailable, implement WHIP via a small fallback and document). Options: resolution, fps, bitrate, keyframe interval (to trigger health warnings), duration, "bad encoder" modes (wrong keyframe interval, too-high bitrate). Process supervision and cleanup.
4. **Simulated viewers** `src/viewer.ts`: Playwright **Chromium and WebKit** (headless) opening a player page — by default a harness-owned minimal page served by the harness (`harness/player/index.html` bundling hls.js from node_modules — self-hosted, no CDN) that calls the real `playback.start` API, plays the signed playlist, sends heartbeats like the real player contract, and reports: time-to-first-frame, stall count/duration, glass-to-glass latency (decode the timestamp strip from a canvas `drawImage` of the video every second and compare to `Date.now()`), bytes HTTP/P2P. WebKit must use **native HLS** (no MSE path) to mirror Safari/iOS and must fall back cleanly with P2P disabled. A switch `--player web` later points viewers at the real web app's embed route (`/embed/<channel>`) once it exists; keep a single viewer interface.
   Scaling: many viewers per browser context/page with low resolution; a lightweight **HTTP-only viewer** (no browser: fetches playlists/segments on schedule and heartbeats) for load tests where 200+ real browsers are too heavy — the full scenario uses a mix (e.g. 20 browser viewers + 180 HTTP viewers); both look "real" to integrity (headful-like fingerprints, realistic heartbeat jitter).
5. **Simulated viewbots** `src/viewbot.ts`: scripted fake viewers and chatters designed to be caught: datacenter IPs (set the `X-Forwarded-For`-equivalent the API trusts in harness mode? — design: the API trusts `x-forwarded-for` only from configured proxies; the harness runs through a tiny local proxy you write that injects addresses from the sample hosting CIDRs — document this; the API trusts `x-forwarded-for` only from `coreEnv.TRUSTED_PROXY_CIDRS`), headless fingerprints, perfectly periodic heartbeats, playlists without segments, many sessions per device, follow bursts from fresh accounts, chat spam.
6. **Chat clients**: harness chat client over the chat WebSocket (`ClientFrame`/`ServerFrame`) for chat scenarios; an **SDK bot** stub interface (the real SDK lands later — define `harness/src/bots/sdk-bot.ts` against the contract-level client so it can be swapped to `@commonair/sdk`) and a **tmi.js bot** (unmodified `tmi.js` 1.8.5 connecting to the IRC gateway WS port) that answers `!ping` → `pong` and `!uptime`.
7. **Metrics**: per-scenario timing; system metrics sampler for load tests (Prometheus HTTP API queries when available: origin egress bytes by source, CPU per container via `podman stats --no-stream --format json`, p95 latency from viewer reports).
8. **Load test** `load` command: N streamers × M viewers for a duration, reporting origin egress, CPU, p95 glass-to-glass and TTFF, stall rate.
9. **Scenarios to implement now** (others are added by later units using your framework): `smoke` (API up, sign up, sign in), `ingest-rtmp` and `ingest-whip` (publish → `stream.online` observable via API `channels.get` live → playback through origin plays in Chromium and WebKit with measured TTFF/latency → stop → offline), `viewers` (N viewers on one channel; verified viewer count converges), `load-smoke` (2×10 for 30 s). Until the API/origin units are merged, these scenarios cannot pass end to end — write them fully, and verify your drivers in isolation with integration tests (below).

## Dependencies you may add

`@playwright/test` 1.64.1 (or `playwright`), `hls.js` 1.7.3, `tmi.js` 1.8.5, `altcha-lib` 2.6.0, `@orpc/client` (catalog). Use the installed system `ffmpeg`. Install Playwright browsers to the default cache (`bunx playwright install chromium webkit`).

## Tests

- Unit: timestamp-strip encoder/decoder round trip (encode a number into the bit layout, render via ffmpeg one frame to PNG, decode the PNG pixels → same ms ±1 frame), ffmpeg arg builders, scenario registry/CLI parsing, report formatting, viewbot behaviors produce the intended signals.
- Integration: run a throwaway MediaMTX container on random ports (`docker.io/bluenviron/mediamtx:1.21.2`, permissive config, unique container name, removed in afterAll); RTMP streamer publishes; the harness player page plays it directly from MediaMTX HLS in **Chromium and WebKit** and reports TTFF and a glass-to-glass latency within sane bounds (< 15 s); HTTP-only viewer fetches segments; WHIP publish if supported.

## Done means

Common rules; `harness/README.md` explains every driver, how to run scenarios and the load test, and how to add a scenario.
