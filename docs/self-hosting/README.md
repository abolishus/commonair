<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Self-hosting CommonAir

This guide takes you from a fresh Linux server to a running CommonAir instance. You need no
Bun, Node or git on the server, and no proprietary service: payments default to a manual
adapter, storage to Garage, and OAuth sign-in is optional.

## What you get

One command, `selfhost.sh install`, sets up the whole platform on one host:

- the web app, API, chat, the Twitch-compatible IRC gateway, the HLS origin, the media pipeline,
  the background worker and the P2P tracker;
- Postgres with continuous WAL-G archiving and a daily base backup;
- Valkey, Garage (S3 object storage) and MediaMTX (RTMP and WHIP ingest);
- Caddy for HTTPS, with Let's Encrypt certificates or its own internal CA;
- Prometheus, Loki, Tempo and Grafana for metrics, logs and traces.

Everything runs as rootless Podman containers under systemd user units (Quadlet). Every image
is pinned by digest and signed. Upgrades are ordered (backup, migrations, then services) and
roll back on their own when the new release does not become healthy.

## The 10-minute path

1. Check the [requirements](requirements.md): Debian 13 or Fedora 42+, a domain whose A record
   points at the server, the public ports open, and an SMTP relay.
2. Download the release bundle and verify it ([install.md](install.md#2-download-and-verify-the-release)).
3. Run one command as root:

   ```sh
   sh commonair-selfhost_0.1.0-rc.1/selfhost.sh install --yes \
     --bundle "$PWD/commonair-selfhost_0.1.0-rc.1.tar.gz" \
     --domain stream.example.org --email ops@example.org
   ```

4. Set the SMTP values, sign up, and make yourself an admin
   ([install.md](install.md#5-the-first-admin-account)).
5. Stream to it from OBS ([install.md](install.md#6-first-stream)).

Replace `0.1.0-rc.1` with the latest version on the project's releases page.

## Pages

| Page                                     | What it covers                                                      |
| ---------------------------------------- | ------------------------------------------------------------------- |
| [requirements.md](requirements.md)       | Distributions, Podman, hardware, DNS, ports, mail, off-host storage |
| [install.md](install.md)                 | Download, verify, install, first admin, first stream                |
| [configuration.md](configuration.md)     | Every environment variable, and how to change one                   |
| [tls.md](tls.md)                         | ACME certificates, the internal CA, the IRC certificate             |
| [upgrades.md](upgrades.md)               | `selfhost.sh upgrade`, rollback, pinning a version                  |
| [backups.md](backups.md)                 | WAL-G, off-host storage, restore, the restore drill                 |
| [scaling.md](scaling.md)                 | What to watch and what to split off first                           |
| [relays.md](relays.md)                   | Running a member relay                                              |
| [verifying.md](verifying.md)             | Checking signatures, SBOMs and provenance yourself                  |
| [mirroring.md](mirroring.md)             | Copying a release into your own registry                            |
| [troubleshooting.md](troubleshooting.md) | Status, logs, common failures                                       |

## Known limitations

These are true of the current release. Each one is tracked for a later release.

- **One host only.** `selfhost.sh` installs everything on one server. Splitting Postgres or
  media onto other servers is not scripted yet ([scaling.md](scaling.md)).
- **A service holds its own secrets.** Each unit gets only its keys of `commonair.env`
  ([configuration.md](configuration.md#which-unit-sees-which-key)): Caddy gets none, but a
  compromised api or worker still holds the database password and S3 keys it needs.
- **IRC and RTMP clients share one address.** HTTPS (the web app, API, chat, HLS, the
  tracker and WHIP signaling) sees each client's own address, IPv6 included: systemd holds
  ports 80 and 443 and hands them to Caddy. IRC (6667, 6697) and MediaMTX (RTMP 1935, WebRTC
  8189/udp) still go through rootless Podman's port forwarding, so every IRC client appears to
  come from one internal address and IRC's per-address limits count them together. See
  [troubleshooting.md](troubleshooting.md#irc-clients-are-refused).
- **Two local services listen on the host's loopback.** Garage (`127.0.0.1:3900`, for the
  off-host object copy; every request needs an S3 key) and Grafana (`127.0.0.1:3030`, behind its
  admin login). Nothing else is reachable from the host, and Valkey requires a password.
- **Unit edits do not survive.** `install` and `upgrade` replace every `commonair*` file in
  `~/.config/containers/systemd/`, and a drop-in directory there (for example
  `commonair-media.container.d/` for a GPU) makes them fail. There is no supported way to
  customize a unit yet.
- **Objects are not backed up.** WAL-G backs up Postgres. Media, clips, VODs, exports and sealed
  evidence in Garage are not backed up by `selfhost.sh` ([backups.md](backups.md#what-is-not-backed-up)).
- **An optional service in a crash loop can hold back the others.** App units start `After=`
  the OpenTelemetry collector, so a collector that never gets healthy delays their start.
