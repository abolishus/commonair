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
- Valkey, MediaMTX (RTMP and WHIP ingest) and object storage: Garage on the same host, or an
  S3-compatible store of yours ([object-storage.md](object-storage.md));
- Caddy for HTTPS, with Let's Encrypt certificates or its own internal CA;
- Prometheus, Loki, Tempo and Grafana for metrics, logs and traces.

Everything runs as rootless Podman containers under systemd user units (Quadlet). Every image
is pinned by digest and signed. Upgrades are ordered (backup, migrations, then services) and
roll back on their own when the new release does not become healthy.

## Reading path

Read the pages in this order. Each step says what "done" looks like before you go on.

1. [requirements.md](requirements.md): a Debian 13 or Fedora 42+ server, its A (and AAAA)
   record, the public ports open, an SMTP relay that the server can reach. **Done:** `dig +short
   stream.example.org` from another network returns the server's address, and the SMTP port
   answers from the server.
2. [install.md](install.md): download, verify, install, mail, the first admin, the first stream.
   Decide on the object store before you start (step 3 below). **Done:** `selfhost.sh status`
   shows every long-running unit `active running healthy`, you are signed in as an admin, and a
   test stream plays in the browser.
3. [configuration.md](configuration.md): the env file, how to change a value, which unit sees
   which key. **Done:** your contacts, `INSTANCE_NAME` and mail settings are what you want, and
   you keep an offline copy of `commonair.env`.
4. [object-storage.md](object-storage.md), **only for an external S3 store**. The choice is made
   at the first install and never changes, so read it before step 2 if you want one. **Done:**
   `status` shows `storage: external S3 at …`, lists every bucket, and does not say `the store
   is NOT ready`.
5. [backups.md](backups.md): WAL-G off the server, the daily object copy, a restore drill.
   **Done:** `status` shows `last backup: … (success)` and `last object backup:` with a time, the
   backups are on another server or region, and one restore drill has worked.
6. [upgrades.md](upgrades.md): `selfhost.sh upgrade`, rollback, pinning, forks. **Done:** you know
   which version runs (`status`), and where its next release comes from.
7. [troubleshooting.md](troubleshooting.md), when something is not right: `status`, the logs and
   the common failures.

[tls.md](tls.md), [scaling.md](scaling.md), [relays.md](relays.md),
[verifying.md](verifying.md) and [mirroring.md](mirroring.md) are for when you need them.

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

| Page                                     | What it covers                                                        |
| ---------------------------------------- | --------------------------------------------------------------------- |
| [requirements.md](requirements.md)       | Distributions, Podman, hardware, DNS, ports, mail, off-host storage   |
| [install.md](install.md)                 | Download, verify, install, first admin, first stream                  |
| [configuration.md](configuration.md)     | Every environment variable, and how to change one                     |
| [object-storage.md](object-storage.md)   | An external S3 store instead of Garage: what it needs, Spaces         |
| [tls.md](tls.md)                         | ACME certificates, the internal CA, the IRC certificate               |
| [upgrades.md](upgrades.md)               | `selfhost.sh upgrade`, rollback, pinning a version, a fork's releases |
| [backups.md](backups.md)                 | WAL-G, off-host storage, object backups, restore, the restore drill   |
| [scaling.md](scaling.md)                 | What to watch and what to split off first                             |
| [relays.md](relays.md)                   | Running a member relay                                                |
| [verifying.md](verifying.md)             | Checking signatures, SBOMs and provenance yourself                    |
| [mirroring.md](mirroring.md)             | Copying a release into your own registry                              |
| [troubleshooting.md](troubleshooting.md) | Status, logs, common failures                                         |

How far one host goes, measured, is in [the capacity runbook](../operators/capacity.md).

## Customizing a unit

The supported way to change a unit is a **drop-in**, never an edit of the unit file: `install`,
`upgrade` and a rollback replace every unit file, so an edit is lost at the next one.

- A container unit: `~/.config/containers/systemd/commonair-<unit>.container.d/<name>.conf`,
  with Quadlet keys. For example, a GPU for the media pipeline, in
  `commonair-media.container.d/gpu.conf`:

  ```ini
  [Container]
  AddDevice=/dev/dri/renderD128
  ```

- The backup services, the timers and the sockets:
  `~/.config/systemd/user/commonair-<unit>.<service|timer|socket>.d/<name>.conf`, with systemd
  keys.

Then `systemctl --user daemon-reload` and restart the unit. `install`, `upgrade` and a rollback
keep drop-in directories, including a drop-in directory that is a symlink; a drop-in symlink
whose target no longer exists is removed. (Releases up to 0.1.0-rc.2 deleted symlinked drop-in
directories, in both `~/.config/containers/systemd/` and `~/.config/systemd/user/`.) A drop-in for a unit that a later release removes
stays behind, unused.

## Known limitations

These are true of the current release. Each one is tracked for a later release.

- **One host only.** `selfhost.sh` installs everything on one server. Splitting Postgres or
  media onto other servers is not scripted yet ([scaling.md](scaling.md)). Only the object store
  can live elsewhere ([object-storage.md](object-storage.md)).
- **A service holds its own secrets.** Each unit gets only its keys of `commonair.env`
  ([configuration.md](configuration.md#which-unit-sees-which-key)): Caddy gets none, but a
  compromised api or worker still holds the database password and S3 keys it needs.
- **RTMP and WebRTC clients share one address.** HTTPS (the web app, API, chat, HLS, the
  tracker and WHIP signaling) and IRC see each client's own address, IPv6 included: systemd holds
  ports 80 and 443 (`commonair-caddy.socket`) and 6667 and 6697 (`commonair-irc.socket`,
  `commonair-ircs.socket`) and hands them to Caddy and the IRC gateway, so IRC's per-address
  limits count each client separately. Only MediaMTX (RTMP 1935, WebRTC 8189/udp) still goes
  through rootless Podman's port forwarding and sees every encoder at one internal address.
- **Two local services listen on the host's loopback.** Garage (`127.0.0.1:3900`, with Garage
  only, for `selfhost.sh backup --objects`; every request needs an S3 key) and Grafana
  (`127.0.0.1:3030`, behind its admin login). Nothing else is reachable from the host, and Valkey
  requires a password.
- **Object backups need rclone and a second store.** WAL-G backs up Postgres. Media and sealed
  evidence are copied by `selfhost.sh backup --objects` once you set the
  `BACKUP_OBJECTS_REMOTE_*` keys, install rclone and run it by hand once; its first success
  turns on the daily timer. Until then they are not backed up
  ([backups.md](backups.md#objects)). Data exports are never copied.
- **The observability services do not hold back the app while they run.** Units that depend on
  the OpenTelemetry collector, Loki, Tempo or Prometheus wait only for its container to start,
  not for its health, so an unhealthy collector no longer delays the apps. One whose container
  cannot start at all (a missing image, say) still can. With the collector down, telemetry is
  retried and then dropped, and the app keeps running; a crash loop there only throttles that
  service.
