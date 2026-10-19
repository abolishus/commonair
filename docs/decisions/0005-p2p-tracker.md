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
   `@commonair/contracts/internal`). Evidence is per session, not per swarm. Merely announcing
   into a swarm that honest viewers populate earns nothing. A session is evidenced when all three
   hold:
   - It announced within the window.
   - It **completed a signalling exchange** with a peer on another network within the window.
     The tracker relayed an offer between the two sessions, and the matching answer came back.
     The tracker records the peer's network for both sides in `KEYS.p2pLinks`.
   - Its swarm has at most `maxSessionsPerNetwork` announcers on its own network. Beyond that,
     no session on that network is evidenced.

   "Too few fetches" is judged against the reduced share. "Too many fetches" is still judged
   against share 1, so an honest lone peer is never penalised. Playback sessions keep recording
   the HTTP delivery source, never `p2p`.

## Consequences

- No new runtime dependency, so nothing new to license-check.
- We own protocol compatibility. The tracker's tests pin the frames that browser WebTorrent and
  p2p-media-loader clients send, and an interop test with a real client is a follow-up once the
  web player ships a P2P loader.
- **Residual risk.** A farm can still earn the reduced share for some of its sessions. It needs
  valid playback tokens and live heartbeats. It also needs to answer offers on a second network,
  or to have honest peers' clients answer offers it sends (browsers answer automatically). The
  per-network cap limits a farm behind one prefix to `maxSessionsPerNetwork` evidenced sessions
  per swarm, and a farm spread across many prefixes is exposed to the datacenter-range and
  headless signals. Honest viewers behind one large NAT above the cap lose only the P2P discount.
  They are judged as plain HTTP sessions, which can flag a pure-P2P viewer as `too_few_segments`
  (held pending, not banned).
- **The tracker accepts a token for up to `TRACKER_TOKEN_MAX_AGE_SECONDS`.** A leaked playback
  token can occupy that session's tracker slot. A socket presenting a newer `iat` for the same
  session replaces the older socket, so the honest viewer reclaims it with its next refreshed
  token.
