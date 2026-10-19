<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0005: Native WebTorrent tracker and server-side P2P evidence

- Status: accepted (amends ADR 0003 decision 10 and PLAN open decision D2)
- Date: 2026-10-18

## Context

ADR 0003 picked `bittorrent-tracker` (MIT) as the WebTorrent tracker, run under Bun. Two things
changed when the P2P slice was designed:

1. **Integrity needs server-side evidence.** Whether a viewer runs the P2P loader is client input
   (`p2pCapable`, heartbeat `bytesP2p`). A viewbot that claims P2P could fetch almost nothing
   from the origin and still pass the fetch checks. Integrity may lower a session's expected HTTP
   share only when the server saw that session take part in a real swarm.
2. **The dependency is mostly unused weight.** `bittorrent-tracker` 11.2.3 also ships the HTTP and
   UDP trackers and a client. Its dependencies include `@thaunknown/simple-peer` (pulls a native
   WebRTC binding), `socks`, `chrome-dgram` and `ip`, which has a history of advisories. We need
   only the WebSocket signalling subset. We also need to authenticate the socket at upgrade time
   and to see each announce, and both would mean working around the library's internals.

## Decision

1. **`services/tracker` implements the WebTorrent WebSocket tracker protocol natively** on
   `Bun.serve` WebSockets, with no tracker dependency. The protocol is JSON frames: `announce` with
   `info_hash`, `peer_id`, `offers`, `answer`, `to_peer_id`, `offer_id`, `numwant` and `event`,
   plus `scrape`. Hashes and ids are 20-byte binary strings. Only the subset that browser
   WebTorrent and p2p-media-loader clients send is implemented. There is no HTTP or UDP tracker.
2. **Sockets are authenticated by the playback token.** The API puts the session's playback token
   in each tracker URL (`?t=`). The tracker verifies the Ed25519 signature with the playback key
   and accepts a token whose `iat` is at most `TRACKER_TOKEN_MAX_AGE_SECONDS` old, because sockets
   outlive the 120 s token. It also requires the session to be heartbeating (`KEYS.viewers`). The
   token's session id binds the socket. A socket without a valid token is refused, and so is a
   second socket for a session that already has one.
3. **Announces become evidence** in Valkey (`KEYS.p2pPeer`, `KEYS.p2pSwarm`). A swarm is
   identified by the token's channel and the `info_hash`. The announcing network is stored as an
   HMAC of its /24 (IPv4) or /48 (IPv6) prefix, never the address.
4. **Integrity applies the reduced HTTP share only to evidenced sessions** (`P2P_EVIDENCE` in
   `@commonair/contracts/internal`). An evidenced session announced within the window, and its
   swarm had announcers from at least two distinct networks. "Too few fetches" is judged against
   the reduced share. "Too many fetches" is still judged against share 1, so an honest lone peer
   is never penalised. Playback sessions keep recording the HTTP delivery source and never `p2p`.

## Consequences

- No new runtime dependency, so nothing new to license-check.
- We own protocol compatibility. The tracker's tests pin the frames that browser WebTorrent and
  p2p-media-loader clients send, and an interop test with a real client is a follow-up once the
  web player ships a P2P loader.
- A viewbot farm that spans two networks, holds valid playback tokens and keeps heartbeating can
  still earn the reduced share. The other integrity signals (datacenter ranges, headless
  fingerprints, concurrency) still apply to it.
