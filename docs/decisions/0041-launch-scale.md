<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0041: Launch at 1,000 concurrent live streams

- Status: proposed 2026-11-11. The target in decision 1 and the answers under
  [Maintainer's answers](#maintainers-answers-2026-11-11) are the maintainer's; the rest is a draft
  for acceptance. [Open questions](#open-questions) lists what still needs a decision.
- Date: 2026-11-11 (code checked at `14c3c83a`)
- Amends: [ADR 0032](0032-scaling-and-availability.md) §2 (stages and triggers) and §7 (autoscaling
  out of scope). Everything else in 0032 stands: targets, external services, backups, the layer 4
  load balancer, the metrics in §6.
- Plan: [S1 scaling](../../.claude/briefs/next/S1-scaling.md), section "Launch scale".

## Context

ADR 0032 grows our instance one stage at a time, each stage triggered by a number held for 7
days. It assumes launch traffic fits one app droplet and that autoscaling waits until stage 2 has
run by hand. On 2026-11-11 the maintainer set the launch expectation: **more than 1,000 live
streams at once at peak.** That is far past every trigger in 0032 on day one.

What one host does today, from S1-a's sweep on a `c-4` (4 vCPU, 8 GB; `docs/operators/capacity.md`,
`v0.1.0-rc.10`, 2026-11-04):

| Cost                                                   | Measured                                      |
| ------------------------------------------------------ | --------------------------------------------- |
| One 1080p adaptive ladder (`commonair-media`)          | about 2.1 cores                               |
| Live moderation (`moderation.scan`), per live stream   | about 0.2–0.25 core, with or without a ladder |
| Caddy and origin, per 100 HLS viewers                  | about 0.5 core                                |
| Ingest and HLS packaging of a stream with no ladder    | **not measured on its own**                   |
| Postgres / Valkey CPU at the sweep's last passing step | 2.5% / 1.2%                                   |

One `c-4` carried about 100 viewers on one stream, or 60 over 3 streams, and broke on CPU before
the network (162 of 1,870 Mbit/s). At these costs moderation alone needs 200–250 cores for 1,000
streams. Three of the costs look like software, not hardware:

- **Moderation spawns two ffmpeg processes for every sample**, every `MODERATION_SAMPLE_SECONDS`
  (10 s) per stream. `liveCapture` (`services/media/src/moderation/sampler.ts`) connects over
  RTSP, waits for a keyframe, decodes and encodes a 1024 px PNG; `decodeImage`
  (`packages/moderation/src/frames.ts`) then runs a second ffmpeg to turn the PNG into raw
  frames. Hash matching runs in media. The classifier already runs in the worker
  (`services/worker/src/jobs/moderation-scan.ts`), one frame per job, with each 440 kB frame
  passed through Valkey. Not profiled, so which half costs more is unknown.
- **Serving HLS costs about 0.5 core per 100 viewers**, high for static segments. Not profiled.
- **Ladders are capped per host already** (`TRANSCODE_MAX_LADDERS`: 2 with NVENC, else one per 4
  cores), and NVENC is supported (`TRANSCODE_HWACCEL`). Neither has been measured at fleet scale.

The DigitalOcean account offers nothing above about $0.17/h and no droplet in NYC3 (ADR 0032 §1).
Launch scale needs a limit increase regardless of design.

## Decision

### 1. Target

- **1,000 concurrent live streams at peak**, with provisioned headroom to 1,500 before admission
  control (decision 6) engages.
- **About 10,000 concurrent viewers at peak** (maintainer, 2026-11-11): 10 per stream on average,
  with a long tail. Most streams sit below the ladder threshold, with a few hundred viewers on the
  largest. The largest single stream to plan for is not set; S1-o's rehearsal uses 500.
- ADR 0032's availability target (99.9% a month) applies unchanged.

### 2. Launch topology: stages 1, 2 and 3 at once, stage 4 on from day one

| Pool                | Runs                                               | Scales on                                                             | Minimum at launch |
| ------------------- | -------------------------------------------------- | --------------------------------------------------------------------- | ----------------- |
| State               | Managed PostgreSQL and Valkey, one standby each    | by hand (node size), as in 0032                                       | as 0032           |
| App                 | caddy, api, chat, web, worker, origin              | CPU p95 across the pool                                               | 2                 |
| Media               | MediaMTX + media (ingest, packaging, ladders, VOD) | placed streams and ladders per host against the host's measured limit | 2 + headroom      |
| Moderation          | workers that consume only the moderation queue     | sample lag (the oldest unclassified sample's age)                     | 1                 |
| Tracker, monitoring | as 0032                                            | not scaled                                                            | 1 each            |

- Stage 4's relays and P1's browser P2P are on from day one, because egress grows with viewers
  and no host size reduces it.
- Kubernetes stays out of scope (0032 §7). Pools are droplets running the Quadlet units of one
  `selfhost.sh --role`.

### 3. Autoscaling is a launch requirement

This replaces 0032 §7's "autoscaling before stage 2 has run by hand".

- **A scaler adapter, with a static default.** The platform has a scaler interface (list a
  pool's hosts, create a host from an image, destroy one). Cordoning and draining are our own
  node states, not the provider's. The decision loop runs as a worker job, once per tick
  cluster-wide. The default
  implementation is **static**: a fixed pool the operator lists, which never creates or destroys
  hosts. Our instance uses a DigitalOcean adapter. No provider is special-cased outside the
  adapter (AGENTS.md non-negotiable 3).
- **We decide when to scale, not the provider.** A media host carrying streams must not be
  destroyed by a CPU-average rule. DigitalOcean's Droplet Autoscale Pools may still create and
  destroy droplets for us; S1-k checks whether they accept a desired size set by us and spare
  named hosts on scale-in. That is not verified yet. If they don't, the adapter drives the
  droplet API directly.
- **Scale-out:**
  - Media: when placed load passes 60% of the pool's measured capacity, or headroom falls below
    the largest 10-minute rise in go-lives seen in the last 7 days.
  - App: when CPU p95 passes 60% for 5 minutes.
  - Moderation: when sample lag passes 2 × `MODERATION_SAMPLE_SECONDS`.
- **Scale-in only drains.** A media host is cordoned (no new placements), waits for its streams
  to end, up to a limit, and only then is destroyed. Scale-in never moves a live stream.
- **Boot time is part of the design.** A droplet rebuild plus `selfhost.sh install` took about
  7 minutes (0032 §1). Pools boot from a prebuilt snapshot with images pulled, and keep warm
  spare hosts. Target: a new media host accepting streams within 3 minutes.
- **A new host gets no long-lived secret from the provider.** Its user data carries only a
  one-time join token (10 minutes, single use, accepted over the internal transport only), which it exchanges
  with the api for its role's configuration. Snapshots hold no secret and no node identity.
- **Hard ceilings.** Each pool has a maximum size, from the budget in
  [Open questions](#open-questions). At the ceiling, admission control (decision 6) takes over.
  The scaler never spends past it.

### 4. Placement (S1-e, moved to launch)

- **RTMP ingest goes through its own layer 4 load balancer,** which targets the media pool.
  The app pool's balancer stops forwarding 1935.
  - MediaMTX on each media host names its node when it asks the api to authorize a publish and
    when it reports the stream ready. The api records the node on the broadcast in Postgres, in
    the transaction that starts it.
  - A media host reports itself unhealthy to the load balancer's health check when it is
    cordoned or at its stream limit, so new connections go elsewhere.
  - RTMP clients don't follow redirects reliably, so the balancer chooses the host.
  - WHIP signalling reaches the app pool, which picks the least-loaded node and proxies the
    request to it over the internal transport. The WebRTC media then flows to that node's own public address.
  - S1-e checks that the load balancer keeps existing connections to a host that fails its
    health check.
- **Origin routes by placement.** Playlist and segment requests reach the app pool. Origin looks
  up the placement, cached in Valkey, and fetches from the placed host over the internal
  transport (inside one VPC that traffic is not billed; between providers it is the sender's
  egress). There is one public origin, and viewers never address media hosts.
- **Host loss.**
  - The streamer's encoder reconnects through the load balancer and lands on another host.
  - The reconnect grace (`LIVE_RULES.reconnectGraceSeconds`) continues the same broadcast, and
    the placement row moves.
  - Viewers see a stall, not an ended stream.
  - The harness proves this before launch.
- **Ladders are placed with streams.** A stream that crosses `TRANSCODE_VIEWER_THRESHOLD` gets a
  ladder only if its host has a free slot. A host with no slot stays on source-only for that
  stream; we never migrate a live stream to get a slot. Media capacity is counted in ladder
  slots, not only streams.

### 5. Cost per stream is a launch gate

Nothing is sized until these are measured (S1-i) and, where the targets miss, fixed:

| Cost                                          | Launch target                                                                     |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| Ingest + HLS packaging, no ladder, per stream | measured; target at most 0.1 core                                                 |
| Moderation, per stream                        | at most 0.05 core (today about 0.2–0.25)                                          |
| Origin + Caddy, per 100 viewers               | at most 0.15 core (today about 0.5)                                               |
| One 1080p ladder                              | measured on CPU and on a GPU droplet with NVENC; pick the cheaper per ladder-hour |

- **Moderation** keeps its detection guarantees (ADR 0006): same sample interval, same hash
  lists, same classifier. What changes is how a frame reaches the classifier: one long-lived
  reader per stream, or a frame tap from the packager, instead of two ffmpeg processes per sample, batched
  inference, and workers that can run as a moderation-only pool.
- **Database connections** grow with hosts. Each pool host's services multiplied by
  `DATABASE_POOL_MAX` passes a managed node's `max_connections` quickly (47 usable on
  `db-s-1vcpu-2gb`). A transaction-mode pooler goes in front of Postgres: the provider's PgBouncer
  pools, or a bundled PgBouncer for self-hosters. S1-f checks that postgres.js runs without
  prepared statements, and finds every session-level feature the services rely on. The relay
  purges, IRC listeners and the RTSP publish proxy use listeners; whether any is a Postgres
  `LISTEN` is not checked yet.

### 6. Admission control when capacity runs out

- When the media pool is at its ceiling, or scaling has not caught up, **a new go-live is
  refused** by the api, where publishes are authorized, with a "capacity full, retrying" state shown in the creator dashboard and to OBS (the
  publish is rejected, and the encoder's own retry tries again). Live streams are never
  degraded or cut to make room.
- Ladders are the first thing given up: past 80% of the pool, new ladders stop starting.
- Every refusal is counted. A refusal is an alertable event, not a quiet failure.
- Admission order is FIFO by retry. A priority rule (for example, partners first) would be a
  separate decision.

### 7. Self-hosters

- The single-host install stays the default, with no change for operators who don't opt in.
- `selfhost.sh --role app|media|moderation` and the static scaler give any operator the same
  pools with hand-listed hosts. Placement, admission control and the pooler work identically
  with one host or many.
- The DigitalOcean scaler adapter is optional, like Stripe (ADR 0032 decision 1, the
  self-host-parity rule).

### 8. Proving it before launch

- **Harness, local:** `multi-instance` grows to two media hosts. New `placement` and
  `admission` scenarios cover:
  - streams spread across hosts;
  - a host killed mid-stream, with the stream continuing on another;
  - cordon and drain;
  - a full pool refusing a go-live.
- **On DigitalOcean (paid, each run approved by the maintainer):**
  - a per-stream cost run (S1-i);
  - a scaling rehearsal: 100 streams growing to 300 on a small pool, with the scaler creating and
    draining hosts;
  - one full-size run before launch: 1,000 streams and the viewer target, with generators sized
    to it (`capacity.md`'s 430-viewers-per-address limit means many generator addresses), plus
    the `failover` drill at that load.

## Consequences

- **Launch is later.** S1-e, S1-f, the moderation rework, the pooler, the scaler and the
  rehearsals become launch-critical. S1-e was the largest S1 unit before this.
- **Cost becomes a fleet, not a droplet.** Until S1-i has numbers, a rough bound at today's costs
  with no ladders is 1,000 × (0.25 moderation + about 0.1 ingest) ≈ 350 cores. Hitting decision
  5's targets brings that to about 150. Viewers, ladders and egress come on top. The
  maintainers set the budget, and the scaler's ceilings come from it.
- **Egress is likely the largest bill.** 10,000 viewers at 3 Mbps is about 30 Gbps at peak.
  Relays and P2P carry part of it, and the rest is metered past the pooled allowance at
  $0.01/GiB. A first estimate (2026-11-11, not measured):
  - Viewers cost about 1.35 GB per viewer-hour (ADR 0032). If the average over a month is 10% to
    30% of the 10,000 peak, that is about 1 to 3 PB a month, or about $9,000 to $27,500 at
    $0.01/GiB. The pooled allowance takes a few hundred TB off, and relays and P2P take off a
    share nobody has measured.
  - Compute for comparison: 150 to 350 cores at the `c-4` price read on 2026-11-11 ($0.125 an
    hour, about $23 a vCPU-month) is about $3,400 to $8,000 a month.
  - The average is the maintainer's to estimate (open question 4). The estimate is small at the
    100 and 300 waves, so it gates only the 1,000 wave.
- **Where viewers are served may differ from where the platform runs.** ADR 0025 chose
  DigitalOcean on tooling and stability and named the way out: "a dedicated media origin
  elsewhere is an add-on, not a migration". That stays true only if nothing built for launch
  assumes every host shares one private network. The contract step (§4) carries that rule, and the
  scaler's provider adapter (decision 3) already keeps a second provider to one more adapter.
  Whether to add a viewer-facing pool on a provider with cheap or unmetered transfer is decided
  before the 1,000 wave (open question 4), from measured egress at the 300 wave.
- **The account limit is a long-lead blocker.** Raising it should start now, independent of the
  design. As read on 2026-11-11 the account allows 10 droplets, no GPU droplets and no size above
  4 vCPU (`c-4`). DigitalOcean's prepaid tiers raise the counts (15 droplets and 2 GPUs at $250,
  100 and 16 at $4,000); whether a tier also lifts the size cap is not confirmed.
- **ADR 0032's stage triggers** still describe the self-host default and growth past launch
  capacity. For our instance the trigger to grow a pool is the scaler's, and the pool ceilings
  are the new "move on" number.

## Maintainer's answers (2026-11-11)

- **Viewers:** plan for about 10,000 concurrent at peak (decision 1).
- **Ladders: raise the threshold.** A stream gets a ladder only above a higher viewer count than
  today's 50, and only while its host has a free slot (decision 4). The working value is
  `TRANSCODE_VIEWER_THRESHOLD=200` for our instance. S1-i's cost per ladder and the budget set the
  final number. The default for self-hosters stays 50.
- **Launch ramps in waves.** A cap on concurrent go-lives rises in steps, 100, then 300, then 1,000,
  each step held until the scaler, the cost targets and the alerts have held at that load. The cap
  is admission control's pool ceiling (decision 6) set by hand, so it needs no second mechanism.
  The full-size rehearsal (decision 8) gates the last step, not the first.
- **Budget: decided after measuring.** The monthly ceiling is set once S1-i has costs per stream,
  per viewer and per ladder. Until then S1-k's pool maximums are parameters with no production
  values.

## Open questions

1. **Monthly budget ceiling**, which sets each pool's maximum size. Waits for S1-i (above).
2. **Region and droplet sizes,** after the account limit increase. 0032's NYC3 still stands unless
   the limit forces another region.
3. **The largest single stream** to plan for, which sizes origin's fan-out for one placement.
4. **Where viewer egress is served at the 1,000 wave:** DigitalOcean at $0.01/GiB, or a
   viewer-facing pool on a provider with cheap or unmetered transfer. Needs the maintainer's
   estimate of average concurrent viewers, the share relays and P2P carry (measured at the 300
   wave), and that provider's current transfer price, checked on the day.
