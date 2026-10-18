<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Unit 2F: Member relay node (`relay/`, Go)

## You own

- `relay/**` (Go module `github.com/abolishus/commonair/relay`, Go 1.27, **standard library only** — no third-party modules; this keeps the license gate trivial: `relay/module-licenses.json` stays `{}`).

## Contracts (read-only)

- Token and receipt formats: `packages/contracts/src/tokens.ts` (PlaybackClaims: v, sid, cid, path, src, rid, iat, exp; base64url(claims JSON) "." base64url(Ed25519 sig)) and `shapes.ts` ReceiptPayload (v=1, relayId, nonce 16–64 chars, periodStart/periodEnd ISO, entries[{sessionId, segments, bytes}]). The relay signs the exact UTF-8 payload bytes; it sends `{"payload": base64url(bytes), "signature": base64url(sig)}`.
- Test vectors: `packages/tokens/vectors.json` (test-only RFC 8032 key; your Go tests must reproduce the playback token signature verification and the receipt signature byte-for-byte; read the file via a relative path from the test).
- Relay protocol endpoints in `packages/contracts/src/api/router.ts` under `relays.register`, `relays.heartbeat`, `relays.receipt` — served by the API under prefix `/api` (so `POST <api>/api/relay/register`, `/api/relay/heartbeat`, `/api/relay/receipts`) with `Authorization: Bearer <relay registration token>`. Origin relay-pull: `GET <originUrl>/relay-pull/live/<slug>/<file>` with the same bearer token. Viewer requests to the relay: `GET /hls/live/<slug>/<file>?t=<viewer token>` (token `src` must be `relay` and `rid` must equal this relay's id; path must match the token's `path` prefix).
- Strict base64url: reject padding and non-alphabet characters, like `packages/tokens/src/index.ts`.

## Build

A single static binary `commonair-relay` that a member runs with one command:
`commonair-relay --api https://<instance>/ --token relay_xxx --public-url https://relay.example.org --listen :8443 --capacity-mbps 200 --data-dir ~/.commonair-relay [--tls-cert --tls-key | --behind-proxy]`.

1. **Identity**: on first start generate an Ed25519 key in `data-dir/relay.key` (0600, PKCS#8 PEM) and reuse it after; `register` sends the raw public key (base64url, 43 chars), version, capacity, public URL; response gives relayId, originUrl, originPublicKey, receipt/heartbeat intervals and status. Re-register on restart or when the API says unknown.
2. **Serving**: verify viewer tokens with the origin public key (stdlib `crypto/ed25519`), expiry with 30 s skew, src/rid/path binding; playlists: fetch from origin relay-pull (short cache, honor LL-HLS blocking params by passing them through and coalescing identical in-flight requests), rewrite media URIs to stay on this relay and carry the viewer's `t=`; segments: pull-through cache (memory LRU sized `--cache-mb`, default 1024; coalesced misses; immutable). CORS `*` for GET. Limits: max concurrent viewers derived from capacity; return 503 when saturated (the origin's assignment should prevent it).
3. **Accounting and receipts**: count bytes and segments actually written to each viewer session (sid) per period; every `receiptIntervalSeconds` (60) build a ReceiptPayload with a random nonce, sign, POST; on failure retry with backoff and keep unsent periods (bounded, persisted in data-dir so restarts don't lose them). Never report bytes for failed/partial writes beyond what was written.
4. **Heartbeat** every `heartbeatIntervalSeconds` with active viewers, egress Mbps (EWMA), cache bytes; obey status `suspended` (stop serving viewers with 410, keep heartbeating) and `active`.
5. **Health**: `GET /healthz` (JSON: status, version, viewers) used by the origin's health check.
6. Graceful shutdown on SIGTERM: stop accepting, flush a final receipt.
7. Structured JSON logs (log/slog), no viewer IPs logged.
8. **Builds**: `relay/Makefile` (or `relay/build.sh`) producing `CGO_ENABLED=0` static binaries for linux/amd64, linux/arm64, darwin/amd64, darwin/arm64, windows/amd64 into `relay/bin/` with `-trimpath -ldflags "-s -w -X main.version=..."` (reproducible: no build timestamps). `relay/Containerfile`: multi-stage `docker.io/library/golang:1.27.2-trixie` → `gcr.io/distroless/static-debian13:nonroot`, exposes 8443, runs as nonroot, data dir volume. `relay/README.md`: one-command run instructions (binary and `podman run`), flags, how earnings are verified.
9. Create `relay/module-licenses.json` containing `{}` (the license gate reads it).

## Tests (Go, `go test -race ./...`; `gofmt` clean; `go vet` clean)

- Token verification against vectors.json (valid; tampered; expired; wrong rid; wrong path; malleable base64 variants rejected).
- Receipt signing reproduces vectors.json signature for the vector payload bytes exactly; nonce uniqueness.
- Playlist rewriting fixtures (LL-HLS parts, preload hints, rendition reports, map).
- Cache: LRU eviction by size, miss coalescing (N concurrent requests → 1 origin fetch).
- End-to-end with `httptest`: fake API (register/heartbeat/receipts) + fake origin serving a playlist and segments; a viewer with a valid token gets bytes; receipts sum exactly the bytes served; suspended status → 410; unsent receipts survive a restart.

## Done means

`cd relay && gofmt -l . && go vet ./... && go test -race ./...` clean, plus `bun run verify --quick` at the repo root (it runs the relay checks too). Commit per common rules.
