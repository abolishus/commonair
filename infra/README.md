<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Infrastructure

Everything needed to run CommonAir: one `compose.yaml` for development, testing and small
deployments, and hand-written Quadlet units (`quadlet/`) for production on systemd. Both use the
same images, the same configuration files from this directory and the same environment variables.

```sh
bun scripts/init-env.ts        # .env with fresh secrets (never committed)
podman compose build           # our images (Postgres+WAL-G, services, tools, probes)
podman compose up -d           # the whole platform, observability included
podman compose --profile harness --profile stripe up -d   # plus test doubles
```

Requirements: Podman ≥ 5 with podman-compose ≥ 1.6 (macOS via `podman machine`, or Linux
rootless). Nothing needs root, `privileged`, host ports below 1024 or the Podman socket.

> `podman compose up <service>` builds only the services you name, not their dependencies.
> Run `podman compose build` once (and after changing a Containerfile) before starting a subset.

## Services

| Service           | Image                                                            | Role                                                                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres`        | built: `postgres/Containerfile`                                  | Postgres 17.11 + WAL-G v3.0.9, continuous WAL archiving to Garage                                                                                                                                          |
| `migrate`         | built: `tools`                                                   | one-shot: migrations as the owner, then the `commonair_app` role                                                                                                                                           |
| `valkey`          | `valkey/valkey:9.1.2-trixie`                                     | ephemeral state: presence, rate limits, caches, pub/sub, BullMQ                                                                                                                                            |
| `garage`          | `dxflrs/garage:v2.4.1`                                           | S3 object storage (single node)                                                                                                                                                                            |
| `garage-init`     | built: `tools`                                                   | one-shot: layout, key import, buckets (`garage/bootstrap.ts`, idempotent)                                                                                                                                  |
| `mailpit`         | `axllent/mailpit:v1.31.6`                                        | development SMTP sink (production uses a real SMTP server)                                                                                                                                                 |
| `mediamtx`        | `bluenviron/mediamtx:1.21.2-ffmpeg`                              | RTMP/WHIP ingest, LL-HLS, RTSP (config: `mediamtx/mediamtx.yml`, media unit); gets `INTERNAL_API_SECRET`, which it expands in its hooks; healthcheck probes RTMP because its API sits behind the auth hook |
| `api` … `tracker` | built: `containers/service.Containerfile`                        | `api`, `chat`, `irc`, `origin`, `media` (+FFmpeg), `worker`, `tracker`                                                                                                                                     |
| `web`             | built: same, `SERVICE=web`                                       | TanStack Start build output (`vp build` in `apps/web`)                                                                                                                                                     |
| `otel-collector`  | built: probe over `otel/opentelemetry-collector-contrib:0.163.1` | OTLP in; traces → Tempo, metrics → Prometheus, logs → Loki                                                                                                                                                 |
| `prometheus`      | `prom/prometheus:v3.15.0`                                        | metrics, 30 days                                                                                                                                                                                           |
| `loki`            | built: probe over `grafana/loki:3.7.8`                           | logs (native OTLP ingest), 31 days                                                                                                                                                                         |
| `tempo`           | built: probe over `grafana/tempo:3.1.0`                          | traces                                                                                                                                                                                                     |
| `grafana`         | `grafana/grafana:13.2.4` (OSS)                                   | dashboards; datasources provisioned from `grafana/provisioning/`                                                                                                                                           |
| `caddy`           | `library/caddy:2.11.7-alpine`                                    | profile `tls`: HTTPS for `PUBLIC_HOSTNAME`                                                                                                                                                                 |
| `mock-rtmp`       | `bluenviron/mediamtx:1.21.2-ffmpeg`                              | profile `harness`: fake simulcast target on :1936                                                                                                                                                          |
| `stripe-mock`     | `stripe/stripe-mock:v0.206.0`                                    | profile `stripe`: Stripe API double                                                                                                                                                                        |

"probe" images (`containers/probe.Containerfile`) are the upstream image unchanged plus a
static BusyBox, because those images ship without a shell and a healthcheck needs `wget`.
Every image is pinned and listed with its license in `image-licenses.json` (ADR 0002);
`infra/tests/compose.test.ts` and `bun scripts/check-licenses.ts` enforce it.

### Profiles

- **default**: the full platform including observability. Observability is not optional
  (services export to the collector, status and integrity work needs metrics), so it has no
  profile; start a subset (`podman compose up -d postgres valkey …`) if you want less.
- **harness**: adds `mock-rtmp` (simulcast target for harness scenarios).
- **stripe**: adds `stripe-mock`. Set `PAYMENTS_PROVIDER=stripe`, `STRIPE_SECRET_KEY=sk_test_…`
  and `STRIPE_API_BASE=http://stripe-mock:12111` to use it.
- **tls**: adds `caddy` (see [TLS](#tls-caddy)).

### Start order

`postgres` (healthy) → `migrate` (exit 0); `garage` (healthy) → `garage-init` (exit 0);
`loki` + `tempo` → `otel-collector`; then the app services, which wait for both one-shot jobs,
Valkey and the collector. `irc` waits for `chat`; `origin` and `media` for `mediamtx`;
`web` for `api`; `caddy` for `web` and `api`.

## Ports

Host ports bind to `BIND_ADDRESS` (default `127.0.0.1`) and are all variables, so a second
stack can run next to the first (`podman compose -p other …` with shifted ports; the
integration test does exactly that with +20000). Inside the network, ports are fixed.

| Variable                                    | Default            | Service                                               |
| ------------------------------------------- | ------------------ | ----------------------------------------------------- |
| `POSTGRES_PORT`                             | 5432               | postgres                                              |
| `VALKEY_PORT`                               | 6379               | valkey                                                |
| `GARAGE_S3_PORT`                            | 3900               | garage S3 API (admin :3903 internal)                  |
| `MAILPIT_SMTP_PORT` / `MAILPIT_HTTP_PORT`   | 1025 / 8025        | mailpit                                               |
| `MEDIAMTX_RTMP_PORT`                        | 1935               | RTMP ingest                                           |
| `MEDIAMTX_WEBRTC_PORT`                      | 8889               | WHIP/WebRTC                                           |
| `MEDIAMTX_ICE_UDP_PORT`                     | 8189/udp           | WebRTC ICE (keep equal to 8189)                       |
| `MOCK_RTMP_PORT`                            | 1936               | mock-rtmp (harness)                                   |
| `WEB_PORT`                                  | 3000               | web                                                   |
| `API_PORT`                                  | 3001               | api                                                   |
| `CHAT_PORT`                                 | 3002               | chat                                                  |
| `ORIGIN_PORT`                               | 3003               | origin                                                |
| `IRC_PORT` / `IRC_TLS_PORT` / `IRC_WS_PORT` | 6667 / 6697 / 6680 | irc                                                   |
| `TRACKER_PORT`                              | 8000               | tracker                                               |
| `OTLP_HTTP_PORT`                            | 4318               | collector (for services run on host)                  |
| `PROMETHEUS_PORT`                           | 9090               | prometheus                                            |
| `GRAFANA_PORT`                              | 3030               | grafana                                               |
| `CADDY_HTTP_PORT` / `CADDY_HTTPS_PORT`      | 8080 / 8443        | caddy (binds `CADDY_BIND_ADDRESS`, default `0.0.0.0`) |
| `STRIPE_MOCK_PORT`                          | 12111              | stripe-mock                                           |

Not published: MediaMTX RTSP 8554, HLS 8888, API 9997, metrics 9998; media 3004 and worker
3005 (health only); IRC health 6681; Loki, Tempo, Garage admin.

`API_PORT` and friends also exist in `.env` for services run directly on the host. In compose
the container side is pinned (`API_PORT=3001` etc. are overridden) and the same variable picks
the host port.

## Volumes

`postgres-data`, `media-work` (`MEDIA_WORK_DIR` scratch for VOD/clips), `garage-meta`, `garage-data`, `prometheus-data`, `loki-data`, `tempo-data`,
`grafana-data`, `caddy-data` (certificates), `caddy-config`. Valkey is deliberately ephemeral.
Config files are bind-mounted read-only from `infra/` with `:Z` (SELinux relabel on Linux).
`podman compose down` keeps volumes; `down -v` deletes them.

## Environment

Every container reads `.env` (`env_file`, optional, path overridable with `COMMONAIR_ENV_FILE`)
and compose overrides the hostnames for the compose network:
`DATABASE_URL=postgres://commonair_app:${POSTGRES_APP_PASSWORD}@postgres:5432/commonair`,
`VALKEY_URL=redis://valkey:6379`, `S3_ENDPOINT=http://garage:3900`, `MEDIAMTX_*` → `mediamtx`,
`API_INTERNAL_URL=http://api:3001`, `CHAT_INTERNAL_URL=ws://chat:3002/ws`,
`ORIGIN_INTERNAL_URL=http://origin:3003`, `SMTP_HOST=mailpit`,
`OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318`, `OTEL_SERVICE_NAME=<service>`.

Service secrets (`AUTH_SECRET`, `INTERNAL_API_SECRET`, `MEDIA_INTERNAL_PASSWORD` for api,
origin and media, `PLAYBACK_SIGNING_KEY`, …) reach the services only through that env file.
MediaMTX gets just `INTERNAL_API_SECRET` (for its hook header); its own requests are
authorized by the API's auth hook.

Variables used by compose itself (interpolated from `.env` or the shell). None of the secrets
has a default; missing ones make the dependent container fail with a clear message.

| Variable                                    | Default                       | Purpose                                                    |
| ------------------------------------------- | ----------------------------- | ---------------------------------------------------------- |
| `POSTGRES_PASSWORD`                         | `commonair` (dev only)        | owner (`commonair`) password; set a real one in production |
| `POSTGRES_APP_PASSWORD`                     | —                             | `commonair_app` password (in `.env.example`)               |
| `GARAGE_RPC_SECRET`                         | —                             | Garage RPC secret, 64 hex chars                            |
| `GARAGE_ADMIN_TOKEN`                        | —                             | Garage admin API token (garage-init)                       |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | —                             | imported into Garage by garage-init; used by WAL-G too     |
| `GRAFANA_ADMIN_PASSWORD`                    | —                             | Grafana refuses to start without it                        |
| `GRAFANA_ADMIN_USER`                        | `admin`                       |                                                            |
| `PUBLIC_HOSTNAME`                           | `localhost`                   | Caddy site address                                         |
| `BIND_ADDRESS` / `CADDY_BIND_ADDRESS`       | `127.0.0.1` / `0.0.0.0`       | host bind addresses                                        |
| `IMAGE_REGISTRY` / `IMAGE_TAG`              | `localhost/commonair` / `dev` | names of our built images                                  |
| `WALG_RETAIN_FULL`                          | `7`                           | full backups kept by `commonair-backup`                    |
| `COMMONAIR_ENV_FILE`                        | `.env`                        | env file every container reads                             |

## Database roles

`migrate` runs as the owner (`commonair`): `bun packages/db/src/migrate.ts`, then
`bun infra/postgres/apply-app-role.ts`, which applies `postgres/app-role.sql` in one
transaction: create/update `commonair_app` (LOGIN, no SUPERUSER/CREATEDB/CREATEROLE/
REPLICATION/BYPASSRLS, no memberships, owns nothing), `REVOKE TEMPORARY … FROM PUBLIC`,
`CONNECT` only on the database, no access to the `drizzle` schema, and finally
`commonair_configure_app_role('commonair_app')` from migration 0002 (DML on ordinary tables,
nothing on history tables, no TRUNCATE/TRIGGER/REFERENCES, no CREATE on `public`). The
password reaches the server as a transaction-local setting, never spliced into SQL. Services
connect only as `commonair_app` (ADR 0004).

## Object storage (Garage)

`garage/garage.toml` holds no secrets: `GARAGE_RPC_SECRET` and `GARAGE_ADMIN_TOKEN` come from
the environment. `s3_region` is `garage` and must equal `S3_REGION`. `garage-init` (admin API
v2) waits for the node, assigns and applies a single-node layout if none exists, waits for a
healthy cluster, imports the key pair from `S3_ACCESS_KEY_ID` (`GK` + 24 hex) /
`S3_SECRET_ACCESS_KEY` (64 hex) — the format `bun scripts/init-env.ts` generates — creates
`S3_BUCKET_MEDIA`, `S3_BUCKET_EXPORTS`, `S3_BUCKET_BACKUPS` and grants the key
read/write/owner. Re-running changes nothing.

Rotating the key: Garage never lets a key id be reused, and garage-init refuses an existing id
with a different secret. Generate a new pair, put it in `.env`, run
`podman compose up -d garage-init` (imports and grants it), restart the services, then delete
the old key with `podman compose exec garage /garage key delete --yes <old id>`.

Browser uploads use presigned URLs to `S3_PUBLIC_ENDPOINT`; in production give Garage its own
hostname (path-style URLs cannot live under a path prefix of the web host, SigV4 signs the path).

## Backups (WAL-G)

The Postgres image adds WAL-G (glibc build for Ubuntu 24.04, which runs on Debian trixie;
SHA-256 for amd64 and arm64 pinned in the Containerfile and verified at build time) and runs
with `archive_mode=on`, `archive_command='wal-g wal-push %p'`, `archive_timeout=60`.
`postgres/walg-env.sh` maps `S3_*` to WAL-G's `AWS_*` settings and sets
`WALG_S3_PREFIX=s3://commonair-backups/wal`. If Garage starts later than Postgres, archiving
fails and Postgres retries; segments stay in `pg_wal` until archived, so nothing is lost (watch
disk usage if Garage stays down).

```sh
podman compose exec postgres commonair-backup        # base backup + prune to WALG_RETAIN_FULL
podman compose exec postgres wal-g backup-list
```

Restore into an empty data directory (never the live one), then start Postgres on it; it
replays all archived WAL and promotes (or stops at `RECOVERY_TARGET_TIME`):

```sh
podman compose stop postgres
podman run --rm -it --network commonair_default --env-file .env \
  -v commonair_postgres-restore:/var/lib/postgresql/data \
  localhost/commonair/postgres:dev commonair-restore     # [target-dir] [backup-name]
```

The integration test runs `commonair-backup`, writes a row afterwards, restores into a fresh
container and checks the row came back through WAL replay. The scheduled restore drill is a
harness scenario (operations unit).

## Observability pipeline

```
services ──OTLP/HTTP :4318──▶ otel-collector ──▶ Tempo (OTLP gRPC)          traces
  (logs, traces, metrics)            ├─────────▶ Prometheus exporter :9464 ◀── scraped   metrics
                                     └─────────▶ Loki /otlp (native OTLP)    logs
Prometheus also scrapes Garage, Loki and Tempo (MediaMTX metrics sit behind its auth hook).
Grafana reads all three.
```

Podman's container log files are not portable (journald vs. k8s-file, machine VMs), so there
is no `filelog` receiver: services keep writing JSON logs to stdout (`podman logs`) and export
the same records over OTLP. The collector drops client-address attributes and hashes
`enduser.id` as a second line of defence for "no PII in logs". Grafana: no anonymous access, no
sign-up, no telemetry or update checks; datasources are provisioned read-only and dashboards
load from `grafana/dashboards/` (empty for now). Loki, Tempo and Grafana usage reporting is off.

## TLS (Caddy)

`podman compose --profile tls up -d` with `PUBLIC_HOSTNAME=stream.example.org` in `.env`.
Routes: `/api/*`, `/rpc/*` → api; `/chat` → chat `/ws` (WebSocket); `/hls/*`, `/relay-pull/*`,
`/cdn/*` → origin; `/tracker` → tracker; everything else → web. `/internal/*` always answers 404. Headers: HSTS, CSP (`frame-ancestors 'none'`, except `/embed/*` which any site may
frame), nosniff, referrer and permissions policies; services may send a stricter CSP, which
wins. No access log (it would record viewer IPs). Set `PUBLIC_URL`, `API_PUBLIC_URL`,
`PLAYBACK_PUBLIC_URL` to `https://<host>`, `CHAT_PUBLIC_URL=wss://<host>/chat`,
`P2P_TRACKER_URL=wss://<host>/tracker` and `TRUSTED_PROXY_CIDRS` to the compose network's
subnet (`podman network inspect commonair_default`).

ACME needs ports 80 and 443 on the public address. Rootless Podman cannot bind them by default:
either `sysctl net.ipv4.ip_unprivileged_port_start=80` on the host and set
`CADDY_HTTP_PORT=80 CADDY_HTTPS_PORT=443`, or redirect 80/443 to 8080/8443 in the host
firewall.

## GPU transcoding

`media` uses NVENC when `TRANSCODE_HWACCEL=auto|nvenc` and a GPU is visible. With the NVIDIA
Container Toolkit's CDI spec installed, add `devices: ["nvidia.com/gpu=all"]` to `media` in a
local `compose.override.yaml` (Quadlet: uncomment `AddDevice=` in `commonair-media.container`).

## Production: Quadlet

Compose is the development path; `quadlet/` is the production path on systemd (rootless user
units). Same images, same config files, same variables.

```sh
git clone <repo> ~/commonair && cd ~/commonair     # units bind-mount config from %h/commonair/infra
bun scripts/init-env.ts --out ~/.config/commonair/commonair.env   # then edit: real SMTP, URLs …
IMAGE_TAG=latest podman compose build              # or pull released images and tag them
printf 'postgres://commonair_app:%s@postgres:5432/commonair' "$APP_PW" | podman secret create commonair-database-url -
printf 'postgres://commonair:%s@postgres:5432/commonair' "$OWNER_PW" | podman secret create commonair-owner-database-url -
printf '%s' "$GRAFANA_PW" | podman secret create commonair-grafana-admin-password -
mkdir -p ~/.config/containers/systemd && cp infra/quadlet/* ~/.config/containers/systemd/
systemctl --user daemon-reload && systemctl --user start commonair-caddy commonair-web
loginctl enable-linger "$USER"                     # keep running after logout
```

`DATABASE_URL` comes from the podman secret, so remove it from the env file (or set it to the
app-role URL). The env file must also contain `POSTGRES_PASSWORD`, `GARAGE_RPC_SECRET`,
`GARAGE_ADMIN_TOKEN`. Units declare `Notify=healthy`, so systemd orders dependents after their
dependencies are healthy; one-shot jobs are `Type=oneshot`. `mailpit`, `mock-rtmp` and
`stripe-mock` are development-only and have no unit. Caddy publishes 80/443 directly (see the
sysctl above).

## Tests

- `infra/tests/*.test.ts` (unit): compose policy (rootless rules, pinned licensed images,
  healthchecks, app role, no secret defaults), Caddy routes, Quadlet parity with compose,
  Garage bootstrap against a fake admin API, workspace closure, healthcheck probe.
- `infra/tests/stack.int.test.ts` (integration): a separate project `commonair-it-<rand>` with
  host ports +20000…: postgres (image build), valkey, garage, garage-init, mailpit, migrate.
  Asserts health, buckets + key via `@commonair/storage`, app-role limits (no TRUNCATE, no
  temp tables, no DDL, no history writes), idempotent re-runs, WAL archiving after
  `pg_switch_wal()`, and backup → restore with WAL replay. Always `down -v`; never touches
  the shared `commonair` project.

## `scripts/infra.ts test`

The integration tests of other packages need Garage too. `TEST_SERVICES` in `scripts/infra.ts`
should become `["postgres", "valkey", "mailpit", "garage", "garage-init", "migrate"]` and the
health wait should cover the long-running ones only (`postgres`, `valkey`, `mailpit`,
`garage`), then wait for `garage-init` and `migrate` to exit 0. Because `postgres` is now a
built image, run `podman compose build postgres tools`-equivalent first
(`podman compose build postgres garage-init`).
