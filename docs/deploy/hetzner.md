<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Production on Hetzner dedicated

This guide covers the production host chosen in
[ADR 0010](../decisions/0010-production-hosting.md): one Hetzner dedicated server running a
CommonAir release with `selfhost.sh`, with backups stored off the server and a small cloud VM
for monitoring. Nothing here is Hetzner-specific code. Everything after the server's first boot
is the [self-hosting guide](../self-hosting/README.md), which is the reference; this page adds
only what is specific to Hetzner. Staging stays on Railway ([railway.md](railway.md)).

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
   - image: **Debian 13 (trixie)**. It ships Podman 5 and systemd 257, which the units need.
     Ubuntu 24.04 ships Podman 4.9 and does not qualify.
   - `SWRAID 1`, `SWRAIDLEVEL 1` across both NVMe disks.
   - a hostname of your choice.
4. Reboot into the installed system and confirm `ssh root@<server>` works.
5. In Robot, enable the server firewall with the rules in [Firewall](#firewall).

From here on, setup is one script and can be run over SSH by any operator (or an agent given a
deploy key).

## 2. Prepare the host

As root, update the system and add the packages Hetzner's image does not have:

```sh
apt-get update && apt-get full-upgrade -y
apt-get install -y unattended-upgrades nftables
```

Install cosign 3.x ([install.md](../self-hosting/install.md#1-prepare-the-server)). Point the
domain's A record at the server's IPv4 address. Do not add an AAAA record yet
([Gaps](#gaps-before-go-live)).

`selfhost.sh` does the rest of the host preparation when run as root with `--yes`: it installs
Podman, creates the `commonair` user, enables linger and allows unprivileged ports from 80.

## 3. Install the stack

Download and verify the release, then install it as root
([install.md](../self-hosting/install.md#2-download-and-verify-the-release)):

```sh
sh "commonair-selfhost_$VERSION/selfhost.sh" install --yes \
  --bundle "$PWD/commonair-selfhost_$VERSION.tar.gz" \
  --domain <your domain> --email <operator address> \
  --require-signature
```

`--domain` sets every public URL, `IRC_PUBLIC_HOST`, and the RTMP and WHIP ingest URLs. The
server's public IPv4 becomes `MTX_WEBRTCADDITIONALHOSTS` automatically: Hetzner dedicated
servers have it on their interface, so WHIP works without `--public-ip`.

Then, as `commonair`:

1. Give each operator their own SSH key in `/home/commonair/.ssh/authorized_keys`, so one can be
   revoked alone. Disable password login and root login in `sshd_config` once the `commonair`
   user works.
2. Set the real SMTP relay and review the instance contacts in
   `~/.config/commonair/commonair.env`, and apply them with
   `sh ~/commonair/selfhost.sh install --reinstall`.
3. Create the first admin account
   ([install.md](../self-hosting/install.md#5-the-first-admin-account)).

The IRC certificate follows on its own once DNS resolves and Caddy has its certificate
([tls.md](../self-hosting/tls.md#the-irc-certificate)). Upgrades go through
`selfhost.sh upgrade` ([upgrades.md](../self-hosting/upgrades.md)).

## 4. Backups off the server

Send WAL-G to Hetzner Object Storage in a location other than the server's, as described in
[backups.md](../self-hosting/backups.md#off-host-s3). The env-file entries:

```sh
AWS_ENDPOINT=https://<location>.your-objectstorage.com
AWS_REGION=<location>
AWS_ACCESS_KEY_ID=<object storage key>
AWS_SECRET_ACCESS_KEY=<object storage secret>
WALG_S3_PREFIX=s3://<bucket>/wal
```

Create the bucket and key in the Hetzner Cloud console (or with OpenTofu, see
[Infrastructure as code](#infrastructure-as-code)). Check the endpoint form and path-style
support against Hetzner's Object Storage documentation when you set it up. Apply the settings
and confirm a base backup arrives:

```sh
sh ~/commonair/selfhost.sh install --reinstall
sh ~/commonair/selfhost.sh backup
```

Before launch, **restore once onto a scratch server**
([the restore drill](../self-hosting/backups.md#the-restore-drill)) and check the data is there.
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

Allow established/related return traffic. Robot's firewall is stateless, so outbound traffic
only gets its answers if you also allow, to the ephemeral port range (32768–65535):

- inbound TCP with the ACK flag (image pulls, ACME, SMTP, the release download);
- inbound UDP and TCP from source port 53 (DNS answers; without them nothing resolves, so every
  flow above fails);
- inbound UDP from source port 123, if the server syncs time over NTP.

Everything else (Postgres, Valkey, Garage, Grafana)
stays on `127.0.0.1`; reach Grafana through an SSH tunnel
(`ssh -L 3030:127.0.0.1:3030 commonair@<server>`).

## Infrastructure as code

Hetzner Cloud resources (the monitoring VM, Cloud firewalls, Object Storage buckets, DNS zones
if hosted there) belong in OpenTofu with the `hetznercloud/hcloud` provider, under `infra/` next
to the Railway definition. Verify the provider's license at the pinned version (ADR 0002) when
adding it. The API token is `HCLOUD_TOKEN` in the operator's shell or password manager, never
in git. The dedicated server itself is ordered in Robot (step 1); everything after its first boot
is `scripts/selfhost.sh`.

## Operating it

- **Deploys**: tagged releases through `selfhost.sh upgrade`, not hand edits on the server
  (ADR 0023 replaced the `podman auto-update` plan of ADR 0010, because it cannot order
  migrations). Changes to units or config go through the repository and a release.
- **Status, logs and metrics**: `selfhost.sh status`, `journalctl --user -u commonair-<service>`,
  and Grafana over the SSH tunnel ([troubleshooting.md](../self-hosting/troubleshooting.md)).
- **Abuse reports**: Hetzner forwards abuse and copyright complaints to the account's abuse
  contact and expects an answer, usually within 24 hours. Route them into the trust-safety
  process ([operators/trust-safety.md](../operators/trust-safety.md)); a missed deadline can get
  the server's IP blocked.
- **Disk failure**: Hetzner replaces a failed disk on request. Check `cat /proc/mdstat` after any
  hardware alert and let the RAID resync.
- **Capacity**: watch the network port's utilization. Near 1 Gbit/s sustained, scale out in
  the order of ADR 0010 §3: Postgres and Valkey to their own server, then origin/media servers,
  with member relays and P2P before any CDN ([scaling.md](../self-hosting/scaling.md)).

## Gaps before go-live

Closed: public binds for RTMP, ICE and IRC; WHIP through Caddy; the ICE public address; the
daily base backup and IRC certificate timers; signed releases and the one-command install and
upgrade (`selfhost.sh`, Phase 5). Still open:

- Public ports bind IPv4 (`0.0.0.0`) only. IPv6 viewers and encoders need `[::]` binds before
  the domain gets an AAAA record.
- IRC over WebSocket (6680, what tmi.js uses) stays on `127.0.0.1`. tmi.js connects to `/` on
  its own hostname, so it needs a separate Caddy site, not a path on the main one.
- Rootless port forwarding hides client addresses, so per-address limits count all clients as
  one and `X-Forwarded-For` from clients is trusted. Source-address preservation is needed
  before launch ([known limitations](../self-hosting/README.md#known-limitations)).
- Objects in Garage (VODs, clips, evidence) are not backed up automatically; backups.md has
  an rclone recipe ([backups](../self-hosting/backups.md#objects-in-garage)).
