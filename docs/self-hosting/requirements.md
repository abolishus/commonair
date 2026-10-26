<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Requirements

## Operating system

- **Debian 13 (trixie)** or **Fedora 42 or newer**. `selfhost.sh` refuses other distributions
  unless you pass `--unsupported-distro`, and then you are on your own.
- **Podman 5** with `catatonit`. Both distributions ship it. Run as root, `selfhost.sh` installs
  it for you (`podman catatonit uidmap passt dbus-user-session curl ca-certificates` on Debian,
  `podman catatonit passt curl` on Fedora).
- **systemd 254 or newer**, for `RestartSteps=` in the units. Both distributions have it.
- **amd64 or arm64.** Every release image is built for both.

## Hardware

| Instance                      | CPU                         | RAM   | Disk                        | Source                   |
| ----------------------------- | --------------------------- | ----- | --------------------------- | ------------------------ |
| Test or LAN instance          | 4 cores                     | 8 GB  | 60 GB SSD                   | estimate, not measured   |
| Small public instance         | 8 cores                     | 16 GB | 250 GB NVMe                 | estimate, not measured   |
| The co-op's production server | recent AMD Ryzen/Intel Core | 64 GB | 2 × NVMe in software RAID 1 | ADR 0010 (a placeholder) |

The full stack is about 20 containers. Transcoding, frame sampling and the moderation
classifier run on the CPU, so CPU is what runs out first when streamers go live. Recordings and
clips need scratch space (`MEDIA_WORK_DIR_MAX_BYTES`, 20 GiB by default), and Garage keeps every
VOD and clip on the local disk.

The E6 load test (`load-plan`: 20 streamers × 200 viewers) is how the project sizes a server.
Its results are not published yet, so every row above except the last is an estimate. The
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
| 6697 | TCP      | IRC over TLS                                            |
| 6667 | TCP      | plain IRC, if you offer it                              |
| 22   | TCP      | SSH, ideally restricted to your own addresses           |

Each public port listens on IPv6 and IPv4 (IPv4 alone on a host without IPv6). Ports 80 and
443 are held by systemd (`commonair-caddy.socket`) and handed to Caddy, so the instance sees
each HTTPS client's own address; the others go through rootless Podman's port forwarding.

Nothing else is reachable from outside the containers, except two ports on the host's
`127.0.0.1`: Garage's S3 API (3900, for the [off-host object copy](backups.md)) and Grafana
(3030). Postgres, Valkey, Prometheus, the collector and the services are reachable only inside
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
- your SMTP relay.

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

Backups go to the local Garage by default, which does not survive the loss of the server. For a
real instance, point WAL-G at an S3-compatible bucket somewhere else: DigitalOcean Spaces, Hetzner Object
Storage, a Garage node on a second host, or any other S3 service. See [backups.md](backups.md).

## Accounts and access

- Root (or `sudo`) on the server, once, for the host preparation.
- An SSH key for the `commonair` service user, which owns the instance. Rootless Podman and
  systemd user units need a real login session for that user: log in over SSH, or use
  `machinectl shell commonair@` (on Debian, `apt install systemd-container` first). `su` and
  `sudo -u` do not start a user manager.
