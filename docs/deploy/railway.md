<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Staging on Railway

Railway is an **optional** host for a staging environment; production runs on a Hetzner dedicated
server ([hetzner.md](hetzner.md), ADR 0010). The platform's default, FOSS
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
| `evidence` (bucket)                                      | Railway bucket                                                 | Sealed evidence only; its own key, set on the worker alone (ADR 0006 Q4)                                                        |
| `valkey`                                                 | `ghcr.io/valkey-io/valkey` image                               | ephemeral by design, private only                                                                                               |
| `mailpit`                                                | `ghcr.io/axllent/mailpit` image                                | staging email sink; UI behind basic auth (`MP_UI_AUTH`)                                                                         |
| `migrate`                                                | tools image                                                    | runs migrations + app role on each deploy, then exits                                                                           |
| `mediamtx`                                               | `infra/mediamtx/Containerfile`                                 | RTMP ingest through a Railway TCP proxy; WHIP signaling on an HTTPS domain; HLS/RTSP/API private                                |
| `webrtc-tcp`                                             | tools image, `infra/railway/tcp-forward.ts`                    | owns the ICE-TCP TCP proxy and forwards it to MediaMTX (see [WebRTC on Railway](#webrtc-on-railway))                            |
| `web`, `api`, `chat`, `origin`, `irc`, `media`, `worker` | `infra/containers/service.Containerfile` (`SERVICE` build arg) | health checks on `/healthz` of each service's own port (`PORT`)                                                                 |

Public endpoints: generated HTTPS domains for `web` (3000), `api` (3001), `chat` (3002, WebSocket
`/ws`), `origin` (3003), `irc` (WebSocket listener, 6680), `mailpit` (UI, 8025) and `mediamtx` (WHIP,
8889); TCP proxies for RTMP (`mediamtx` 1935), ICE-TCP (`webrtc-tcp` 8189) and plain IRC (`irc` 6667). Internal URLs use Railway's private network
(`<service>.railway.internal`); new Railway environments are dual-stack, so the services' default
`0.0.0.0` binding works.

### Differences from compose (accepted for staging)

- **WebRTC/WHIP over ICE-TCP only**: Railway has no public UDP. Encoders that can only do
  WebRTC over UDP (ffmpeg's `whip` muxer, OBS up to 33.0) must use RTMP here; see below.
- **No media work-dir volume**: Railway volumes mount as root and the images run as `bun`; a
  recording in progress does not survive a restart of `media`.
- **No observability stack** (OTel collector, Prometheus, Loki, Tempo, Grafana). Logs are in
  Railway; Railway's own tracing can be enabled per service if wanted.
- **No P2P tracker** (`P2P_ENABLED=false`) — `services/tracker` is not built yet anywhere.
- **Bucket objects are private**: presigned uploads and downloads work; public media URLs
  (avatars, banners) do not until a public read path exists.
- Postgres is managed; the WAL-G image and `infra/postgres/backup.sh` are not used here.

## WebRTC on Railway

Railway exposes TCP (HTTP domains and TCP proxies) but no public UDP, so WHIP works here only
with ICE over TCP (RFC 6544, passive server candidates), which browsers support:

- **Signaling** (the WHIP `POST`/`PATCH`/`DELETE`) goes to MediaMTX's HTTPS domain, port 8889.
  `INGEST_WHIP_PUBLIC_URL` points there.
- **Media** goes to a TCP proxy owned by the `webrtc-tcp` service. MediaMTX writes the port it
  _listens_ on into its ICE-TCP candidate, but a Railway TCP proxy's public port is assigned by
  Railway and differs from the container port it targets. So MediaMTX listens on the proxy's
  public port (`MTX_WEBRTCLOCALTCPADDRESS=:${{webrtc-tcp.RAILWAY_TCP_PROXY_PORT}}`) and advertises
  the proxy host (`MTX_WEBRTCADDITIONALHOSTS`), while `webrtc-tcp` takes the proxy's traffic on 8189
  and forwards it byte for byte to MediaMTX on that port over the private network. A separate
  service keeps `RAILWAY_TCP_PROXY_PORT` unambiguous (MediaMTX's own proxy carries RTMP).

Who can publish over WHIP here:

| Client                               | Works on Railway | Why                                                                        |
| ------------------------------------ | ---------------- | -------------------------------------------------------------------------- |
| Browsers (Chromium, Firefox, Safari) | yes              | gather active TCP candidates                                               |
| OBS ≤ 33.0                           | no               | libjuice ICE is UDP-only; ICE-TCP is in obs-studio PR 12848 (33.1 tracker) |
| ffmpeg `whip` muxer                  | no               | picks the first UDP candidate only                                         |

So the `ingest-whip` harness scenario (ffmpeg) cannot run against staging; `ingest-rtmp` can. To
try WHIP on staging, publish from a browser to `https://<mediamtx domain>/live/<slug>/whip` with
the stream key as the bearer token. Compose keeps ICE over UDP 8189 and is unaffected.

## Status

The `commonair` project (workspace "Josh Shevach's Projects", environment `staging`) was created
and applied from this file on 2026-10-18; all twelve services deploy and pass their health checks,
and `railway config plan --detailed-exit-code` reports no drift. Find the generated domains with
`railway domain list --service <name>`; they are deliberately not recorded in the repository.
Notes from bring-up:

- Production mode requires the instance contact addresses; staging uses placeholders on the web
  domain (`contact@…`, `security@…`, …). Replace them before inviting anyone.
- IRC sets `IRC_TLS_ALLOW_SELF_SIGNED=true`: the TLS listener's port is not exposed on Railway,
  plain IRC goes through the TCP proxy and secure clients use the WebSocket listener over HTTPS.
- Restart policies equal to Railway's defaults are not stored and would show as drift forever, so
  the file only sets one where it differs (MediaMTX `ALWAYS`).
- The Mailpit UI login is the `MP_UI_AUTH` variable on the `mailpit` service.

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

# 3. Secrets (incl. the evidence keypair), bucket credentials and public domains (idempotent; --dry-run to preview).
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

Scenarios that read verification emails (`smoke`, `e2e-basic`) also need the Mailpit API, which
`MP_UI_AUTH` protects on staging:

```bash
export HARNESS_MAILPIT_URL=https://<mailpit domain>
export HARNESS_MAILPIT_AUTH="$(railway variables --service mailpit --kv | sed -n 's/^MP_UI_AUTH=//p')"
```

`HARNESS_MAILPIT_AUTH` is `user:password` (Mailpit's own format); credentials in the URL's
userinfo work too. The harness sends them as a basic-auth header and never logs them.
