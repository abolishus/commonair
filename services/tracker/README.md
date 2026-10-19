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
(20 characters, each char code 0–255); anything else is refused.

| Client → tracker                                                                                                                 | Tracker → client                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `{"action":"announce","info_hash","peer_id","numwant"?,"uploaded"?,"downloaded"?,"left"?,"event"?,"offers"?:[{offer,offer_id}]}` | `{"action":"announce","interval":120,"info_hash","complete","incomplete"}`                                   |
|                                                                                                                                  | each offer to a random other peer: `{"action":"announce","offer","offer_id","peer_id":<sender>,"info_hash"}` |
| `{"action":"announce","info_hash","peer_id","to_peer_id","answer","offer_id"}`                                                   | to `to_peer_id` only: `{"action":"announce","answer","offer_id","peer_id":<sender>,"info_hash"}`             |
| `{"action":"scrape","info_hash"?: string \| string[]}`                                                                           | `{"action":"scrape","files":{<info_hash>:{complete,incomplete,downloaded}}}`                                 |
| anything invalid                                                                                                                 | `{"failure reason":"…","info_hash"?}` (the socket stays open)                                                |

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

| Check                                                                                                           | Refusal |
| --------------------------------------------------------------------------------------------------------------- | ------- |
| Ed25519 signature valid under the playback key (derived from `PLAYBACK_SIGNING_KEY`); `exp` is **not** enforced | 401     |
| `iat` at most `TRACKER_TOKEN_MAX_AGE_SECONDS` old and not more than 30 s in the future                          | 401     |
| the session is heartbeating: `ZSCORE KEYS.viewers(cid) sid` present and at most 30 s old                        | 401     |
| no other socket for the same session id with the same or a newer `iat` (a newer `iat` replaces it, see below)   | 409     |
| `TRACKER_MAX_CONNECTIONS` / `TRACKER_MAX_CONNECTIONS_PER_IP`                                                    | 503/429 |

The heartbeat is re-checked on announces, at most every 30 s; a lapsed session is closed with 1008.
A re-check that fails on a Valkey error is not recorded, so the next announce tries again.
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
| Swarms per socket   | 4                                                      |
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
  TTL. This counts a network's announcers across **all** of the channel's swarms, because clients
  choose info hashes and a farm could otherwise split into private swarms under the cap.

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
`tracker.upgrades.refused{reason}`, `tracker.frames.refused{reason}`, `tracker.announces`,
`tracker.offers.relayed`, `tracker.answers.relayed`, `tracker.exchanges.completed`,
`tracker.connections.replaced`, `tracker.swarms` (up/down), `tracker.evidence.failures`.

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
podman compose --profile p2p up            # whole platform plus the tracker
bun services/tracker/src/main.ts           # standalone, with a local .env
bun run --filter @commonair/tracker test       # unit
bun run --filter @commonair/tracker test:int   # integration (needs Valkey)
```
