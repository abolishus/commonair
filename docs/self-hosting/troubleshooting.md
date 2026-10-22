<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Troubleshooting

Run everything here as the `commonair` user, logged in over SSH (or `machinectl shell
commonair@`), unless it says root.

## Start with `status`

```sh
sh ~/commonair/selfhost.sh status
```

It shows the installed and previous version, the hostname and TLS mode (and the internal CA's
root path), the certificate's expiry, every unit with its state, sub-state and container
health, the last backup and its result, and the size of every volume.

A healthy instance has every long-running unit `active running healthy`. The one-shots
(`commonair-migrate`, `commonair-garage-init`) show `active exited`, and
`commonair-irc-cert` shows `inactive dead` between runs.

## Logs

Every container logs to the journal through its unit:

```sh
journalctl --user -u commonair-api -n 200 --no-pager
journalctl --user -u commonair-api -f                     # follow
journalctl --user -u 'commonair-*' --since '10 min ago'   # everything
```

If `journalctl --user` shows nothing, the journal is not persistent for user units on this
host. As root, the same logs are available with
`journalctl _SYSTEMD_USER_UNIT=commonair-api.service`.

A service that refuses its configuration logs `Invalid environment:` followed by every bad
variable. Fix them in `~/.config/commonair/commonair.env` and run
`sh ~/commonair/selfhost.sh install --reinstall` ([configuration.md](configuration.md)).

Grafana has the services' structured logs, metrics and traces
([requirements.md](requirements.md#ports) shows the SSH tunnel).

## A unit is unhealthy or restarting

Every long-running unit restarts on its own: on a crash, and when its health check fails
(`HealthOnFailure=kill`). Restarts back off from 5 seconds to 5 minutes and never give up. So
a unit stuck in `activating` or flapping between states is retrying; its log says why.

```sh
systemctl --user status commonair-worker
journalctl --user -u commonair-worker -n 100 --no-pager
```

Common causes:

- **Postgres not healthy yet.** Services wait for it. After a crash, a reboot or a restore,
  Postgres replays WAL first; `journalctl --user -u commonair-postgres` shows each replayed
  segment. The unit waits as long as the replay advances. It restarts Postgres when a normal
  start has not come up after about two minutes, or when the replay has made no progress for
  10 minutes ([backups.md](backups.md#restore)).
- **The migration failed.** `commonair-migrate` retries six times an hour, then fails for good,
  and every service that needs the database stays down. Its log has the error. After fixing the
  cause, `sh ~/commonair/selfhost.sh install --reinstall` clears the failed state and starts
  over.
- **An observability service in a crash loop.** App units start after the OpenTelemetry
  collector, so a collector that never gets healthy holds them back. Check
  `commonair-otel-collector`, `commonair-loki` and `commonair-tempo`.

To restart one service by hand: `systemctl --user restart commonair-worker`.

## The install or upgrade stops with an error

Each check prints the problem and the fix. The ones you are most likely to meet:

| Error                                               | Fix                                                                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `linger is off for commonair`                       | As root: `loginctl enable-linger commonair`                                                               |
| `no systemd user manager for commonair`             | Log in as `commonair` over SSH or with `machinectl shell commonair@`; `su` and `sudo -u` do not start one |
| `net.ipv4.ip_unprivileged_port_start is 1024`       | As root, the `sysctl` command it prints, or run the install as root with `--yes`                          |
| `no /etc/subuid entry for commonair`                | As root: `usermod --add-subuids 100000-165535 --add-subgids 100000-165535 commonair`                      |
| `ports already in use`                              | Stop what listens there (`sudo ss -ltnup`), usually another web server on 80/443                          |
| `an instance is already installed`                  | `install --reinstall` to reinstall, or `upgrade` for a new version                                        |
| `checksum mismatch` / `signature … does not verify` | Download again. If it persists, do not install; report it to the project                                  |
| `the instance did not become healthy`               | `selfhost.sh status`, then the logs of the units that are not healthy                                     |

## ACME fails

Caddy logs every attempt:

```sh
journalctl --user -u commonair-caddy -n 200 --no-pager | grep -i -e acme -e certificate -e challenge
```

Check, in order:

1. **DNS.** The A record resolves to this server from outside (`dig +short stream.example.org`
   from another network). No AAAA record, because the ports bind IPv4 only.
2. **Ports 80 and 443 reach Caddy** from outside: the host firewall, and any provider firewall
   in front of it.
3. **Rate limits.** After repeated failures, Let's Encrypt refuses for a while; the log says so.
   Fix the cause, then wait, and use the staging CA while you test ([tls.md](tls.md#acme)).

Caddy retries on its own. Once it has a certificate, start the IRC sync
(`systemctl --user start commonair-irc-cert.service`).

## WHIP connects but no video arrives

WHIP signaling goes through Caddy on 443, but the media itself flows over WebRTC on UDP 8189,
straight to MediaMTX. When signaling works and no video arrives:

1. **UDP 8189 is open** inbound, in every firewall in front of the server.
2. **`MTX_WEBRTCADDITIONALHOSTS`** in the env file lists the addresses encoders can reach the
   server on. `install` fills it from the server's global interface addresses. Behind NAT (or a
   cloud provider's 1:1 NAT), those are private addresses: set the public address instead,
   with `install --reinstall --public-ip 203.0.113.10` or by editing the file and reinstalling.
3. The encoder's network allows outbound UDP. Where it does not, use RTMP.

RTMP (TCP 1935) has none of these requirements and is the fallback.

## Linger is missing

Without linger, the `commonair` user's units stop when its last session ends, so the instance
goes down when you log out. `selfhost.sh install` refuses to run without it. As root:

```sh
loginctl enable-linger commonair
loginctl show-user commonair --property=Linger
```

## Ports below 1024

Rootless containers cannot bind ports below 1024 unless the host allows it. Caddy needs 80 and 443. As root:

```sh
echo 'net.ipv4.ip_unprivileged_port_start=80' > /etc/sysctl.d/90-commonair.conf
sysctl --system
```

`selfhost.sh install` run as root with `--yes` does this for you.

## IRC clients are refused

Rootless Podman forwards public ports so that every client appears to come from the same
address, the container network's gateway. The IRC gateway's per-address limits then apply to
all clients together: after `IRC_MAX_CONNECTIONS_PER_IP` (50) connections, or a burst of
`IRC_CONNECT_BURST_PER_IP` (20) new ones, everyone is refused. Until source addresses are
preserved, raise both in the env file to what the whole instance should allow, and reinstall.
The tracker's `TRACKER_MAX_CONNECTIONS_PER_IP` behaves the same way.

## Postgres

```sh
journalctl --user -u commonair-postgres -n 200 --no-pager
podman exec -it commonair-postgres psql -U commonair -d commonair
```

- **WAL piles up in `pg_wal`.** Archiving to S3 is failing (Garage down, or wrong `AWS_*`
  settings). Postgres keeps the segments until archiving works, so nothing is lost, but the
  disk fills. `podman exec commonair-postgres psql -U commonair -c 'select * from pg_stat_archiver'`
  shows the last failure.
- **"too many clients".** Raise `POSTGRES_MAX_CONNECTIONS` (or lower `DATABASE_POOL_MAX`) and
  reinstall.
- **A failed backup.** `journalctl --user -u commonair-backup` has the WAL-G error.

To restore, see [backups.md](backups.md#restore).

## Disk full

```sh
df -h
sh ~/commonair/selfhost.sh status        # volume sizes
podman system df
```

- **Old images.** Each upgrade leaves the previous release's images. While the stack is
  running, `podman image prune -a` removes every image no running container uses. That
  includes the `tools` image of the one-shot jobs, which Podman pulls again by digest the next
  time they run, and the previous release's images, which a rollback would then have to pull
  again. Run it only while the stack is up, or it removes the current release's images too.
- **`pg_wal`** growing: archiving is failing (above).
- **Garage**: VODs and clips. VODs expire after their channel's retention period (at most 60
  days).
- **The journal**: `journalctl --vacuum-size=1G` as root.

Postgres stops accepting writes when its disk is full. Free space first, then check that every
unit came back with `selfhost.sh status`.

## Abuse reports

Hosting providers forward abuse and copyright complaints to the account's abuse contact and
expect an answer, often within 24 hours; some block the server's address when you miss it. The
instance's own `ABUSE_EMAIL` and `DMCA_EMAIL` receive reports from users. Route both into the
trust and safety process in [operators/trust-safety.md](../operators/trust-safety.md), which
covers takedowns, legal holds and evidence.
