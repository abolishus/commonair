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

### With Podman (or Docker)

```sh
podman run -d --name commonair-relay --restart=always \
  -p 8443:8443 \
  -v commonair-relay:/data \
  -e COMMONAIR_RELAY_TOKEN=relay_xxx \
  ghcr.io/abolishus/commonair-relay:latest \
  --api https://<instance>/ --public-url https://relay.example.org \
  --capacity-mbps 200 --behind-proxy
```

The image is distroless, runs as a non-root user, and keeps its key and unsent receipts in the
`/data` volume. Keep that volume: it is the relay's identity.

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
| `--shutdown-timeout` | `25s`               | Time for in-flight requests and the final receipt on SIGTERM.              |
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
  this). When the API marks the relay `suspended`, viewer requests get `410` and heartbeats
  continue so a reinstatement takes effect immediately.
- **Health.** `GET /healthz` returns `{"status","version","viewers"}`; the origin health-checks it.
  It reports `starting` until registration succeeds and `draining` (503) during shutdown.
- **Heartbeats** report active viewers, egress (an exponentially weighted moving average, in
  Mbps) and cache size at the interval the API sets.
- **Shutdown.** On SIGTERM the relay stops accepting connections, finishes in-flight requests,
  closes the current period and tries to deliver every queued receipt.
- **Privacy.** Logs never contain viewer IP addresses or tokens; the HTTP server's own error log
  is redacted.

## How earnings are verified

1. For every viewer session the relay counts the bytes it actually delivered and the media
   objects (segments, parts, init) delivered completely. Bytes count only after they were
   flushed to the connection; a viewer who disconnects mid-segment is counted for what was
   written, never the full segment. Playlist bytes are not counted, which keeps receipts
   comparable to what the origin issues.
2. Every receipt interval (60 s by default) the relay closes the period and builds a receipt:
   `{v, relayId, nonce, periodStart, periodEnd, entries: [{sessionId, segments, bytes}]}` with a
   random 128-bit nonce. It signs the exact UTF-8 bytes of that JSON with its Ed25519 key and
   sends `{"payload": base64url(bytes), "signature": base64url(sig)}` to
   `POST <api>/api/relay/receipts`.
3. Receipts are written to `data-dir/receipts/` before sending and deleted only once the API
   accepts them (or permanently rejects one as malformed or replayed). Failures retry with
   exponential backoff; an API outage or a restart loses nothing. The backlog is capped at two
   days of periods; beyond that the oldest are dropped with an error log.
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
