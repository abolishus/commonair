<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Capacity: how far one host goes

This page is the runbook and the results for measuring one CommonAir host: how many concurrent
viewers and live streams a droplet size serves within the load targets, what breaks first, and
what each viewer costs in egress and CPU. The numbers size the launch droplet (L1) and set the
stage triggers of the scaling plan ([ADR 0032](../decisions/0032-scaling-and-availability.md),
`.claude/briefs/next/S1-scaling.md`). Hosting is DigitalOcean
([ADR 0025](../decisions/0025-hosting-on-digitalocean.md)), but nothing below is specific to it
except the `doctl` commands; any Debian 13 host in a private network works the same way.

The tooling is the harness's load test pointed at a **remote** instance: `load-sweep` steps the
load up until a target breaks, `load-plan` runs one fixed size, and `load-cost` measures what
one stream, one viewer and one ladder cost, each alone ([Cost per stream and per
viewer](#cost-per-stream-and-per-viewer-load-cost)). Both sample the target over
SSH (whole-host CPU, memory, load and NIC bytes from `/proc`, per-container CPU from `podman
stats`) and the generator machines the same way, and call a run **inconclusive** when the
generator was the limit, so a generator limit is never reported as the target's.

## Before you start: one address, one rate-limit bucket

Read this first; it decides how many generator machines a run needs.

**Viewers do not sign up.** An HTTP viewer starts an anonymous playback session
(`POST /api/channels/{channel}/playback`, `services/api/src/routes/playback.ts` `playback.start`),
heartbeats every 10 s (`playback.heartbeat`) and fetches HLS from the origin. No account, no
`auth` bucket hit.

**Playback calls have their own per-address bucket.** `playback.start`, `heartbeat` and `end`
declare `rateLimit: "playback"` (`packages/contracts/src/api/router.ts`): 3000 calls a minute
per client address (`DEFAULT_RATE_LIMITS`, `services/api/src/lib/ratelimit.ts`). Caddy trusts no
forwarded header (`infra/caddy/Caddyfile`), so every simulated viewer on one generator is one
address. At about 7 calls a minute per viewer that is **about 430 steady viewers per generator
address**. Past that, starts fail with 429 and heartbeats fail. Playback tokens (120 s,
`PLAYBACK_TOKEN_TTL_SECONDS`) then stop being refreshed, and segment fetches start failing about
two minutes in. IPv6 does not help: limits apply per /64 (`rateLimitSubjectIp`), and a droplet's
addresses share one.

The harness reports failed heartbeats per step (`heartbeatErrors` in each sweep row, metric
`heartbeat.errors`). In `load-sweep`, and in `load-plan` against a remote target, a step with
more than `maxHeartbeatErrors` failed heartbeats (default 0) is judged inconclusive: it measured
the rate limiter, not the host. The test instance must not raise the limits: there is no env
override, and the instance under test is an unmodified release.

## The test instance

Everything below changes only `~/.config/commonair/commonair.env` on the target and
`/etc/hosts` on the generators.

**Mail.** Sign-up needs a verified address. Run Mailpit on the first generator (pinned exactly
like the harness stack's, from `compose.yaml`) and point the instance's SMTP at its VPC address:

```sh
SMTP_HOST=10.110.0.7        # the generator's VPC address
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_REQUIRE_TLS=false
SMTP_USER=
SMTP_PASSWORD=
MAIL_FROM=noreply@load.stream.example.org
```

Mail never leaves the VPC. `HARNESS_MAILPIT_URL` points the harness at the same Mailpit.

**Streamer accounts.** The harness signs streamers up through the real flow (ALTCHA, sign-up,
verification mail, sign-in). The instance's `auth` bucket allows 10 auth writes (sign-up and
sign-in each count) per address per minute, so the harness **paces** them
(`HARNESS_LOAD_AUTH_PER_MINUTE=10`, a sliding window with a second of margin; a 429 waits for its
`retryAfterSeconds`) and **reuses** accounts (`HARNESS_LOAD_ACCOUNTS_FILE`, test credentials per
instance, mode 0600). A new account costs two auth writes, a reused one costs one: 20 streamers
take about 4 minutes the first time and 2 minutes on every later run against the same instance;
100 take about 20 and 10. A fresh droplet per size means one paced sign-up per size. Nothing is
weakened and no new code path exists in the services; accounts created ahead of time would need
a new admin command, and an override of the `auth` bucket does not exist.

**Name resolution.** The instance needs a real DNS name for its ACME certificate (for example
`load.stream.example.org`, an A record to the target's public address, DNS only). The
generators resolve that name to the target's **VPC address** in `/etc/hosts`, so viewer traffic
stays on the private network and TLS still validates.

**Transfer.** DigitalOcean's bandwidth billing page (checked 2026-10-26) says data transfer
between droplets over the VPC network uses the private interface, and only data sent over a
public interface counts against the team's pooled transfer allowance; overage is $0.01 per GiB
of outbound transfer. A sweep over the VPC therefore costs droplet time, not transfer. The
target's public interface still shows ACME, package downloads and anything a viewer outside the
VPC fetches; the per-interface NIC numbers keep the two apart.

## Stand it up

Run these from the operator's machine with `doctl` authenticated by the operator's own scoped
token (ADR 0025 decision 5). The token is never written to git and never handed to an agent.
Droplets bill per second: tear down as soon as the numbers are in.

```sh
REGION=fra1
RUN=load-$(date -u +%Y%m%d)
SSH_KEY=$(doctl compute ssh-key list --format ID --no-header | head -1)

# Sizes under test: dedicated-vCPU General Purpose (g-*, gd-*) and CPU-Optimized (c-*, c2-*).
# List the current slugs now instead of trusting this page, and record the ones you use.
doctl compute size list --format Slug,VCPUs,Memory,PriceMonthly,Regions | grep -E '^(g|gd|c|c2)-'
doctl compute image list-distribution --format Slug | grep -E '^debian-13'

TARGET_SIZE=g-4vcpu-16gb     # one of the listed slugs
GEN_SIZE=c-8                 # CPU-Optimized is a sensible start for generators
IMAGE=debian-13-x64          # the slug the list above printed

VPC=$(doctl vpcs create --name "$RUN" --region "$REGION" --format ID --no-header)
doctl compute droplet create "$RUN-target" --size "$TARGET_SIZE" --image "$IMAGE" \
  --region "$REGION" --vpc-uuid "$VPC" --ssh-keys "$SSH_KEY" --tag-name "$RUN" --wait
doctl compute droplet create "$RUN-gen1" --size "$GEN_SIZE" --image "$IMAGE" \
  --region "$REGION" --vpc-uuid "$VPC" --ssh-keys "$SSH_KEY" --tag-name "$RUN" --wait
# More generators: "$RUN-gen2", … with the same flags.

doctl compute droplet list --tag-name "$RUN" \
  --format Name,PublicIPv4,PrivateIPv4,Size,Region
```

Note the target's public and private addresses (`TARGET_PUBLIC`, `TARGET_VPC`) and each
generator's (`GEN1_VPC`, …). Point the DNS name at `TARGET_PUBLIC`.

**Target.** Install the release exactly as [install.md](../self-hosting/install.md) says
(download, verify, `selfhost.sh install --yes --bundle … --domain load.stream.example.org
--email … --require-signature`). Then, as `commonair`, add the mail settings above to
`~/.config/commonair/commonair.env` and apply them with `sh ~/commonair/selfhost.sh install
--reinstall`. Let the first generator's root key in as `commonair` (the user that owns the
rootless containers, so `podman stats` sees them):

```sh
# on the target, as root, with the generator's public key in /root/gen1.pub
install -d -m 700 -o commonair -g commonair /home/commonair/.ssh
cat /root/gen1.pub >> /home/commonair/.ssh/authorized_keys
chown commonair:commonair /home/commonair/.ssh/authorized_keys
chmod 600 /home/commonair/.ssh/authorized_keys
apt-get install -y iperf3
```

**Generators.** On each one, as root:

```sh
apt-get update && apt-get install -y git podman iperf3 curl xz-utils

# The repository at the release under test, at the same path on every generator.
git clone https://github.com/abolishus/commonair.git /srv/commonair
cd /srv/commonair && git checkout "v$VERSION"

# Bun from the image the release pins by digest (infra/containers/service.Containerfile,
# BUN_IMAGE=docker.io/oven/bun:<tag>@sha256:<digest>). Podman refuses an image whose content
# does not match the digest, so the binary is the one the repository vetted, not merely one
# that matches a checksum downloaded from the same place.
BUN_IMAGE=$(sed -n 's/^ARG BUN_IMAGE=\(.*@sha256:[0-9a-f]\{64\}\)$/\1/p' infra/containers/service.Containerfile)
test -n "$BUN_IMAGE" || echo "STOP: no digest-pinned BUN_IMAGE in service.Containerfile" >&2
podman pull "$BUN_IMAGE"
BUN_CTR=$(podman create "$BUN_IMAGE")
podman cp "$BUN_CTR:/usr/local/bin/bun" /usr/local/bin/bun
podman rm "$BUN_CTR"
bun --version      # must match the image tag (and CI's BUN_VERSION in .github/workflows/ci.yml)

bun install --frozen-lockfile
bun x playwright install --with-deps chromium webkit   # only bun is copied, so no bunx

# FFmpeg 8.1, the harness image's build and checksum (infra/containers/harness.Containerfile):
# Debian 13's FFmpeg 7.1 lacks -readrate_catchup, which every harness streamer passes.
FFMPEG_BUILD=$(sed -n 's/^ARG FFMPEG_BUILD=//p' infra/containers/harness.Containerfile)
FFMPEG_SUM=$(sed -n 's/.*amd64) arch=linux64; sum=\([0-9a-f]\{64\}\).*/\1/p' infra/containers/harness.Containerfile)
curl -fsSL -o /tmp/ffmpeg.tar.xz "$FFMPEG_BUILD-linux64-gpl-8.1.tar.xz"
echo "$FFMPEG_SUM  /tmp/ffmpeg.tar.xz" | sha256sum -c -
tar -xJf /tmp/ffmpeg.tar.xz -C /usr/local/bin --strip-components=2 --wildcards '*/bin/ffmpeg' '*/bin/ffprobe'
ffmpeg -hide_banner -h full | grep -q readrate_catchup

echo "$TARGET_VPC load.stream.example.org" >> /etc/hosts
```

On the first generator only, Mailpit on its VPC address, with the image line from
`compose.yaml` (tag and digest):

```sh
MAILPIT=$(sed -n 's/^ *image: \(ghcr\.io\/axllent\/mailpit:.*\)$/\1/p' /srv/commonair/compose.yaml)
podman run -d --name load-mailpit -p "$GEN1_VPC:1025:1025" -p 127.0.0.1:8025:8025 "$MAILPIT"
```

From the first generator, give every other generator's key to `root` there (the remote shards
run as root over SSH), and check both SSH paths work non-interactively:

```sh
ssh -o BatchMode=yes commonair@"$TARGET_VPC" 'podman stats --no-stream --format json' | head -c 200
ssh -o BatchMode=yes root@"$GEN2_VPC" true
```

**NIC ceilings.** Measure them once per size; the judges need them in Mbit/s:

```sh
ssh commonair@"$TARGET_VPC" 'iperf3 -s -D'
iperf3 -c "$TARGET_VPC" -t 20 -P 8        # generator → target: generator transmit
iperf3 -c "$TARGET_VPC" -t 20 -P 8 -R     # target → generator: target transmit
ssh commonair@"$TARGET_VPC" 'pkill iperf3'
```

Take the `[SUM] … receiver` rates. The target's transmit is `HARNESS_LOAD_TARGET_NIC_MBPS`; the
lower of the generator's two directions is `HARNESS_LOAD_GENERATOR_NIC_MBPS`. Without them the
NIC rules are skipped and the report says so.

## Run

On the first generator, in `/srv/commonair`:

```sh
export HARNESS_API_URL=https://load.stream.example.org
export HARNESS_WEB_URL=https://load.stream.example.org
export HARNESS_ORIGIN_URL=https://load.stream.example.org
export HARNESS_RTMP_URL=rtmp://load.stream.example.org:1935
export HARNESS_WHIP_URL=https://load.stream.example.org
export HARNESS_MAILPIT_URL=http://127.0.0.1:8025
export HARNESS_CONTAINER_PREFIX=commonair
export HARNESS_LOAD_TARGET_SSH=commonair@$TARGET_VPC
export HARNESS_LOAD_TARGET_NIC_MBPS=…        # measured above
export HARNESS_LOAD_GENERATOR_NIC_MBPS=…     # measured above
export HARNESS_LOAD_GENERATOR_HOSTS=local,root@$GEN2_VPC   # or unset: one generator
export HARNESS_LOAD_GENERATOR_REPO=/srv/commonair
export HARNESS_LOAD_AUTH_PER_MINUTE=10
export HARNESS_LOAD_ACCOUNTS_FILE=/root/load-accounts.json
export HARNESS_REPORT_DIR=/root/load-reports

# Viewers axis: 250 → 4000 viewers over 20 streams, 120 s per step, 30 s cool-down.
bun harness/src/cli.ts run load-sweep

# Streams axis: 1 → 32 live streams at 60 viewers each (ladders start at
# TRANSCODE_VIEWER_THRESHOLD, 50 by default), to find the transcode limit. Each streamer sends
# 1920x1080 at 6000 kbps by default, so the ladder has rungs to make (a 640x360 source makes
# at most one); set width, height and bitrateKbps to match the audience you expect.
bun harness/src/cli.ts run load-sweep --set streamerSteps=1,2,4,8,16,32 --set ladderViewers=60

# One fixed size (the PLAN size), judged pass/fail/inconclusive.
bun harness/src/cli.ts run load-plan
```

Useful knobs (`--set`): `steps`, `streamers`, `seconds`, `cooldownSeconds`, `browserViewers`
(default 10; glass-to-glass needs at least one), `httpPerProcess`, the source every streamer
sends (`width`, `height`, `bitrateKbps`, `protocol`: 640x360 at 1200 kbps over RTMP on the
viewers axis, 1920x1080 at 6000 kbps on the streams axis), the targets `maxLatencyMs`,
`maxTtffMs`, `maxStallRatio`, `maxErrorRate`, `maxTargetCpuP95` (85), `targetNicFraction` (0.95),
the generator judge's `generatorCpuP95` (80) and `generatorNicHeadroom` (0.15), and
`maxHeartbeatErrors` (0; `load-plan` takes it too). The harness README has the full list.

**An inconclusive run has its own scenario status.** The harness prints it as
`INCONCLUSIVE  load-sweep` (or `load-plan`) with one `inconclusive:` line per reason (the
generator limit or the failed heartbeats, and for a sweep the step), the run's last line counts
it (`FAILED: 0 passed, 0 failed, 0 skipped, 1 inconclusive`), and the report has
`status: "inconclusive"` with `inconclusiveReasons`. It is not a pass: the command exits 1, as
for a failure, because an inconclusive run is not a capacity number. Only a scenario declared
report-only would let it through, and neither load scenario is. The details are in the report:
`data.verdict.outcome` for `load-plan` (`judged` or `inconclusive`, with `limits` and `invalid`
saying why) and `data.sweepSummary.outcome` for `load-sweep` (`completed`, `break` or
`inconclusive`; each row's `status`, `generatorLimits` and `invalidReasons` say which step and
why). The metric `load.inconclusive` or `sweep.inconclusive` is 1 in the same case. A sweep that
found the break (`break`) is a result, not a failure: it passes unless the first step already
broke.

The sweep stops at the first step that breaks a target or where a generator was the limit. Its
report (`$HARNESS_REPORT_DIR`) holds `data.sweep` (one row per step: streams, the source shape
they sent, viewers, status, what broke, why a step was invalid, ladders, latency, TTFF, stalls, errors, heartbeat errors, target CPU p95 and NIC,
per-viewer egress, Postgres and Valkey CPU, generator CPU) and `data.sweepSummary` (the last
passing step, the first failing one and why, per-viewer egress and CPU at the last passing
step). Each step's full measurements are under `data["sweep step N"]` (`target`, `containers`,
`generators`, `verdict`).

## Cost per stream and per viewer (`load-cost`)

The sweep finds where one host breaks; it does not say what one stream or one viewer costs,
because every step mixes both. `load-cost` measures them apart: it runs fixed **cells** and
turns their CPU into cores per unit by subtracting one cell from another. Nothing on the
instance is switched off to do it: there is no moderation off switch and no rate-limit
override, and the cells differ only in what the generator sends.

| Cell           | Streams            | Viewers                          | Yields                                                        |
| -------------- | ------------------ | -------------------------------- | ------------------------------------------------------------- |
| `idle`         | 0                  | 0                                | the baseline every other cell subtracts, and its noise        |
| `viewers`      | 1                  | `viewers` (40)                   | caddy + origin + api cores per viewer                         |
| `viewers-many` | `manyStreams` (10) | `viewers` (40) each              | the same over many playlists and segment paths (cache misses) |
| `ingest`       | `streams` (10)     | 0                                | mediamtx + media + worker + valkey cores per live stream      |
| `ingest-2x`    | 2 × `streams`      | 0                                | whether the per-stream cost is linear                         |
| `ladder`       | 1                  | `ladderViewers` (threshold + 10) | one 1080p ladder, by subtraction from `viewers`               |

The cells run in that order. Streams only grow until `ingest-2x`, and the ladder runs last: a
ladder stops only after 2 minutes below 80 % of the threshold, so a ladder cell earlier on would
leak into the next one. Every cell checks the ladder count at the start and end of its window: a
ladder in a cell that must have none, or none in the ladder cell, fails the cell.

Each cell warms up (`warmupSeconds`, 30; the ladder cell `ladderWarmupSeconds`, 90, and then
waits up to `ladderWaitSeconds`, 60, for the ladder), then measures for `seconds` (180). Every
streamer sends the same source (1920x1080 at 6000 kbps over RTMP by default), so no subtraction
mixes two encodes. The derived costs:

- **Ingest per stream** = (`ingest` − `idle`) / N, per container. Moderation spans two of them:
  the frame capture in `media` (`services/media/src/moderation/sampler.ts`, two ffmpeg runs per
  sample) and the classifier in `worker` (`services/worker/src/jobs/moderation-scan.ts`). The
  report gives both and their sum as **moderation per stream**. It is an upper bound: `media`
  also runs each stream's controller and recorder, which only a profile or `pidstat` (below)
  separates. **Packaging per stream** is `mediamtx` + `valkey`.
- **Linearity**: (`ingest-2x` − `idle`) / 2N against the `ingest` figure, and what the second N
  streams added. Within `linearityTolerance` (0.2) is linear.
- **Per viewer** = (`viewers` − `idle` − 1 × ingest per stream) / V, and the same for
  `viewers-many` with S streams. The headline is caddy + origin per 100 viewers (ADR 0041
  decision 5); api and every other container are in the breakdown.
- **Ladder** = `ladder` − `viewers` − (L − V) × the per-viewer cost.
- **Valkey bytes per stream**: Valkey's receive and transmit rates from `ingest` minus `idle`,
  per stream. Each moderation sample puts a 384² RGB frame (about 440 kB) in
  `moderation:frame:<id>` for the worker to read.
- **Host cores** beside each line: the same subtraction over the whole target's `/proc/stat`,
  which also counts what no container owns (SSH, the samplers, the kernel).

**How CPU is read.** Not from `podman stats`' `cpu_percent`: a one-shot `--no-stream` call has no
earlier sample to compare with, so Podman measures from the container's start, and the
percentage can be a lifetime average (it equals `avg_cpu` in the same output). `load-cost` reads
cumulative counters instead and divides their change over the window: on the target, each
container's cgroup v2 `cpu.stat` `usage_usec` and its network namespace's `/proc/<pid>/net/dev`
(the container list, PIDs and cgroup paths are resolved once per cell; each read is a few
`cat`s over the existing SSH connection). Locally, or when no cgroup resolves, it falls back to
`podman stats`' `cpu_time` and `net_io`, whose byte counts have three significant digits. The
report says which (`containerSource`). The sweep's `cpu` figures still come from `podman stats`.

**Judging.** A cell is `measured`, `failed` or `inconclusive`:

- **inconclusive** when the generator was the limit (the sweep's rules: CPU p95 over
  `generatorCpuP95`, or a NIC within `generatorNicHeadroom` of its ceiling), when more than
  `maxHeartbeatErrors` heartbeats failed (the generator's address was rate-limited), when a
  container read failed, or a container restarted or went missing mid-window. A cost that needs
  an inconclusive cell is reported as unavailable, with the reason; it is never computed from it.
- **failed** when a stream was not live at the end of the window (or never went live), a viewer
  got no session or played no segment, a viewer reported an error, or the ladder check failed.
  A failed cell stops the run: the fleet is in an unknown state.
- A cell shorter than 60 s after its warm-up is refused (`podman stats` and the counters sample
  every 5 s).
- Subtraction can go negative from noise. The report keeps every cell's raw numbers
  (`data.cost.cells`) next to each difference, lists negative differences (`negative`) and flags
  every difference smaller than the `idle` cell's own p95 − p50 spread for that container
  (`belowNoise`, and `totalBelowNoise` for a line's sum). A target check on a noisy line is left
  unjudged (`met: null`). If a cost you need is below the noise, raise `streams` or `viewers`.

**One address, one bucket, again.** `viewers-many` opens S × V viewers (400 by default) through
the playback bucket of each generator address: about 430 steady viewers per address. A plan past
that prints a note before it starts, and the cell will be inconclusive on failed heartbeats; add
generator hosts (`HARNESS_LOAD_GENERATOR_HOSTS`) or lower `manyStreams`.

**Generators.** Every streamer runs on the first generator, and the 1080p source costs about one
x264 core each there: `ingest-2x` with N = 10 is 20 encodes. Use a 32-vCPU CPU-Optimized size
for the first generator, or lower `streams` (5 is still well above the noise at today's
per-stream cost). The generator judge reports an overloaded generator as inconclusive either way.

### Run it

With the environment of [Run](#run), on the first generator:

```sh
# Every cell, the defaults: about 35 minutes (20 streamer sign-ups the first time add ~4).
bun harness/src/cli.ts run load-cost

# Split the viewer cost: playlists and playback API calls only (no segment downloads) …
bun harness/src/cli.ts run load-cost --set cells=idle,viewers --set fetchSegments=false
# … and playlists and segments only (no heartbeats). A viewer without heartbeats is cut off when
# its 120 s playback token expires, so `seconds` is capped to fit inside it (71 s with the
# default warm-up and 40 viewers) and the report's `data.params.notes` says so.
bun harness/src/cli.ts run load-cost --set cells=idle,viewers --set heartbeats=false

# A smaller ingest set, for a small first generator:
bun harness/src/cli.ts run load-cost --set cells=idle,ingest,ingest-2x --set streams=5
```

The knobs (`--set`): `cells`, `seconds`, `warmupSeconds`, `ladderWarmupSeconds`,
`ladderWaitSeconds`, `cooldownSeconds` (20), `streams`, `viewers`, `manyStreams`,
`ladderThreshold` (the instance's `TRANSCODE_VIEWER_THRESHOLD`, 50: the harness cannot read it),
`ladderViewers`, `heartbeats` and `fetchSegments` (the `viewers` cell only; the ladder cell
always needs both, since heartbeats make the viewer count), the source (`width`, `height`,
`bitrateKbps`, `protocol`), `browserViewers` (0), `httpPerProcess`, `maxHeartbeatErrors`,
`generatorCpuP95`, `generatorNicHeadroom`, `linearityTolerance`, and `profiles` / `profileDir`
(below). `--set preset=smoke` runs tiny cells (2 streams, 5 viewers, 20 s, no ladder) against the
local stack only; its numbers are the developer machine's and it checks the plumbing.

Against the local stack every run prints that the numbers are the developer machine's, and the
report says so (`data.cost.local`).

**The report.** `data.cost` holds `outcome` (`measured`, `inconclusive`, `failed`), `cells` (one
row per cell: status and why, streams, viewers, ladders at the start and end, per container
`cores`, `coresP50`, `coresP95`, receive and transmit bytes per second, the host's cores, and
the viewer counts), `costs` (each line's `basis` in words, `perService`, the group `total`,
`allServices`, `host`, `belowNoise`, `negative`, `unavailable`), `targets` (each ADR 0041
target, the value and `met`), and `notes`. Metrics: `cost.ingest.cores_per_stream`,
`cost.packaging.cores_per_stream`, `cost.moderation.cores_per_stream` (and `.capture_…`,
`.classifier_…`), `cost.edge.cores_per_100_viewers`, `cost.edge_many.cores_per_100_viewers`,
`cost.ladder.cores`, `cost.ladder.media_cores`, `cost.linearity.ratio`,
`cost.valkey.rx_bytes_per_stream`, `cost.valkey.tx_bytes_per_stream`, `cost.cells_measured` and
`cost.inconclusive`. An inconclusive cell makes the scenario `INCONCLUSIVE` with one line per
reason; a failed cell fails it.

## CPU profiles

The cost lines say which container; a profile says which code. **The switch is for test
instances only.** `infra/containers/entrypoint.sh` starts a Bun service under Bun's CPU profiler
when `COMMONAIR_CPU_PROFILE` names a writable directory (an empty or unset variable leaves the
command exactly as before; a directory that is missing or read-only stops the service from
starting, loudly). It cannot be turned on from `commonair.env`: `render-env.sh` copies only each
unit's listed keys, and this one is in no list. Only a quadlet drop-in on the host sets it.

Bun writes the profile when the process exits. Checked with the pinned Bun 1.4.3: a long-running
`Bun.serve` server that handles SIGTERM by calling `process.exit` (every service does, through
`runService` in `packages/service/src/server.ts`) writes its `.cpuprofile` (and, with
`--cpu-prof-md`, a Markdown summary) on SIGTERM; the same server without a SIGTERM handler is
killed by the signal and writes nothing. A SIGKILL (a stop timeout, `HealthOnFailure=kill`)
writes nothing either. The profile covers the JavaScript thread: time inside native code
(onnxruntime's inference threads in the worker, ffmpeg in its own processes) shows only as the
calling frame or not at all; use `perf` for those.

On the target, as `commonair`, for the services to profile:

```sh
for s in api media worker origin; do
  mkdir -p ~/commonair-profiles/$s ~/.config/containers/systemd/commonair-$s.container.d
  cat > ~/.config/containers/systemd/commonair-$s.container.d/50-cpu-profile.conf <<'EOF'
[Container]
Environment=COMMONAIR_CPU_PROFILE=/var/lib/commonair/cpu-profile
# U: owned by the container's user (uid 1000 inside), so Bun can write there.
Volume=%h/commonair-profiles/SERVICE:/var/lib/commonair/cpu-profile:Z,U
EOF
  sed -i "s/SERVICE/$s/" ~/.config/containers/systemd/commonair-$s.container.d/50-cpu-profile.conf
done
systemctl --user daemon-reload
systemctl --user restart commonair-api commonair-media commonair-worker commonair-origin
journalctl --user -u commonair-media -n 20 | grep 'CPU profiler on'
```

Then let `load-cost` drive it (`profiles` names the services, `profileDir` the host directory
relative to `commonair`'s home, `commonair-profiles` by default):

```sh
bun harness/src/cli.ts run load-cost --set cells=idle,ingest --set profiles=media,worker
bun harness/src/cli.ts run load-cost --set cells=idle,viewers-many --set profiles=api,origin
```

The restarts go through `systemctl --user` over the same SSH connection, so check first that
the session reaches `commonair`'s user manager:
`ssh commonair@"$TARGET_VPC" systemctl --user is-active commonair-api.service` prints `active`.
It refuses to start if a named container has no `COMMONAIR_CPU_PROFILE`. Otherwise it restarts
each service before the first cell (so the profile covers this run), and after the last cell
stops it (the profile is written), starts it again and copies every new file over SSH into
`$HARNESS_REPORT_DIR/profiles/<run id>/<service>/` (`data.profiles` lists them). Open a
`.cpuprofile` in any Chrome DevTools-compatible viewer; the `.md` beside it is a plain-text
summary. Remove the drop-ins (and `daemon-reload`, restart) before the instance is used for
anything else. The self-hosting documentation does not mention this switch, on purpose.

**ffmpeg, MediaMTX, Caddy, Postgres and Valkey are not Bun.** Profile them with `perf` on the
target, as root, by the container's cgroup (DigitalOcean droplets expose no hardware counters to
the guest, so use the `cpu-clock` software event):

```sh
apt-get install -y linux-perf sysstat
# The container's PID and cgroup (rootless: ask as commonair).
PID=$(sudo -iu commonair podman inspect --format '{{.State.Pid}}' commonair-mediamtx)
CG=$(sed -n 's/^0:://p' /proc/$PID/cgroup)

perf top -e cpu-clock -G "${CG#/}" -a                     # live, while a cell runs
perf record -e cpu-clock -F 499 -g -a -G "${CG#/}" -o /root/mediamtx.data -- sleep 120
perf report -i /root/mediamtx.data --stdio --sort comm,dso,sym | head -80

# media's processes one by one: the moderation capture ffmpeg runs, the ladder's ffmpeg, the
# recorder, and Bun itself, each with its command line.
MPID=$(sudo -iu commonair podman inspect --format '{{.State.Pid}}' commonair-media)
MCG=$(sed -n 's/^0:://p' /proc/$MPID/cgroup)
pidstat -u -h -l -p "$(paste -sd, /sys/fs/cgroup$MCG/cgroup.procs)" 5 12
perf record -e cpu-clock -F 499 -g -p <the ladder ffmpeg's PID from pidstat> -o /root/ladder.data -- sleep 60
```

`pidstat` re-reads its PID list only at start, and each moderation sample is a new short ffmpeg
process: run it several times, or use `perf record -G` on the cgroup, which follows new
processes. Copy the data files off with `scp` before tearing down.

## The ladder on a GPU droplet

ADR 0041 decision 5 asks for the ladder's cost on CPU and with NVENC, per ladder-hour. The CPU
figure is the `ladder` cell on the size under test. For NVENC, stand up a second target on a
GPU droplet, in a region that has one, with a generator in the same region and VPC.

```sh
doctl compute size list --format Slug,VCPUs,Memory,PriceHourly,Regions | grep -i gpu
```

Pick a GPU **with NVENC**: NVIDIA's RTX and L-series data-centre cards (RTX 4000 Ada, RTX 6000
Ada, L40S) have hardware encoders; the H100 and H200 have none, and AMD's MI300X is not NVENC.
Record the slug and its hourly price from that listing at run time, beside the CPU size's.

1. Install the release as in [Stand it up](#stand-it-up). Then install the NVIDIA driver and the
   NVIDIA Container Toolkit on the host, and write the CDI spec rootless Podman reads:
   `nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml`, then `nvidia-ctk cdi list` must show
   `nvidia.com/gpu=all`.
2. As `commonair`, give `media` the GPU and insist on NVENC (a missing encoder then stops
   `media` from starting instead of falling back to the CPU):

   ```sh
   mkdir -p ~/.config/containers/systemd/commonair-media.container.d
   printf '[Container]\nAddDevice=nvidia.com/gpu=all\n' \
     > ~/.config/containers/systemd/commonair-media.container.d/50-gpu.conf
   echo 'TRANSCODE_HWACCEL=nvenc' >> ~/.config/commonair/commonair.env
   systemctl --user daemon-reload
   sh ~/commonair/selfhost.sh install --reinstall
   ```

   Operator drop-ins (`commonair-<unit>.container.d/`) survive `selfhost.sh` installs and
   upgrades.

3. Confirm NVENC is in use: `journalctl --user -u commonair-media | grep 'media capabilities'`
   must show `"encoder":"h264_nvenc"`; during the ladder cell, `nvidia-smi` (on the host) lists
   the ladder's ffmpeg process, and `nvidia-smi dmon -s u` shows the `enc` column above 0.
4. Run `bun harness/src/cli.ts run load-cost --set cells=idle,viewers,ladder`. On CPU the
   ladder shows as `media` cores; with NVENC whatever the pipeline still does on the CPU
   (decoding, scaling, audio) stays in `media`'s cores, and the encoder's share is in
   `nvidia-smi`.
5. **Ladders per GPU.** Without `TRANSCODE_MAX_LADDERS`, an NVENC host takes 2 ladders
   (`defaultTranscodeSlots`; each opens up to three encode sessions); a CPU host takes one per
   4 cores. To find the GPU's real limit, raise `TRANSCODE_MAX_LADDERS` on the test instance and
   run the sweep's streams axis (`load-sweep --set streamerSteps=1,2,3,4,6,8`) until a step
   breaks or `nvidia-smi` reports the encoder session limit.
6. **Cost per ladder-hour**, beside the CPU figure:
   - CPU: (ladder cores ÷ the size's vCPUs) × the size's hourly price, or the size's hourly
     price ÷ ladders per host at the 60 % threshold below.
   - GPU: the GPU droplet's hourly price ÷ ladders it carries within targets, plus the CPU cores
     its ladders still use, priced as above.

## Droplet time for one cost run

For one size under test plus the GPU cell, with one generator per target:

| Step                                                                               | Droplets                                | Wall time |
| ---------------------------------------------------------------------------------- | --------------------------------------- | --------- |
| Stand up target and generator, install, NIC ceilings                               | target + first generator (32 vCPU)      | ~40 min   |
| `load-cost` (every cell)                                                           | same                                    | ~40 min   |
| Two viewer splits (`fetchSegments`, `heartbeats`)                                  | same                                    | ~20 min   |
| Two profiled runs (`ingest`, `viewers-many`) and `perf`                            | same                                    | ~30 min   |
| GPU target: driver, toolkit, install, `idle,viewers,ladder`, a short streams sweep | GPU droplet + a generator in its region | ~1.5 h    |

That is about 2.2 hours each for the target and its generator (about 4.5 droplet-hours) and
about 1.5 hours each for the GPU droplet and its generator (3 droplet-hours): **about 7.5
droplet-hours**, plus about 4.5 for each further CPU size. The account's current size limit
(ADR 0041, "Context") has to be raised first for a 32-vCPU generator or any GPU.

## Tear down

```sh
doctl compute droplet delete --tag-name "$RUN" --force
doctl vpcs delete "$VPC" --force
doctl compute droplet list --tag-name "$RUN"     # must print nothing
```

Remove the DNS record. The accounts file and the reports stay on the generator; copy the
reports off before deleting it. Nothing else is left behind.

## Results

One row per size. Fill it from `data.sweepSummary` (and the streams-axis sweep for the stream
column). Egress is per viewer at the last passing step; CPU and NIC are p95 there. The source
column is each sweep's `source` (from `data.params` or any row): viewers axis / streams axis.

| Size (slug)               | vCPU / RAM   | Source (viewers / streams axis)             | Max viewers within targets        | Max live streams (with ladders)                                     | Broke first                                                           | Origin egress per viewer | Target CPU p95 | Target NIC tx p95 | Postgres CPU | Valkey CPU | Release      | Date         |
| ------------------------- | ------------ | ------------------------------------------- | --------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------ | -------------- | ----------------- | ------------ | ---------- | ------------ | ------------ |
| `c-4` (sfo2)              | 4 / 8 GiB    | 640x360@1200k rtmp / 1920x1080@6000k rtmp   | 100 (1 stream); 60 over 3 streams | 0 (0): one 1080p ladder with 60 viewers broke `target_cpu` (93.8 %) | `target_cpu`: at 500 viewers on 1 stream, 120 on 3, 100 on 4, 50 on 6 | 196 kB/s                 | 57 %           | 162 Mbit/s        | 2.5 %        | 1.2 %      | v0.1.0-rc.10 | 2026-11-04   |
| _example: `g-4vcpu-16gb`_ | _4 / 16 GiB_ | _640x360@1200k rtmp / 1920x1080@6000k rtmp_ | _2000 (20 streams)_               | _8 (8)_                                                             | _target_cpu at 4000_                                                  | _150 kB/s_               | _71 %_         | _310 Mbit/s_      | _9 %_        | _2 %_      | _v0.1.0_     | _2026-11-02_ |

The example row is invented to show the format; it is not a measurement.

**`c-4`, 2026-11-04 (agent track U5):** one target and four `c-4` generators in sfo2, the VPC
NIC ceiling 1870 Mbit/s each way. The 1-stream sweep also "passed" 150 and 250 viewers, but those
viewers were on the ladder's audio-only rung (fixed in `edc349e4`), so they do not count. A
`load-plan` of 1 stream × 100 viewers was judged and passed: CPU p95 53.6 %, glass-to-glass p95
3.9 s. Where the CPU went (per-container cgroup samples):

- one 1080p ladder: about 2.1 cores (`commonair-media`);
- the live moderation classifier (`moderation.scan`): about 0.2–0.25 core per live stream, even
  with no ladder. A software limit worth profiling before a size is chosen;
- Caddy and origin: about 0.5 core per 100 viewers.

CPU is spiky (mean 55 % against p95 94 %), so the p95 rule breaks first. Every streamer and
browser viewer runs on the first generator; only HTTP viewers go to the others. Keep
`browserViewers` at 2 and the stream count low on small generators, or the first generator
becomes the limit and the run is inconclusive. The account offered no 4-vCPU General Purpose
size (ADR 0032 §1).

### Cost per stream and per viewer

One row per size and release, from `load-cost`'s `data.cost`. Cores are per unit, by container,
from the cgroup counters (`containerSource: cgroup`). Write `noise` where the line was
`totalBelowNoise`, and leave a cell empty when its cost was unavailable (and say why below the
table). The four ADR 0041 targets: packaging ≤ 0.1 core per stream, moderation ≤ 0.05, caddy +
origin ≤ 0.15 per 100 viewers, and the ladder on CPU against NVENC.

| Size (slug)      | Release  | Date         | Source                 | Ingest per stream (mediamtx / media / worker / valkey = total) | Packaging per stream | Moderation per stream (capture + classifier) | Linear? (N → 2N per stream, ratio) | Per 100 viewers, 1 path (caddy / origin / api) | Per 100 viewers, S paths | One ladder (media / all; NVENC row: GPU) | Valkey per stream (rx / tx) |
| ---------------- | -------- | ------------ | ---------------------- | -------------------------------------------------------------- | -------------------- | -------------------------------------------- | ---------------------------------- | ---------------------------------------------- | ------------------------ | ---------------------------------------- | --------------------------- |
| _example: `c-8`_ | _v0.1.0_ | _2026-11-20_ | _1920x1080@6000k rtmp_ | _0.01 / 0.14 / 0.09 / 0.004 = 0.244_                           | _0.014_              | _0.23 (0.14 + 0.09)_                         | _yes (0.244 → 0.251, 1.03)_        | _0.31 / 0.18 / 0.05_                           | _0.52_                   | _2.0 / 2.1_                              | _45 / 46 kB/s_              |

The example row is invented to show the format; it is not a measurement. Before S1-i the only
figures were the `c-4` sweep's, never measured apart: about 0.2–0.25 core of moderation per
stream, 0.5 core of Caddy and origin per 100 viewers, and 2.1 cores per 1080p ladder.

## How the numbers are used

- **Launch size (L1).** The smallest size whose last passing step covers the expected launch
  peak with headroom: the peak audience at most about half of "max viewers within targets", and
  the expected concurrent streams at most half of the streams-axis result.
- **Stage 0 → 1** (Postgres CPU over 50 % at peak): the Postgres container CPU column per
  viewer, scaled to the peak, says how far that trigger is.
- **Stage 1 → 2** (app droplet CPU over 60 % at peak): the target CPU p95 per viewer at the last
  passing step, scaled to the peak.
- **Stage 2 → 3** (concurrent live streams past the per-host number): the streams-axis result is
  that per-host number; a step that broke on `target_cpu` with ladders running is the transcode
  limit.
- **Stage 3 → 4** (egress past the budget): per-viewer egress × viewer-hours a month is the
  monthly transfer; compare it with the team's pooled allowance and the $0.01 per GiB overage.
- **What broke first** says which limit to watch: `target_cpu` (CPU-bound, a CPU-Optimized size
  helps), `target_nic` (egress-bound, relays and P2P help before any size does), `stalls` or
  `latency` with headroom left on CPU and NIC (a software limit worth a profile).

### Sizing a pool from the cost table

ADR 0041 scales a pool out at **60 %** of its measured capacity (media: placed load; app: CPU
p95 for 5 minutes), so a host is sized to carry its share at 60 % of its cores, after what it
burns idle. With C vCPUs per host and the `idle` cell's cores I (all containers that pool runs):

- **Media host** (MediaMTX + media): usable = 0.6 × C − I. Streams per host
  = (usable − ladders × ladder cores) / (mediamtx + media per stream). Ladder slots are counted
  apart (ADR 0041 decision 4): on CPU at most `usable / ladder cores`, with NVENC the GPU's
  measured limit.
- **Moderation pool** (worker on the moderation queue): hosts = streams × worker per stream /
  (0.6 × C − I).
- **App pool** (caddy, origin, api): hosts = viewers / 100 × (caddy + origin + api per 100
  viewers, the `viewers-many` figure, since launch traffic spans many streams) / (0.6 × C − I).
- **Valkey**: streams × Valkey bytes per stream is the moderation frame traffic the managed node
  must carry, beside its CPU.

Worked with the pre-S1-i estimates (to be replaced by the table above), for 1,000 streams and
10,000 viewers on 8-vCPU hosts with I = 0.5 core per host: usable = 0.6 × 8 − 0.5 = 4.3 cores.

- Moderation at 0.22 core per stream: 1,000 × 0.22 / 4.3 ≈ **52 hosts** for moderation alone; at
  the 0.05 target, 1,000 × 0.05 / 4.3 ≈ 12.
- Caddy + origin at 0.5 core per 100 viewers: 100 × 0.5 / 4.3 ≈ **12 app hosts**; at the 0.15
  target, about 4.
- Ladders at 2.1 cores on CPU: 2 per host (4.3 / 2.1); a few hundred laddered streams need
  that many media hosts again, which is why the GPU figure decides the media size.

The ingest-per-stream line (mediamtx and media without moderation) is the one figure with no
estimate at all: it decides how many streams a media host places, and so the media pool.
