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

| Service           | Image                                                                                                               | Role                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres`        | built: `postgres/Containerfile`                                                                                     | Postgres 17.11 + WAL-G v3.0.9, continuous WAL archiving to Garage                                                                                                                                          |
| `migrate`         | built: `tools`                                                                                                      | one-shot: migrations as the owner, then the `commonair_app` role                                                                                                                                           |
| `valkey`          | `ghcr.io/valkey-io/valkey:9.1.2-trixie`                                                                             | ephemeral state: presence, rate limits, caches, pub/sub, BullMQ                                                                                                                                            |
| `garage`          | `dxflrs/garage:v2.4.1`                                                                                              | S3 object storage (single node)                                                                                                                                                                            |
| `garage-init`     | built: `tools`                                                                                                      | one-shot: layout, key import, buckets (`garage/bootstrap.ts`, idempotent)                                                                                                                                  |
| `mailpit`         | `ghcr.io/axllent/mailpit:v1.31.6`                                                                                   | development SMTP sink (production uses a real SMTP server)                                                                                                                                                 |
| `mediamtx`        | `bluenviron/mediamtx:1.21.2-ffmpeg`                                                                                 | RTMP/WHIP ingest, LL-HLS, RTSP (config: `mediamtx/mediamtx.yml`, media unit); gets `INTERNAL_API_SECRET`, which it expands in its hooks; healthcheck probes RTMP because its API sits behind the auth hook |
| `api` … `tracker` | built: `containers/service.Containerfile`                                                                           | `api` (+FFmpeg), `chat`, `irc`, `origin`, `media` (+FFmpeg), `worker` (+FFmpeg), `tracker`                                                                                                                 |
| `web`             | built: same, `SERVICE=web`                                                                                          | TanStack Start build output (`vp build` in `apps/web`)                                                                                                                                                     |
| `otel-collector`  | built: probe over `ghcr.io/open-telemetry/opentelemetry-collector-releases/opentelemetry-collector-contrib:0.163.1` | OTLP in; traces → Tempo, metrics → Prometheus, logs → Loki                                                                                                                                                 |
| `prometheus`      | `quay.io/prometheus/prometheus:v3.15.0`                                                                             | metrics, 30 days                                                                                                                                                                                           |
| `loki`            | built: probe over `grafana/loki:3.7.8`                                                                              | logs (native OTLP ingest), 31 days                                                                                                                                                                         |
| `tempo`           | built: probe over `grafana/tempo:3.1.0`                                                                             | traces                                                                                                                                                                                                     |
| `grafana`         | `grafana/grafana:13.2.4` (OSS)                                                                                      | dashboards; datasources provisioned from `grafana/provisioning/`                                                                                                                                           |
| `caddy`           | `library/caddy:2.11.7-alpine`                                                                                       | profile `tls`: HTTPS for `PUBLIC_HOSTNAME`                                                                                                                                                                 |
| `mock-rtmp`       | `bluenviron/mediamtx:1.21.2-ffmpeg`                                                                                 | profile `harness`: fake simulcast target on :1936                                                                                                                                                          |
| `stripe-mock`     | `stripe/stripe-mock:v0.206.0`                                                                                       | profile `stripe`: Stripe API double                                                                                                                                                                        |

"probe" images (`containers/probe.Containerfile`) are the upstream image unchanged plus a
static BusyBox, because those images ship without a shell and a healthcheck needs `wget`.
Every image is pinned as `name:tag@sha256:<digest>` and listed with its license in
`image-licenses.json` (ADRs 0002 and 0022); `infra/tests/compose.test.ts`,
`bun scripts/check-licenses.ts` and `bun scripts/check-supply-chain.ts` enforce it. To bump an
image, change its tag, run `bun scripts/pin-images.ts --write`, and update its license entry.

Docker Hub limits anonymous pulls, which stalls fresh stacks and CI. Where the publisher also
pushes the same image to its own registry (Quay for Prometheus; GitHub's registry for Valkey,
Mailpit and the OTel collector), we pull it from there. The manifest digests were checked equal
to Docker Hub's at the pinned tags. Docker's official images (`library/*`) and images published
only on Docker Hub stay there; `podman login docker.io` raises their limit.

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

**Restart policy under podman-compose.** podman-compose turns every `depends_on` entry into
a hard `podman create --requires=…`, the one-shot `service_completed_successfully` jobs
included. Podman only applies a restart policy when every required container is _running_,
and `migrate` and `garage-init` have exited by design. So under `podman compose` an app
service that exits on its own (crash, OOM, uncaught error) stays `stopped` with RestartCount 0,
despite `restart: unless-stopped`. `podman ps` shows it as `Exited`. Containers without
`--requires`, or whose dependencies all keep running, restart normally. The services are
written to survive dependency restarts rather than relying on this: a Postgres restart or
crash recovery fails the queries in flight and the pool reconnects
(`packages/db/tests/reconnect.int.test.ts`). To bring a stopped service back, run
`podman start commonair_<service>_1` (manual start does accept exited dependencies) or
`bun scripts/infra.ts stack` again. Production is not affected: the Quadlet units run the
one-shots as `Type=oneshot` with `RemainAfterExit=yes` and the services with `Restart=always`
(see [Production: Quadlet](#production-quadlet)).

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

Our own images (the app services and the tools-image jobs) read `.env` (`env_file`, optional,
path overridable with `COMMONAIR_ENV_FILE`); third-party services get only the variables they use
through `environment:`. Compose overrides the hostnames for the compose network:
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
| `COMMONAIR_ENV_FILE`                        | `.env`                        | env file our own images read                               |

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

Browser uploads (channel images) and data-export downloads use presigned path-style URLs on
`S3_PUBLIC_ENDPOINT` (ADR 0024). In development that is the published Garage port
(`http://localhost:${GARAGE_S3_PORT}`). Behind Caddy it is the site itself, `https://<host>`
(`selfhost.sh` writes it; with the compose `tls` profile set it in `.env`): SigV4 signs the host
and the full path, so the bucket path is used on the main host unchanged, never under a stripped
prefix. Caddy forwards only two shapes to `garage:3900`, path and `Host` untouched:
`PUT /<S3_BUCKET_MEDIA>/incoming/*` with an `X-Amz-Signature` query parameter (body at most
10 MB, the upload contract's limit), and `GET`/`HEAD /<S3_BUCKET_EXPORTS>/*` with one. Anything
else on those paths (other methods, buckets or prefixes, unsigned requests, listings) reaches the
web app and gets a 404. Signed responses are not compressed, so Garage's `Content-Length` and
`ETag` pass through. The uploads are same-origin, so neither CORS nor the CSP needs changing. An
external S3 store with its own public endpoint instead needs CORS for the site's origin and that
origin in the CSP's `connect-src`.

Public media (avatars, thumbnails, clips, VODs) is read at `MEDIA_PUBLIC_URL`, by default the
origin's `/media` route (`http://localhost:3003/media`; `https://<host>/media` behind Caddy). The
origin reads the media bucket with the service key and serves only the public prefixes
(`channels/`, `clips/`, `thumbnails/`, `vods/`), never `incoming/` or `moderation/`. Garage
refuses anonymous reads on its S3 API, and its web endpoint stays off because it would publish
the whole bucket (ADR 0009).

## Backups (WAL-G)

The Postgres image adds WAL-G (glibc build for Ubuntu 24.04, which runs on Debian trixie;
SHA-256 for amd64 and arm64 pinned in the Containerfile and verified at build time) and runs
with `archive_mode=on`, `archive_command='timeout 20 wal-g wal-push %p'`, `archive_timeout=60`.
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
`P2P_TRACKER_URL=wss://<host>/tracker`. Services trust `x-forwarded-for` only from the compose
network (its fixed subnet `10.89.42.0/24`; a non-empty `TRUSTED_PROXY_CIDRS` overrides it), so the
web proxy and Caddy pass real client addresses through.

Certificates come from `TLS_MODE` (ADR 0023 §11): `acme` (the default) gets them from Let's
Encrypt, or from the directory in `ACME_CA`, with `ACME_EMAIL` for expiry notices; `internal`
uses Caddy's own CA, whose root is `/data/caddy/pki/authorities/local/root.crt` in the
`caddy-data` volume ([docs/self-hosting/tls.md](../docs/self-hosting/tls.md)).

ACME needs ports 80 and 443 on the public address. Rootless Podman cannot bind them by default:
either `sysctl net.ipv4.ip_unprivileged_port_start=80` on the host and set
`CADDY_HTTP_PORT=80 CADDY_HTTPS_PORT=443`, or redirect 80/443 to 8080/8443 in the host
firewall.

## GPU transcoding

`media` uses NVENC when `TRANSCODE_HWACCEL=auto|nvenc` and a GPU is visible. With the NVIDIA
Container Toolkit's CDI spec installed, add `devices: ["nvidia.com/gpu=all"]` to `media` in a
local `compose.override.yaml` (Quadlet: uncomment `AddDevice=` in `commonair-media.container`;
`selfhost.sh` replaces installed units on every install and upgrade, so a release install has no
supported way to keep that edit yet).

## Production: Quadlet

Compose is the development path; `quadlet/` is the production path on systemd (rootless user
units). Same images, same config files, same variables. Operators install a signed release with
`scripts/selfhost.sh`, which renders, installs and runs these units: the
[self-hosting guide](../docs/self-hosting/README.md) is the reference, and
[docs/deploy/hetzner.md](../docs/deploy/hetzner.md) the co-op's own production host (ADR 0010).
This section describes the units for people who change them.

### Units in the repository and rendered units

The units here name our images `Image=localhost/commonair/<name>:latest`, so they work with
images built from source, and the compose/Quadlet parity test compares like with like.
Third-party images are pinned `name:tag@sha256:…` in both. A release never ships these files
as they are: `scripts/selfhost/bundle.ts` renders every unit from the release manifest
(`scripts/selfhost/render.ts`), replacing each `localhost/commonair/<name>:latest` with
`<registry>/<name>:<version>@<digest>`, and refuses any other `localhost/` image
(ADR 0023 §6–7).

Rules every unit follows (ADR 0023 §10, checked by `infra/tests/quadlet.test.ts`):

- `RunInit=true` (catatonit as PID 1 reaps orphans; see the Postgres fix in PROGRESS session
  ten).
- Long-running units: `Restart=always`, `RestartMode=direct`, back-off from 5 s to 5 min
  (`RestartSteps=`, `RestartMaxDelaySec=`, systemd 254+), `StartLimitIntervalSec=0`, a health
  check with `HealthOnFailure=kill` and `Notify=healthy`.
- `Requires=` + `After=` only on the one-shots (`commonair-migrate`, `commonair-garage-init`,
  `Type=oneshot`, `RemainAfterExit=yes`, bounded retries). Long-running dependencies are
  `Wants=` + `After=`, so a failed start there does not fail dependents with result
  `dependency`, which `Restart=` never retries.
- No unit reads `%h/.config/commonair/commonair.env` whole. A unit with configuration runs
  `ExecStartPre=/bin/sh %h/commonair/scripts/selfhost/render-env.sh …`, which copies only the
  keys of its list (`selfhost/env/commonair-<unit>.keys`) to
  `%h/.config/commonair/unit-env/commonair-<unit>.env` (0600), and reads that file
  (`EnvironmentFile=`). It fails closed: without a readable `commonair.env` the unit does not
  start. The lists of our services are generated from their env schemas by
  `bun scripts/selfhost/unit-env.ts` (a test fails when they are stale); Valkey, Loki, Tempo,
  Prometheus and the collector get no env file. Internal hostnames and ports are `Environment=`
  lines, which win over the env file. `DATABASE_URL` comes from the Podman secrets
  `commonair-database-url` (app role) or `commonair-owner-database-url` (migrate), and
  Grafana's password from `commonair-grafana-admin-password`.
- Config files are bind-mounted from `%h/commonair/infra/…`. Other host mounts are under
  `%h/.local/share/commonair/` (hash lists, the moderation model) and
  `%h/.config/commonair/irc-tls/`.

Only Caddy (80/443 and 443/udp), MediaMTX RTMP (1935) and ICE (8189/udp), and IRC (6667/6697)
bind `0.0.0.0`; everything else stays on `127.0.0.1` (a test enforces the list). WHIP signaling
reaches MediaMTX through Caddy (`/live/<slug>/whip`), and MediaMTX advertises the addresses in
`MTX_WEBRTCADDITIONALHOSTS` as ICE candidates. `mailpit`, `mock-rtmp` and `stripe-mock` are
development-only and have no unit.

`commonair-irc-cert.container` is a one-shot that copies Caddy's certificate for
`IRC_PUBLIC_HOST` to the IRC unit's TLS mount (`irc/sync-cert.ts`, run in the `tools` image)
and restarts IRC when it changed. `systemd/` holds the plain user units Quadlet does not
generate: `commonair-backup.service` and `.timer` (daily WAL-G base backup) and
`commonair-irc-cert.timer` (runs the sync daily).

### Release directories

`selfhost.sh` keeps each installed release in `~/.local/share/commonair/releases/<version>/`
(the unpacked bundle: `selfhost.sh`, `release-manifest.json`, `release.env`, the rendered
`quadlet/`, `systemd/`, the mounted config files under `infra/`, the env renderer
`scripts/selfhost/render-env.sh` with the key lists in `infra/selfhost/env/`, and `tools/`).
Install removes the per-unit env files in `~/.config/commonair/unit-env/`; each unit writes its
own again when it starts. `~/commonair` is
a symlink to the current one and `~/.local/share/commonair/previous` to the one before, so the
units' `%h/commonair/infra/…` mounts follow the symlink, and a rollback is a symlink flip plus
the previous release's units. Install copies the rendered units to
`~/.config/containers/systemd/` and `~/.config/systemd/user/`, replacing every `commonair*`
file there. An upgrade keeps the current and the previous release and removes older ones.

### Building from source

To run the units with images you built yourself (to test a unit change on a real systemd host,
not for production):

```sh
git clone <repo> ~/src/commonair && cd ~/src/commonair && bun install
ln -s ~/src/commonair ~/commonair                     # the units mount %h/commonair/infra/…
IMAGE_TAG=latest podman compose build                 # localhost/commonair/<name>:latest
bun scripts/init-env.ts --out ~/.config/commonair/commonair.env   # then set the public URLs, SMTP, NODE_ENV …
bun scripts/fetch-model.ts --out ~/.local/share/commonair/models/adamcodd-vit-base-nsfw-detector-8587de99-int8.onnx
mkdir -p ~/.local/share/commonair/moderation ~/.config/commonair/irc-tls
touch ~/.local/share/commonair/moderation/csam.pdq ~/.local/share/commonair/moderation/ncii.pdq
printf 'postgres://commonair_app:%s@postgres:5432/commonair' "$APP_PW" | podman secret create commonair-database-url -
printf 'postgres://commonair:%s@postgres:5432/commonair' "$OWNER_PW" | podman secret create commonair-owner-database-url -
printf '%s' "$GRAFANA_PW" | podman secret create commonair-grafana-admin-password -
mkdir -p ~/.config/containers/systemd ~/.config/systemd/user
cp infra/quadlet/* ~/.config/containers/systemd/ && cp infra/systemd/* ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user start commonair-migrate              # migrations first, then everything else
systemctl --user start --no-block $(cd ~/.config/containers/systemd && ls commonair-*.container \
  | grep -v -e irc-cert -e migrate | sed 's/\.container$/.service/')
systemctl --user enable --now commonair-backup.timer commonair-irc-cert.timer
```

`APP_PW`, `OWNER_PW` and `GRAFANA_PW` are the env file's `POSTGRES_APP_PASSWORD`,
`POSTGRES_PASSWORD` and `GRAFANA_ADMIN_PASSWORD`. The host needs linger and the
unprivileged-port sysctl, as in [requirements.md](../docs/self-hosting/requirements.md). To test
the release path itself (render, bundle, install, upgrade, rollback) on a throwaway systemd
container instead, run `bun scripts/selfhost/e2e.ts` (its header lists what it needs).

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

The integration tests of other packages need Garage too. `scripts/infra.ts test` builds the
`postgres` and tools images, starts `postgres`, `valkey`, `mailpit`, `garage`, `garage-init` and
`migrate`, waits for the long-running ones to be healthy and for the two one-shot jobs to exit 0
(printing the job's logs if one fails).
