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
load up until a target breaks, and `load-plan` runs one fixed size. Both sample the target over
SSH (whole-host CPU, memory, load and NIC bytes from `/proc`, per-container CPU from `podman
stats`) and the generator machines the same way, and call a run **inconclusive** when the
generator was the limit, so a generator limit is never reported as the target's.

## Before you start: one address, one rate-limit bucket

Read this first; it decides how many generator machines a run needs.

**Viewers do not sign up.** An HTTP viewer starts an anonymous playback session
(`POST /api/channels/{channel}/playback`, `services/api/src/routes/playback.ts` `playback.start`),
heartbeats every 10 s (`playback.heartbeat`) and fetches HLS from the origin. No account, no
`auth` bucket hit.

**But playback calls share the per-address `default` bucket.** The playback procedures declare no
rate-limit bucket in the contract (`packages/contracts/src/api/router.ts`, `playback.start`,
`heartbeat`, `end`), so `services/api/src/lib/orpc.ts` charges them to `default`: 120 calls a
minute per client address for anonymous callers (`DEFAULT_RATE_LIMITS`,
`services/api/src/lib/ratelimit.ts`). Caddy trusts no forwarded header (`infra/caddy/Caddyfile`),
so every simulated viewer on one generator is one address. At 6 heartbeats a minute that is
**about 20 steady viewers per generator address**; past it, starts fail with 429 and heartbeats
fail, playback tokens (120 s, `PLAYBACK_TOKEN_TTL_SECONDS`) stop being refreshed, and segment
fetches start failing about two minutes in. IPv6 does not help: limits apply per /64
(`rateLimitSubjectIp`), and a droplet's addresses share one.

Real audiences behind one address (carrier-grade NAT, a campus, a household) meet the same wall,
so this is reported to the maintainers as a contract request (per-session limits for heartbeat
and end, a playback bucket for start). Until it lands, a sweep from one generator measures the
rate limiter past about 20 viewers, not the host. The harness reports failed heartbeats per step
(`heartbeatErrors` in each sweep row, metric `heartbeat.errors`); a step with more than
`maxHeartbeatErrors` failed heartbeats (default 0) is judged inconclusive, in `load-sweep` and in
`load-plan` against a remote target, because it is not a capacity number. The test instance must not raise the limits: there is no env override,
and the instance under test is an unmodified release.

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
apt-get update && apt-get install -y git ffmpeg podman iperf3

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
bunx playwright install --with-deps chromium webkit

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

**Read the outcome from the report, not the scenario status.** The harness has no
"inconclusive" scenario status yet, so an inconclusive run shows as passed. Before using any
number, check the outcome in the report: `data.verdict.outcome` for `load-plan` (`judged` or
`inconclusive`, with `limits` and `invalid` saying why) and `data.sweepSummary.outcome` for
`load-sweep` (`completed`, `break` or `inconclusive`; each row's `status`, `generatorLimits` and
`invalidReasons` say which step and why). The metric `load.inconclusive` or
`sweep.inconclusive` is 1 in the same case. An inconclusive run is not a capacity number.

The sweep stops at the first step that breaks a target or where a generator was the limit. Its
report (`$HARNESS_REPORT_DIR`) holds `data.sweep` (one row per step: streams, the source shape
they sent, viewers, status, what broke, why a step was invalid, ladders, latency, TTFF, stalls, errors, heartbeat errors, target CPU p95 and NIC,
per-viewer egress, Postgres and Valkey CPU, generator CPU) and `data.sweepSummary` (the last
passing step, the first failing one and why, per-viewer egress and CPU at the last passing
step). Each step's full measurements are under `data["sweep step N"]` (`target`, `containers`,
`generators`, `verdict`).

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

| Size (slug)               | vCPU / RAM   | Source (viewers / streams axis)             | Max viewers within targets | Max live streams (with ladders) | Broke first          | Origin egress per viewer | Target CPU p95 | Target NIC tx p95 | Postgres CPU | Valkey CPU | Release  | Date         |
| ------------------------- | ------------ | ------------------------------------------- | -------------------------- | ------------------------------- | -------------------- | ------------------------ | -------------- | ----------------- | ------------ | ---------- | -------- | ------------ |
| _example: `g-4vcpu-16gb`_ | _4 / 16 GiB_ | _640x360@1200k rtmp / 1920x1080@6000k rtmp_ | _2000 (20 streams)_        | _8 (8)_                         | _target_cpu at 4000_ | _150 kB/s_               | _71 %_         | _310 Mbit/s_      | _9 %_        | _2 %_      | _v0.1.0_ | _2026-11-02_ |

The example row is invented to show the format; it is not a measurement.

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
