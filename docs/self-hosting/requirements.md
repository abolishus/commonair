<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Requirements

## Operating system

- **Debian 13 (trixie)** or **Fedora 42 or newer**. `selfhost.sh` refuses other distributions
  unless you pass `--unsupported-distro`, and then you are on your own.
- **Podman 5** with `catatonit`. Both distributions ship it. Run as root, `selfhost.sh` installs
  it for you when it or a helper is missing (`podman catatonit uidmap passt aardvark-dns nftables
  dbus-user-session curl ca-certificates rclone` on Debian, `podman catatonit passt aardvark-dns
  nftables curl rclone` on Fedora).
- **rclone**, from the distribution, only for the object backups
  ([backups.md](backups.md#objects)). `selfhost.sh` installs it with Podman; if Podman was
  already there, install it yourself (`apt-get install rclone` or `dnf install rclone`).
- **systemd 254 or newer**, for `RestartSteps=` in the units. Both distributions have it.
- **amd64 or arm64.** Every release image is built for both.

## Time synchronization

The host clock must be NTP-synchronized (ADR 0012 decision 2). Live and VOD segment timestamps
come from it, so an unsynchronized clock makes them drift. Debian and Fedora both ship a client:
enable `systemd-timesyncd` (`timedatectl set-ntp true`) or `chrony`. Check with
`timedatectl show -p NTPSynchronized --value`, which should print `yes`. `selfhost.sh` warns at
install time if it is not, and never blocks.

## Hardware

| Instance                      | CPU                         | RAM   | Disk                        | Source                   |
| ----------------------------- | --------------------------- | ----- | --------------------------- | ------------------------ |
| Test or LAN instance          | 4 cores                     | 8 GB  | 60 GB SSD                   | estimate, not measured   |
| Small public instance         | 8 cores                     | 16 GB | 250 GB NVMe                 | estimate, not measured   |
| The co-op's production server | recent AMD Ryzen/Intel Core | 64 GB | 2 × NVMe in software RAID 1 | ADR 0010 (a placeholder) |

The full stack is about 20 containers. Transcoding, frame sampling and the moderation
classifier run on the CPU, so CPU is what runs out first when streamers go live. Recordings and
clips need scratch space (`MEDIA_WORK_DIR_MAX_BYTES`, 20 GiB by default), and Garage keeps every
VOD and clip on the local disk. With an external object store
([object-storage.md](object-storage.md)), the host's disk holds no objects: size it for
Postgres, the scratch space, the images and the logs.

The E6 load test (`load-plan`: 20 streamers × 200 viewers) is how the project sizes a server.
Its results are not published yet, so every row above except the last is an estimate. They will
go into [the capacity runbook](../operators/capacity.md), which also says how to measure a host
yourself. The
production row is the minimum the co-op chose in
[ADR 0010](../decisions/0010-production-hosting.md), also before the load test.

**Bandwidth matters more than CPU.** One viewer at about 3 Mbit/s uses about 1.35 GB per hour.
Pick a host with unmetered or generous egress, and see [scaling.md](scaling.md).

## DNS

Create an **A record** for the instance's hostname (for example `stream.example.org`) that
points at the server's public IPv4 address. With the default ACME mode, do this before you
install: Caddy asks the certificate authority for a certificate as soon as it starts.

If the server has a public IPv6 address, add an **AAAA record** for it too: every public port
listens on IPv6 as well as IPv4 (`install` says whether the host has a global IPv6 address).
Without IPv6 on the server, publish no AAAA record: clients and an ACME CA that prefer IPv6
would fail to connect. Open the firewall for IPv6 as well as IPv4.

The IRC gateway uses the same hostname, with the same certificate.

## Ports

Open these inbound, in the host firewall and in any provider firewall in front of it:

| Port | Protocol | For                                                     |
| ---- | -------- | ------------------------------------------------------- |
| 80   | TCP      | ACME HTTP challenge, redirect to HTTPS                  |
| 443  | TCP      | HTTPS: the web app, API, chat, HLS, WHIP signaling      |
| 443  | UDP      | HTTP/3                                                  |
| 1935 | TCP      | RTMP ingest (OBS)                                       |
| 8189 | UDP      | WebRTC ICE for WHIP ingest (signaling itself is on 443) |
| 3478 | UDP      | STUN for P2P playback (coturn; [p2p.md](p2p.md))        |
| 6697 | TCP      | IRC over TLS                                            |
| 6667 | TCP      | plain IRC, if you offer it                              |
| 22   | TCP      | SSH, ideally restricted to your own addresses           |

Only if you turn the TURN relay on (`--turn-relay`, off by default): UDP 49160-49199
(`TURN_RELAY_PORT_MIN`-`MAX`), the relay's range. DigitalOcean's cloud firewall from the
Terraform module opens single ports only, so open the range there by hand ([p2p.md](p2p.md)).

Each public port listens on IPv6 and IPv4 (IPv4 alone on a host without IPv6). Ports 80 and
443 are held by systemd (`commonair-caddy.socket`) and handed to Caddy, and 6667 and 6697 the
same way (`commonair-irc.socket`, `commonair-ircs.socket`) to the IRC gateway, so the instance
sees each HTTPS and IRC client's own address. RTMP (1935) and WebRTC (8189/udp) go through
rootless Podman's port forwarding, so MediaMTX sees every encoder at one internal address.
coturn (3478/udp and the relay range) runs on the host network instead, because STUN must see
each viewer's own address.

Nothing else is reachable from outside the containers, except two ports on the host's
`127.0.0.1`: Garage's S3 API (3900, with Garage only, for `selfhost.sh backup --objects`, the
[off-host object copy](backups.md#objects)) and Grafana (3030). Postgres, Valkey, Prometheus, the collector and the services are reachable only inside
the instance's container network. Reach Grafana through an SSH tunnel:

```sh
ssh -L 3030:127.0.0.1:3030 commonair@stream.example.org
```

Rootless Podman cannot bind ports below 1024 by default. Run as root, `selfhost.sh` writes
`net.ipv4.ip_unprivileged_port_start=80` to `/etc/sysctl.d/90-commonair.conf` so the service
user's systemd can bind 80 and 443 (the setting covers IPv6 too).

## Outbound network

The server must reach, over HTTPS:

- the project's release page on GitHub (the bundle and `SHA256SUMS`);
- `ghcr.io` (our images), `docker.io`, `quay.io` (third-party images, all pinned by digest);
- `huggingface.co` once, for the moderation model (or pass `--model` with a verified copy);
- the ACME CA (Let's Encrypt by default);
- Sigstore's public services, if you verify signatures with cosign (recommended);
- your SMTP relay;
- an external object store and the offsite store for backups, if you use them.

To avoid the image registries, run your own mirror ([mirroring.md](mirroring.md)).

## SMTP relay

You need a real mail relay. Sign-up requires a verified email address, so nobody (you included)
can create an account until mail works. Any SMTP service with STARTTLS or TLS works. Set the
`SMTP_*` values after the install ([install.md](install.md#5-the-first-admin-account)).

Some hosting providers block outbound SMTP ports. DigitalOcean blocks 25, 465 and 587 by default
(seen on the first real install, v0.1.0-rc.1): mail times out and nothing says why. Check from the
server before you sign up, for example `timeout 5 bash -c '</dev/tcp/smtp.example.org/587'`. If
the port is blocked, use your relay's alternate port (often 2525; Resend also has 2587 for
STARTTLS and 2465 for implicit TLS; see your relay's documentation) or ask the provider to lift
the block.

## Optional: off-host object storage

Objects and backups go to the local Garage by default, which does not survive the loss of the
server. For a real instance, you need an S3-compatible bucket somewhere else: DigitalOcean
Spaces, Hetzner Object Storage, a Garage node on a second host, or any other S3 service.

- **Backups.** Point WAL-G at it, and copy the media and evidence there daily with
  `selfhost.sh backup --objects` ([backups.md](backups.md)).
- **The objects themselves**, optionally: install against an external store instead of Garage
  ([object-storage.md](object-storage.md)). Decide before the first install; an instance never
  switches store.

## Accounts and access

- Root (or `sudo`) on the server, once, for the host preparation.
- An SSH key for the `commonair` service user, which owns the instance. Rootless Podman and
  systemd user units need a real login session for that user: log in over SSH, or use
  `machinectl shell commonair@` (on Debian, `apt install systemd-container` first). `su` and
  `sudo -u` do not start a user manager.
