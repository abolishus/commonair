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

| Command                                          | What it does                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| `run <scenario...>`                              | Run scenarios in order. `full`: see "`full` and the harness stack" below. |
| `list [--json]`                                  | Scenarios with descriptions and needs (`*` = part of `full`).             |
| `load --streamers N --viewers M --duration 120s` | Load test (see below). `--browser-viewers K`, `--protocol rtmp\|whip`.    |

Options for `run` and `load`:

- `--profile no-proprietary` (alias `--no-proprietary`): first reads the API's `/healthz` and
  fails the run (one failed `no-proprietary preflight` entry, no scenario started) unless it
  reports `stripe`, `oauth` and `cdn` all `false`; a missing flag fails too. Then scenarios whose
  `needs` include `stripe`, `oauth` or `cdn` are skipped, and so are steps: a parameter variant
  declared in `paramNeeds` (e.g. `e4b-money --set provider=stripe`) or a step run with
  `ctx.optionalStep(name, needs, fn)`. Each skip carries its reason in the report
  (`skipReason`, `skippedSteps`), and the CLI prints a skip table at the end. Expected on the
  harness stack: no scenario skipped, one step (the `e4b-money` Stripe variant).
- `--report <path>`: where the JSON report goes. Default `harness/reports/<time>-<cmd>-<run>.json`
  (gitignored), next to a `.txt` summary, plus `harness/reports/latest.json`.
- `--set key=value`: scenario parameters (`ctx.param` / `ctx.intParam`), e.g. `--set viewers=50`.
- `--player harness|web`: which page browser viewers open (see Viewers).
- `--skip-unavailable`: skip instead of fail scenarios whose needs are unreachable.

Exit code is 0 only if no scenario failed; 2 on usage errors. Ctrl-C aborts the run (cleanups and
the report still happen); a second Ctrl-C exits immediately. Every ffmpeg process is supervised
and killed if the harness exits.

### `full` and the harness stack

`full` runs every scenario except `load-plan` (ADR 0021): `smoke` first, `e2e-relay` last (it is
the longest), the rest by name, about 25–30 minutes. `FULL_REQUIRED` in `src/registry.ts` names
every Phase 4 scenario it must include (E6 adds `simulcast`, `overlay-alert`, `vod-clips`,
`data-export`, `account-deletion` and `backup-restore`; `e5-coop`, `trust-safety` and `e2e-relay`
joined in E6); if one is missing or marked `inFull: false`, `run full` refuses to start rather
than run less. Naming scenarios explicitly is unaffected.

`full:<shard>` runs one part of `full` (`FULL_SHARDS` in `src/shards.ts`: `relay` is e2e-relay,
`long` is trust-safety and e5-coop, `rest` is everything else), each in `full`'s order and each on
its own stack. CI runs one job per shard (`bun run verify --full --only harness --shard <name>`).

`full` runs on the harness stack: `compose.yaml` with every harness override layered
(`harness/compose.trust-safety.yaml`, `harness/compose.e5-coop.yaml`, `harness/compose.e6.yaml`),
on a Postgres volume created once with the E5 bootstrap (ADR 0020: `harness/compose.e5-coop.yaml`
gives `migrate` the short governance periods in `GOVERNANCE_BOOTSTRAP_JSON`, which apply at the
database's first migration only; see `e5-coop` below).

```sh
# once: recreate the Postgres volume so the E5 bootstrap applies (destroys local data)
podman compose down
podman volume rm commonair_postgres-data
bun scripts/infra.ts stack --harness
# afterwards, and after every rebuild
bun scripts/infra.ts stack --harness
bun harness/src/cli.ts run full
bun harness/src/cli.ts run full --profile no-proprietary   # Stripe, OAuth and CDN unset in .env
```

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
  `HARNESS_CONTAINER_PREFIX`), run locally or, with `HARNESS_LOAD_TARGET_SSH`, on the target over
  SSH;
- whole-host CPU (busy and steal across all cores), memory, load average and NIC bytes per
  interface from `/proc` (`src/load/host.ts`), sampled every 5 s over the hold: the target's over
  SSH, the generators' locally and over SSH (`target.cpu.p95`, `target.nic.tx_bytes_per_second`,
  `generator.cpu.p95`, … metrics);
- p50/p95 glass-to-glass (browser viewers), p95 HTTP delivery latency, p50/p95 TTFF;
- stall ratio (stalled time / watched time), stall count and stalls per viewer-minute; errors.

The report's `scenarios[].data.load` section (`src/load/report.ts`) holds `egress` (method,
`totalBytes`, `bytesPerSecond`, `perViewerBytes`, `perViewerBytesPerSecond`, `bySource`), `cpu`
per container (`avgPercent`, `maxPercent`), `glassToGlassP95Ms`, `ttffP95Ms`, `stallRatio`,
`stallCount`, `errors`, `started`/`viewers`, `shards`, the raw aggregates under `breakdown`, and
`target.host`, `target.containers` (source, incomplete flag, CPU) and `generator.host` (plus
`generator.hosts` with remote shard hosts). Both load scenarios assert that every viewer started
(hard) and check stall ratio < 5 %, p95 glass-to-glass and TTFF < 15 s and no errors (soft).
An SSH failure mid-run marks the samples incomplete (`samples_incomplete` metric, `incomplete` in
the summary); it never fails the scenario on its own.

**Remote target.** Against an installed instance (`selfhost.sh`), the load test is configured by
the `HARNESS_LOAD_*` variables (`src/load/env.ts`; all optional, unset = the local behaviour):

| Variable                          | Meaning                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `HARNESS_LOAD_TARGET_SSH`         | SSH destination of the target as `commonair` (`podman stats` and `/proc` there)   |
| `HARNESS_LOAD_TARGET_NIC_MBPS`    | The target's measured NIC ceiling; unset = no target-NIC rule                     |
| `HARNESS_LOAD_GENERATOR_NIC_MBPS` | The generators' measured NIC ceiling; unset = no generator-NIC rule               |
| `HARNESS_LOAD_GENERATOR_HOSTS`    | Where shards run: SSH destinations and/or `local`, dealt round-robin              |
| `HARNESS_LOAD_GENERATOR_REPO`     | The checkout path on generator hosts (default: this checkout's path)              |
| `HARNESS_LOAD_AUTH_PER_MINUTE`    | Pace sign-ups and sign-ins under the instance's per-address `auth` limit (10)     |
| `HARNESS_LOAD_ACCOUNTS_FILE`      | Reuse streamer accounts across runs on one instance (test credentials, mode 0600) |

With a remote target, a run is **inconclusive** (neither passed nor failed: `data.verdict`,
metric `load.inconclusive`) when a generator's CPU p95 is over 80 % or its NIC transmit or
receive p95 is within 15 % of the ceiling. The runbook, the per-address rate-limit caveat and the
results are in [docs/operators/capacity.md](../docs/operators/capacity.md).

**Sharding.** One process drives about a thousand HTTP viewers. Past `httpPerProcess` (default 1000) the HTTP audience is split round-robin over child processes (`src/load/worker.ts`, spawned
with `Bun.spawn` and supervised like ffmpeg): each opens its slice, prints `started`, holds until
SIGINT and prints its viewers' final reports on one `LOAD_SHARD` stdout line, which the parent
merges into the same report. Browser viewers always stay in the parent. With
`HARNESS_LOAD_GENERATOR_HOSTS`, shards run on the listed hosts over SSH (`src/load/processes.ts`:
the same worker and line protocol, from the same checkout path; at least one shard per host);
the parent stops a remote shard by closing its stdin, which a shell wrapper on the far side turns
into SIGINT. Only the instance URLs (`HARNESS_API_URL`, `HARNESS_WEB_URL`, `HARNESS_ORIGIN_URL`,
`HARNESS_PLAYER`, `LOG_LEVEL`, …) are passed to the remote worker.

| Knob (`--set`)       | `load-smoke` | `load-plan` | Meaning                                        |
| -------------------- | ------------ | ----------- | ---------------------------------------------- |
| `streamers`          | 2            | 20          | Streams published                              |
| `viewersPerStreamer` | 5            | 200         | Viewers on every channel                       |
| `viewers`            | —            | —           | Total instead (exclusive with the one above)   |
| `seconds`            | 30           | 120         | Hold time (the egress window)                  |
| `browserViewers`     | 2            | 20          | Real browsers among the viewers                |
| `httpPerProcess`     | 1000         | 1000        | HTTP viewers per process before the run shards |

## Scenarios

| Scenario         | What it proves                                                                                                                                                                                                          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke`          | API up; sign-up through ALTCHA + email verification; sign in with a fresh session; the member's channel exists.                                                                                                         |
| `ingest-rtmp`    | RTMP publish → live via `channels.get` → Chromium + WebKit play through the origin (TTFF, glass-to-glass) → offline.                                                                                                    |
| `ingest-whip`    | The same over WHIP.                                                                                                                                                                                                     |
| `viewers`        | N viewers (`--set viewers=10 --set browserViewers=2`); the verified viewer count converges to exactly N, never overshoots, and decays after they leave.                                                                 |
| `load-smoke`     | The load test at 2 streamers × 10 viewers for 30 s, with thresholds.                                                                                                                                                    |
| `e2e-basic`      | Milestone E1 through the real web app: web sign-up + email link → dashboard key → RTMP → Chromium (signed in) + WebKit (anonymous) watch → chat → offline.                                                              |
| `e2e-social`     | Milestone E2: directory → follow → tmi.js bot via IRC → chat timeout seen on web and IRC (see below).                                                                                                                   |
| `e2e-relay`      | Milestone E3: a member's Go relay serves viewers, receipts verify, viewbots excluded, a 5× liar relay is suspended, drain and retire (see below).                                                                       |
| `e4b-money`      | Milestone E4b: manual payments, chat events, revenue figures, refund + chargeback, payout threshold, transparency, ledger (see below).                                                                                  |
| `trust-safety`   | Milestone E4c: T0 live, evidence through deletion, two-reviewer dismissal, T2 label + appeal, T1 queue, upload rejection, NCII clock (see below).                                                                       |
| `e5-coop`        | Milestone E5: share, streamer and worker memberships, council, an ordinary decision applied, a protected decision rejected by the streamer class, patronage with two people, transparency, audit/outbox (see below).    |
| `backup-restore` | E6: WAL-G backup of a throwaway Postgres, wipe, restore with WAL replay; triggers, protection functions, app-role grants, rows and the ledger come back, and the app role is refused every protected write (see below). |
| `load-plan`      | E6: the load test at PLAN size, 20 streamers × 200 viewers for 120 s, sharded over processes. Not in `full`.                                                                                                            |
| `load-sweep`     | S1-a: steps viewers (or live streams) up until latency, TTFF, stalls, errors, target CPU or NIC breaks; one row per step, or inconclusive when the generator was the limit. Not in `full`.                              |

E1's E6 scenarios (`simulcast`, `overlay-alert`, `vod-clips`, `data-export`, `account-deletion`)
are documented with [docs/testing/e6-selectors.md](../docs/testing/e6-selectors.md).

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

E6 adds the SDK bot right after the tmi.js `!ping`: the streamer creates a second bot and its
token (`me.bots.createToken`, scopes `chat:read chat:edit`), `SdkBot` (`src/bots/sdk-bot.ts`)
joins over the chat WebSocket, the fan sends `!ping` again, and a chat socket opened for the fan
must receive `pong` from both bots, the SDK bot's message carrying the `bot` badge
(`sdk_bot_reply_round_trip`).

### `backup-restore` (E6)

The drill in [docs/testing/e6-selectors.md](../docs/testing/e6-selectors.md) ("Backup and restore
drill"), in `src/drill/`. It never touches the running stack (ADR 0021): it reads the stack's
Postgres container (`podman inspect`, by its compose labels) only for its image and network, and
refuses to run if `commonair-drill-<runId>` or its volume `commonair-drill-<runId>-pgdata`
already exist, are the stack's, or if the WAL-G prefix would be the stack's.

1. Start `commonair-drill-<runId>` from the stack's Postgres image on the compose network, with
   its own volume, a random owner password, `WALG_S3_PREFIX=s3://$S3_BUCKET_BACKUPS/drill/<runId>`
   (the stack's Garage key) and Postgres on a random loopback port. Secrets reach podman through
   its environment (`-e NAME`), never its arguments.
2. Migrate as the owner (`runMigrations`), configure the app role
   (`infra/postgres/apply-app-role.ts`, random password), run the demo seed CLI and post 20
   balanced ledger transactions with `@commonair/ledger` `post`, both as the app role.
3. Fingerprint (`collectFingerprint`): non-internal triggers with `tgenabled`, the md5 of
   `pg_get_triggerdef` and the function each runs; `commonair_*` functions with the md5 of
   `pg_get_functiondef` (body, `SECURITY DEFINER`, `SET search_path`, volatility), owner and
   `proconfig`; the app role's table and column grants, attributes (`SUPERUSER`, `INHERIT`,
   `CREATEROLE`, `CREATEDB`, `REPLICATION`, `BYPASSRLS` all off), memberships (none) and `TEMP`
   (revoked); row counts of every table, the ordered md5 of `ledger_entries`, and unbalanced
   transactions. Required protections must be
   present before anything is compared, so an empty fingerprint never passes.
4. `commonair-backup`; post the marker transaction; `pg_switch_wal()`; wait until
   `pg_stat_archiver` has archived that segment.
5. Stop and remove the container, remove and recreate the volume, `commonair-restore` into it (a
   one-shot container), start Postgres again and wait for `pg_is_in_recovery()` to be false.
6. `compareFingerprints(before, after, marker)` must find nothing (a missing, disabled or changed
   trigger, a changed or dropped function, a dropped or added grant, different row counts, a
   changed ledger, a missing marker, an unbalanced transaction each fail it); then as the app role
   `UPDATE`/`DELETE` on `ledger_entries` and `audit_log`, an unbalanced posting, and a proposal
   inserted as or moved to `passed`, and `SET ROLE` to the schema owner must each be refused with
   the protection's SQLSTATE and message (a typo or a lost connection is not a refusal).
7. Cleanup (always, once): remove the container and the volume, delete `drill/<runId>/` from the
   backups bucket. It is authoritative: on a timeout or Ctrl-C it refuses every later podman call
   of the still-running drill, kills the in-flight one through the scenario signal and waits for
   it before removing. The scenario timeout exceeds the sum of the drill's bounded waits.

Metrics: `backup.bytes`, `backup.wal_objects`, `restore.fetch`, `restore.to_promoted`,
`restore.wal_segments_replayed`. **Needs:** `podman`, the built Postgres image (the stack's), the
stack running (Garage, its network), and `S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`
(and optionally `S3_BUCKET_BACKUPS`) from the repo `.env`. The database half is also covered by
`tests/drill.int.test.ts` against a throwaway test database.

```sh
bun harness/src/cli.ts run backup-restore
```

### `load-plan` (E6)

The load test at PLAN size (ADR 0021 §4), outside `full`; knobs in "Metrics and the load test".
Against a remote instance (`HARNESS_LOAD_TARGET_SSH`), a run where the generator was the limit,
or where more than `--set maxHeartbeatErrors` (default 0) heartbeats failed, is inconclusive rather
than passed or failed (`data.verdict.outcome`; the scenario status cannot say "inconclusive" yet).

```sh
bun harness/src/cli.ts run load-plan
bun harness/src/cli.ts run load-plan --set streamers=10 --set viewersPerStreamer=100 --set httpPerProcess=500
```

### `load-sweep` (S1-a)

Steps the load up until one host stops coping (`src/load/sweep.ts`), outside `full`. Streams stay
up across steps; each step opens its audience, holds `seconds`, collects, and cools down. The
sweep stops at the first step that breaks a target and records which (several breaking in one
step are reported together), or at the first step where a generator was the limit or heartbeats
failed (inconclusive; read `data.sweepSummary.outcome`, since the scenario status cannot say so). Report: `data.sweep` (one row per step), `data.sweepSummary` (last passing step,
first failing step and why, per-viewer egress and CPU at the last passing step), and per step
`data["sweep step N"]`. The scenario fails only if the first step already broke a target.

```sh
bun harness/src/cli.ts run load-sweep                                    # 250 → 4000 viewers
bun harness/src/cli.ts run load-sweep --set steps=100,200,400 --set streamers=4
bun harness/src/cli.ts run load-sweep --set streamerSteps=1,2,4,8 --set ladderViewers=60
```

| Knob (`--set`)                             | Default                | Meaning                                                              |
| ------------------------------------------ | ---------------------- | -------------------------------------------------------------------- |
| `steps`                                    | 250,500,1000,2000,4000 | Viewers per step (viewers axis); strictly increasing                 |
| `streamerSteps`                            | —                      | Live streams per step instead (streams axis; exclusive with `steps`) |
| `streamers`                                | 20                     | Streams on the viewers axis                                          |
| `ladderViewers`                            | 60                     | Viewers per stream on the streams axis (≥ the transcode threshold)   |
| `seconds` / `cooldownSeconds`              | 120 / 30               | Hold per step, pause between steps                                   |
| `browserViewers` / `httpPerProcess`        | 10 / 1000              | As for `load-plan`                                                   |
| `maxLatencyMs` / `maxTtffMs`               | 15000 / 15000          | p95 glass-to-glass and TTFF; break at or above                       |
| `maxStallRatio` / `maxErrorRate`           | 0.05 / 0               | Break at or above / above                                            |
| `maxTargetCpuP95`                          | 85                     | Target host CPU p95 (%); break above                                 |
| `targetNicFraction`                        | 0.95                   | Target NIC transmit p95 as a share of `HARNESS_LOAD_TARGET_NIC_MBPS` |
| `generatorCpuP95` / `generatorNicHeadroom` | 80 / 0.15              | The inconclusive judgment                                            |
| `maxHeartbeatErrors`                       | 0                      | Failed heartbeats above this make a step inconclusive                |
| `width` / `height` / `bitrateKbps`         | see below              | What every streamer sends (even dimensions, kbps)                    |
| `protocol`                                 | rtmp                   | `rtmp` or `whip`                                                     |

Streamers send 640x360 at 1200 kbps on the viewers axis and 1920x1080 at 6000 kbps on the streams
axis, so the transcode ladder has rungs to make; every row records the `source` it was run with.

Each row also counts the streams with a transcode ladder at the end of the hold (from
`playback.start`'s renditions) and failed heartbeats (a rate-limited generator address shows
there first; see capacity.md).

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
(`http://localhost:3003` locally). It also needs the worker
(receipts and integrity). Part of `full`, which runs it last: it takes about 15 minutes, and the
harness stack sets the private-network setting.

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

### `e4b-money` (milestone E4b)

[docs/testing/e4b-selectors.md](../docs/testing/e4b-selectors.md), the nine steps of "The
`e4b-money` scenario", on the manual payments adapter:

1. **Setup.** API sign-ups for a streamer, a treasurer and viewers A, B, C. The treasurer role is
   granted with the operator CLI (`bun packages/db/src/roles/cli.ts <username> treasurer`, run
   from the repo root with `DATABASE_URL`), then the treasurer signs in again. The streamer sets
   tiers of 4.99 / 9.99 / 24.99 on `/revenue` (odd cents, so the cut's floor matters); B and C
   follow the channel and chat once (the gift pool).
2. **Subscribe.** A picks tier 2 in the Support dialog and gets a `CA-…` reference; the treasurer
   finds it with `treasury-search` and confirms. A's `/settings/subscriptions` row is `active`
   tier 2, chat shows `channel.subscribe`, and A's next message carries the `subscriber` badge.
3. **Gift.** A gifts 2 tier-1 subs at random; confirmed; B and C each hold an active gifted
   subscription; one `channel.subscription.gift` with total 2.
4. **Tip.** A tips 5.00 anonymously with a message; confirmed; `channel.tip` with an empty user
   and 500 cents.
5. **Dashboard.** `/revenue`: held = the creator shares, available = 0, owed = 0, the source
   split, tier counts (2 / 1 / 0) and monthly shares, one ledger row per payment, and the rows'
   `data-net` sum to `revenue-earned`; every row satisfies gross + deductions = net.
6. **Refund and chargeback.** The tip is refunded in full and the tier-2 payment charged back;
   A's subscription turns `canceled`; held drops by exactly the reversed shares; `refund` and
   `chargeback` rows appear with negative net.
7. **Payout threshold.** A payout run pays the streamer nothing (no payout row for them;
   `data-created=0` is a soft check because the run is instance-wide); held + available + owed is
   unchanged.
8. **Transparency.** This UTC month's `data-revenue` rose by the creator + co-op shares net of the
   reversals, against a baseline read before the first confirmation (so a long-lived stack is
   fine); payouts unchanged.
9. **Ledger integrity.** Read-only, with `DATABASE_URL`: every `ledger_transactions` row whose
   `ref_id` is one of the scenario's payments or their disputes sums to zero per currency.

Every expected figure comes from the tier prices above and the `platform.cut` that
`money.support` reports, using the ledger's rule (creator = `floor(net × streamerShare)` in
integer millionths, reversals as split(cumulative) − split(already)), in `src/money.ts`. The
report has per-step timings, `*.confirm_to_chat_event` metrics, and `money.plan`,
`money.expected`, `money.observed.step5|6|7`, `money.payoutRun`, `transparency.*` and `ledger.*`
data. The web path selects only by test id; the subscriber badge is read from an anonymous chat
socket on both paths, and on the web path A's message row must also render in the streamer's
chat as `chat-message` with `data-badges~="subscriber"`. On failure every open page is
screenshotted into `<report dir>/<run id>-e4b-money/`.

**Needs:** `api`, `web`, `chat`, `worker`, `mail`, `browser`; `PAYMENTS_PROVIDER=manual` (the
default; the scenario stops if `money.support` reports `stripe`) and `DATABASE_URL` pointing at
the stack's Postgres (Bun loads it from the repo `.env` when run from the repo root). Part of
`full`. Its Stripe variant (`--set provider=stripe`) is declared as a parameter variant needing
`stripe` (`DEFAULT_PARAM_NEEDS` in `src/registry.ts`), so `--profile no-proprietary` reports it
as the one skipped step.

| Knob  | Default | Meaning                                                   |
| ----- | ------- | --------------------------------------------------------- |
| `via` | `web`   | `api`: the same steps through the API and the chat socket |

```sh
bun harness/src/cli.ts run e4b-money
bun harness/src/cli.ts run e4b-money --set via=api   # backend only
```

### `trust-safety` (milestone E4c)

[docs/testing/e4c-selectors.md](../docs/testing/e4c-selectors.md), the seven steps of "Scenario
`trust-safety`". **Synthetic material only:** the scenario publishes and uploads nothing but the
geometric test patterns generated by code in `packages/moderation/fixtures/` (`t0-pattern.png` on
the fixture CSAM list, `t0-ncii-pattern.png` on the fixture NCII list) and a run-unique ffmpeg
cellular-automaton pattern; T1/T2 come only from the scripted classifier
(`PUT /internal/moderation/script`). No industry hash list is downloaded or embedded. The report
holds ids, timings and statuses, never image bytes or emails, and screenshots are never taken of
legal pages.

1. **T0 live.** Streamer A loops the CSAM fixture over RTMP. From A's first encoded frame, within
   `2 × sampleSeconds + 5 s`, `channels.get` shows A suspended and off air; a republish with the
   same key never goes live (ffmpeg's non-zero exit is a soft check). Legal L1 finds the case
   (`list = csam`), its evidence (the inline frame decrypts; its bytes become log needles), an
   active `csam_match` hold, a `draft` NCMEC report and `moderation.t0.match` in the history; A's
   VODs and clips list empty (owner and public). A moderator gets `NOT_FOUND` for the case and
   its evidence and never sees it in the mod queue. Web: `/admin/legal` rows for L1; nothing for
   the moderator on `/admin/legal` or `/admin/moderation`.
2. **Evidence survives deletion** (pulls in step 1). `admin.expediteDeletion` for A; the worker
   pseudonymizes A (`--set deletionTimeoutSeconds=600`); L1 still reads the evidence, the hold and
   the draft; `account_deletions.retained` lists `legal_holds`, `evidence_objects`,
   `ncmec_reports` (cases and flags soft). Then, with `DATABASE_URL`, deleting the evidence row,
   the hold and the draft **as the app role** (`SET LOCAL ROLE commonair_app`, `--set appRole=`)
   must each be refused. Every attempt runs in a transaction that is always rolled back.
3. **Two reviewers.** Streamer B loops the NCII fixture; L1 dismisses (`dismissal_pending`), L1
   again is refused, L2 dismisses (`dismissed`, `mediaRestored: false`); B is unsuspended and
   unbanned; the hold stays active. Web: L1 sees `dismissal_pending` with `legal-dismiss` disabled.
4. **T2 label and appeal.** C scripted `sexual = 0.85`; C's channel turns mature within two
   intervals + 5 s of going live; the script is then cleared so the label is not reapplied. An
   anonymous `playback.start` gets `FORBIDDEN mature_gate`; web: `mature-gate` with the sign-in
   link. C appeals from `moderation-label-notice` on `/dashboard`; the moderator overturns on
   `/admin/appeals`; the channel is not mature and playback works again.
5. **T1 blur, queue, clear.** D scripted `sexual = 0.99`; the broadcast is `under_review` within
   two intervals + 5 s, has no thumbnail and leaves `directory.live`; the moderator's open T1 case
   has a framed `t1` flag and `moderation.t1.restrict` (system). Web: `stream-restricted`, a
   `modq-item` `t1` whose `modq-frame`s are all `data-revealed="false"` (never revealed), then
   clear. The stream is listed again; history has the system and the moderator step.
6. **Upload rejected.** E uploads the CSAM fixture as an avatar; `commitUpload` fails with
   `upload_rejected`; the avatar is unchanged; `channels/<E>/avatar/` in the media bucket is empty
   (listed with the `S3_*` credentials of the repo `.env`); a T0 case with subject `upload` exists.
7. **NCII clock.** F streams the run-unique pattern and makes two 5 s clips, then stops (so the
   live stream cannot match the hashes added below). Request 1 for clip 1 (`/takedown`, or
   `ncii.submit` with `via=api`): `deadlineAt` = receipt + 48 h ± 5 s; the request must resolve its
   URL to the clip; `POST /internal/moderation/ncii-tick` as of receipt + 48 h + 1 min hides clip 1
   (`removed_reason = ncii_deadline`, audit `ncii.auto_hide` by system). Request 2 for clip 2 is
   submitted after the tick and decided `removed`; clip 2's hashes reach `local_hash_list`, and
   re-uploading clip 2's first frame as a panel image is rejected.

After every step the harness reads `podman logs --since <step start>` of the `api`, `worker`,
`media`, `web`, `chat`, `origin` and `irc` containers (`HARNESS_CONTAINER_PREFIX`) and fails the
step on: base64 of the fixtures, of the decrypted evidence frame or of clip 2's frame (at any byte
alignment), any base64 image or base64 run of 1024+ characters, the run's account and requester
emails, and the requester's name, description and URLs. The report lists only the source, the
kind and the count.

The tick hook acts on every undecided NCII request of the instance, and the clip's hashes stay
on the instance's local NCII list (they are run-unique, so no later stream matches them): use a
test stack. The URL form the requester pastes for a clip is not fixed by the spec; the harness
sends `<HARNESS_WEB_URL>/<channel>/clip/<clipId>` and fails clearly if the API does not resolve it.

**Needs:** `api`, `web`, `media`, `worker`, `mail`, `ffmpeg`, `browser`, `podman`; the stack
started with the override, which mounts the fixture lists and sets `MODERATION_CLASSIFIER=scripted`,
`MODERATION_SAMPLE_SECONDS=2` and `MODERATION_TEST_HOOKS=true` for `media`, `worker` and `api`
(never on a public instance); `DATABASE_URL`, `INTERNAL_API_SECRET` (or
`HARNESS_INTERNAL_API_SECRET`) and `S3_ENDPOINT` / `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`
from the repo `.env` (run from the repo root). Part of `full` (on the harness stack).

| Knob                     | Default         | Meaning                                                       |
| ------------------------ | --------------- | ------------------------------------------------------------- |
| `steps`                  | `all`           | `1,2,5`, ranges `1-3`; step 2 adds step 1                     |
| `via`                    | `web`           | `api`: everything through the API (no browser)                |
| `sampleSeconds`          | `2`             | The stack's `MODERATION_SAMPLE_SECONDS` (deadline arithmetic) |
| `deletionTimeoutSeconds` | `600`           | How long step 2 waits for the worker's deletion run           |
| `appRole`                | `commonair_app` | The role step 2 acts as for the refusal checks                |

```sh
bun packages/moderation/fixtures/generate.ts        # only if the fixtures are missing (unit A commits them)
podman compose -f compose.yaml -f harness/compose.trust-safety.yaml up -d
bun harness/src/cli.ts run trust-safety
bun harness/src/cli.ts run trust-safety --set via=api --set steps=1,2,6
podman compose up -d                                 # back to the normal configuration afterwards
```

### `e5-coop` (milestone E5)

[docs/testing/e5-selectors.md](../docs/testing/e5-selectors.md), "Scenario `e5-coop`". Accounts
are fresh per run: viewer V, streamers S1 and S2, worker W, treasurers T1 and T2 and an admin
(roles from the operator CLI). The E5 routes and test ids live in `src/coop-selectors.ts` (a unit
test checks them against the spec); the flows in `src/coop-actors.ts` (web and API), the test-hook
client in `src/coop-io.ts`, the database checks in `src/coop-db.ts` and the pure parts in
`src/coop.ts`.

1. **Membership.** V buys the share (`/coop/membership`), T1 confirms it on `/treasury`; V is a
   `viewer`/`share` member with the share `held`. S1 and S2 each stream an ffmpeg test pattern to
   `viewersPerStream` harness HTTP viewers (the default 2 meets `minVerifiedViewers`) until
   `coop.membership` shows the streamer class eligible (the worker's scoring and its 5-minute
   `stream-hours` job; bounded by `qualifySeconds`, reported as `streamer_qualification`); a
   `membership-sync` tick makes both `streaming_hours` members. The admin appoints W on
   `/admin/coop` (`board_appointment`).
2. **Council.** `council-recompute` ticks until the current term seats S1 and S2; `/coop/council`
   lists both.
3. **Revenue.** V tips S1 (manual); T1 confirms.
4. **Governance vote.** S2 drafts the ordinary, creator-affecting `discovery.ranking` change on
   `/coop/proposals/new` (the whole value, `spotlightSlots` alternating 4/5 per run) and submits
   it; V and W comment. `proposals-advance` ticks run until the council review opens (S1 publishes
   `support` at once), then until voting opens (V votes on the web, W, S1 and S2 through the API,
   at once), then until it is decided (`tally` passed, per class streamer 2 / viewer 1 / worker 1
   yes) and applied (`/coop/settings` shows `discovery.ranking` set by it).
5. **Protected decision**, in the same windows: W's `platform.cut` change (streamer 0.85), S2
   `oppose`, V, W, S2 yes and S1 no: rejected, `streamer-class majority not met`. Then, as the app
   role (`--set appRole=`, default `commonair_app`) inside a transaction that is always rolled
   back: setting it `passed`, inserting a `tallies` row with `passed = true` and applying its change
   must each be refused; `platform.cut` is unchanged.
6. **Patronage.** T1 runs `[run start, now − 1 s)` on `/treasury` (whole minutes through the web
   form, whole seconds through the API; after any earlier period); T1's own approval is disabled and
   refused with `second_approver`; T2 approves; S1's statement has a positive total and explained
   lines. Every ledger transaction of the run (share purchase, tip, period close, patronage
   allocation) sums to zero.
7. **Transparency.** Both proposals (`data-passed` true / false) and this month's patronage.
8. **Audit and outbox.** Every action of the run has its `audit_log` row (action, actor type,
   actor) and its `events` row; drafts emit no event; no audit `details` or event payload holds a
   vote choice, a comment body or an email; neither does any line of `podman logs --since <run
   start>` of the `api`, `worker`, `media`, `web`, `chat`, `origin` and `irc` containers (a choice
   field, or a voter's id or username beside a quoted choice).
9. **Exit and refund.** V exits (`refund_pending`), T1 refunds on `/treasury` (`refunded`, a
   balanced `share_refund`), S1, S2 and W exit, so later runs start from a clean electorate. When a
   run stops before step 9 (a prefix or a failure), a best-effort cleanup exits the run's members
   and refunds the share (`--set cleanup=off` keeps them).

Governance windows run on the database clock: every wait polls state with a deadline (window +
60 s) and ticks the job; a tick answering `{ skipped: 1 }` is simply repeated. The report holds
ids, statuses, timings and counts (never emails, comment text or choices).

**Needs:** `api`, `web`, `worker`, `mail`, `media`, `origin`, `ffmpeg`, `browser`, `podman`; a
stack started with `harness/compose.e5-coop.yaml` on a **freshly created database** (the bootstrap
applies at the first migration only; ADR 0020): `COOP_TEST_HOOKS=true` for `api` and `worker`,
and `GOVERNANCE_BOOTSTRAP_JSON` for `migrate` (30 s discussion and council review, 45 s votes,
quorum 0.01, a 36-second streamer threshold). The scenario stops at once with the reset hint when
`governance.ordinary.discussionSeconds` > 60 or the tick hook answers 404. `DATABASE_URL` and
`INTERNAL_API_SECRET` (or `HARNESS_INTERNAL_API_SECRET`) come from the repo `.env`. Part of
`full` (on the harness stack). The override layers with `harness/compose.trust-safety.yaml` (a unit test checks).

Step 2 needs S1 and S2 among the council's `council.config.size` seats (7 by default). Every
streamer another scenario qualifies stays a council candidate on a long-lived stack, so before it
ticks, step 2 compares the active streamer members with the seats and the current term; when
seating is not certain it tries one short recompute and then fails with the reason (term full, or
S1 and S2 outranked) instead of a timeout. Reset the stack, or raise `council.config.size`, then.

| Knob               | Default         | Meaning                                                         |
| ------------------ | --------------- | --------------------------------------------------------------- |
| `steps`            | `all`           | A prefix: `1-5` (each step builds on the previous one)          |
| `via`              | `web`           | `api`: everything through the API (no browser)                  |
| `qualifySeconds`   | `600`           | How long step 1 waits for the streamer class to become eligible |
| `viewersPerStream` | `2`             | Harness HTTP viewers per streamer                               |
| `appRole`          | `commonair_app` | The role step 5 acts as for the refusal checks                  |
| `cleanup`          | `on`            | `off`: keep the run's members when it stops before step 9       |

```sh
podman compose down && podman volume rm commonair_postgres-data   # once: periods are fixed at first migration
podman compose -f compose.yaml -f harness/compose.e5-coop.yaml up -d
bun harness/src/cli.ts run e5-coop
bun harness/src/cli.ts run e5-coop --set via=api --set steps=1-5
# with the other scenarios on one stack:
podman compose -f compose.yaml -f harness/compose.trust-safety.yaml -f harness/compose.e5-coop.yaml up -d
bun harness/src/cli.ts run e5-coop e4b-money trust-safety
```

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
