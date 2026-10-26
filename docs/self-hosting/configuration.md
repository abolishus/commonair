<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Configuration

An instance is configured by one env file: `~/.config/commonair/commonair.env`, owned by the
`commonair` user, mode 0600. `selfhost.sh install` writes it. It is the only file you edit and
back up: no container reads it whole. Each unit gets a copy of just the keys it needs (see
[Which unit sees which key](#which-unit-sees-which-key)).

## Changing a value

1. Edit the file. It takes one `KEY=value` per line, with no quotes and no comment after a
   value.
2. Apply it, either way:

   - Restart the units that read the key, e.g. `systemctl --user restart commonair-api`. Every
     unit copies its keys from `commonair.env` each time it starts, so a restart is enough for
     any key a unit reads from the file.
   - Or restart everything in order (migrations first):

     ```sh
     sh ~/commonair/selfhost.sh install --reinstall
     ```

     Without `--version` or `--bundle`, this reuses the installed release. It keeps every
     secret and edit. Use it after changing `POSTGRES_APP_PASSWORD`, `POSTGRES_PASSWORD` or
     `GRAFANA_ADMIN_PASSWORD`: it also recreates the Podman secrets made from them, which a
     restart does not.

   `selfhost.sh upgrade` applies every edit too, since it restarts the whole stack.

`install` and `upgrade` never overwrite a value you set, with these exceptions, which
`install` sets from its flags every time: the public URLs and `PUBLIC_HOSTNAME`,
`IRC_PUBLIC_HOST`, `NODE_ENV`, `TLS_MODE`, `ACME_EMAIL`, `MTX_WEBRTCADDITIONALHOSTS` (only when
you pass `--public-ip`) and `DATABASE_URL`. The contacts (`CONTACT_EMAIL` and the others) are
set from `--email` only while they are empty. Keys you add yourself are carried across
upgrades.

## How values are resolved

- **Services validate their environment at start** and refuse to boot on a bad value. The
  error names every bad variable (`journalctl --user -u commonair-api`, see
  [troubleshooting.md](troubleshooting.md)).
- **An empty value means unset**, so the default applies.
- **The units set some variables themselves** (internal hostnames, ports, the S3 endpoint, the
  OpenTelemetry endpoint, `TRUSTED_PROXY_CIDRS`). Those win over the env file, so editing them
  there has no effect. They are marked "set in the units" below.
- **Each unit sees only its own keys** ([below](#which-unit-sees-which-key)). A key a unit's
  list does not name never reaches that container, so setting it there has no effect on it.
- **Some secrets are scoped more tightly still.** Of the CommonAir services, only
  `commonair-api` sees `EVIDENCE_PRIVATE_KEY`, and only `commonair-worker` sees
  `S3_EVIDENCE_ACCESS_KEY_ID` and `S3_EVIDENCE_SECRET_ACCESS_KEY` (`commonair-garage-init` also
  reads them, to create that key). The other service units also set them to an empty value. The
  env file is still where they come from, so editing them there does take effect. They are
  marked "env file (blanked in units that must not see it)" below.
- **`DATABASE_URL` comes from a Podman secret** (`commonair-database-url`, the least-privilege
  app role), which `install` recreates from `POSTGRES_APP_PASSWORD` every time.
- **Production instances other than the co-op's flagship must publish their own contacts.**
  With `NODE_ENV=production` and `INSTANCE_IS_FLAGSHIP=false`, the services refuse to start
  unless `CONTACT_EMAIL`, `SECURITY_EMAIL`, `ABUSE_EMAIL`, `DMCA_EMAIL` and `PRIVACY_EMAIL` are
  set. `install` sets them from `--email`.

Never set `MODERATION_TEST_HOOKS`, `COOP_TEST_HOOKS`, `OPS_TEST_HOOKS`,
`EVENTSUB_ALLOW_INSECURE_CALLBACKS` or `OUTBOUND_ALLOW_PRIVATE_NETWORKS` on a public instance.
They exist for the test harness and development.

## Which unit sees which key

Before each start, a unit runs `~/commonair/scripts/selfhost/render-env.sh`, which copies the
keys the unit needs from `commonair.env` into `~/.config/commonair/unit-env/<unit>.env` (mode
0600), and the container reads that copy. The lists are in
`~/commonair/infra/selfhost/env/<unit>.keys`, one key per line (`MTX_*` means every key starting
with `MTX_`):

- **CommonAir services** (`commonair-api`, `-chat`, `-irc`, `-media`, `-origin`, `-tracker`,
  `-web`, `-worker`): every variable their configuration schema reads, generated from the
  schemas below, except the ones the unit sets itself.
- **Caddy**: `PUBLIC_HOSTNAME`, `TLS_MODE`, `ACME_EMAIL`, `ACME_CA`, `S3_BUCKET_MEDIA` and
  `S3_BUCKET_EXPORTS`. No secret at all.
- **MediaMTX**: `INTERNAL_API_SECRET` (its hooks call the API) and every `MTX_*` setting.
- **Postgres**: `POSTGRES_PASSWORD`, `POSTGRES_MAX_CONNECTIONS`, the S3 key and backup bucket
  WAL-G uses, and every `AWS_*` and `WALG_*` setting.
- **Garage**: `GARAGE_RPC_SECRET` and `GARAGE_ADMIN_TOKEN`. **Grafana**: every `GF_*` setting
  (its admin password is a Podman secret).
- **The jobs** `commonair-migrate`, `commonair-garage-init` and `commonair-irc-cert`: what their
  scripts read.
- Valkey, Loki, Tempo, Prometheus and the OpenTelemetry collector get no env file.

A key in `commonair.env` reaches a unit only if its list names it. The lists name every
variable the services read, and the prefixes cover the third-party images' own settings
(`MTX_*`, `GF_*`, `AWS_*`, `WALG_*`), so any documented setting works. The lists ship with each
release and an upgrade replaces them: do not edit them.

If `commonair.env` cannot be read (missing, unreadable, empty), the copy step fails and the
unit does not start, rather than starting without its settings. `journalctl --user -u
<unit>` shows `render-env:` and the reason.

## Variables outside the schemas

These are read by the third-party containers or the backup scripts, not by the CommonAir
services, so the reference below does not list them.

| Variable                    | Read by          | What it does                                                                                |
| --------------------------- | ---------------- | ------------------------------------------------------------------------------------------- |
| `MTX_WEBRTCADDITIONALHOSTS` | MediaMTX         | Addresses advertised to WHIP clients as ICE candidates, comma-separated. `install` sets it. |
| `AWS_ENDPOINT`              | WAL-G (Postgres) | S3 endpoint for backups, instead of the local Garage ([backups.md](backups.md))             |
| `AWS_REGION`                | WAL-G (Postgres) | Region of that endpoint (default: `S3_REGION`)                                              |
| `AWS_ACCESS_KEY_ID`         | WAL-G (Postgres) | Key for the backup bucket (default: `S3_ACCESS_KEY_ID`)                                     |
| `AWS_SECRET_ACCESS_KEY`     | WAL-G (Postgres) | Secret for the backup bucket (default: `S3_SECRET_ACCESS_KEY`)                              |
| `AWS_S3_FORCE_PATH_STYLE`   | WAL-G (Postgres) | Path-style S3 URLs (default `true`)                                                         |
| `WALG_S3_PREFIX`            | WAL-G (Postgres) | Where backups go (default `s3://<S3_BUCKET_BACKUPS>/wal`)                                   |

## Reference

Generated from `packages/config/src/env.ts` by `bun scripts/config-reference.ts`; do not edit
the tables by hand. Columns:

- **Required**: a service that reads this group refuses to start without it.
- **Default**: what applies when the variable is unset or empty.
- **Self-host**: "generated" means `install` writes a fresh random secret; "set by install"
  means `install` writes it from its flags; "set in the units" means the Quadlet units set it,
  which wins over the env file; "env file (blanked in units that must not see it)" means the
  value comes from the env file, and the units of services that must not hold it set it empty.

<!-- BEGIN GENERATED: bun scripts/config-reference.ts -->

### `coreEnv`

| Variable                      | Required | Default                                  | Self-host        | Description                                                                                                    |
| ----------------------------- | -------- | ---------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                    | no       | `development`                            | set by install   | `production` turns on the production checks (instance contacts, IRC TLS certificate files).                    |
| `LOG_LEVEL`                   | no       | `info`                                   | —                | Minimum level the services log.                                                                                |
| `PUBLIC_URL`                  | no       | `http://localhost:3000`                  | set by install   | Public base URL of the web app; links in mail, auth origins and the default noreply domain derive from it.     |
| `API_PUBLIC_URL`              | no       | `http://localhost:3001`                  | set by install   | Public base of the API as browsers, bots and relays reach it (no trailing slash).                              |
| `CHAT_PUBLIC_URL`             | no       | `ws://localhost:3002/ws`                 | set by install   | Public chat WebSocket URL.                                                                                     |
| `IRC_PUBLIC_HOST`             | no       | `localhost`                              | set by install   | Public IRC gateway host and ports shown in developer docs.                                                     |
| `INSTANCE_NAME`               | no       | `CommonAir`                              | —                | Name of this instance, shown in the UI, mail, legal documents and the IRC MOTD.                                |
| `INSTANCE_IS_FLAGSHIP`        | no       | `false`                                  | —                | Whether this is the co-op's flagship instance; in production, only the flagship may use the built-in contacts. |
| `CONTACT_EMAIL`               | no       | —                                        | set by install   | General contact address; required in production on instances other than the flagship.                          |
| `SECURITY_EMAIL`              | no       | —                                        | set by install   | Where security reports go; required in production on instances other than the flagship.                        |
| `ABUSE_EMAIL`                 | no       | —                                        | set by install   | Where abuse reports go; required in production on instances other than the flagship.                           |
| `DMCA_EMAIL`                  | no       | —                                        | set by install   | Where copyright (DMCA) notices go; required in production on instances other than the flagship.                |
| `PRIVACY_EMAIL`               | no       | —                                        | set by install   | Where privacy requests go; required in production on instances other than the flagship.                        |
| `NOREPLY_EMAIL`               | no       | —                                        | —                | Sender for automated mail; defaults to the flagship noreply on the flagship, else noreply@\<public host>.      |
| `SOURCE_URL`                  | no       | `https://github.com/abolishus/commonair` | —                | Repository URL of the running source code, linked from the UI, legal documents and the IRC MOTD (AGPL).        |
| `SOURCE_COMMIT`               | no       | `unknown`                                | —                | Commit of the running build, appended to the source link; set by the container image build.                    |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no       | —                                        | set in the units | OTLP/HTTP collector for traces and metrics; unset turns telemetry off.                                         |
| `OTEL_SERVICE_NAME`           | no       | —                                        | set in the units | Service name in telemetry; unset uses the service's own name (api, chat, …).                                   |
| `TRUSTED_PROXY_CIDRS`         | no       | (empty)                                  | set in the units | Proxies whose X-Forwarded-For is trusted (comma-separated CIDRs), e.g. Caddy's network.                        |

### `databaseEnv`

| Variable                    | Required | Default | Self-host                        | Description                                                                                                                                                                                    |
| --------------------------- | -------- | ------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | yes      | —       | set by install, set in the units | Postgres connection URL: the least-privilege app role for services, the owner role for migrations.                                                                                             |
| `DATABASE_POOL_MAX`         | no       | `10`    | —                                | Most Postgres connections each service process holds.                                                                                                                                          |
| `POSTGRES_APP_PASSWORD`     | no       | —       | generated                        | Password of the least-privilege application role (compose creates `commonair_app`).                                                                                                            |
| `GOVERNANCE_BOOTSTRAP_JSON` | no       | —       | —                                | First-run governance values (JSON: { "\<setting key>": { field: value } }), applied only when a setting does not exist yet. Lets a test instance use short review periods. Ignored afterwards. |

### `valkeyEnv`

| Variable     | Required | Default | Self-host                        | Description                                                                                                                                                                     |
| ------------ | -------- | ------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALKEY_URL` | yes      | —       | set by install, set in the units | Valkey (Redis protocol) URL for presence, caches, rate limits and job queues. With a password (VALKEY_PASSWORD), `redis://:\<password>@host:6379`: init-env writes it that way. |

### `internalEnv`

| Variable              | Required | Default                  | Self-host        | Description                                                                          |
| --------------------- | -------- | ------------------------ | ---------------- | ------------------------------------------------------------------------------------ |
| `INTERNAL_API_SECRET` | yes      | —                        | generated        | Shared secret for service-to-service calls (chat → api, media → api, worker → api).  |
| `API_INTERNAL_URL`    | no       | `http://localhost:3001`  | set in the units | API base URL other services and MediaMTX's hooks call on the internal network.       |
| `CHAT_INTERNAL_URL`   | no       | `ws://localhost:3002/ws` | set in the units | Chat WebSocket URL the IRC gateway connects to; the API health check also probes it. |
| `ORIGIN_INTERNAL_URL` | no       | `http://localhost:3003`  | set in the units | Origin base URL on the internal network; the API health check probes its `/readyz`.  |

### `storageEnv`

| Variable               | Required | Default                       | Self-host        | Description                                                                                                                                                                               |
| ---------------------- | -------- | ----------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `S3_ENDPOINT`          | yes      | —                             | set in the units | S3 endpoint the services use on the internal network (Garage by default).                                                                                                                 |
| `S3_PUBLIC_ENDPOINT`   | no       | —                             | set by install   | S3 endpoint browsers reach for presigned uploads and export downloads (not for public media); unset means S3_ENDPOINT. Self-hosted: `https://\<host>`, routed by Caddy (ADR 0024).        |
| `MEDIA_PUBLIC_URL`     | no       | `http://localhost:3003/media` | set by install   | Base URL of public media objects (`\<base>/\<key>`). The origin's `/media` route by default, which serves only the public key prefixes (ADR 0009); a CDN or public bucket may replace it. |
| `S3_REGION`            | no       | `garage`                      | set in the units | S3 region used to sign requests (`garage` for Garage).                                                                                                                                    |
| `S3_ACCESS_KEY_ID`     | yes      | —                             | generated        | S3 access key for the media, exports and backups buckets (not the evidence bucket).                                                                                                       |
| `S3_SECRET_ACCESS_KEY` | yes      | —                             | generated        | Secret of S3_ACCESS_KEY_ID.                                                                                                                                                               |
| `S3_FORCE_PATH_STYLE`  | no       | `true`                        | set in the units | Use path-style S3 URLs (`\<endpoint>/\<bucket>/\<key>`), as Garage needs.                                                                                                                 |
| `S3_BUCKET_MEDIA`      | no       | `commonair-media`             | —                | Bucket for public media (avatars, thumbnails, clips, VODs) and moderation frames.                                                                                                         |
| `S3_BUCKET_EXPORTS`    | no       | `commonair-exports`           | —                | Bucket for personal data export archives, which users download through presigned URLs.                                                                                                    |
| `S3_BUCKET_BACKUPS`    | no       | `commonair-backups`           | —                | Bucket for WAL-G Postgres backups (prefix `wal/` unless WALG_S3_PREFIX is set).                                                                                                           |
| `S3_BUCKET_EVIDENCE`   | no       | `commonair-evidence`          | —                | Sealed T0 evidence too large for Postgres (VOD and clip objects). Only the worker holds a key for it (`evidenceStorageEnv`); the main key has no access at all (ADR 0006 Q4).             |

### `authEnv`

| Variable                      | Required | Default | Self-host | Description                                                                                   |
| ----------------------------- | -------- | ------- | --------- | --------------------------------------------------------------------------------------------- |
| `AUTH_SECRET`                 | yes      | —       | generated | Secret that signs sessions and keys the HMACs of stored IP, device and mailbox hashes.        |
| `AUTH_TRUSTED_ORIGINS`        | no       | (empty) | —         | Origins besides PUBLIC_URL that auth and CORS accept (comma-separated).                       |
| `AUTH_MIN_AGE`                | no       | `13`    | —         | Minimum age to sign up, checked against the birth date; also filled into the legal documents. |
| `ALTCHA_HMAC_KEY`             | yes      | —       | generated | HMAC key for the ALTCHA proof-of-work challenges on sign-up and NCII reports.                 |
| `OAUTH_DISCORD_CLIENT_ID`     | no       | —       | —         | Discord OAuth client ID; sign-in with Discord is on when it and its secret are set.           |
| `OAUTH_DISCORD_CLIENT_SECRET` | no       | —       | —         | Discord OAuth client secret.                                                                  |
| `OAUTH_TWITCH_CLIENT_ID`      | no       | —       | —         | Twitch OAuth client ID; sign-in with Twitch is on when it and its secret are set.             |
| `OAUTH_TWITCH_CLIENT_SECRET`  | no       | —       | —         | Twitch OAuth client secret.                                                                   |
| `OAUTH_GITHUB_CLIENT_ID`      | no       | —       | —         | GitHub OAuth client ID; sign-in with GitHub is on when it and its secret are set.             |
| `OAUTH_GITHUB_CLIENT_SECRET`  | no       | —       | —         | GitHub OAuth client secret.                                                                   |

### `mailEnv`

| Variable           | Required | Default     | Self-host | Description                                                                                                   |
| ------------------ | -------- | ----------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| `SMTP_HOST`        | no       | `localhost` | —         | SMTP relay host for outgoing mail.                                                                            |
| `SMTP_PORT`        | no       | `1025`      | —         | SMTP relay port.                                                                                              |
| `SMTP_SECURE`      | no       | `false`     | —         | Connect with implicit TLS (usually port 465) instead of STARTTLS.                                             |
| `SMTP_REQUIRE_TLS` | no       | `false`     | —         | Refuse to send credentials or mail without TLS (STARTTLS). Leave false only for a local catcher like Mailpit. |
| `SMTP_USER`        | no       | —           | —         | SMTP username; when set, STARTTLS is required unless SMTP_SECURE is on.                                       |
| `SMTP_PASSWORD`    | no       | —           | —         | SMTP password for SMTP_USER.                                                                                  |
| `MAIL_FROM`        | no       | —           | —         | From header of outgoing mail; unset uses `"\<instance name>" \<NOREPLY_EMAIL>`.                               |

### `paymentsEnv`

| Variable                        | Required | Default                                    | Self-host | Description                                                                                                                                                               |
| ------------------------------- | -------- | ------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYMENTS_PROVIDER`             | no       | `manual`                                   | —         | `manual` (default, no vendor) or `stripe` (test mode only in this build).                                                                                                 |
| `STRIPE_SECRET_KEY`             | no       | —                                          | —         | Stripe test-mode secret key (`sk_test_`/`rk_test_`), used when PAYMENTS_PROVIDER=stripe; live keys are refused.                                                           |
| `STRIPE_WEBHOOK_SECRET`         | no       | —                                          | —         | Signing secret of the Stripe webhook endpoint for platform-account events.                                                                                                |
| `STRIPE_CONNECT_WEBHOOK_SECRET` | no       | —                                          | —         | Signing secret of the Connect webhook endpoint (connected accounts' `account.updated`).                                                                                   |
| `STRIPE_API_BASE`               | no       | —                                          | —         | Override the Stripe API base, e.g. a local stripe-mock in the harness.                                                                                                    |
| `CURRENCY`                      | no       | `usd`                                      | —         | Instance currency for prices and tips. Must equal the `payout.rules` governance setting's currency (the payout minimum, schedule and hold period live there, not in env). |
| `MANUAL_PAYMENT_INSTRUCTIONS`   | no       | `Send {amount} to the co-op treasurer an…` | —         | Manual adapter: what the payer is told after checkout. `{reference}` and `{amount}` are filled in. Operator text, shown as is (not translated).                           |
| `MANUAL_PAYOUT_INSTRUCTIONS`    | no       | `Contact the co-op treasurer to set up h…` | —         | Manual adapter: shown on the creator's payout settings until the treasurer enables payouts.                                                                               |
| `PAYMENT_PENDING_DAYS`          | no       | `7`                                        | —         | Days a pending (unconfirmed) payment stays open before it expires as failed.                                                                                              |

### `mediaEnv`

| Variable                        | Required | Default                      | Self-host        | Description                                                                                                                                                                        |
| ------------------------------- | -------- | ---------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEDIA_INTERNAL_PASSWORD`       | yes      | —                            | generated        | Password for the MediaMTX-internal user (origin and media read RTSP/HLS and publish renditions). Separate from INTERNAL_API_SECRET because it appears in ffmpeg process arguments. |
| `MEDIAMTX_API_URL`              | no       | `http://localhost:9997`      | set in the units | MediaMTX control API, used by media and by the API's health and live-moderation checks.                                                                                            |
| `MEDIAMTX_HLS_URL`              | no       | `http://localhost:8888`      | set in the units | MediaMTX HLS server the origin pulls playlists and segments from.                                                                                                                  |
| `MEDIAMTX_RTSP_URL`             | no       | `rtsp://localhost:8554`      | set in the units | MediaMTX RTSP server media reads streams from and publishes renditions to.                                                                                                         |
| `INGEST_RTMP_PUBLIC_URL`        | no       | `rtmp://localhost:1935/live` | set by install   | Public RTMP ingest URL shown to streamers (the server URL in OBS).                                                                                                                 |
| `INGEST_WHIP_PUBLIC_URL`        | no       | `http://localhost:8889/live` | set by install   | Public WHIP ingest base shown to streamers; `/\<channel>/whip` is appended.                                                                                                        |
| `TRANSCODE_VIEWER_THRESHOLD`    | no       | `50`                         | —                | Viewers above which a stream gets an adaptive ladder (after 30 s; it stops below 80% for 2 min).                                                                                   |
| `TRANSCODE_HWACCEL`             | no       | `auto`                       | —                | `auto` uses NVENC when a test encode works, else the CPU; `nvenc` refuses to start without it; `none` always uses the CPU.                                                         |
| `MEDIA_WORK_DIR`                | no       | —                            | set in the units | Scratch space for recordings, clip cuts and thumbnails (defaults to \<tmpdir>/commonair-media).                                                                                    |
| `MEDIA_WORK_DIR_MAX_BYTES`      | no       | `21474836480`                | —                | Most bytes the work dir may hold before new recordings and clips are refused (default 20 GiB).                                                                                     |
| `MEDIA_WORK_DIR_MIN_FREE_BYTES` | no       | `2147483648`                 | —                | Free space the work dir's filesystem must keep (default 2 GiB).                                                                                                                    |
| `TRANSCODE_MAX_LADDERS`         | no       | —                            | —                | Concurrent adaptive ladders per host; unset picks 2 with NVENC or one per 4 CPU cores.                                                                                             |

### `moderationEnv`

| Variable                      | Required | Default | Self-host        | Description                                                                                                                                                            |
| ----------------------------- | -------- | ------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODERATION_SAMPLE_SECONDS`   | no       | `10`    | —                | Seconds between sampled live frames; the effective interval is the smaller of this and the governance setting.                                                         |
| `MODERATION_HASHLIST_CSAM`    | no       | (empty) | set in the units | Operator CSAM hash list (one PDQ hex per line); empty = none (the database block list always loads).                                                                   |
| `MODERATION_HASHLIST_NCII`    | no       | (empty) | set in the units | Operator NCII hash list (StopNCII or similar), same format.                                                                                                            |
| `MODERATION_CLASSIFIER`       | no       | `onnx`  | —                | `onnx` (the default open-weight model) or `scripted` (test hooks only).                                                                                                |
| `MODERATION_CLASSIFIER_MODEL` | no       | (empty) | set in the units | Path to the ONNX model; empty = the path `bun scripts/fetch-model.ts` writes. Checked by sha256 on load.                                                               |
| `MODERATION_TEST_HOOKS`       | no       | `false` | —                | Harness only, never on a public instance: allows the scripted classifier and the `/internal/moderation/*` hooks. Services log a warning at every start while it is on. |

### `coopEnv`

| Variable          | Required | Default | Self-host | Description                                                                  |
| ----------------- | -------- | ------- | --------- | ---------------------------------------------------------------------------- |
| `COOP_TEST_HOOKS` | no       | `false` | —         | Harness only: serves `POST /internal/coop/tick`. Never on a public instance. |

### `opsEnv`

| Variable         | Required | Default | Self-host | Description                                                                 |
| ---------------- | -------- | ------- | --------- | --------------------------------------------------------------------------- |
| `OPS_TEST_HOOKS` | no       | `false` | —         | Harness only: serves `POST /internal/ops/tick`. Never on a public instance. |

### `evidenceSealEnv`

| Variable              | Required | Default | Self-host | Description                                                                            |
| --------------------- | -------- | ------- | --------- | -------------------------------------------------------------------------------------- |
| `EVIDENCE_PUBLIC_KEY` | yes      | —       | generated | Evidence public key (raw 32-byte X25519, base64) that sealed evidence is encrypted to. |

### `evidenceOpenEnv`

| Variable               | Required | Default | Self-host                                                   | Description                                                                                                       |
| ---------------------- | -------- | ------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `EVIDENCE_PRIVATE_KEY` | yes      | —       | generated, env file (blanked in units that must not see it) | Evidence private key (X25519 PKCS#8 DER, base64); keep an offline copy, sealed evidence is unreadable without it. |

### `evidenceStorageEnv`

| Variable                        | Required | Default | Self-host                                                   | Description                                 |
| ------------------------------- | -------- | ------- | ----------------------------------------------------------- | ------------------------------------------- |
| `S3_EVIDENCE_ACCESS_KEY_ID`     | yes      | —       | generated, env file (blanked in units that must not see it) | S3 access key for the evidence bucket only. |
| `S3_EVIDENCE_SECRET_ACCESS_KEY` | yes      | —       | generated, env file (blanked in units that must not see it) | Secret of S3_EVIDENCE_ACCESS_KEY_ID.        |

### `playbackEnv`

| Variable                     | Required | Default                 | Self-host      | Description                                                                               |
| ---------------------------- | -------- | ----------------------- | -------------- | ----------------------------------------------------------------------------------------- |
| `PLAYBACK_SIGNING_KEY`       | yes      | —                       | generated      | Ed25519 private key (PKCS#8 DER, base64) used to sign playback/segment tokens.            |
| `PLAYBACK_PUBLIC_URL`        | no       | `http://localhost:3003` | set by install | Public origin of the HLS edge (origin service), no trailing slash.                        |
| `P2P_ENABLED`                | no       | `true`                  | —              | Offer peer-to-peer segment sharing to players that support it (not native HLS).           |
| `P2P_TRACKER_URL`            | no       | `ws://localhost:8000`   | set by install | Tracker base URL handed to players (the API appends `?t=\<playback token>`).              |
| `CDN_PROVIDER`               | no       | `none`                  | —              | Optional burst CDN (origin-pull). Disabled by default.                                    |
| `CDN_BASE_URL`               | no       | —                       | —              | Public base URL of the origin-pull CDN; CDN_PROVIDER=origin-pull does nothing without it. |
| `CDN_BURST_VIEWER_THRESHOLD` | no       | `5000`                  | —              | Verified viewers above which a channel's new sessions are sent to the CDN.                |
| `ORIGIN_CACHE_MB`            | no       | `512`                   | —              | Size of the origin's in-memory segment and playlist cache, in MB.                         |
| `ORIGIN_ISSUANCE_ENABLED`    | no       | `true`                  | —              | Compute relay issuance on this origin; replicas elect one leader per tick through Valkey. |

### `integrityEnv`

| Variable                          | Required | Default | Self-host | Description                                                                           |
| --------------------------------- | -------- | ------- | --------- | ------------------------------------------------------------------------------------- |
| `INTEGRITY_DATACENTER_CIDRS_FILE` | no       | —       | —         | Operator-supplied hosting-provider CIDR list (one per line) for datacenter detection. |

### `developerEnv`

| Variable                            | Required | Default | Self-host | Description                                                                                                                                                                              |
| ----------------------------------- | -------- | ------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVENTSUB_ALLOW_INSECURE_CALLBACKS` | no       | `false` | —         | Allow http:// and private-network EventSub webhook callbacks. Development and harness only.                                                                                              |
| `OUTBOUND_ALLOW_PRIVATE_NETWORKS`   | no       | `false` | —         | Allow relay URLs and simulcast targets on private, loopback and other non-public networks (and plain http relays). Development and harness only: the local stack runs on such addresses. |

### `workerEnv`

| Variable             | Required | Default | Self-host | Description                                                                          |
| -------------------- | -------- | ------- | --------- | ------------------------------------------------------------------------------------ |
| `WORKER_CONCURRENCY` | no       | (empty) | —         | Per-queue concurrency, e.g. "webhooks=32,retention=1". Unlisted queues use defaults. |
| `WORKER_BULL_PREFIX` | no       | `bull`  | —         | BullMQ key prefix in Valkey.                                                         |

### `infraEnv`

| Variable                   | Required | Default | Self-host      | Description                                                                                                                                                                                                                                          |
| -------------------------- | -------- | ------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`        | no       | —       | generated      | Password of the Postgres owner role `commonair` (migrations and backups).                                                                                                                                                                            |
| `GARAGE_RPC_SECRET`        | no       | —       | generated      | Garage requires exactly 64 hex characters.                                                                                                                                                                                                           |
| `GARAGE_ADMIN_TOKEN`       | no       | —       | generated      | Bearer token for Garage's admin API, used by garage-init to create buckets and keys.                                                                                                                                                                 |
| `GRAFANA_ADMIN_PASSWORD`   | no       | —       | generated      | Password of Grafana's `admin` user; Grafana refuses to start without it.                                                                                                                                                                             |
| `VALKEY_PASSWORD`          | no       | —       | generated      | Password Valkey requires (`requirepass`). Empty runs Valkey without one (development only; the self-hosted unit refuses to start without it). It goes into VALKEY_URL unescaped, so only URL-safe characters (init-env generates 64 hex characters). |
| `BIND_ADDRESS`             | no       | —       | —              | Host interface for published ports (default 127.0.0.1).                                                                                                                                                                                              |
| `PUBLIC_HOSTNAME`          | no       | —       | set by install | Public hostname Caddy serves with TLS (profile `tls`).                                                                                                                                                                                               |
| `TLS_MODE`                 | no       | —       | set by install | Caddy's certificate source (ADR 0023): `acme` (default) gets a publicly trusted certificate for PUBLIC_HOSTNAME; `internal` uses Caddy's own CA for LAN and test hosts.                                                                              |
| `ACME_EMAIL`               | no       | —       | set by install | Account email for ACME expiry notices (optional).                                                                                                                                                                                                    |
| `ACME_CA`                  | no       | —       | —              | ACME directory URL override, e.g. a staging CA (default: Let's Encrypt production; no ZeroSSL fallback).                                                                                                                                             |
| `IMAGE_REGISTRY`           | no       | —       | —              | Compose only: registry and namespace of the CommonAir images (default `localhost/commonair`).                                                                                                                                                        |
| `IMAGE_TAG`                | no       | —       | —              | Compose only: tag of the CommonAir images (default `dev`).                                                                                                                                                                                           |
| `WALG_RETAIN_FULL`         | no       | —       | —              | Full backups `commonair-backup` keeps; older ones are pruned (unset keeps all).                                                                                                                                                                      |
| `POSTGRES_MAX_CONNECTIONS` | no       | —       | —              | Postgres `max_connections` (compose default 400: parallel integration suites hold many pools).                                                                                                                                                       |
| `COMPOSE_SUBNET`           | no       | —       | —              | Compose network subnet (default 10.89.42.0/24); a second stack on one host needs its own.                                                                                                                                                            |
| `COMMONAIR_ENV_FILE`       | no       | —       | —              | Compose only: path of the env file our own images read; third-party services do not (default `.env`).                                                                                                                                                |

### `servicePorts`

| Variable                    | Required | Default | Self-host        | Description                                                                                                                                                         |
| --------------------------- | -------- | ------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEB_PORT`                  | no       | `3000`  | set in the units | Port the web server listens on.                                                                                                                                     |
| `API_PORT`                  | no       | `3001`  | set in the units | Port the API listens on.                                                                                                                                            |
| `CHAT_PORT`                 | no       | `3002`  | set in the units | Port the chat WebSocket service listens on.                                                                                                                         |
| `ORIGIN_PORT`               | no       | `3003`  | set in the units | Port the HLS origin listens on.                                                                                                                                     |
| `IRC_PORT`                  | no       | `6667`  | set in the units | Plain-TCP IRC port.                                                                                                                                                 |
| `IRC_TLS_PORT`              | no       | `6697`  | set in the units | IRC over TLS port.                                                                                                                                                  |
| `IRC_WS_PORT`               | no       | `6680`  | set in the units | IRC over WebSocket port (what tmi.js uses).                                                                                                                         |
| `IRC_HEALTH_PORT`           | no       | `6681`  | set in the units | HTTP port of the IRC gateway's `/healthz`, `/readyz` and `/stats`.                                                                                                  |
| `MEDIA_PORT`                | no       | `3004`  | set in the units | Port of the media service's health endpoints.                                                                                                                       |
| `WORKER_PORT`               | no       | `3005`  | set in the units | Port of the worker's health endpoints.                                                                                                                              |
| `TRACKER_PORT`              | no       | `8000`  | set in the units | Port the WebTorrent tracker listens on (WebSocket and health).                                                                                                      |
| `IRC_TLS_CERT_FILE`         | no       | —       | set in the units | PEM certificate for the IRC TLS listener; set with IRC_TLS_KEY_FILE (required in production unless self-signed is allowed).                                         |
| `IRC_TLS_KEY_FILE`          | no       | —       | set in the units | PEM private key for IRC_TLS_CERT_FILE.                                                                                                                              |
| `IRC_TLS_ALLOW_SELF_SIGNED` | no       | `false` | —                | Let a production instance run the IRC TLS listener on an ephemeral self-signed certificate when no files are configured. For hosts that do not expose the TLS port. |

### `ircEnv`

| Variable                        | Required | Default | Self-host | Description                                                                   |
| ------------------------------- | -------- | ------- | --------- | ----------------------------------------------------------------------------- |
| `IRC_MAX_CONNECTIONS`           | no       | `20000` | —         | Most IRC connections per process; more are refused.                           |
| `IRC_MAX_CONNECTIONS_PER_IP`    | no       | `50`    | —         | Most IRC connections from one client address.                                 |
| `IRC_CONNECT_BURST_PER_IP`      | no       | `20`    | —         | Token bucket for new connections per client address: the burst size.          |
| `IRC_CONNECT_PER_SECOND_PER_IP` | no       | `2`     | —         | Sustained new IRC connections per second per client address, after the burst. |

### `trackerEnv`

| Variable                         | Required | Default | Self-host | Description                                                                                                                                                                          |
| -------------------------------- | -------- | ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TRACKER_MAX_CONNECTIONS`        | no       | `20000` | —         | Most tracker sockets per process; more are refused with 503.                                                                                                                         |
| `TRACKER_MAX_CONNECTIONS_PER_IP` | no       | `20`    | —         | Most tracker sockets from one client address; more are refused with 429.                                                                                                             |
| `TRACKER_MAX_NUMWANT`            | no       | `20`    | —         | Most peers (offers) relayed per announce, whatever `numwant` asks for.                                                                                                               |
| `TRACKER_TOKEN_MAX_AGE_SECONDS`  | no       | `43200` | —         | Oldest playback token (by `iat`) accepted at connect. Tokens live 120 s but a tracker socket outlives them; the tracker also requires the session to be heartbeating (KEYS.viewers). |

<!-- END GENERATED -->
