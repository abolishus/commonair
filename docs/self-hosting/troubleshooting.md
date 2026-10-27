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
root path), the certificate's expiry, the object store (with an external one, each bucket and
whether it is ready), every unit with its state, sub-state and container health, the socket
units, the last base backup and its result, the last object backup, and the size of every
volume.

A healthy instance has every long-running unit `active running healthy` and every socket
(`commonair-caddy.socket`, `commonair-irc.socket`, `commonair-ircs.socket`) `active listening`.
The one-shots (`commonair-migrate`, `commonair-storage-init`) show `active exited`, and
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
variable. Fix them in `~/.config/commonair/commonair.env` and restart that unit
(`systemctl --user restart commonair-api`), or run
`sh ~/commonair/selfhost.sh install --reinstall` to restart everything
([configuration.md](configuration.md#changing-a-value)).

A unit that fails before its container starts, with `render-env:` in its journal, could not
copy its keys from `commonair.env` (the file is missing, unreadable or empty). It does not start
without them. Restore the file (from your offline copy if need be, mode 0600) and start the unit
again ([configuration.md](configuration.md#which-unit-sees-which-key)).

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
- **The object store is not ready.** Every service waits for `commonair-storage-init`. With
  Garage it creates the buckets and keys; with an external store it checks each bucket with the
  instance's keys, and fails naming the missing bucket or the key that was denied:
  `journalctl --user -u commonair-storage-init`. It retries six times an hour, then fails for
  good, and the services that need it fail with it and do not start again on their own. Fix it at
  the store (create the bucket, widen the key), then run
  `sh ~/commonair/selfhost.sh install --reinstall`, which clears the failed state, starts the
  stack again and waits for it to be healthy
  ([object-storage.md](object-storage.md#install-against-it)).
- **An observability service in a crash loop.** It does not hold the app back: units that
  depend on the OpenTelemetry collector, Loki, Tempo or Prometheus wait only for its container
  to start, not for its health. Only a container that cannot start at all (a missing image, say)
  delays them. Check `commonair-otel-collector`, `commonair-loki` and `commonair-tempo`.
- **`Failed to spawn executor: Device or resource busy`** on every restart. The unit's cgroup
  was not cleaned up after its container died, a gap in systemd 257 with in-place restarts.
  Every unit now cleans it up itself after each stop (`scripts/selfhost/cgroup-reset.sh`, the
  unit's first `ExecStopPost=`, before Quadlet's own `podman rm`). On an instance installed
  before that, `systemctl --user restart <unit>` clears it.

To restart one service by hand: `systemctl --user restart commonair-worker`.

## The install or upgrade stops with an error

Each check prints the problem and the fix. The ones you are most likely to meet:

| Error                                               | Fix                                                                                                                                                        |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `linger is off for commonair`                       | As root: `loginctl enable-linger commonair`                                                                                                                |
| `no systemd user manager for commonair`             | Log in as `commonair` over SSH or with `machinectl shell commonair@`; `su` and `sudo -u` do not start one                                                  |
| `net.ipv4.ip_unprivileged_port_start is 1024`       | As root, the `sysctl` command it prints, or run the install as root with `--yes`                                                                           |
| `no /etc/subuid entry for commonair`                | As root: `usermod --add-subuids 100000-165535 --add-subgids 100000-165535 commonair`                                                                       |
| `ports already in use`                              | Stop what listens there (`sudo ss -ltnup`), usually another web server on 80/443                                                                           |
| `an instance is already installed`                  | `install --reinstall` to reinstall, or `upgrade` for a new version                                                                                         |
| `checksum mismatch` / `signature … does not verify` | Download again. If it persists, do not install; report it to the project                                                                                   |
| `the instance did not become healthy`               | `selfhost.sh status`, then the logs of the units that are not healthy                                                                                      |
| `could not pull <image>`                            | Podman's error is printed above it. A registry's 5xx, 429 or timeout is retried four times first; if it persists, try later or use a mirror (`--registry`) |

## ACME fails

Caddy logs every attempt:

```sh
journalctl --user -u commonair-caddy -n 200 --no-pager | grep -i -e acme -e certificate -e challenge
```

Check, in order:

1. **DNS.** The A record resolves to this server from outside (`dig +short stream.example.org`
   from another network). An AAAA record must point at this server's own IPv6 address, or be
   absent; check `dig +short AAAA stream.example.org` too.
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

## Image uploads or export downloads fail

With Garage, channel images and data exports go from the browser to `https://<host>/<bucket>/…`
with a presigned URL, which Caddy forwards to Garage
([tls.md](tls.md#uploads-and-export-downloads)). When they fail:

1. **`S3_PUBLIC_ENDPOINT`** in the env file is `https://<host>`, the same host as
   `PUBLIC_HOSTNAME`. Empty, or an address like `http://garage:3900`, makes the browser call a
   host it cannot reach. Fix it and run `install --reinstall`.
2. **A 404 from the web app** means Caddy did not recognize the request as a presigned one:
   the bucket in the URL differs from `S3_BUCKET_MEDIA` or `S3_BUCKET_EXPORTS` in the env file,
   or the URL lost its query string. Caddy reads the bucket names from the env file when it
   starts: after changing them, reinstall.
3. **A 403 with an XML body** comes from Garage: the signature does not match. The URL expired
   (uploads after 10 minutes), the browser changed the content type or length, or a proxy in
   front of Caddy rewrote the `Host` header or the path.
4. **413** means the file is over the 10 MB upload limit.
5. With `--tls internal`, the browser must trust Caddy's root, as for the site itself.

With an external store ([object-storage.md](object-storage.md)), the browser talks to the store
itself, and Caddy has no part in it. The browser's console names the cause:

1. **A CORS error.** The media bucket needs a CORS rule that allows `PUT` and `GET` from
   `https://<host>` with any header
   ([object-storage.md](object-storage.md#buckets-and-keys)). Exports need none.
2. **A Content-Security-Policy error** (`connect-src`). `S3_CONNECT_SRC` in the env file must be
   the origin the presigned URLs point at: the public endpoint with path-style URLs, or
   `https://<media bucket>.<endpoint host>` with virtual-hosted ones. `install` works it out;
   after changing the endpoint or path style, run `install --reinstall`.
3. **The browser cannot reach the host.** `S3_PUBLIC_ENDPOINT` (from `--s3-public-endpoint`,
   else `--s3-endpoint`) must be an address browsers can reach, not a private one.
4. **403 from the store**: the signature does not match (an expired URL, or a proxy that rewrote
   the request), or the main key may not write to the media bucket.

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

The IRC ports come from systemd: `commonair-irc.socket` holds 6667 and `commonair-ircs.socket`
6697, as `commonair-caddy.socket` holds 80 and 443, and both are handed to `commonair-irc`. So
the gateway sees each client's own address, IPv4 or IPv6, and its per-address limits count
each client separately.

**"Too many connections from your address"** means that one real client address already has
`IRC_MAX_CONNECTIONS_PER_IP` (50) connections open. Raise that limit.

**"Reconnecting too fast"** means that one address has used up its burst of new connections:
`IRC_CONNECT_BURST_PER_IP` (20), refilled at `IRC_CONNECT_PER_SECOND_PER_IP` (2 a second). Raise
those.

Many users behind one NAT, or a bouncer that connects for all of them, look like either. If that
address is legitimate, raise the limit in the env file (`IRC_MAX_CONNECTIONS` still caps the
total), then `systemctl --user restart commonair-irc`.

**The gateway does not come up at all:**

```sh
systemctl --user status commonair-irc.socket commonair-ircs.socket
journalctl --user -u commonair-irc -n 100 --no-pager
```

Both sockets must be `active (listening)`. A socket that failed usually means something else
holds the port (`sudo ss -ltnp 'sport = :6667'`). The gateway refuses to bind the ports itself:
`systemd socket activation failed; not starting` in its journal means the descriptors were
missing or unusable; start the sockets, then the service. When it does start, its
`irc gateway listening` line shows `fdNames`: `irc:ircs` (or `ircs:irc`) when it found both sockets by name, `unnamed,
fd-order fallback` otherwise. Without a TLS certificate yet, IRC does not start either
([tls.md](tls.md#the-irc-certificate)).

## Valkey

Valkey requires `VALKEY_PASSWORD` from the env file, and the services connect with the
`VALKEY_URL` that carries it (`install` and `upgrade` write both and the `commonair-valkey-url`
Podman secret). Valkey refuses to start with an empty password. To talk to it by hand:

```sh
podman exec -it commonair-valkey sh -c 'VALKEYCLI_AUTH="$VALKEY_PASSWORD" valkey-cli'
```

After changing the password in the env file, run `selfhost.sh install --reinstall`, which
rewrites the URL and the secret and restarts everything together.

## Postgres

```sh
journalctl --user -u commonair-postgres -n 200 --no-pager
podman exec -it commonair-postgres psql -U commonair -d commonair
```

- **WAL piles up in `pg_wal`.** Archiving to S3 is failing (Garage or the external store
  unreachable, or wrong `AWS_*` settings). Postgres keeps the segments until archiving works, so nothing is lost, but the
  disk fills. `podman exec commonair-postgres psql -U commonair -c 'select * from pg_stat_archiver'`
  shows the last failure.
- **"too many clients".** Raise `POSTGRES_MAX_CONNECTIONS` (or lower `DATABASE_POOL_MAX`) and
  reinstall.
- **A failed backup.** `journalctl --user -u commonair-backup` has the WAL-G error.
- **A start that hangs is stopped hard.** When Postgres does not come up in time, its health
  check stops it (SIGQUIT to the postmaster, or SIGTERM to the container when there is no
  postmaster yet) so the unit restarts. If it is still running `COMMONAIR_PG_KILL_GRACE_SECONDS`
  (30) later, the check sends SIGKILL and logs `commonair-pg-health: … sending SIGKILL` in the
  container's log. A server that stops in time
  gets no SIGKILL. The check keeps its state in `/run/commonair-pg-health.state` inside the
  container.

To restore, see [backups.md](backups.md#restore).

## Object backups

`selfhost.sh backup --objects` and its daily timer copy the media and evidence buckets offsite
([backups.md](backups.md#objects)). `status` shows the `last object backup:`, which only a run
that copied every bucket updates.

- **A failed daily copy** shows in `systemctl --user status commonair-object-backup.service`
  and in `journalctl --user -u commonair-object-backup`, while `status` keeps the last success.
  To stop the daily copy: `systemctl --user disable --now commonair-object-backup.timer`.
- **`rclone is not installed`.** As root: `apt-get install rclone` or `dnf install rclone`.
- **`<bucket> is empty but its offsite copy is not`.** The run refused to empty the copy. If the
  instance lost its objects, restore them: `selfhost.sh backup --restore-objects`. If the bucket
  is empty on purpose, run `selfhost.sh backup --objects --allow-empty-source` once.
- **A run stopped at `--max-delete`.** More objects left the instance than the limit (1000 per
  bucket unless `BACKUP_OBJECTS_MAX_DELETE` says otherwise). If the deletions are expected, run
  `selfhost.sh backup --objects --max-delete off` once; if not, restore first.
- **`another object backup or restore is running (pid N)`.** Wait for it to finish. A lock left
  by a run that was killed is taken over by the next run.
- **`a backup --restore-objects … has not finished`.** Run `selfhost.sh backup --restore-objects`
  again until it succeeds. If the instance has everything it should, remove the marker instead:
  `rm ~/.local/state/commonair/object-restore-incomplete`.

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
- **Garage** (when the objects live on this host): VODs and clips. VODs expire after their
  channel's retention period (at most 60 days).
- **The journal**: `journalctl --vacuum-size=1G` as root.

Postgres stops accepting writes when its disk is full. Free space first, then check that every
unit came back with `selfhost.sh status`.

## Abuse reports

Hosting providers forward abuse and copyright complaints to the account's abuse contact and
expect an answer, often within 24 hours; some block the server's address when you miss it. The
instance's own `ABUSE_EMAIL` and `DMCA_EMAIL` receive reports from users. Route both into the
trust and safety process in [operators/trust-safety.md](../operators/trust-safety.md), which
covers takedowns, legal holds and evidence.
