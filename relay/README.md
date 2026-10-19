<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# commonair-relay

The CommonAir member relay: a small, single-binary segment cache that a co-op member runs to
donate upload bandwidth. The platform assigns some viewers to your relay; the relay pulls the
live stream from the instance's origin once, serves it to those viewers, and every minute
submits a signed receipt of the bytes it delivered. Verified receipts count toward your
patronage.

Go standard library only, no cgo, no third-party modules (AGPL-3.0-or-later).

## Run it

1. Create a relay in your account's relay settings (API: `POST /api/relays`). Copy the
   registration token (`relay_…`); it is shown once.
2. Make the relay reachable over HTTPS at a public URL, either with your own certificate or
   behind a reverse proxy that terminates TLS (Caddy, nginx, Traefik).
3. Start it:

```sh
COMMONAIR_RELAY_TOKEN=relay_xxx commonair-relay \
  --api https://<instance>/ \
  --public-url https://relay.example.org \
  --listen :8443 \
  --capacity-mbps 200 \
  --data-dir ~/.commonair-relay \
  --tls-cert /etc/letsencrypt/live/relay.example.org/fullchain.pem \
  --tls-key  /etc/letsencrypt/live/relay.example.org/privkey.pem
```

Behind a TLS-terminating proxy, replace the two TLS flags with `--behind-proxy` and point the
proxy at the listen address. `--token relay_xxx` works too, but the environment variable keeps
the token out of `ps` output and shell history.

### Run against a local stack

For development against `podman compose up` on your machine (the `e2e-relay` harness scenario
starts the relay the same way). The relay runs on the host, not in a container, and serves plain
HTTP on the host's LAN address.

1. Allow http and private-network relay URLs in the API: set
   `OUTBOUND_ALLOW_PRIVATE_NETWORKS=true` in the repository's `.env`, then restart the API
   (`podman compose up -d api`). Without it, registration is refused.
2. Create a relay at `http://localhost:3000/relays` and copy the token.
3. Find the host's LAN IPv4 (`ipconfig getifaddr en0` on macOS, `hostname -I` on Linux).
   `localhost` does not work: the API container health-checks the public URL, and inside the
   container `localhost` is the container itself.
4. Build and start:

```sh
cd relay
go build ./cmd/commonair-relay
COMMONAIR_RELAY_TOKEN=relay_xxx ./commonair-relay \
  --api http://localhost:3000/ \
  --public-url http://192.168.1.20:8443 \
  --listen :8443 \
  --data-dir "$(mktemp -d)" \
  --capacity-mbps 1000 \
  --log-level debug
```

The first log line (`"msg":"listening"`) shows the public URL, region, capacity and version,
never the token; a warning follows that plain HTTP is for local use only. The relay pulls from
the origin at the `originUrl` the API returns (`PLAYBACK_PUBLIC_URL`, `http://localhost:3003`
locally). Within a minute the relay's row on `/relays` shows `active`. Ctrl-C drains (one
`draining` heartbeat, current viewers keep playing until `--drain-timeout`, final receipt);
press it again to exit at once.

### With Podman (or Docker)

```sh
podman run -d --name commonair-relay --restart=always --stop-timeout 50 \
  -p 8443:8443 \
  -v commonair-relay:/data \
  -e COMMONAIR_RELAY_TOKEN=relay_xxx \
  ghcr.io/abolishus/commonair-relay:latest \
  --api https://<instance>/ --public-url https://relay.example.org \
  --capacity-mbps 200 --behind-proxy
```

The image is distroless, runs as a non-root user, and keeps its key and unsent receipts in the
`/data` volume. Keep that volume: it is the relay's identity. `--stop-timeout 50` gives the
relay time to drain (30 s by default) and send its final receipt (10 s) before the runtime
kills it; set `TimeoutStopSec=50` likewise under systemd.

## Flags

| Flag                 | Default             | Meaning                                                                    |
| -------------------- | ------------------- | -------------------------------------------------------------------------- |
| `--api`              | (required)          | Instance base URL. Env `COMMONAIR_RELAY_API`.                              |
| `--token`            | (required)          | Registration token. Prefer env `COMMONAIR_RELAY_TOKEN`.                    |
| `--public-url`       | (required)          | URL viewers use to reach this relay. Env `COMMONAIR_RELAY_PUBLIC_URL`.     |
| `--listen`           | `:8443`             | Listen address.                                                            |
| `--capacity-mbps`    | `100`               | Upload bandwidth you donate. Used for assignment and the viewer limit.     |
| `--viewer-mbps`      | `5`                 | Assumed average per viewer; viewer limit = capacity / this.                |
| `--cache-mb`         | `1024`              | Memory cache for segments and playlists (MiB).                             |
| `--data-dir`         | `~/.commonair-relay` | Relay key (`relay.key`, 0600) and unsent receipts (`receipts/`).          |
| `--tls-cert/--tls-key` |                   | Serve HTTPS directly. Files are re-read when they change (ACME renewals).  |
| `--behind-proxy`     | `false`             | Serve plain HTTP for a TLS-terminating proxy.                              |
| `--region`           |                     | Optional label such as `eu-west`.                                          |
| `--log-level`        | `info`              | `debug`, `info`, `warn`, `error`. Logs are JSON on stderr.                 |
| `--drain-timeout`    | `30s`               | On SIGTERM, time to keep serving current viewers (min 25 s); then 10 s for receipts. |
| `--version`          |                     | Print the version.                                                         |

## What it does

- **Identity.** On first start the relay generates an Ed25519 key in `data-dir/relay.key`
  (PKCS#8 PEM, mode 0600) and reuses it afterwards. It registers its public key, version,
  capacity and public URL with `POST <api>/api/relay/register`, and registers again after a
  restart or when the API no longer recognizes it.
- **Serving.** Viewers request `GET /hls/live/<slug>/<file>?t=<token>`. The token must be signed
  by the origin (the relay learns the origin public key at registration), unexpired (30 s
  skew), issued for delivery by relay with this relay's id, and the path must lie under the
  token's stream path. Playlists are pulled from `<origin>/relay-pull/...`, cached briefly,
  with LL-HLS blocking requests (`_HLS_msn`, `_HLS_part`, `_HLS_skip`) passed through and
  identical in-flight requests coalesced. Every URI in a playlist is rewritten to stay on this
  relay and carry the viewer's token. Segments go through a size-bounded LRU cache with
  coalesced misses, so each segment is fetched from the origin once.
- **Limits.** New viewers beyond capacity get `503` (the platform's assignment should prevent
  this). At most 256 distinct origin fetches run at once (more get `503`), over at most 128
  connections to the origin; one viewer session may have at most 8 requests in flight (more
  get `429`). A fetch nobody waits for any more is cancelled. Blocking playlist requests for a
  segment more than one past the newest one in the current playlist, or for a part number
  beyond what a segment can hold, get `400` without reaching the origin. When the API marks
  the relay `suspended`, viewer requests get `410` and heartbeats continue so a reinstatement
  takes effect immediately.
- **Health.** `GET /healthz` returns `{"status","version","viewers"}`; the origin health-checks it.
  It reports `starting` until registration succeeds and `draining` (503) during shutdown.
- **Heartbeats** report active viewers, egress (an exponentially weighted moving average, in
  Mbps) and cache size at the interval the API sets. What the relay does with the answer:

  | API answer                                          | Relay                                                                                                |
  | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
  | `active`, `pending`, `degraded`                     | Adopts the status and origin key.                                                                    |
  | `suspended`                                         | Logs an error, serves `410` to viewers, keeps heartbeating so a reinstatement applies at once.       |
  | `offline` (timed out while paused, or drained)      | Registers again with the same token and key.                                                         |
  | `401`, `404`, `412` (unknown or not registered)     | Registers again; a retired relay's token is refused there, and the log says to create a new relay.   |
  | other `4xx`, `5xx`, network errors, timeouts        | Keeps its current state and tries at the next interval.                                              |

- **Shutdown.** On SIGTERM or SIGINT the relay sends one heartbeat with `draining: true` (5 s
  timeout, best effort; a failure is logged and the platform's health check takes the relay out
  instead), sends no further heartbeats and does not register again. `/healthz` answers
  `draining` (503). Viewers already being served keep playing until the player moves to the
  origin or `--drain-timeout` is nearly over; new viewer sessions get `503`. The last few
  seconds of the window let in-flight requests finish, then remaining connections are closed,
  the relay waits briefly for their handlers, and only then closes the final period (covering
  the drain) and delivers queued receipts. A second signal exits at once.
- **Privacy.** Logs never contain viewer IP addresses or tokens; the HTTP server's own error log
  is redacted.

## How earnings are verified

1. Receipts are **media-only**. For every viewer session the relay counts the bytes of media
   objects (segments, parts, init sections) it actually delivered, and the number of media
   objects delivered completely. Playlists are never counted, neither bytes nor objects: the
   origin's issuance log, which receipts are cross-checked against, counts media objects the
   same way. Bytes count only after they were flushed to the connection; a viewer who
   disconnects mid-segment is counted for what was written, never the full segment.
2. Every receipt interval (60 s by default) the relay closes the period and builds a receipt:
   `{v, relayId, nonce, periodStart, periodEnd, entries: [{sessionId, segments, bytes}]}` with a
   random 128-bit nonce. It signs the exact UTF-8 bytes of that JSON with its Ed25519 key and
   sends `{"payload": base64url(bytes), "signature": base64url(sig)}` to
   `POST <api>/api/relay/receipts`.
3. Receipts are written to `data-dir/receipts/` before sending and deleted only once the API
   accepts them (or permanently rejects one as malformed or replayed). Failures retry with
   exponential backoff; an API outage or a restart loses nothing. The backlog is capped at two
   days of periods; beyond that the oldest are dropped with an error log. On start, every
   queued receipt is verified against the relay's own key; unreadable or unverifiable files are
   renamed to `*.corrupt` and never sent.
4. The platform verifies each signature against the key the relay registered, rejects reused
   nonces, and cross-checks the claimed bytes against what the origin issued to the sessions it
   assigned to this relay. Only verified receipts count toward patronage; over-reporting beyond
   tolerance suspends the relay pending review.

The token and receipt formats are specified in `packages/contracts/src/tokens.ts` and pinned by
shared test vectors in `packages/tokens/vectors.json`, which the Go tests reproduce byte for byte.

## Build

```sh
make            # gofmt check, go vet, go test -race, then bin/commonair-relay
make release    # static binaries for linux/amd64, linux/arm64, darwin/amd64, darwin/arm64,
                # windows/amd64 in bin/, plus SHA256SUMS
make image      # container image via podman
```

Builds are reproducible: `CGO_ENABLED=0`, `-trimpath`, `-buildvcs=false`, an empty build id, and
the version from `git describe` (`-X main.version=...`), with no timestamps. Two builds of the
same commit with the same Go toolchain produce identical bytes; compare against `SHA256SUMS`.

## Layout

| Path                    | Purpose                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `cmd/commonair-relay`   | Flags, TLS, signals, logging                                  |
| `internal/tokens`       | Strict base64url, playback token verification, receipt signing |
| `internal/identity`     | Relay key generation and loading                              |
| `internal/apiclient`    | Relay protocol client (register, heartbeat, receipts)         |
| `internal/server`       | `/hls/` and `/healthz` handlers, origin pull                   |
| `internal/hls`          | Path validation, playlist rewriting, LL-HLS directives        |
| `internal/cache`        | Size-bounded LRU and request coalescing                       |
| `internal/accounting`   | Per-session byte/segment ledger, viewer limit, egress EWMA    |
| `internal/receipts`     | Receipt building, persistent queue, delivery with backoff     |
| `internal/relay`        | Lifecycle wiring and end-to-end tests                         |
