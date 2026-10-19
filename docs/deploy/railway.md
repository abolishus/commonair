<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Staging on Railway

Railway is an **optional** host for a staging environment. The platform's default, FOSS
deployment stays `podman compose` / Quadlet (`infra/README.md`); nothing in the code depends on
Railway. The Railway project is described as code in [`.railway/railway.ts`](../../.railway/railway.ts)
with Railway's Infrastructure as Code (TypeScript, generally available; the older
`railway.json`/`railway.toml` Config as Code is deprecated and stops being read on 2026-12-01, so
this repository never uses it). The SDK is the MIT-licensed `railway` npm package, pinned in the
root `package.json`.

## What runs

| Railway resource                                         | From                                                           | Notes                                                                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `postgres`                                               | Railway managed Postgres                                       | migrations run as its owner; services use the least-privilege `commonair_app` role (ADR 0004). Backups are Railway's, not WAL-G |
| `media` (bucket)                                         | Railway bucket                                                 | S3-compatible; one bucket holds media, exports and backups (keys are prefixed per kind)                                         |
| `valkey`                                                 | `valkey/valkey` image                                          | ephemeral by design, private only                                                                                               |
| `mailpit`                                                | `axllent/mailpit` image                                        | staging email sink; UI behind basic auth (`MP_UI_AUTH`)                                                                         |
| `migrate`                                                | tools image                                                    | runs migrations + app role on each deploy, then exits                                                                           |
| `mediamtx`                                               | `infra/mediamtx/Containerfile`                                 | RTMP ingest through a Railway TCP proxy; HLS/RTSP/API private                                                                   |
| `web`, `api`, `chat`, `origin`, `irc`, `media`, `worker` | `infra/containers/service.Containerfile` (`SERVICE` build arg) | health checks on `/healthz` of each service's own port (`PORT`)                                                                 |

Public endpoints: generated HTTPS domains for `web` (3000), `api` (3001), `chat` (3002, WebSocket
`/ws`), `origin` (3003), `irc` (WebSocket listener, 6680) and `mailpit` (UI, 8025); TCP proxies for
RTMP (`mediamtx` 1935) and plain IRC (`irc` 6667). Internal URLs use Railway's private network
(`<service>.railway.internal`); new Railway environments are dual-stack, so the services' default
`0.0.0.0` binding works.

### Differences from compose (accepted for staging)

- **No WebRTC/WHIP ingest**: Railway has no UDP. RTMP only.
- **No media work-dir volume**: Railway volumes mount as root and the images run as `bun`; a
  recording in progress does not survive a restart of `media`.
- **No observability stack** (OTel collector, Prometheus, Loki, Tempo, Grafana). Logs are in
  Railway; Railway's own tracing can be enabled per service if wanted.
- **No P2P tracker** (`P2P_ENABLED=false`) — `services/tracker` is not built yet anywhere.
- **Bucket objects are private**: presigned uploads and downloads work; public media URLs
  (avatars, banners) do not until a public read path exists.
- Postgres is managed; the WAL-G image and `infra/postgres/backup.sh` are not used here.

## First-time setup

Prerequisites: the Railway CLI (≥ 5.63), logged in (`railway login`), and Railway's GitHub app
installed on the repository so services can build from `main`.

```bash
# 1. Create (or pick) the project and a `staging` environment, and link this checkout to it.
railway init --name commonair            # or: railway link --project <name-or-id>
railway environment new staging          # skip if it exists
railway link --project commonair --environment staging

# 2. Review and apply the infrastructure.
railway config plan                      # read the whole plan
railway config apply                     # creates services, database, bucket

# 3. Secrets, bucket credentials and public domains (idempotent; --dry-run to preview).
bun scripts/railway-bootstrap.ts --environment staging

# 4. Redeploy so every service picks up its variables.
railway redeploy --service migrate --yes
for s in api chat origin irc media worker web mediamtx; do railway redeploy --service "$s" --yes; done
```

`railway config plan` must show only the changes you expect; values are redacted unless you pass
`--show-values`. Secrets are never in `.railway/railway.ts`: they are `preserve()`d there and set
by the bootstrap script through stdin.

## Ongoing changes

- Edit `.railway/railway.ts`, run `railway config plan`, review, then `railway config apply`.
- In CI, `railway config plan --detailed-exit-code` exits 2 when Railway has drifted from the file.
  To apply only a reviewed plan: `railway config plan --out railway-plan.json`, review, then
  `railway config apply --plan railway-plan.json --yes` (store the artifact outside `.railway/`; it
  may contain secrets). Railway maintains a GitHub Action for this (`railwayapp/config`); adding it
  is optional and needs a project token scoped to the staging environment.
- Code deploys follow pushes to `main` for every service built from the repository.

## Running the harness against staging

```bash
export HARNESS_WEB_URL=https://<web domain>
export HARNESS_API_URL=https://<api domain>
export HARNESS_ORIGIN_URL=https://<origin domain>
export HARNESS_RTMP_URL=rtmp://<mediamtx tcp proxy host>:<port>
export HARNESS_IRC_WS_URL=wss://<irc domain>
bun harness/src/cli.ts run smoke
```

Scenarios that read verification emails need the Mailpit API (`HARNESS_MAILPIT_URL`); the harness
does not yet send the Mailpit basic-auth credentials, so `smoke`/`e2e-basic` against staging need
that small harness change first.
