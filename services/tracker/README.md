<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# `@commonair/tracker`: WebTorrent WebSocket tracker

Signalling for peer-to-peer HLS delivery (p2p-media-loader / browser WebTorrent), implemented
natively on `Bun.serve` WebSockets with no tracker dependency ([ADR 0005](../../docs/decisions/0005-p2p-tracker.md)).
Every accepted announce is also recorded as server-side **P2P evidence** in Valkey, which
integrity uses before it lowers a session's expected HTTP share.

There is no HTTP or UDP tracker. Upgrades are accepted on any path (Caddy proxies `/tracker*`
with the prefix stripped); `/healthz` and `/readyz` (Valkey ping) are the only HTTP routes.

## Protocol subset

JSON text frames. `info_hash`, `peer_id`, `to_peer_id` and `offer_id` are 20-byte binary strings
(20 characters, each char code 0–255); anything else is refused. p2p-media-loader 4.0.0 sends 20
ASCII characters for all four (see "The pinned client" below).

**Allowed info hashes.** A socket may announce or scrape only the info hashes derived from its
session's grant (ADR 0005 amendment 1, decision 5): `computeInfoHash(id)` for every `id` in
`p2pAllowedStreamSwarmIds(grant)` (`ca1:<swarmId>:<main|secondary>:<rendition>`, both stream types
× every name in `P2P_STREAM_RENDITIONS`, 10 hashes). `computeInfoHash` is the loader's recipe,
Base64 of the first 15 bytes of SHA-1 over the UTF-8 id, reimplemented in `src/infohash.ts` and
pinned to `P2P_INFOHASH_VECTORS`; the sets are cached per swarm id in a 256-entry LRU. Any other
hash gets `{"failure reason":"info_hash not allowed","info_hash":<it>}` (for a scrape, the first
foreign hash) and records nothing: no swarm join, no evidence.

| Client → tracker                                                                                                                 | Tracker → client                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `{"action":"announce","info_hash","peer_id","numwant"?,"uploaded"?,"downloaded"?,"left"?,"event"?,"offers"?:[{offer,offer_id}]}` | `{"action":"announce","interval":120,"info_hash","complete","incomplete"}`                                   |
|                                                                                                                                  | each offer to a random other peer: `{"action":"announce","offer","offer_id","peer_id":<sender>,"info_hash"}` |
| `{"action":"announce","info_hash","peer_id","to_peer_id","answer","offer_id"}`                                                   | to `to_peer_id` only: `{"action":"announce","answer","offer_id","peer_id":<sender>,"info_hash"}`             |
| `{"action":"scrape","info_hash"?: string \| string[]}`                                                                           | `{"action":"scrape","files":{<info_hash>:{complete,incomplete,downloaded}}}`                                 |
| anything invalid, or an `info_hash` outside the grant                                                                            | `{"failure reason":"…","info_hash"?}` (the socket stays open)                                                |

- Offers are relayed to `min(numwant ?? offers.length, TRACKER_MAX_NUMWANT, offers.length)`
  distinct random peers of the swarm, never back to the sender.
- `event` is `started`, `stopped`, `completed` or `update`. `stopped` (or closing the socket)
  removes the peer. `left: 0` or `completed` makes it a seeder (`complete`); `completed` counts
  once towards scrape's `downloaded`.
- An answer frame gets no announce response of its own; an answer to an unknown peer is dropped.
- A swarm is the token's channel plus the `info_hash`: sockets of different channels never meet.
  A scrape without `info_hash` reports only the swarms this socket is in.
- Peer ids are unique per swarm: a second socket claiming one gets `peer_id in use`.

## Authentication

The tracker URL carries the session's playback token: `wss://<host>/tracker?t=<token>`.
At upgrade the tracker requires:

| Check                                                                                                             | Refusal               |
| ----------------------------------------------------------------------------------------------------------------- | --------------------- |
| Ed25519 signature valid under the playback key (derived from `PLAYBACK_SIGNING_KEY`); `exp` is **not** enforced   | 401                   |
| `iat` at most `TRACKER_TOKEN_MAX_AGE_SECONDS` old and not more than 30 s in the future                            | 401                   |
| the session is heartbeating: `ZSCORE KEYS.viewers(cid) sid` present and at most 30 s old                          | 401                   |
| the session has a P2P grant: `GET KEYS.p2pGrant(sid)` is a non-empty swarm id (a Valkey error: 503 `unavailable`) | 403 `p2p_not_granted` |
| no other socket for the same session id with the same or a newer `iat` (a newer `iat` replaces it, see below)     | 409                   |
| `TRACKER_MAX_CONNECTIONS` / `TRACKER_MAX_CONNECTIONS_PER_IP`                                                      | 503/429               |

The heartbeat and the grant are re-checked on announces (not on `stopped`), at most every 30 s.
A lapsed heartbeat closes the socket with 1008 `session not watching`; a grant that is gone or now
names another swarm id closes it with 1008 `p2p not granted`. The API writes the grant at
`playback.start` only when P2P is enabled for the session, refreshes it with heartbeats, and
deletes it at `playback.end` and when the stream becomes gated, so a gated, opted-out or ended
session loses P2P at its next re-check. A re-check that fails on a Valkey error is not recorded,
so the next announce tries again.

The grant's other half is the origin's **segment digest** endpoint
(`/p2p-digest/live/<slug>[/<rendition>]/<file>?t=<token>`, ADR 0005 amendment 1, decision 7): a
peer in the same swarm could serve altered media, so the player checks every P2P-delivered
segment against the SHA-256 the origin serves there and refetches over HTTP on a mismatch. The
tracker never sees segment bytes.
The signature is checked with `verifyPlaybackTokenSignature` from `@commonair/tokens`.

A socket whose token has a **newer** `iat` than the session's open socket replaces it: the old
socket leaves its swarms at once (so the new one can reclaim the same peer ids) and is closed
with 1008. A leaked token can therefore hold the session's slot only until the honest viewer's
next refreshed token (ADR 0005).

The client address is the socket peer, or the rightmost untrusted `X-Forwarded-For` hop when the
peer is in `TRUSTED_PROXY_CIDRS` (same rules as the API). Logs never contain tokens, SDP,
addresses or peer ids.

## Limits

| Limit               | Value                                                  |
| ------------------- | ------------------------------------------------------ |
| Frame size          | 64 KiB (larger: Bun closes the socket)                 |
| Offers per announce | 10                                                     |
| SDP length          | 16 KiB                                                 |
| Swarms per socket   | 10 (every hash of the grant, see below)                |
| Hashes per scrape   | 10                                                     |
| Frames per socket   | token bucket, burst 20, 5/s; overflow closes with 1008 |
| Idle timeout        | 150 s (Bun pings keep live sockets open)               |
| Binary frames       | closed with 1003                                       |
| Send backpressure   | 1 MiB queued to a socket that stops reading closes it  |
| Per-address limit   | per IPv4 address, per IPv6 /64                         |

## Evidence (Valkey)

On every accepted announce frame, offers and answers alike (each is a real signalling exchange),
in one pipeline:

- `HSET KEYS.p2pPeer(sid)`: `swarm` = `p2pSwarmId(channelId, hex(info_hash))`, `net` = hex
  HMAC-SHA256 keyed with the subkey HMAC-SHA256(`INTERNAL_API_SECRET`, `"p2p-net-v1"`) over the canonical /24 (IPv4, including
  IPv4-mapped IPv6) or /48 (IPv6) prefix), `last` (epoch ms); `HSETNX first`; `HINCRBY announces 1`;
  `EXPIRE` `P2P_EVIDENCE.peerTtlSeconds`.
- `ZADD KEYS.p2pSwarm(swarm) <ms> sid`, trim members older than the TTL, `EXPIRE` the same TTL.
- `ZADD KEYS.p2pChannelNet(channelId, net) <ms> sid`, trim to the TTL window, `EXPIRE` the same
  TTL. This counts a network's announcers across **all** of the channel's swarms: a broadcast has
  one swarm per rendition and stream type, and a session moves between them on level switches,
  so a per-swarm count would split one network's sessions.

On a **completed signalling exchange**, i.e. the tracker relayed session A's offer to session B and
B's answer with the same `offer_id` came back in the same swarm within
`P2P_EVIDENCE.exchangeTimeoutMs` (60 s), both sides are linked in one pipeline:
`ZADD KEYS.p2pLinks(A) <ms> <B's net>` and `ZADD KEYS.p2pLinks(B) <ms> <A's net>`, each trimmed
to the TTL and given the same `EXPIRE`. Answers to offers the tracker never relayed, from another
session, or after the timeout are still relayed (they are signalling) but link nothing. Each
socket remembers at most 100 relayed offers awaiting an answer (`src/exchanges.ts`), oldest
evicted first. Integrity decides which links count (another network, the per-network cap).

A session's `swarm` is the swarm of its **latest** announce: one that announces to a second info
hash moves there. `stopped` and socket close `ZREM` the session from the `p2pSwarm` ZSETs it left
(that key is live membership). They never touch `p2pPeer`, `p2pLinks` or `p2pChannelNet`, which
age out with the TTL, so leaving never dodges the per-network cap. Valkey
failures never drop signalling: they are logged and counted (`tracker.evidence.failures`).

Counters (`@commonair/observability` meter `tracker`): `tracker.connections.opened|closed`,
`tracker.upgrades.refused{reason}` (`capacity`, `ip_limit`, `token_*`, `not_watching`,
`p2p_not_granted`, `duplicate_session`, `unavailable`, `bad_upgrade`),
`tracker.frames.refused{reason}` (the failure reason, including `info_hash not allowed`, plus
`rate_limited`), `tracker.connections.revoked{reason}` (`not_watching`, `p2p_not_granted`: closed
at a re-check), `tracker.announces`, `tracker.offers.relayed`, `tracker.answers.relayed`,
`tracker.exchanges.completed`, `tracker.connections.replaced`, `tracker.swarms` (up/down),
`tracker.evidence.failures`.

## The pinned client

p2p-media-loader-core 4.0.0 (`src/webtorrent/`), checked against the tracker; the frames are
pinned in `tests/fixtures.ts` and exercised by `tests/interop.test.ts` and `tests/tracker.int.test.ts`.

- **One socket per session.** The loader's `WebTorrentSocketPool` keys sockets by tracker URL,
  one pool per `Core`, so every rendition and the audio track share one socket, and one peer id.
  A reconnect reuses the same URL (`websocket-client/index.ts:74`), hence the same token: after
  `TRACKER_TOKEN_MAX_AGE_SECONDS` it is refused and the player stays on HTTP.
- **Swarms.** Each rendition and audio track is its own swarm. On a level switch the old
  rendition's loader is destroyed (and sends `stopped`) at once if it stored no segments, else
  after `p2pInactiveLoaderDestroyTimeoutMs` (30 s), so a session briefly holds several swarms;
  the per-socket limit is the grant's whole set (10).
- **Frames sent.** `announce` with `info_hash`, `peer_id`, `numwant` (= offers made, 0 when none),
  `uploaded: 0`, `downloaded: 0`, `offers`, `event` only for `started`/`stopped`, and `trackerid`
  only after a response carried `"tracker id"` (this tracker never sends one; the field would be
  ignored). Answers carry `to_peer_id`, `offer_id` and `answer`. It never sends `scrape` or `left`.
- **Fields read.** `info_hash` (it drops messages for other torrents on the shared socket),
  `"failure reason"`, `"warning message"`, `interval` (floored at 20 s), and `peer_id` +
  `offer_id` + `offer`/`answer` on relays. `complete`/`incomplete` are unread.

## Environment

| Variable                                                                                                            | Use                                        |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `TRACKER_PORT` (8000)                                                                                               | listener (WebSocket + health)              |
| `PLAYBACK_SIGNING_KEY`                                                                                              | playback key; the public half verifies     |
| `INTERNAL_API_SECRET`                                                                                               | keys the network HMAC                      |
| `VALKEY_URL`                                                                                                        | heartbeats and evidence                    |
| `TRUSTED_PROXY_CIDRS`                                                                                               | proxies whose `X-Forwarded-For` is honored |
| `TRACKER_MAX_CONNECTIONS`, `TRACKER_MAX_CONNECTIONS_PER_IP`, `TRACKER_MAX_NUMWANT`, `TRACKER_TOKEN_MAX_AGE_SECONDS` | limits (`trackerEnv`)                      |

## Running

```sh
podman compose up                          # whole platform; the tracker runs in every stack
bun services/tracker/src/main.ts           # standalone, with a local .env
bun run --filter @commonair/tracker test       # unit
bun run --filter @commonair/tracker test:int   # integration (needs Valkey)
```
