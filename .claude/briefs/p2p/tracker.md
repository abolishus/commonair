<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **services/tracker** (native WebTorrent WebSocket tracker with server-side
swarm evidence) for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md, HANDOFF.md,
docs/architecture.md and **docs/decisions/0005-p2p-tracker.md** first. Do not look outside the
repository (no web access needed; the protocol is described below). You work in your own git
worktree: run `git merge main --no-edit` first.

## You own (write only these)

- `services/tracker/**` (new workspace package `@commonair/tracker`; model `package.json`,
  `tsconfig.json`, README and test layout on `services/irc`)

## Contracts you must honor (read-only for you)

- `@commonair/contracts/internal`: `KEYS.p2pPeer`, `KEYS.p2pSwarm`, `KEYS.viewers`, `P2P_EVIDENCE`,
  `p2pSwarmId`. `@commonair/contracts` `PlaybackClaims` (tokens.ts) — `sid`, `chn`/channel claim,
  `iat`, `exp`, `src`. Read the exact claim names there.
- `@commonair/tokens` `verifyPlaybackToken` (signature + expiry) — you need signature validity
  **ignoring** `exp` but bounded by `iat` age (`TRACKER_TOKEN_MAX_AGE_SECONDS`). If the package
  cannot do that, verify with the lower-level helper it exports or file a contract request for a
  `verifyPlaybackTokenSignature` export and work around it in a clearly marked local helper.
- `@commonair/config`: `trackerEnv`, `playbackEnv` (`PLAYBACK_SIGNING_KEY`, derive the public key
  as `services/origin` does), `valkeyEnv`, `internalEnv` (`INTERNAL_API_SECRET` keys the network
  HMAC), `servicePorts.TRACKER_PORT`, `TRUSTED_PROXY_CIDRS` (core env).
- `@commonair/service` `runService` (health/readiness, shutdown), `createValkey`.
- `compose.yaml` already defines `tracker` (profile `p2p`, `SERVICE: tracker` build arg, port 8000,
  app healthcheck on `/healthz`); Caddy proxies `/tracker*` with the prefix stripped. Check the
  shared service Containerfile under `infra/containers/` builds a `services/<name>` package
  generically; if it needs a change, that is a contract request (do not edit infra).

## Build

1. **WebSocket tracker on `Bun.serve`** (via `runService`'s `websocket`), accepting upgrades on
   any path (Caddy strips `/tracker`). WebTorrent WS protocol, JSON text frames:
   - client → tracker `{"action":"announce","info_hash","peer_id","numwant"?,"uploaded"?,
     "downloaded"?,"left"?,"event"?: "started"|"stopped"|"completed"|"update","offers"?:[{"offer":
     {type,sdp},"offer_id"}]}`; or an answer `{"action":"announce","info_hash","peer_id",
     "to_peer_id","answer":{type,sdp},"offer_id"}`; or `{"action":"scrape","info_hash"?: string |
     string[]}`. `info_hash`/`peer_id`/`to_peer_id`/`offer_id` are 20-byte binary strings
     (each char code 0–255); validate length and range, refuse otherwise.
   - tracker → client: announce response `{"action":"announce","interval":120,"info_hash",
     "complete","incomplete"}`; forwarded offer `{"action":"announce","offer":…,"offer_id",
     "peer_id":<sender>,"info_hash"}` sent to up to `min(numwant, TRACKER_MAX_NUMWANT, offers.
     length)` random other peers in the swarm; forwarded answer `{"action":"announce","answer":…,
     "offer_id","peer_id":<sender>,"info_hash"}` sent to `to_peer_id`; scrape response
     `{"action":"scrape","files":{<info_hash>:{complete,incomplete,downloaded}}}`; errors
     `{"failure reason":"…","info_hash"?}`.
   - `event: "stopped"` or socket close removes the peer from that swarm (memory) and from the
     `KEYS.p2pSwarm` ZSET. `left === 0` counts as complete (seeder).
   - Bound everything: frame size (e.g. 64 KiB), offers per announce (≤ 10), swarms per socket
     (≤ 4), SDP length, messages per second per socket (token bucket; on abuse close with 1008),
     `TRACKER_MAX_CONNECTIONS` / `TRACKER_MAX_CONNECTIONS_PER_IP`, idle timeout. Peer ids are
     unique per swarm: a second socket claiming an existing peer id in a swarm is refused.
2. **Authentication at upgrade.** Require `?t=<playback token>`. Refuse the upgrade (HTTP 401) if
   the signature is invalid, `iat` is older than `TRACKER_TOKEN_MAX_AGE_SECONDS` or in the future
   beyond 30 s skew, or the session is not heartbeating (`ZSCORE KEYS.viewers(channelId) sid` is
   missing or older than 30 s; re-check on each announce, at most every 30 s, and close with 1008
   when it lapses). One socket per session id: a second one is refused (409). Never log tokens,
   SDP, IPs or peer ids; log hashed/short ids or counts only.
3. **Client address** behind Caddy: honor `X-Forwarded-For` only from `TRUSTED_PROXY_CIDRS`
   (same semantics as `services/api/src/http.ts` + `services/api/src/lib/{ip,netrange}.ts`
   `clientIp`/`canonicalIp`). You may copy those helpers into `services/tracker/src` with a comment
   naming the source; add a contract request to move them into `@commonair/service`.
4. **Evidence** on every accepted announce frame, offers and answers alike (each is a real
   signalling exchange): `HSET KEYS.p2pPeer(sid)` `swarm` = `p2pSwarmId(channelId,
   hex(info_hash))`, `net` = hex HMAC-SHA256(INTERNAL_API_SECRET, `p2p-net:` + canonical prefix:
   /24 for IPv4, /48 for IPv6), `first` (only if absent: `HSETNX`), `last` (ms), `HINCRBY
   announces 1`; `EXPIRE` `P2P_EVIDENCE.peerTtlSeconds`. `ZADD KEYS.p2pSwarm(swarm) <ms> sid`,
   `EXPIRE` same TTL, and trim members older than the TTL. Pipeline these. A session that
   announces to a second info hash moves its `swarm` (document it). Valkey failures never drop the
   signalling: log, count, carry on.
5. **Observability**: `@commonair/observability` logger + counters (connections, refused upgrades
   by reason, announces, offers relayed, swarms, evidence write failures). `/readyz` checks Valkey.
6. `README.md`: protocol subset, auth, limits, evidence keys, env vars, how to run under
   `podman compose --profile p2p up`.

## Dependencies

No new external dependencies. Run `bun install` once to link the new workspace package (it
only touches `bun.lock` workspace entries; mention it in your final message).

## Tests you must add

- Unit (`*.test.ts`): frame validation (binary string lengths/ranges, sizes), swarm bookkeeping
  (announce, offer fan-out ≤ numwant, answer routing, stopped/close removal, seeder counts,
  scrape), rate limiting, network-prefix canonicalisation (IPv4, IPv6, `::ffff:a.b.c.d`), token
  age logic.
- Integration (`*.int.test.ts`, real Valkey, the tracker started in-process on an ephemeral port,
  tokens signed with a throwaway key via `@commonair/tokens`): two sessions (seed `KEYS.viewers`
  with fresh scores) connect with valid tokens, announce the same info hash with offers, the
  offer reaches the other peer, the answer comes back, and both `p2pPeer` hashes plus the
  `p2pSwarm` ZSET hold the evidence with the right swarm and distinct `net` values (simulate two
  networks with `X-Forwarded-For` from a trusted proxy CIDR configured for the test). Refusals:
  no token, bad signature, too old `iat`, session not heartbeating, second socket for one
  session, oversized frame. A lapsed heartbeat closes the socket.
## Done means (session four process rules — every brief)

- **Targeted checks only.** The user runs the gate (`bun run verify`), image rebuilds, harness
  scenarios against the live stack, dev servers and every browser/visual check. You do not. Run:
  your packages' `bun run test` and `bun run test:int` (the data services are already up at the
  `.env.example` defaults; never run `podman compose` or `scripts/infra.ts`), `bunx tsc -p <pkg>
  --noEmit`, `vp lint --deny-warnings <changed paths>`, `vp fmt <changed paths>`, `vp build` for
  `apps/web`, `go test ./...` / `go vet ./...` for `relay/`. Do not run several packages'
  `test:int` at the same time (shared Postgres/Valkey load makes timing tests flaky).
- No files outside your ownership list changed (`git status`).
- Commit in your worktree with `git commit -s` (Conventional Commits), message ending with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`, once your targeted checks pass.
- Final message: what you built, test counts per package, branch + commit sha, **contract
  requests** (exact changes needed in files you do not own), anything left undone, and the exact
  commands the user should run live to exercise your work.
