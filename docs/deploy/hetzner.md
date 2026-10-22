<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Production on Hetzner dedicated

This guide covers the production host chosen in
[ADR 0010](../decisions/0010-production-hosting.md): one Hetzner dedicated server running the
Quadlet units from `infra/quadlet`, with backups stored off the server and a small cloud VM for
monitoring. Nothing here is Hetzner-specific code. The same steps work on any dedicated Linux
server, and [infra/README.md](../../infra/README.md#production-quadlet) remains the reference
for the units themselves. Staging stays on Railway ([railway.md](railway.md)).

The region is still open (ADR 0010). Pick it before ordering.

## What runs where

| Where                                  | What                                                                                              | Why                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Dedicated server (AX/EX class)         | every unit in `infra/quadlet`: Postgres, Valkey, Garage, MediaMTX, services, Caddy, observability | unmetered 1 Gbit/s port, local NVMe, cores for FFmpeg |
| Hetzner Object Storage, other location | WAL-G base backups and WAL (`WALG_S3_PREFIX`)                                                     | a backup on the same server is not a backup           |
| Small Hetzner Cloud VM, other location | uptime checks, status page                                                                        | monitoring must outlive the server it watches         |

Minimum server: 64 GB RAM, two NVMe disks in software RAID 1, a recent AMD Ryzen or Intel
Core CPU. The E6 load test sets the real size.

## 1. Order and install the server (operator, once)

Hetzner's Robot console has no infrastructure-as-code path for ordering, so this step is manual.

1. Open a Hetzner account early. Account verification can take days.
2. Order the server in Robot and add your SSH public key during ordering, so the rescue
   system accepts it.
3. Boot the rescue system and run `installimage`:
   - image: **Debian 13 (trixie)**. It ships Podman 5, which the units need for
     `Notify=healthy`. Ubuntu 24.04 ships Podman 4.9 and does not qualify.
   - `SWRAID 1`, `SWRAIDLEVEL 1` across both NVMe disks.
   - a hostname of your choice.
4. Reboot into the installed system and confirm `ssh root@<server>` works.
5. In Robot, enable the server firewall with the rules in [Firewall](#firewall).

From here on, setup is scripted and can be run over SSH by any operator (or an agent given a
deploy key).

## 2. Prepare the host

As root:

```sh
apt update && apt full-upgrade -y
apt install -y podman git unattended-upgrades nftables
adduser --disabled-password --gecos "" commonair
loginctl enable-linger commonair                       # user units keep running after logout
echo 'net.ipv4.ip_unprivileged_port_start=80' > /etc/sysctl.d/90-commonair.conf
sysctl --system                                        # rootless Caddy may bind 80/443
```

Add each operator's SSH key to `/home/commonair/.ssh/authorized_keys`. Use a separate key per
person or agent, so one can be revoked alone. Disable password login and root login in
`sshd_config` once the `commonair` user works.

Install Bun for the `commonair` user (the setup scripts use it), at the version pinned in the
root `package.json` (`devEngines.packageManager`).

## 3. Install the stack

As `commonair`, follow [infra/README.md → Production: Quadlet](../../infra/README.md#production-quadlet):
clone the repository to `~/commonair`, generate `~/.config/commonair/commonair.env` with
`bun scripts/init-env.ts --out …`, create the podman secrets, copy the units and start them.

Production values in the env file:

| Variable                                              | Value                                                    |
| ----------------------------------------------------- | -------------------------------------------------------- |
| `PUBLIC_HOSTNAME`                                     | your domain; its A/AAAA records point at the server      |
| `PUBLIC_URL`, `API_PUBLIC_URL`, `PLAYBACK_PUBLIC_URL` | `https://<host>`                                         |
| `CHAT_PUBLIC_URL` / `P2P_TRACKER_URL`                 | `wss://<host>/chat` / `wss://<host>/tracker`             |
| `POSTGRES_PASSWORD`                                   | a real secret (the default is dev only)                  |
| `SMTP_*`                                              | a real mail relay; Mailpit has no production unit        |
| `S3_PUBLIC_ENDPOINT`                                  | Garage on its own hostname (path-style SigV4, see infra) |
| `INGEST_RTMP_PUBLIC_URL`                              | `rtmp://<host>/live`                                     |
| `INGEST_WHIP_PUBLIC_URL`                              | `https://<host>/live` (Caddy routes WHIP to MediaMTX)    |
| `MTX_WEBRTCADDITIONALHOSTS`                           | the server's public IPv4 (and IPv6), comma-separated     |
| `IRC_PUBLIC_HOST`                                     | the same as `PUBLIC_HOSTNAME` (see [IRC TLS](#irc-tls))  |
| `NODE_ENV`                                            | `production`                                             |

`MTX_WEBRTCADDITIONALHOSTS` is read by MediaMTX itself, not by the platform, so it is not in
`.env.example`. Without it, MediaMTX offers only the container's internal address as an ICE
candidate and WHIP from remote encoders fails after signaling succeeds.

Install the timers next to the Quadlet units (they are plain systemd user units, which Quadlet
does not generate):

```sh
mkdir -p ~/.config/systemd/user && cp ~/commonair/infra/systemd/* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now commonair-backup.timer commonair-irc-cert.timer
```

`commonair-backup.timer` takes a WAL-G base backup daily at 03:00 UTC. It never starts
Postgres, so it cannot interfere with a restore.

### IRC TLS

IRC refuses to start in production without a certificate. `commonair-irc-cert.service` copies
Caddy's certificate for `IRC_PUBLIC_HOST` into `~/.config/commonair/irc-tls`, which the IRC unit
mounts, and restarts IRC when Caddy has renewed it. Caddy only holds certificates for its own
sites, so `IRC_PUBLIC_HOST` must equal `PUBLIC_HOSTNAME`. On first install, start Caddy, wait
until it has its certificate, then run the sync once before IRC can start:

```sh
systemctl --user start commonair-irc-cert.service
```

Images: until the Phase 5 release pipeline publishes signed images, build them on the server
(`IMAGE_TAG=latest podman compose build`). Afterwards, pull the released tag and let
`podman auto-update` roll it out.

## 4. Backups off the server

WAL-G reads `AWS_*` before the platform's `S3_*` settings (`infra/postgres/walg-env.sh`), so
pointing it at Hetzner Object Storage takes only env file entries, without touching the
buckets the services use:

```sh
AWS_ENDPOINT=https://<location>.your-objectstorage.com    # a location other than the server's
AWS_REGION=<location>
AWS_ACCESS_KEY_ID=<object storage key>
AWS_SECRET_ACCESS_KEY=<object storage secret>
WALG_S3_PREFIX=s3://<bucket>/wal
```

Create the bucket and key in the Hetzner Cloud console (or with OpenTofu, see
[Infrastructure as code](#infrastructure-as-code)). Check the endpoint form and path-style
support against Hetzner's Object Storage documentation when you set it up. Then confirm WAL is
arriving:

```sh
podman exec commonair-postgres commonair-backup
podman exec commonair-postgres wal-g backup-list
```

Before launch, **restore once onto a scratch server** with `commonair-restore`
([infra/README.md → Backups](../../infra/README.md#backups-wal-g)) and check the data is there.
An untested backup does not count (ADR 0010).

## Firewall

Use Robot's stateless firewall as the outer layer and nftables on the host as the inner one.
Allow inbound:

| Port    | Protocol | For                                             |
| ------- | -------- | ----------------------------------------------- |
| 22      | TCP      | SSH (restrict to operator addresses if you can) |
| 80, 443 | TCP      | Caddy: ACME, HTTPS                              |
| 443     | UDP      | HTTP/3                                          |
| 1935    | TCP      | RTMP ingest                                     |
| 8189    | UDP      | WebRTC ICE (WHIP signaling itself is on 443)    |
| 6697    | TCP      | IRC over TLS                                    |
| 6667    | TCP      | plain IRC, if you offer it                      |

Allow established/related return traffic. Everything else (Postgres, Valkey, Garage, Grafana)
stays on `127.0.0.1`; reach Grafana through an SSH tunnel
(`ssh -L 3030:127.0.0.1:3030 commonair@<server>`).

## Infrastructure as code

Hetzner Cloud resources (the monitoring VM, Cloud firewalls, Object Storage buckets, DNS zones
if hosted there) belong in OpenTofu with the `hetznercloud/hcloud` provider, under `infra/` next
to the Railway definition. Verify the provider's license at the pinned version (ADR 0002) when
adding it. The API token is `HCLOUD_TOKEN` in the operator's shell or password manager, never
in git. The dedicated server itself is ordered in Robot (step 1); everything after its first boot
is `scripts/selfhost.sh` (PLAN Phase 5).

## Operating it

- **Deploys**: through the release pipeline and `podman auto-update`, not hand edits on the
  server. Changes to units or config go through the repository.
- **Logs and metrics**: `journalctl --user -u commonair-<service>`, `podman logs`, and Grafana
  over the SSH tunnel.
- **Abuse reports**: Hetzner forwards abuse and copyright complaints to the account's abuse
  contact and expects an answer, usually within 24 hours. Route them into the trust-safety
  process ([operators/trust-safety.md](../operators/trust-safety.md)); a missed deadline can get
  the server's IP blocked.
- **Disk failure**: Hetzner replaces a failed disk on request. Check `cat /proc/mdstat` after any
  hardware alert and let the RAID resync.
- **Capacity**: watch the network port's utilization. Near 1 Gbit/s sustained, add an
  origin/media server or more member relays before anything else (ADR 0010).

## Gaps before go-live

Closed: public binds for RTMP, ICE and IRC; WHIP through Caddy; the ICE public address; the
daily base backup and IRC certificate timers. Still open:

- Public ports bind IPv4 (`0.0.0.0`) only, like Caddy's. IPv6 viewers and encoders need
  `[::]` binds added once the server has an IPv6 address in DNS.
- IRC over WebSocket (6680, what tmi.js uses) stays on `127.0.0.1`. tmi.js connects to `/` on
  its own hostname, so it needs a separate Caddy site, not a path on the main one.
- `scripts/selfhost.sh`, the release pipeline and the operator guide are PLAN Phase 5 and not
  written yet. Until then, steps 2–4 are run by hand.
