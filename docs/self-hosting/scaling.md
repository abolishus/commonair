<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Scaling

`selfhost.sh` installs the whole platform on one server. That server runs out of one of three
things first: network egress, CPU for the media pipeline, or disk.

## What to watch

**Port utilization, first.** Viewers dominate cost and capacity. One viewer at about 3 Mbit/s
uses about 1.35 GB per hour, so a 1 Gbit/s port carries a few hundred concurrent viewers from
the origin alone. Watch the sustained utilization of the server's network port (your
provider's graphs, or `sar -n DEV` from sysstat). Near the port's capacity, add capacity as
described below. Do not wait for a bill: on an unmetered port, the symptom is buffering.

**CPU while streamers are live.** Each live stream with enough viewers gets an adaptive ladder
(FFmpeg), and every stream is sampled for moderation. Relevant settings:

- `TRANSCODE_VIEWER_THRESHOLD` (default 50): viewers before a stream gets a ladder;
- `TRANSCODE_MAX_LADDERS`: concurrent ladders on the host (default: one per 4 CPU cores);
- `MODERATION_SAMPLE_SECONDS` (default 10): the frame-sampling interval. The governance setting
  can only make it shorter.

**Disk.** VODs and clips live in Garage on the local disk. Recording scratch space is
`MEDIA_WORK_DIR_MAX_BYTES` (20 GiB by default), and new recordings stop when the disk has less
than `MEDIA_WORK_DIR_MIN_FREE_BYTES` free. `selfhost.sh status` shows each volume's size.

Grafana (over an SSH tunnel, [requirements.md](requirements.md#ports)) shows the services'
metrics, logs and traces.

## The order to scale in

[ADR 0010](../decisions/0010-production-hosting.md) sets the order. Scale out by role, not by
buying a bigger box:

1. **Member relays and P2P before anything else.** Members who run a relay
   ([relays.md](relays.md)) serve viewers from their own upload bandwidth, and the WebTorrent
   P2P swarm (`P2P_ENABLED`, on by default) lets viewers share segments. Both take load off the
   origin at no cost to the co-op.
2. **Move Postgres and Valkey to their own server**, so the database stops competing with
   FFmpeg for CPU and memory.
3. **Add origin and media servers** for more egress and more transcoding.
4. **A CDN last**, and only as an optional burst adapter (`CDN_PROVIDER=origin-pull`). The
   platform never requires one.

Steps 2 and 3 are not scripted yet: `selfhost.sh` manages one host. Doing them by hand means
running the same images with the same env file on another host, pointing `DATABASE_URL`,
`VALKEY_URL` and the internal URLs at it, and keeping the internal ports off the public
internet. Plan that work with the project before you need it.

The E6 load test (`load-plan` in the harness) measures origin egress, CPU and p95 latency for
N streamers × M viewers, and is how the thresholds for each step will be set.
