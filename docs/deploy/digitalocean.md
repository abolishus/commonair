<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Staging and production on DigitalOcean

This guide covers the co-op's own hosts, chosen in
[ADR 0025](../decisions/0025-hosting-on-digitalocean.md): DigitalOcean droplets running a
CommonAir release with `selfhost.sh`, backups in Spaces in another region, and a small droplet
elsewhere for monitoring. Nothing here is DigitalOcean-specific code. Everything after the
droplet's first boot is the [self-hosting guide](../self-hosting/README.md), which is the
reference; this page adds only what is specific to DigitalOcean.

Staging and production are the same install from the same signed releases. Staging gets every
release candidate first, through `selfhost.sh upgrade`.

## What runs where

| Where                           | What                                                                                              | Why                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Droplet, dedicated vCPUs (prod) | every unit in `infra/quadlet`: Postgres, Valkey, Garage, MediaMTX, services, Caddy, observability | cores for FFmpeg and the classifier, public UDP for WebRTC |
| Droplet, shared vCPUs (staging) | the same units                                                                                    | tests what production runs, at staging cost                |
| Spaces bucket, another region   | WAL-G base backups and WAL (`WALG_S3_PREFIX`); object backups                                     | a backup on the same droplet, or region, is not a backup   |
| Small droplet, another region   | uptime checks, status page                                                                        | monitoring must outlive the droplet it watches             |
| Block storage volume, if needed | media work space (`MEDIA_WORK_DIR_*`) when the boot disk is too small                             | VOD recording scratch space grows with live streams        |

Production uses General Purpose or CPU-Optimized droplets: shared-CPU droplets showed more tail
latency under load. The S1-a load test sets the size
([S1](../../.claude/briefs/next/S1-scaling.md)). The region is still open (ADR 0025).

Staging today is `commonair-rc-test` (`staging-stream.abolish.us`, Debian 13, 4 shared vCPU,
8 GB), the host that ran v0.1.0-rc.1 and the upgrade to rc.2. It is recreated from OpenTofu once
those definitions exist.

## 1. Create the droplet (operator, once per host)

1. Create a droplet from the **Debian 13 (trixie)** image with IPv6 enabled and your SSH key
   added. Debian 13 ships Podman 5 and systemd 257, which the units need; Ubuntu 24.04 ships
   Podman 4.9 and does not qualify.
2. Attach a [cloud firewall](#firewall) before the first install.
3. Point the domain's A and AAAA records at the droplet. With Cloudflare, use **DNS only**
   records (grey cloud): Caddy needs real client addresses, and RTMP, IRC and WebRTC are not HTTP.
4. Confirm `ssh root@<droplet>` works.

`doctl`, the DigitalOcean MCP server and OpenTofu can each do these steps. The API token is the
operator's, scoped to what the task needs, and stays in the operator's shell or password
manager, never in git or in an agent's context (ADR 0025 decision 5).

## 2. Prepare the host

As root, update the system and add what the image lacks:

```sh
apt-get update && apt-get full-upgrade -y && reboot
apt-get install -y unattended-upgrades nftables systemd-container
```

`systemd-container` provides `machinectl`, for a login session as `commonair` without SSH
([requirements.md](../self-hosting/requirements.md#accounts-and-access)). Install cosign 3.x
([install.md](../self-hosting/install.md#1-prepare-the-server)).

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
droplet's public addresses are on its interface, so `MTX_WEBRTCADDITIONALHOSTS` is filled in
without `--public-ip`; check it in `~/.config/commonair/commonair.env` after the install.

Then, as `commonair`:

1. Give each operator their own SSH key in `/home/commonair/.ssh/authorized_keys`, so one can be
   revoked alone. Disable password login and root login in `sshd_config` once the `commonair`
   user works.
2. Set the SMTP relay and review the instance contacts in `~/.config/commonair/commonair.env`,
   and apply them with `sh ~/commonair/selfhost.sh install --reinstall`. **DigitalOcean blocks
   outbound 25, 465 and 587** on new accounts: use the relay's alternate port (Resend: 2587 with
   STARTTLS), as staging does ([requirements.md](../self-hosting/requirements.md#smtp-relay)).
3. Create the first admin account
   ([install.md](../self-hosting/install.md#5-the-first-admin-account)).

The IRC certificate follows on its own once DNS resolves and Caddy has its certificate
([tls.md](../self-hosting/tls.md#the-irc-certificate)). Upgrades go through
`selfhost.sh upgrade` ([upgrades.md](../self-hosting/upgrades.md)).

## 4. Backups off the droplet

Send WAL-G to a Spaces bucket in a region other than the droplet's, as described in
[backups.md](../self-hosting/backups.md#off-host-s3). The env-file entries:

```sh
AWS_ENDPOINT=https://<region>.digitaloceanspaces.com
AWS_REGION=<region>
AWS_ACCESS_KEY_ID=<Spaces access key>
AWS_SECRET_ACCESS_KEY=<Spaces secret key>
WALG_S3_PREFIX=s3://<bucket>/wal
```

Create the bucket and a key limited to it in the control panel (or with OpenTofu, see
[Infrastructure as code](#infrastructure-as-code)). Leave the Spaces CDN off: backups are not
public. Apply the settings and confirm a base backup arrives:

```sh
sh ~/commonair/selfhost.sh install --reinstall
sh ~/commonair/selfhost.sh backup
```

Before launch, **restore once onto a second droplet**
([the restore drill](../self-hosting/backups.md#the-restore-drill)), check the data is there,
and record how long it took: that time is the recovery target at launch. An untested backup does
not count (ADR 0025, keeping ADR 0010's rule).

## Firewall

Use a DigitalOcean cloud firewall as the outer layer and nftables on the host as the inner one.
Cloud firewalls are stateful, so return traffic for outbound connections needs no rules. Allow
inbound, over IPv4 and IPv6:

| Port    | Protocol | For                                             |
| ------- | -------- | ----------------------------------------------- |
| 22      | TCP      | SSH (restrict to operator addresses if you can) |
| 80, 443 | TCP      | Caddy: ACME, HTTPS                              |
| 443     | UDP      | HTTP/3                                          |
| 1935    | TCP      | RTMP ingest                                     |
| 8189    | UDP      | WebRTC ICE (WHIP signaling itself is on 443)    |
| 6697    | TCP      | IRC over TLS                                    |
| 6667    | TCP      | plain IRC, if you offer it                      |

Everything else (Postgres, Valkey, Garage, Grafana) stays on `127.0.0.1`; reach Grafana through
an SSH tunnel (`ssh -L 3030:127.0.0.1:3030 commonair@<droplet>`).

## Infrastructure as code

Droplets, cloud firewalls, volumes, Spaces buckets and reserved IPs belong in OpenTofu with the
`digitalocean/digitalocean` provider (MPL-2.0; verify at the pinned version per ADR 0002 and vet
it per ADR 0022), under `infra/tofu/digitalocean/` (S1-g). DNS stays where the domain is. The
token is `DIGITALOCEAN_TOKEN` in the operator's shell, never in git. Everything after a
droplet's first boot is `scripts/selfhost.sh`.

## Operating it

- **Deploys**: tagged releases through `selfhost.sh upgrade`, staging first, not hand edits on
  the droplet. Changes to units or config go through the repository and a release.
- **Status, logs and metrics**: `selfhost.sh status`, `journalctl --user -u commonair-<service>`,
  and Grafana over the SSH tunnel ([troubleshooting.md](../self-hosting/troubleshooting.md)).
- **Abuse reports**: DigitalOcean sends abuse and copyright complaints to the account and expects
  a response. Route them into the trust-safety process
  ([operators/trust-safety.md](../operators/trust-safety.md)).
- **Egress is metered**: each droplet adds to a transfer allowance pooled across the account, and
  traffic beyond it is billed per GiB. Watch the account's transfer use against the budget, not
  only the droplet's network graph. Member relays and P2P take viewers off the origin
  ([scaling.md](../self-hosting/scaling.md)).
- **Capacity**: scale out in the stages of S1, each started by its trigger
  ([scaling.md](../self-hosting/scaling.md#the-order-to-scale-in)).

## Gaps before go-live

Closed: public binds for RTMP, ICE and IRC over IPv4 and IPv6; WHIP through Caddy; the ICE
public address; real client addresses for HTTP (proved over the internet on the rc droplet);
the daily base backup and IRC certificate timers; signed releases and the one-command install
and upgrade. Still open:

- IRC and MediaMTX (RTMP, ICE) still see one client address under rootless Podman; IRC's fix is
  socket activation (R0-a), MediaMTX has none ([infra/README.md](../../infra/README.md)).
- IRC over WebSocket (6680, what tmi.js uses) stays on `127.0.0.1`. tmi.js connects to `/` on
  its own hostname, so it needs a separate Caddy site, not a path on the main one.
- Objects in Garage (VODs, clips, evidence) are not backed up automatically; backups.md has
  an rclone recipe ([backups](../self-hosting/backups.md#objects-in-garage)), and R0-c scripts it.
- The restore onto a second droplet has not been run yet (R0).
