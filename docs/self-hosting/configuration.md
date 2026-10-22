<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Configuration

An instance is configured by one env file: `~/.config/commonair/commonair.env`, owned by the
`commonair` user, mode 0600. `selfhost.sh install` writes it, and every container reads it.

## Changing a value

1. Edit the file. It takes one `KEY=value` per line, with no quotes and no comment after a
   value.
2. Apply it:

   ```sh
   sh ~/commonair/selfhost.sh install --reinstall
   ```

   Without `--version` or `--bundle`, this reuses the installed release. It keeps every secret
   and edit, recreates the Podman secrets, and restarts the stack in order (migrations first).

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
- **`DATABASE_URL` comes from a Podman secret** (`commonair-database-url`, the least-privilege
  app role), which `install` recreates from `POSTGRES_APP_PASSWORD` every time.
- **Production instances other than the co-op's flagship must publish their own contacts.**
  With `NODE_ENV=production` and `INSTANCE_IS_FLAGSHIP=false`, the services refuse to start
  unless `CONTACT_EMAIL`, `SECURITY_EMAIL`, `ABUSE_EMAIL`, `DMCA_EMAIL` and `PRIVACY_EMAIL` are
  set. `install` sets them from `--email`.

Never set `MODERATION_TEST_HOOKS`, `COOP_TEST_HOOKS`, `OPS_TEST_HOOKS`,
`EVENTSUB_ALLOW_INSECURE_CALLBACKS` or `OUTBOUND_ALLOW_PRIVATE_NETWORKS` on a public instance.
They exist for the test harness and development.

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
  which wins over the env file.

<!-- BEGIN GENERATED: bun scripts/config-reference.ts -->

### `coreEnv`

| Variable                      | Required | Default                                  | Self-host        | Description                                                                                               |
| ----------------------------- | -------- | ---------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                    | no       | `development`                            | set by install   | —                                                                                                         |
| `LOG_LEVEL`                   | no       | `info`                                   | —                | —                                                                                                         |
| `PUBLIC_URL`                  | no       | `http://localhost:3000`                  | set by install   | —                                                                                                         |
| `API_PUBLIC_URL`              | no       | `http://localhost:3001`                  | set by install   | Public base of the API as browsers, bots and relays reach it (no trailing slash).                         |
| `CHAT_PUBLIC_URL`             | no       | `ws://localhost:3002/ws`                 | set by install   | Public chat WebSocket URL.                                                                                |
| `IRC_PUBLIC_HOST`             | no       | `localhost`                              | set by install   | Public IRC gateway host and ports shown in developer docs.                                                |
| `INSTANCE_NAME`               | no       | `CommonAir`                              | —                | —                                                                                                         |
| `INSTANCE_IS_FLAGSHIP`        | no       | `false`                                  | —                | —                                                                                                         |
| `CONTACT_EMAIL`               | no       | —                                        | set by install   | —                                                                                                         |
| `SECURITY_EMAIL`              | no       | —                                        | set by install   | —                                                                                                         |
| `ABUSE_EMAIL`                 | no       | —                                        | set by install   | —                                                                                                         |
| `DMCA_EMAIL`                  | no       | —                                        | set by install   | —                                                                                                         |
| `PRIVACY_EMAIL`               | no       | —                                        | set by install   | —                                                                                                         |
| `NOREPLY_EMAIL`               | no       | —                                        | —                | Sender for automated mail; defaults to the flagship noreply on the flagship, else noreply@\<public host>. |
| `SOURCE_URL`                  | no       | `https://github.com/abolishus/commonair` | —                | —                                                                                                         |
| `SOURCE_COMMIT`               | no       | `unknown`                                | —                | —                                                                                                         |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | no       | —                                        | set in the units | —                                                                                                         |
| `OTEL_SERVICE_NAME`           | no       | —                                        | set in the units | —                                                                                                         |
| `TRUSTED_PROXY_CIDRS`         | no       | (empty)                                  | set in the units | Proxies whose X-Forwarded-For is trusted (comma-separated CIDRs), e.g. Caddy's network.                   |

### `databaseEnv`

| Variable                    | Required | Default | Self-host                        | Description                                                                                                                                                                                    |
| --------------------------- | -------- | ------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | yes      | —       | set by install, set in the units | —                                                                                                                                                                                              |
| `DATABASE_POOL_MAX`         | no       | `10`    | —                                | —                                                                                                                                                                                              |
| `POSTGRES_APP_PASSWORD`     | no       | —       | generated                        | Password of the least-privilege application role (compose creates `commonair_app`).                                                                                                            |
| `GOVERNANCE_BOOTSTRAP_JSON` | no       | —       | —                                | First-run governance values (JSON: { "\<setting key>": { field: value } }), applied only when a setting does not exist yet. Lets a test instance use short review periods. Ignored afterwards. |

### `valkeyEnv`

| Variable     | Required | Default | Self-host        | Description |
| ------------ | -------- | ------- | ---------------- | ----------- |
| `VALKEY_URL` | yes      | —       | set in the units | —           |

### `internalEnv`

| Variable              | Required | Default                  | Self-host        | Description                                                                         |
| --------------------- | -------- | ------------------------ | ---------------- | ----------------------------------------------------------------------------------- |
| `INTERNAL_API_SECRET` | yes      | —                        | generated        | Shared secret for service-to-service calls (chat → api, media → api, worker → api). |
| `API_INTERNAL_URL`    | no       | `http://localhost:3001`  | set in the units | —                                                                                   |
| `CHAT_INTERNAL_URL`   | no       | `ws://localhost:3002/ws` | set in the units | —                                                                                   |
| `ORIGIN_INTERNAL_URL` | no       | `http://localhost:3003`  | set in the units | —                                                                                   |

### `storageEnv`

| Variable               | Required | Default                       | Self-host        | Description                                                                                                                                                                               |
| ---------------------- | -------- | ----------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `S3_ENDPOINT`          | yes      | —                             | set in the units | —                                                                                                                                                                                         |
| `S3_PUBLIC_ENDPOINT`   | no       | —                             | —                | S3 endpoint browsers reach for presigned uploads and downloads (not for public media).                                                                                                    |
| `MEDIA_PUBLIC_URL`     | no       | `http://localhost:3003/media` | set by install   | Base URL of public media objects (`\<base>/\<key>`). The origin's `/media` route by default, which serves only the public key prefixes (ADR 0009); a CDN or public bucket may replace it. |
| `S3_REGION`            | no       | `garage`                      | set in the units | —                                                                                                                                                                                         |
| `S3_ACCESS_KEY_ID`     | yes      | —                             | generated        | —                                                                                                                                                                                         |
| `S3_SECRET_ACCESS_KEY` | yes      | —                             | generated        | —                                                                                                                                                                                         |
| `S3_FORCE_PATH_STYLE`  | no       | `true`                        | set in the units | —                                                                                                                                                                                         |
| `S3_BUCKET_MEDIA`      | no       | `commonair-media`             | —                | —                                                                                                                                                                                         |
| `S3_BUCKET_EXPORTS`    | no       | `commonair-exports`           | —                | —                                                                                                                                                                                         |
| `S3_BUCKET_BACKUPS`    | no       | `commonair-backups`           | —                | —                                                                                                                                                                                         |
| `S3_BUCKET_EVIDENCE`   | no       | `commonair-evidence`          | —                | Sealed T0 evidence too large for Postgres (VOD and clip objects). Only the worker holds a key for it (`evidenceStorageEnv`); the main key has no access at all (ADR 0006 Q4).             |

### `authEnv`

| Variable                      | Required | Default | Self-host | Description                                                                                        |
| ----------------------------- | -------- | ------- | --------- | -------------------------------------------------------------------------------------------------- |
| `AUTH_SECRET`                 | yes      | —       | generated | —                                                                                                  |
| `AUTH_TRUSTED_ORIGINS`        | no       | (empty) | —         | —                                                                                                  |
| `AUTH_MIN_AGE`                | no       | `13`    | —         | —                                                                                                  |
| `ALTCHA_HMAC_KEY`             | yes      | —       | generated | —                                                                                                  |
| `OAUTH_DISCORD_CLIENT_ID`     | no       | —       | —         | Optional OAuth providers. Leave blank to disable; operators turn each on by supplying credentials. |
| `OAUTH_DISCORD_CLIENT_SECRET` | no       | —       | —         | —                                                                                                  |
| `OAUTH_TWITCH_CLIENT_ID`      | no       | —       | —         | —                                                                                                  |
| `OAUTH_TWITCH_CLIENT_SECRET`  | no       | —       | —         | —                                                                                                  |
| `OAUTH_GITHUB_CLIENT_ID`      | no       | —       | —         | —                                                                                                  |
| `OAUTH_GITHUB_CLIENT_SECRET`  | no       | —       | —         | —                                                                                                  |

### `mailEnv`

| Variable           | Required | Default     | Self-host | Description                                                                                                   |
| ------------------ | -------- | ----------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| `SMTP_HOST`        | no       | `localhost` | —         | —                                                                                                             |
| `SMTP_PORT`        | no       | `1025`      | —         | —                                                                                                             |
| `SMTP_SECURE`      | no       | `false`     | —         | —                                                                                                             |
| `SMTP_REQUIRE_TLS` | no       | `false`     | —         | Refuse to send credentials or mail without TLS (STARTTLS). Leave false only for a local catcher like Mailpit. |
| `SMTP_USER`        | no       | —           | —         | —                                                                                                             |
| `SMTP_PASSWORD`    | no       | —           | —         | —                                                                                                             |
| `MAIL_FROM`        | no       | —           | —         | —                                                                                                             |

### `paymentsEnv`

| Variable                        | Required | Default                                    | Self-host | Description                                                                                                                                                               |
| ------------------------------- | -------- | ------------------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYMENTS_PROVIDER`             | no       | `manual`                                   | —         | `manual` (default, no vendor) or `stripe` (test mode only in this build).                                                                                                 |
| `STRIPE_SECRET_KEY`             | no       | —                                          | —         | —                                                                                                                                                                         |
| `STRIPE_WEBHOOK_SECRET`         | no       | —                                          | —         | —                                                                                                                                                                         |
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
| `MEDIAMTX_API_URL`              | no       | `http://localhost:9997`      | set in the units | —                                                                                                                                                                                  |
| `MEDIAMTX_HLS_URL`              | no       | `http://localhost:8888`      | set in the units | —                                                                                                                                                                                  |
| `MEDIAMTX_RTSP_URL`             | no       | `rtsp://localhost:8554`      | set in the units | —                                                                                                                                                                                  |
| `MEDIAMTX_RTMP_URL`             | no       | `rtmp://localhost:1935`      | set in the units | —                                                                                                                                                                                  |
| `INGEST_RTMP_PUBLIC_URL`        | no       | `rtmp://localhost:1935/live` | set by install   | Public ingest endpoints shown to streamers.                                                                                                                                        |
| `INGEST_WHIP_PUBLIC_URL`        | no       | `http://localhost:8889/live` | set by install   | —                                                                                                                                                                                  |
| `TRANSCODE_VIEWER_THRESHOLD`    | no       | `50`                         | —                | —                                                                                                                                                                                  |
| `TRANSCODE_HWACCEL`             | no       | `auto`                       | —                | —                                                                                                                                                                                  |
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

| Variable          | Required | Default | Self-host | Description                                                                |
| ----------------- | -------- | ------- | --------- | -------------------------------------------------------------------------- |
| `COOP_TEST_HOOKS` | no       | `false` | —         | Harness only. Never on a public instance: serves POST /internal/coop/tick. |

### `opsEnv`

| Variable         | Required | Default | Self-host | Description                                                               |
| ---------------- | -------- | ------- | --------- | ------------------------------------------------------------------------- |
| `OPS_TEST_HOOKS` | no       | `false` | —         | Harness only. Never on a public instance: serves POST /internal/ops/tick. |

### `evidenceSealEnv`

| Variable              | Required | Default | Self-host | Description                                                                                                                                                                                                   |
| --------------------- | -------- | ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVIDENCE_PUBLIC_KEY` | yes      | —       | generated | X25519 evidence keypair. Media, worker and API seal with the public key; only the API's legal view holds the private key. Keep an offline copy of the private key: sealed evidence cannot be read without it. |

### `evidenceOpenEnv`

| Variable               | Required | Default | Self-host                   | Description |
| ---------------------- | -------- | ------- | --------------------------- | ----------- |
| `EVIDENCE_PRIVATE_KEY` | yes      | —       | generated, set in the units | —           |

### `evidenceStorageEnv`

| Variable                        | Required | Default | Self-host                   | Description |
| ------------------------------- | -------- | ------- | --------------------------- | ----------- |
| `S3_EVIDENCE_ACCESS_KEY_ID`     | yes      | —       | generated, set in the units | —           |
| `S3_EVIDENCE_SECRET_ACCESS_KEY` | yes      | —       | generated, set in the units | —           |

### `playbackEnv`

| Variable                     | Required | Default                 | Self-host      | Description                                                                               |
| ---------------------------- | -------- | ----------------------- | -------------- | ----------------------------------------------------------------------------------------- |
| `PLAYBACK_SIGNING_KEY`       | yes      | —                       | generated      | Ed25519 private key (PKCS#8 DER, base64) used to sign playback/segment tokens.            |
| `PLAYBACK_PUBLIC_URL`        | no       | `http://localhost:3003` | set by install | Public origin of the HLS edge (origin service), no trailing slash.                        |
| `P2P_ENABLED`                | no       | `true`                  | —              | —                                                                                         |
| `P2P_TRACKER_URL`            | no       | `ws://localhost:8000`   | set by install | Tracker base URL handed to players (the API appends `?t=\<playback token>`).              |
| `CDN_PROVIDER`               | no       | `none`                  | —              | Optional burst CDN (origin-pull). Disabled by default.                                    |
| `CDN_BASE_URL`               | no       | —                       | —              | —                                                                                         |
| `CDN_BURST_VIEWER_THRESHOLD` | no       | `5000`                  | —              | —                                                                                         |
| `ORIGIN_CACHE_MB`            | no       | `512`                   | —              | —                                                                                         |
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

| Variable                   | Required | Default | Self-host      | Description                                                                                                                                                             |
| -------------------------- | -------- | ------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`        | no       | —       | generated      | —                                                                                                                                                                       |
| `GARAGE_RPC_SECRET`        | no       | —       | generated      | Garage requires exactly 64 hex characters.                                                                                                                              |
| `GARAGE_ADMIN_TOKEN`       | no       | —       | generated      | —                                                                                                                                                                       |
| `GRAFANA_ADMIN_PASSWORD`   | no       | —       | generated      | —                                                                                                                                                                       |
| `BIND_ADDRESS`             | no       | —       | —              | Host interface for published ports (default 127.0.0.1).                                                                                                                 |
| `PUBLIC_HOSTNAME`          | no       | —       | set by install | Public hostname Caddy serves with TLS (profile `tls`).                                                                                                                  |
| `TLS_MODE`                 | no       | —       | set by install | Caddy's certificate source (ADR 0023): `acme` (default) gets a publicly trusted certificate for PUBLIC_HOSTNAME; `internal` uses Caddy's own CA for LAN and test hosts. |
| `ACME_EMAIL`               | no       | —       | set by install | Account email for ACME expiry notices (optional).                                                                                                                       |
| `ACME_CA`                  | no       | —       | —              | ACME directory URL override, e.g. a staging CA (default: Caddy's, Let's Encrypt then ZeroSSL).                                                                          |
| `IMAGE_REGISTRY`           | no       | —       | —              | —                                                                                                                                                                       |
| `IMAGE_TAG`                | no       | —       | —              | —                                                                                                                                                                       |
| `WALG_RETAIN_FULL`         | no       | —       | —              | —                                                                                                                                                                       |
| `POSTGRES_MAX_CONNECTIONS` | no       | —       | —              | Postgres `max_connections` (compose default 400: parallel integration suites hold many pools).                                                                          |
| `COMPOSE_SUBNET`           | no       | —       | —              | Compose network subnet (default 10.89.42.0/24); a second stack on one host needs its own.                                                                               |
| `COMMONAIR_ENV_FILE`       | no       | —       | —              | —                                                                                                                                                                       |

### `servicePorts`

| Variable                    | Required | Default | Self-host        | Description                                                                                                                                                                        |
| --------------------------- | -------- | ------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEB_PORT`                  | no       | `3000`  | set in the units | —                                                                                                                                                                                  |
| `API_PORT`                  | no       | `3001`  | set in the units | —                                                                                                                                                                                  |
| `CHAT_PORT`                 | no       | `3002`  | set in the units | —                                                                                                                                                                                  |
| `ORIGIN_PORT`               | no       | `3003`  | set in the units | —                                                                                                                                                                                  |
| `IRC_PORT`                  | no       | `6667`  | set in the units | —                                                                                                                                                                                  |
| `IRC_TLS_PORT`              | no       | `6697`  | set in the units | —                                                                                                                                                                                  |
| `IRC_WS_PORT`               | no       | `6680`  | set in the units | —                                                                                                                                                                                  |
| `IRC_HEALTH_PORT`           | no       | `6681`  | set in the units | —                                                                                                                                                                                  |
| `MEDIA_PORT`                | no       | `3004`  | set in the units | —                                                                                                                                                                                  |
| `WORKER_PORT`               | no       | `3005`  | set in the units | —                                                                                                                                                                                  |
| `TRACKER_PORT`              | no       | `8000`  | set in the units | —                                                                                                                                                                                  |
| `IRC_TLS_CERT_FILE`         | no       | —       | set in the units | —                                                                                                                                                                                  |
| `IRC_TLS_KEY_FILE`          | no       | —       | set in the units | —                                                                                                                                                                                  |
| `IRC_TLS_ALLOW_SELF_SIGNED` | no       | `false` | —                | Let a production instance run the IRC TLS listener on an ephemeral self-signed certificate when no files are configured. For hosts that do not expose the TLS port (e.g. Railway). |

### `ircEnv`

| Variable                        | Required | Default | Self-host | Description                                                                       |
| ------------------------------- | -------- | ------- | --------- | --------------------------------------------------------------------------------- |
| `IRC_MAX_CONNECTIONS`           | no       | `20000` | —         | IRC gateway admission limits (per process; connection bucket per client address). |
| `IRC_MAX_CONNECTIONS_PER_IP`    | no       | `50`    | —         | —                                                                                 |
| `IRC_CONNECT_BURST_PER_IP`      | no       | `20`    | —         | Token bucket for new connections per client address: burst size and refill rate.  |
| `IRC_CONNECT_PER_SECOND_PER_IP` | no       | `2`     | —         | —                                                                                 |

### `trackerEnv`

| Variable                         | Required | Default | Self-host | Description                                                                                                                                                                          |
| -------------------------------- | -------- | ------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TRACKER_MAX_CONNECTIONS`        | no       | `20000` | —         | —                                                                                                                                                                                    |
| `TRACKER_MAX_CONNECTIONS_PER_IP` | no       | `20`    | —         | —                                                                                                                                                                                    |
| `TRACKER_MAX_NUMWANT`            | no       | `20`    | —         | Most peers (offers) relayed per announce, whatever `numwant` asks for.                                                                                                               |
| `TRACKER_TOKEN_MAX_AGE_SECONDS`  | no       | `43200` | —         | Oldest playback token (by `iat`) accepted at connect. Tokens live 120 s but a tracker socket outlives them; the tracker also requires the session to be heartbeating (KEYS.viewers). |

<!-- END GENERATED -->
