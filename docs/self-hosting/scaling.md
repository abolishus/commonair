<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Scaling

`selfhost.sh` installs the whole platform on one server. That server runs out of one of three
things first: network egress, CPU for the media pipeline, or disk.

## What to watch

**Egress, first.** Viewers dominate cost and capacity. One viewer at about 3 Mbit/s uses about
1.35 GB per hour, so a 1 Gbit/s port carries a few hundred concurrent viewers from the origin
alone. On an unmetered port, watch its sustained utilization (your provider's graphs, or
`sar -n DEV` from sysstat): the symptom of a full port is buffering, not a bill. On a metered
host (DigitalOcean, most clouds), watch transfer against your allowance and budget as well: the
bill arrives before the port fills.

**CPU while streamers are live.** Each live stream with enough viewers gets an adaptive ladder
(FFmpeg), and every stream is sampled for moderation. Relevant settings:

- `TRANSCODE_VIEWER_THRESHOLD` (default 50): viewers before a stream gets a ladder;
- `TRANSCODE_MAX_LADDERS`: concurrent ladders on the host (default: one per 4 CPU cores);
- `MODERATION_SAMPLE_SECONDS` (default 10): the frame-sampling interval. The governance setting
  can only make it shorter.

**Disk.** With Garage, VODs and clips live on the local disk (with an external store,
[object-storage.md](object-storage.md), they do not). Recording scratch space is
`MEDIA_WORK_DIR_MAX_BYTES` (20 GiB by default), and new recordings stop when the disk has less
than `MEDIA_WORK_DIR_MIN_FREE_BYTES` free. `selfhost.sh status` shows each volume's size.

Grafana (over an SSH tunnel, [requirements.md](requirements.md#ports)) shows the services'
metrics, logs and traces.

## The order to scale in

Scale out by role, not by buying a bigger box. The stages follow the co-op's own plan for its
instance (ADR 0025; the scaling milestone, S1):

1. **Move state off the host.** Postgres and Valkey go to their own servers, or to managed
   services, so the database stops competing with FFmpeg for CPU and memory and can fail over.
   Objects go to an external S3 store, which `selfhost.sh install --s3-*` already sets up with
   any provider ([object-storage.md](object-storage.md)). `selfhost.sh` will accept an external
   Postgres and Valkey too (S1-b), so a self-hosted instance can use the same managed products
   as ours; a managed Postgres must let a non-superuser owner create the protection triggers and
   the non-owner app role (ADR 0004).
2. **Add app servers** (API, chat, web, worker, origin, tracker) behind a load balancer.
3. **Add media servers** for more transcoding and ingest.
4. **Rely on member relays and P2P before any CDN.** Members who run a relay
   ([relays.md](relays.md)) serve viewers from their own upload bandwidth, and the WebTorrent
   P2P swarm (`P2P_ENABLED`, on by default) lets viewers share segments. Both take load off the
   origin at no cost to the co-op, so encourage relays from the start; they do not replace
   the steps above as the platform's own capacity.
5. **A CDN last**, and only as an optional burst adapter (`CDN_PROVIDER=origin-pull`). The
   platform never requires one.

Apart from the object store, steps 1 to 3 are not scripted yet: `selfhost.sh` manages one host. Doing them by hand means
running the same images with the same env file on another host, pointing `DATABASE_URL`,
`VALKEY_URL` and the internal URLs at it, and keeping the internal ports off the public
internet. Plan that work with the project before you need it.

The E6 load test (`load-plan` in the harness) measures origin egress, CPU and p95 latency for
N streamers × M viewers, and is how the thresholds for each step will be set. To measure your
own host the same way, see [the capacity runbook](../operators/capacity.md).
