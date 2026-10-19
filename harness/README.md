<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Simulation harness (`@commonair/harness`)

The harness drives a running CommonAir stack the way real people do: streamers publishing with
ffmpeg, viewers watching in real Chromium and WebKit browsers (and hundreds of lightweight HTTP
viewers), chatters, Twitch-style bots, and viewbots built to be caught. Scenarios assert on what
the platform does in response and write a JSON + human report.

## Quick start

```sh
bun install
bun run --filter @commonair/harness browsers      # Playwright Chromium + WebKit (once)
podman compose up -d                              # the stack
bun harness/src/cli.ts list
bun harness/src/cli.ts run smoke
bun harness/src/cli.ts run full --profile no-proprietary
bun harness/src/cli.ts load --streamers 4 --viewers 200 --duration 120s
```

Host requirements: Bun, Go (for `e2e-relay`), `ffmpeg` on `PATH` (≥ 8 for WHIP; `geq`, `testsrc2`, `sine`, `libx264`,
`aac`, `libopus`), Playwright browsers, and `podman` for the driver integration tests.

## CLI

| Command                                          | What it does                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `run <scenario...>`                              | Run scenarios in order. `full` expands to every scenario not marked `inFull: false`, smoke first. |
| `list [--json]`                                  | Scenarios with descriptions and needs (`*` = part of `full`).                                     |
| `load --streamers N --viewers M --duration 120s` | Load test (see below). `--browser-viewers K`, `--protocol rtmp\|whip`.                            |

Options for `run` and `load`:

- `--profile no-proprietary` (alias `--no-proprietary`): scenarios that need a vendor adapter
  (`stripe`, `oauth`, `cdn`) are skipped and everything else runs on the FOSS defaults. Scenarios
  read `ctx.profile` to pick the `manual` payment path, etc.
- `--report <path>`: where the JSON report goes. Default `harness/reports/<time>-<cmd>-<run>.json`
  (gitignored), next to a `.txt` summary, plus `harness/reports/latest.json`.
- `--set key=value`: scenario parameters (`ctx.param` / `ctx.intParam`), e.g. `--set viewers=50`.
- `--player harness|web`: which page browser viewers open (see Viewers).
- `--skip-unavailable`: skip instead of fail scenarios whose needs are unreachable.

Exit code is 0 only if no scenario failed; 2 on usage errors. Ctrl-C aborts the run (cleanups and
the report still happen); a second Ctrl-C exits immediately. Every ffmpeg process is supervised
and killed if the harness exits.

## Configuration

All variables are optional; defaults match `compose.yaml` (see `src/env.ts`).

| Variable                                                                         | Default                                           |
| -------------------------------------------------------------------------------- | ------------------------------------------------- |
| `HARNESS_API_URL` / `HARNESS_WEB_URL` / `HARNESS_ORIGIN_URL`                     | `http://localhost:3001` / `:3000` / `:3003`       |
| `HARNESS_MAILPIT_URL`                                                            | `http://localhost:8025`                           |
| `HARNESS_RTMP_URL` / `HARNESS_WHIP_URL`                                          | `rtmp://localhost:1935` / `http://localhost:8889` |
| `HARNESS_IRC_WS_URL`                                                             | `ws://localhost:6680`                             |
| `HARNESS_CHAT_HEALTH_URL`, `HARNESS_IRC_HEALTH_URL`, `HARNESS_WORKER_HEALTH_URL` | service `/healthz` URLs (needs probing)           |
| `HARNESS_STRIPE_MOCK_URL`                                                        | `http://localhost:12111`                          |
| `HARNESS_PROMETHEUS_URL`                                                         | unset (load test then uses viewer-reported bytes) |
| `HARNESS_CONTAINER_PREFIX`                                                       | `commonair` (containers sampled for CPU)          |
| `HARNESS_PLAYER`                                                                 | `harness`                                         |
| `HARNESS_DATACENTER_CIDRS_FILE` / `HARNESS_RESIDENTIAL_CIDRS_FILE`               | bundled samples in `fixtures/`                    |
| `HARNESS_EMAIL_DOMAIN`                                                           | `harness.test` (delivered to Mailpit only)        |
| `HARNESS_HEADFUL`                                                                | `false` (`true` shows the browsers)               |
| `HARNESS_REPORT_DIR`, `LOG_LEVEL`                                                | `harness/reports`, `info`                         |

### Stack settings for harness runs

- `TRUSTED_PROXY_CIDRS=127.0.0.1/32` (or the harness host's address as the API sees it) so the API
  honours the harness forwarding proxy's `x-forwarded-for` (see Simulated addresses).
- `INTEGRITY_DATACENTER_CIDRS_FILE=harness/fixtures/datacenter-cidrs.txt` so viewbots are
  detectable.
- `EVENTSUB_ALLOW_INSECURE_CALLBACKS=true` for webhook scenarios; short governance periods via
  `GOVERNANCE_BOOTSTRAP_JSON`.

## Drivers

### Context and API client (`src/platform.ts`, `src/api/`, `src/users.ts`)

`ctx.platform` is the stack as the harness sees it. `platform.api()` returns a typed client
generated from the oRPC contract (`ContractRouterClient<Contract>` over `RPCLink` at `/rpc`, the
same protocol the web app uses), with its **own cookie jar** and its own simulated address, so
every simulated user is isolated. `platform.signUp()` goes through the real auth flow: fetch an
ALTCHA challenge (`GET /api/auth/altcha-challenge`), solve it with `altcha-lib`'s solver (v1 and v2
formats), `POST /api/auth/sign-up/email` with a birth date and the current legal document ids,
read the verification email from Mailpit and follow its link, then sign in. Usernames are unique
per run (`<prefix>_<run tag><n>`), so scenarios are idempotent against a long-lived stack. Other
helpers: `streamerFor(user)` (rotates the stream key and builds a streamer), `waitForLive`,
`viewerCount`, `openViewers`, `chat`, `createBot`, `sdkBot`, `tmiBot`. Waiters (`src/wait.ts`)
always have deadlines and say what they waited for; logs are structured JSON via
`@commonair/observability`.

### Simulated streamers (`src/streamer.ts`, `src/ffmpeg.ts`)

ffmpeg publishes `testsrc2` + a sine tone. Every frame carries a **timestamp strip**
(`src/timestamp-strip.ts`): 54 cells across the top of the frame — white/black sync cells, 44 bits
of capture time in epoch milliseconds, and an 8-bit checksum (ms mod 251) — drawn by ffmpeg's
`geq` filter from the frame time plus the start offset. Cell positions and strip height are
proportional to the frame, so viewers decode it at any rendition or canvas size. When the local
ffmpeg has `drawtext`, a human-readable UTC timecode is burned in below the strip (the Homebrew
build has no libfreetype, so it is skipped automatically there; the strip is what the harness
measures with).

- RTMP: `rtmp://<host>/live/<slug>?key=<secret>` (the API's OBS stream key, verbatim), H.264 high +
  AAC in FLV.
- WHIP: ffmpeg's native `whip` muxer (ffmpeg ≥ 8; checked with `ffmpeg -muxers`), H.264 constrained
  baseline without B-frames + Opus, `Authorization: Bearer <secret>`, endpoint
  `<whip base>/live/<slug>/whip`. If the local ffmpeg lacks the muxer, `start()` fails with a clear
  message and scenarios needing `whip` report the unmet need; there is no fallback publisher.
- Options: resolution, fps, bitrate, keyframe interval, duration, tone, and bad-encoder modes:
  `wrong-keyframe` (10 s GOP) and `high-bitrate` (4× the requested bitrate), to trigger stream-health
  warnings.
- `start()` resolves once ffmpeg reports encoded frames (`-progress pipe:1`); `stats` exposes fps,
  bitrate and dropped frames; `stop()` sends SIGINT then SIGKILL after a grace period.

Known bias: the strip encodes `start + frame time`, so ffmpeg's start-up delay (typically < 0.3 s)
is added to measured latency, never subtracted.

### Viewers (`src/viewer.ts`, `src/browser-viewer.ts`, `src/http-viewer.ts`, `player/`)

One `Viewer` interface (`start`, `waitForFirstFrame`, `report`, `stop`) for every kind:

- **Browser viewers** (Playwright, headless): Chromium plays with hls.js over MSE; WebKit uses
  **native HLS** (no MSE), like Safari and iOS, and never asks for P2P. Several players can share
  one page (`perPage`) at small sizes to fit many viewers per browser.
- **The harness player page** (`player/index.html` + `player/player.ts`, served by
  `src/player-server.ts` with hls.js and the oRPC client bundled from `node_modules`; no CDN)
  calls the real `playback.start`, plays the signed playlist, heartbeats per the player contract
  (played seconds, buffer, stalls, bytes, latency, TTFF, visibility, fingerprint) with human-like
  jitter, follows token refreshes and `switchTo`, and calls `playback.end` when stopped. The page
  is same-origin with its `/rpc` proxy to the API. It has no P2P loader; P2P is measured with
  `--player web`.
- **The probe** (`player/probe.ts`) is injected into every page with `addInitScript`, so the same
  measurements come from the harness page and from the real web app: time to first frame
  (`requestVideoFrameCallback`), stalls and stall time, played time, and **glass-to-glass latency**:
  once a second it draws the video into a canvas, decodes the strip and compares it to `Date.now()`.
- `--player web` (or `HARNESS_PLAYER=web`) opens `<web>/embed/<channel>` instead; the probe works
  unchanged on any `<video>`.
- Well-behaved browser viewers get a small init script that hides `navigator.webdriver` and adds a
  language list, so integrity treats them as people; viewbots do not.
- **HTTP-only viewers** fetch playlists and segments on the player's schedule without a browser,
  model a playback buffer (TTFF, stalls), skip missing segments like players do, heartbeat with
  realistic fingerprints and jitter, and report delivery latency from `EXT-X-PROGRAM-DATE-TIME` or,
  with `decodeStripEvery`, from the strip of a decoded segment frame (via ffmpeg). Use them for the
  bulk of large audiences: the full scenario uses e.g. 20 browsers + 180 HTTP viewers.

### Simulated addresses (`src/proxy.ts`, `src/cidrs.ts`)

The API trusts `x-forwarded-for` only from `TRUSTED_PROXY_CIDRS`. Every simulated client talks to
the API through a tiny local forwarding proxy and tags its requests with `x-harness-client-ip`; the
proxy strips the tag (and any client-sent `x-forwarded-for`) and sets `x-forwarded-for` to the
simulated address. Well-behaved users get one stable address each from
`fixtures/residential-cidrs.txt`; viewbots get addresses from `fixtures/datacenter-cidrs.txt`, a
small sample of published hosting-provider ranges (ADR 0003, decision 8). Browser pages pass their
address to the player server, which forwards the same way. Media requests go straight to the
origin (sessions are identified by token, not address). IPv4 only.

### Viewbots (`src/viewbot.ts`)

Designed to be caught; each behaviour produces one signal: datacenter addresses, headless
fingerprints and `HeadlessChrome` user agents, perfectly periodic heartbeats (zero jitter),
playlist-only sessions that claim playback but download no media, many sessions sharing a few
device ids (`ViewbotSwarm`), follow bursts from freshly created accounts (`followBurst`), and chat
spam at machine rate (`chatSpam`). `planViewbots` is pure, so tests check the signals directly.

### Chat and bots (`src/chat-client.ts`, `src/bots/`)

- `ChatClient` speaks the contract's `ClientFrame`/`ServerFrame` over the chat WebSocket (token
  from `chat.connectToken`, or `Authorization: Bearer` for bots) and validates every incoming
  frame against the schema; invalid frames are recorded, never silently accepted.
- `SdkBot` is written against `BotSdk` (typed API client + chat connection). `createContractSdk`
  implements it on the contract client today; when `@commonair/sdk` lands it only has to satisfy
  (or be adapted to) `BotSdk`.
- `TmiBot` runs **unmodified tmi.js 1.8.5** against the IRC gateway's WebSocket listener with
  `PASS oauth:<token>` (emote-set lookups to Twitch are disabled). Both bots answer `!ping` →
  `pong` and `!uptime` → `live for 1h 2m 3s` (stream uptime from `channels.get`).

### Metrics and the load test (`src/metrics.ts`, `src/load.ts`)

Scenario steps are timed automatically; scenarios add metrics with `ctx.metric(name, value, unit)`.
The load test signs up N streamers, publishes N streams (640×360 by default), spreads M viewers
round-robin (10 % browsers, at most 20, alternating Chromium/WebKit; the rest HTTP), holds for the
duration with progress logs every 10 s, and reports:

- origin egress by delivery source: Prometheus (`HARNESS_PROMETHEUS_URL`, query
  `sum by (source) (increase(origin_egress_bytes_total[<window>]))`), falling back to bytes the
  viewers report;
- CPU per container (`podman stats --no-stream --format json`, mean and peak, containers matching
  `HARNESS_CONTAINER_PREFIX`);
- p50/p95 glass-to-glass (browser viewers), p95 HTTP delivery latency, p50/p95 TTFF;
- stall ratio (stalled time / watched time) and stalls per viewer-minute.

The full breakdown is in the report under `scenarios[].data.load`.

## Scenarios

| Scenario      | What it proves                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke`       | API up; sign-up through ALTCHA + email verification; sign in with a fresh session; the member's channel exists.                                            |
| `ingest-rtmp` | RTMP publish → live via `channels.get` → Chromium + WebKit play through the origin (TTFF, glass-to-glass) → offline.                                       |
| `ingest-whip` | The same over WHIP.                                                                                                                                        |
| `viewers`     | N viewers (`--set viewers=10 --set browserViewers=2`); the verified viewer count converges to exactly N, never overshoots, and decays after they leave.    |
| `load-smoke`  | The load test at 2 streamers × 10 viewers for 30 s, with thresholds.                                                                                       |
| `e2e-basic`   | Milestone E1 through the real web app: web sign-up + email link → dashboard key → RTMP → Chromium (signed in) + WebKit (anonymous) watch → chat → offline. |
| `e2e-social`  | Milestone E2: directory → follow → tmi.js bot via IRC → chat timeout seen on web and IRC (see below).                                                      |
| `e2e-relay`   | Milestone E3: a member's Go relay serves viewers, receipts verify, viewbots excluded, a 5× liar relay is suspended, drain and retire (see below).          |

`e2e-basic` drives `apps/web` with Playwright and selects only by the routes and `data-testid`s in
[docs/testing/e1-selectors.md](../docs/testing/e1-selectors.md), mirrored in `src/web/selectors.ts`
(a unit test fails when they drift). The `web` need is met when `HARNESS_WEB_URL/healthz` answers 200. It publishes to `<stream-server-url>/<stream-key>` exactly as shown on the dashboard;
`--set ingest=harness` swaps the host for `HARNESS_RTMP_URL` when the public ingest host is not
reachable from the harness. TTFF (< 15 s) and glass-to-glass (< 20 s) are soft checks for now. On
failure every open page is screenshotted into `<report dir>/<run id>-e2e-basic/`.

`e2e-social` is milestone E2 ([docs/testing/e2-selectors.md](../docs/testing/e2-selectors.md)): an
API-signed-up streamer goes live over RTMP; a fan finds the stream in the directory (≤ 60 s),
follows it and sees it under `following`; an unmodified tmi.js bot owned by the streamer joins
through the IRC gateway's WebSocket listener and answers `!ping`; the streamer times a troll out
from the chat menu, and the fan (web) and the bot (`CLEARCHAT` with `ban-duration`) both see it;
the timeout is lifted, the fan unfollows, the stream stops. Chat waits are ≤ 10 s. It records
`follow_round_trip`, `bot_reply_round_trip`, `bot_reply_latency`, `moderation_to_web`,
`moderation_to_irc` and `unban_to_chat`. `--set via=api` runs the same steps through the API and
chat socket instead of Chromium, which separates backend failures from web ones. The `irc` need
probes `HARNESS_IRC_HEALTH_URL` (default `http://localhost:6681/healthz`).

### `e2e-relay` (milestone E3)

[docs/testing/e3-selectors.md](../docs/testing/e3-selectors.md), every step of "The `e2e-relay`
scenario":

1. **Setup.** Streamer `S` (API sign-up) goes live over RTMP. Member `M` signs up in the web UI,
   opens `/relays` from `relays-link`, creates `harness-relay` and reads `relay-token` (and checks
   `relay-run-command`). The harness builds `relay/cmd/commonair-relay` (`go build` into
   `$TMPDIR/commonair-harness-relay/<source hash>/`, reused until a `.go`, `go.mod` or `go.sum`
   changes) and starts it on the host with the recipe's flags: `--api $HARNESS_API_URL
   --public-url http://<LAN IPv4>:<port> --listen :<port> --data-dir <tmp> --capacity-mbps 1000`,
   the token in `COMMONAIR_RELAY_TOKEN` (never on the command line). `relay-row` must reach
   `data-status="active"` within 60 s.
2. **Viewers on the relay.** Chromium players on `/$S` (signed in and anonymous; a player reloads
   for a new session, up to `browserRelayAttempts` times, until one lands on the relay) and HTTP
   viewers; new HTTP sessions are opened until at least 2 honest sessions are relay-assigned
   (`player[data-source=relay]`, or the `src`/`rid` claims of the HTTP viewer's token). The relay's
   `/healthz` must report `viewers ≥ 2`.
3. **Viewbot swarm** (`src/viewbot.ts`): datacenter addresses, headless fingerprints, no media,
   few device ids; some land on the relay.
4. **Verification** within one 6-minute window: `relay-receipts[data-verified] ≥ 1`,
   `data-rejected = 0`, `relay-bytes-verified[data-bytes] > 0`; `stream.health.viewers.verified`
   equals the honest sessions still open and `excluded ≥ bots`; the public count never exceeds the
   honest count. With `DATABASE_URL`, the relay-assigned honest sessions must be `verified`.
5. **Over-reporting relay** (`liar=true`): `M` creates relay `liar`; `src/liar-relay.ts` (a Bun
   server, not the Go relay) answers `/healthz`, registers with its own Ed25519 key and token,
   heartbeats, and really serves what it is assigned (pass-through from the origin's
   `/relay-pull/` with its relay token, playlists rewritten to carry the viewer token), so
   issuance accrues honestly. HTTP viewers are opened until `liarViewers` land on it. Every
   minute it submits a correctly signed receipt claiming 5× the media bytes it served (for those
   sessions and any the harness knows are assigned to it). The worker rejects them and the row
   turns `suspended` with `relay-suspended-reason`; the liar's viewers move to the origin on their
   next heartbeat (`switchTo`) and keep playing. Afterwards the count bound is
   `honest − liar-assigned ≤ verified ≤ honest`.
6. **Drain** (`drain=true`): SIGTERM to the Go relay; `relay-row` shows `offline` within 15 s
   (its draining heartbeat), relay-assigned Chromium players show `data-source="origin"` and keep
   `playing` within 30 s (HTTP viewers are checked too). The relay restarts with the same token and
   data dir and returns to `active`; `M` retires it with `relay-remove` → `confirm-dialog-confirm`,
   the row disappears and `relays.mine` omits it. Then the stream stops.

Report: per-step timings plus `relay.active_latency`, `relay.first_playback`,
`relay.time_to_receipts_verified`, `liar.time_to_suspension`, `liar.switch_to_origin`,
`drain.offline_latency`, `drain.switch_to_origin.<player>`, `relay.restart_active_latency`, the
counts (`counts.honest`, `relay_assigned`, `bots`, `bots_relay_assigned`, `liar_assigned`,
`verified`, `excluded`), `liar.receipts`, and the relay and liar logs (the last 50 lines, all of
them when the scenario fails). The Go relay is always stopped (SIGTERM, then SIGKILL after 60 s).

**Needs** (the `relay` need checks them up front and says what to fix): Go on `PATH`
(`go version`), `OUTBOUND_ALLOW_PRIVATE_NETWORKS=true` for the API (read from the harness
process env, which Bun loads from the repo `.env`, else from the repo `.env` file), and a LAN IPv4
on the host that the API container can reach (the first non-internal, non-link-local IPv4; override
with `--set relayHost=<addr>`). The relay pulls from the origin at `PLAYBACK_PUBLIC_URL`
(`http://localhost:3003` locally). Railway staging has no relay. It also needs the worker
(receipts and integrity). Not part of `full` (`inFull: false`): it needs the private-network
setting and takes about 15 minutes.

| Knob                   | Default | Meaning                                                                       |
| ---------------------- | ------- | ----------------------------------------------------------------------------- |
| `relayHost`            | LAN IP  | Address in both relays' `--public-url`                                        |
| `relayPort`            | free    | Go relay port                                                                 |
| `httpViewers`          | 4       | Honest HTTP viewers opened first                                              |
| `browserViewers`       | 2       | Honest Chromium players (alternating signed in / anonymous); 0 with `via=api` |
| `bots`                 | 12      | Viewbots                                                                      |
| `liar` / `drain`       | `true`  | Run step 5 / step 6                                                           |
| `via`                  | `web`   | `api`: create/retire relays through the API, HTTP viewers only                |
| `maxSessions`          | 30      | Honest sessions opened at most while looking for relay (and liar) assignment  |
| `liarViewers`          | 2       | Sessions that must land on the liar                                           |
| `liarFactor`           | 5       | Bytes multiplier the liar claims                                              |
| `browserRelayAttempts` | 3       | Reloads per Chromium player to land on the relay                              |

```sh
# .env: OUTBOUND_ALLOW_PRIVATE_NETWORKS=true, then restart the stack
bun scripts/infra.ts stack
HARNESS_WEB_URL=http://localhost:3100 bun harness/src/cli.ts run e2e-relay
HARNESS_WEB_URL=http://localhost:3100 bun harness/src/cli.ts run e2e-relay --set via=api          # backend only
HARNESS_WEB_URL=http://localhost:3100 bun harness/src/cli.ts run e2e-relay --set liar=false --set drain=false
HARNESS_WEB_URL=http://localhost:3100 bun harness/src/cli.ts run e2e-relay --set relayHost=192.168.1.20
```

Until the API, origin and media units are running, these scenarios fail on unmet needs (and say
which). The drivers themselves are verified against a throwaway MediaMTX by the integration tests.

### Adding a scenario

Create `harness/scenarios/<name>.ts`; the registry discovers it (files starting with `_` are
shared helpers, not scenarios). The default export's `name` must equal the file name.

```ts
import { defineScenario } from "../src/scenario.ts";

export default defineScenario({
  name: "follow",
  description: "a viewer follows a channel and the follower count goes up",
  needs: ["api", "mail"], // probed before running; see NEEDS in src/scenario.ts
  async run(ctx) {
    const streamer = await ctx.step("sign up streamer", () => ctx.platform.signUp({ prefix: "fol" }));
    const fan = await ctx.step("sign up fan", () => ctx.platform.signUp({ prefix: "fan" }));
    const res = await ctx.step("follow", () =>
      fan.api.client.channels.follow({ channel: streamer.username, notify: true }),
    );
    ctx.assert("follower count is 1", res.followerCount === 1, res);
  },
});
```

- `ctx.step(name, fn)` times and records a step; `ctx.assert` stops the scenario on failure,
  `ctx.check` records a soft failure and continues; `ctx.metric` and `ctx.data` add to the report.
- `ctx.defer(fn)` registers cleanup (stop streamers/viewers/bots); it runs in reverse order even
  when the scenario fails or times out. `ctx.signal` aborts on timeout or Ctrl-C.
- Declare every part of the stack you use in `needs`; vendor adapters (`stripe`, `oauth`, `cdn`)
  make the scenario skip under `--profile no-proprietary`, so provide a FOSS path when possible.
- Use unique users per run (`platform.signUp`), never fixed names, so reruns do not collide.
- Set `inFull: false` for scenarios too heavy for `full`, and `timeoutMs` for long ones.

## Tests

- `bun run --filter @commonair/harness test`: unit tests — strip encode → ffmpeg render → PNG →
  decode round trips (raw and through H.264), ffmpeg argument builders and listing parsers, CLI
  parsing, registry and reports, runner semantics, cookie jar, forwarding proxy, ALTCHA solving
  against `altcha-lib`'s verifier, HLS parsing, the HTTP viewer against a fake origin, viewbot
  signals, the chat client and SDK bot against a fake chat service, and unmodified tmi.js against
  a fake Twitch-dialect IRC-over-WebSocket server. For E3: LAN address selection, the
  private-network readiness check, relay source hashing and argv, the relay process lifecycle
  with a stand-in binary, the `e2e-relay` plan from `--set` knobs, liar receipts (5× bytes, signed,
  `verifyReceipt` passes), the liar relay against a fake API and origin, the HTTP viewer following
  `switchTo`, and the E3 selectors parsed from the doc.
- `bun run --filter @commonair/harness test:int`: starts a throwaway MediaMTX container
  (`docker.io/bluenviron/mediamtx:1.21.2`, permissive config, random ports, removed afterwards);
  the RTMP streamer publishes; the harness player plays MediaMTX's LL-HLS in Chromium and WebKit
  with TTFF and glass-to-glass latency under 15 s; the HTTP viewer follows the stream and decodes
  the strip; WHIP publishing works; and API-mode playback sessions (start → heartbeats with token
  refresh → end, `x-forwarded-for` from the proxy) run against a fake `/rpc/playback/*`.
