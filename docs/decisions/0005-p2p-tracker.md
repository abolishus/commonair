<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0005: Native WebTorrent tracker and server-side P2P evidence

- Status: accepted (amends ADR 0003 decision 10 and PLAN open decision D2); amendment 1 (the
  browser P2P client) accepted 2026-10-27, below
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

## Amendment 1: the browser P2P client (P1)

- Status: accepted (2026-10-27), with decision 3 changed from the draft (opt-in by default) and
  per-segment digests (decision 7) brought into P1; see "Decisions at acceptance"
- Date: 2026-10-27 (package and image facts checked on 2026-10-27)
- Counsel has not reviewed the EU lawful basis for showing a viewer's IP address to other
  viewers. Until counsel confirms one, P2P ships off by default (decision 3).

### Context

The tracker exists; the player does not use it. `apps/web/src/player/controller.ts:83` sends
`p2pCapable: false` and `:180` reports `bytesP2p: 0`. The API already hands out a tracker URL
carrying the playback token (`services/api/src/routes/playback.ts:46-50`, `:178`) and uses the
broadcast id as `swarmId`. Until P1 ships, every viewer without a relay is served from the
origin, and DigitalOcean meters that egress (ADR 0025). P1 (`.claude/briefs/next/P1-p2p-client.md`,
unit briefs in `.claude/briefs/p1/`) needed these decisions first. Library line numbers below are
from the published 4.0.0 tarballs.

### 1. Client library: p2p-media-loader 4.0.0, pinned

**Facts** (`bun scripts/vet-package.ts`, 2026-10-27, both pass with no warnings):

| Package                  | Version | Published  | Age     | License    | Direct deps                    |
| ------------------------ | ------- | ---------- | ------- | ---------- | ------------------------------ |
| `p2p-media-loader-core`  | 4.0.0   | 2026-08-19 | 69 days | Apache-2.0 | `debug` ^4.4.3, `@types/debug` |
| `p2p-media-loader-hlsjs` | 4.0.0   | 2026-08-19 | 69 days | Apache-2.0 | `p2p-media-loader-core` 4.0.0  |

- Both are the `latest` tag, well past the 7-day cooldown, published from GitHub Actions with
  provenance attestations, no install scripts. `debug@4.4.3` and `ms@2.1.3` are already in
  `bun.lock` (via iovalkey and Babel). The license is **Apache-2.0, not MIT** as the P1 brief
  says; Apache-2.0 is on the allowlist (hls.js is too, `docs/decisions/0002-license-policy.md:166`).
- Size: about 9.7k lines of TypeScript; `core.es.min.js` is 110 KB (28 KB gzipped), the hls.js
  adapter 9 KB. It loads only when P2P is on, through the same dynamic import as hls.js.
- **hls.js:** the adapter has no peer dependency; it is built and tested against `hls.js ^1.7.0`
  (its `devDependencies`). We pin 1.7.3 (`apps/web/package.json:27`). It plugs in as hls.js
  `fLoader`/`pLoader`, so our `patches/hls.js@1.7.3.patch` (only the stream controller's abort)
  still applies. The P1 interop test confirms both.
- **Tracker protocol.** The client sends `announce` with `info_hash`, `peer_id`, `numwant`,
  `uploaded`, `downloaded`, `offers`, `event` and an echoed `trackerid`, and answers with
  `to_peer_id`/`offer_id` (`webtorrent-client/index.ts:545-570`, `:608-616`). That is the subset
  `services/tracker/src/protocol.ts:107-146` parses; `trackerid` is ignored. Its info hash is
  **20 ASCII characters** (Base64 of 15 SHA-1 bytes, `stream-identity.ts:125-127`), not 20 raw
  bytes. That still passes `isBinaryId` (`protocol.ts:66-70`: 20 chars, codes ≤ 255).
- **One socket per URL.** The client pools sockets by tracker URL
  (`webtorrent-socket-pool/index.ts:31-35`), so one session opens one socket, which the tracker's
  one-socket-per-session rule needs. Each rendition and audio track is its own swarm; a session
  holds at most `LIMITS.maxSwarmsPerSocket` = 4 (`protocol.ts:14`, refused at `swarm.ts:142`),
  so the client must leave a swarm (`event: "stopped"`) on a level switch. The interop test checks this.
- **Token refresh does not fit.** `announceTrackers` is fixed at construction (it is not in
  `DynamicCoreConfig`, `types.ts:120-135`), and a reconnect reuses the same URL
  (`websocket-client/index.ts:74`). The contract comment at
  `packages/contracts/src/api/entities.ts:245-248` ("replace `t` on reconnect") cannot be honoured
  by the stock client. With `TRACKER_TOKEN_MAX_AGE_SECONDS` = 43 200
  (`packages/config/src/env.ts:503`), a reconnect after 12 hours fails and the viewer falls back to
  HTTP. That is harmless for integrity and rare.
- **Defaults to override.** By default it announces to three public trackers and uses Google and
  Twilio STUN (`core.ts:69-79`). We always set `announceTrackers` and `rtcConfig`, and a unit test
  asserts that no default survives.

**Options.**

- **A. p2p-media-loader-core + -hlsjs 4.0.0, exact pins (chosen).** It is the client the
  tracker was written for. It already does segment scheduling against the hls.js buffer, the
  peer protocol, churn and HTTP fallback. It exposes `swarmId`, `streamSwarmIdBuilder`,
  `validateP2PSegment` and a runtime `isP2PDisabled`.
- **B. An in-repo loader.** We would own about 10k lines of scheduling and WebRTC code that
  integrity does not even need, since integrity trusts only tracker evidence. This only becomes
  worth it if A turns out to be unmaintained.

**Consequences.** The 12-hour reconnect limit is accepted, and the contract comment is corrected
to say "a reconnect after `TRACKER_TOKEN_MAX_AGE_SECONDS` falls back to HTTP". If long sessions
matter, a small `bun patch` (like the hls.js one) can make the socket pool resolve its URL on
each connect. ADR 0002's dependency table gains both packages.

### 2. ICE: the instance's own coturn, STUN on, TURN relay off by default

**Facts.** coturn is BSD-3-Clause (`LICENSE` in github.com/coturn/coturn). The official image
`docker.io/coturn/coturn` has `4.18.0-trixie` (pushed 2026-09-08, 49 days old) next to rolling
`edge-*` tags. The DigitalOcean firewall opens exactly seven single ports and its test forbids
ranges (`infra/tofu/digitalocean/modules/instance/tests/stage0.tftest.hcl:46-59`). Caddy cannot
proxy UDP. **A TURN relay saves no egress:** a relayed peer's bytes cross our droplet twice (in
and out), while the origin sends a segment out only once.

**Decision.**

- **coturn ships in compose and Quadlet as `commonair-coturn`**, pinned like every image:
  `docker.io/coturn/coturn:4.18.0-trixie@sha256:…`, written by `bun scripts/pin-images.ts --write`,
  with an `infra/image-licenses.json` entry. The license is BSD-3-Clause and the source is
  `https://github.com/coturn/coturn/blob/4.18.0/LICENSE`. The notes record the Debian trixie base
  and the linked client libraries (OpenSSL, libevent, hiredis, libpq and others), which P1-turn
  checks in the image. `selfhost.sh` offers it to every operator.
- **STUN always, on 3478/udp**, so the firewall and its test gain one single port. No public
  STUN anywhere: the client's `rtcConfig.iceServers` holds only the instance's own URLs.
- **The TURN relay is off by default** (`P2P_TURN_URLS` empty). Peers that cannot connect
  directly fall back to HTTP, the same bytes and price as without P2P. When an operator turns
  TURN on (`selfhost.sh --turn-relay`), coturn runs with `use-auth-secret`, `static-auth-secret`,
  `denied-peer-ip` for every private, loopback and special-purpose range, `no-multicast-peers`,
  `user-quota`, `total-quota` and `max-bps`. A relay port range also needs an operator-chosen
  firewall rule.
- **ICE servers come from their own endpoint**, `p2p.iceServers` (`POST /playback/ice-servers`,
  input `{ sessionId, token }`, output `{ iceServers, expiresAt | null }`), not from
  `PlaybackStart`. Only sessions holding a P2P grant (decision 5) get an answer; others get
  `PRECONDITION_FAILED` (`requirement: "p2p"`). Sessions without P2P never pay for minting
  credentials, and the endpoint can be called again to refresh.
- **Time-limited credentials (TURN REST API)**, only when the relay is on:
  `username = "<expiry epoch s>:<opaque id>"` and
  `credential = base64(HMAC-SHA1(TURN_SHARED_SECRET, username))`, with
  `TURN_CREDENTIAL_TTL_SECONDS` (default 3 600). The opaque id is a truncated HMAC of the session
  id under a subkey of `TURN_SHARED_SECRET`, never the session id itself, because coturn can log
  usernames. The player calls `p2p.iceServers` again at about 80 % of the TTL and applies the
  answer through the runtime `rtcConfig` (`types.ts:135`). New connections pick up the fresh
  credentials. coturn checks the expiry on allocation refresh, so an old relayed connection
  drops when its credentials expire, and the loader falls back to HTTP. With the relay off,
  `expiresAt` is `null` and the answer holds only `stun:` URLs.

**Alternatives.** (a) TURN on by default: more peers connect, but it costs egress and a firewall
range for no saving. That is useful only for future features where peers need each other, not
the origin (W3 watch rooms). (b) STUN only, with no TURN support at all: simpler, but a later
TURN user would need a new ADR. (c) Public STUN: rejected, it is a third party learning every
viewer's address (against AGENTS.md non-negotiables 3 and 4). (d) ICE servers and credentials on
`PlaybackStart.p2p` with a heartbeat refresh (the draft): no extra round trip, but it mints
credentials for every session and widens two hot contracts; rejected at acceptance.

### 3. Defaults: opt-in, an operator default, never for gated streams

- **Off by default.** P2P runs only for viewers who turn it on, until counsel confirms an EU
  lawful basis for showing a viewer's IP address to other viewers. An operator can change the
  default with `P2P_DEFAULT=off|on` (`packages/config` `playbackEnv`, default `off`), published to
  the web app as `instance.info` `features.p2pDefault`.
- **The player's policy**, per device:
  - preference `off`: never;
  - preference `on` (the viewer opted in): yes, unless the path is native HLS or W1b data mode is
    on;
  - no preference: the operator default. With `P2P_DEFAULT=off` that is off. With
    `P2P_DEFAULT=on` it is on only where the device is not touch-primary
    (`matchMedia("(pointer: fine)")`), `navigator.connection.saveData` is not true,
    `navigator.connection.type` is not `"cellular"` and data mode is off. Where
    `navigator.connection` is missing (Firefox, Safari), the pointer test decides. So metered
    connections and data mode stay off even when the operator default is on.
  - Native HLS (WebKit) never gets P2P (`playback.ts:152-153`).
- The player sends `p2pCapable: true` only when this policy allows P2P, so a viewer who has not
  opted in never gets a grant or a tracker URL. `PlaybackStart.p2p.available` tells the player
  whether P2P is possible for this session at all (`P2P_ENABLED`, hls.js, not gated), so it can
  offer the opt-in switch. Opting in during a session takes effect at the next playback start;
  turning it off takes effect at once (`isP2PDisabled`, `types.ts:125`, no reload).
- The viewer's choice is per device (`localStorage`, wrapped in try/catch), because "metered"
  depends on the device. The switch is in the player's P2P dialog and on `/settings/privacy`.
- **Visible indicator** while P2P is on: a player chip with peers and bytes shared, with
  strings in the catalog.
- **Never for gated streams, enforced on the server.** `p2pEnabled` (`playback.ts:153`) also
  requires `!gated(...)` (`:117-125`, 18+, mature category, T1 restriction), and only then does
  the API write the grant the tracker checks (decision 5). A stream that becomes gated
  mid-session loses the grant at the next heartbeat. Private and subscriber-only live streams do
  not exist yet (`visibility` is only on media rows, `packages/db/src/schema/media.ts:150`). The
  rule binds whoever adds them.

**Alternative.** Default on for desktop (the draft): it would save more egress, because most
viewers never change defaults, but it shows addresses to peers before any lawful basis is
confirmed. Changed at acceptance; an operator who has that basis sets `P2P_DEFAULT=on`.

### 4. Peers see each other's IP address

WebRTC candidates carry the public (server-reflexive) address. The tracker relays them inside
the SDP; it never stores them (decision 3 of the base ADR keeps only an HMAC of the prefix).

- **P2P never starts before the viewer has seen the disclosure.** Opting in happens in the
  player's P2P dialog or the `/settings/privacy` section, and both state it next to the switch
  ("Sharing with other viewers shows them your IP address"). Where the operator default is on
  and the viewer has made no choice, the player shows a one-line dismissible notice with the off
  switch the first time P2P would start on the device, and P2P starts only after it has shown.
  Turning it off is one click, in the notice, the dialog and the settings section.
- The instance's `privacy` legal document (`LEGAL_DOCUMENT_KINDS`,
  `packages/contracts/src/enums.ts:166`) gains a P2P section, and the operator guide
  (`docs/self-hosting/p2p.md`) explains `P2P_DEFAULT` and the counsel question.
- **Alternatives.** (a) Default on with only the notice (the draft). Changed at acceptance (decision
  3). (b) Relay-only ICE (`iceTransportPolicy: "relay"`) hides addresses, but it is TURN for
  everyone, which is decision 2's egress cost. Rejected.

### 5. Who may join, and allowed info hashes, are decided on the server

Closes the "client-chosen info hashes" note (`HANDOFF.md:439-440`).

- **A per-session grant.** At `playback.start`, only when P2P is enabled for the session
  (decision 3), the API writes `KEYS.p2pGrant(sessionId)` = the session's swarm id (the broadcast
  id), with TTL `P2P_GRANT_TTL_SECONDS` (43 200, the default `TRACKER_TOKEN_MAX_AGE_SECONDS`).
  Each committed heartbeat refreshes it. The heartbeat deletes it instead when the stream has
  become gated, and `playback.end` deletes it. The tracker refuses a socket whose session has no
  grant (`403 p2p_not_granted`) and closes an open socket at its periodic re-check when the
  grant is gone. `p2p.iceServers` answers only granted sessions. Gated, opted-out and native-HLS
  sessions cannot join, and since a session belongs to one broadcast, a session from a previous
  broadcast cannot join the next broadcast's swarms.
- **Client.** It sets `swarmId` to `PlaybackStart.p2p.swarmId` and a `streamSwarmIdBuilder` that
  returns `p2pStreamSwarmId(swarmId, type, rendition)` =
  `ca1:<swarmId>:<main|secondary>:<rendition>` (from the browser-safe
  `@commonair/contracts/p2p` entry). The rendition comes from the variant playlist URL
  (`runtimeId`, `p2p-media-loader-hlsjs` `segment-manager.ts:27`), whose directory names it
  (`services/origin/src/paths.ts:19`; no directory means `source`), and audio tracks use `audio`.
  The library's default derivation hashes bitrate, codecs and frame rate, which the server
  cannot reproduce for the encoder-chosen source rendition.
- **Tracker.** It computes the allowed set from the grant's swarm id:
  `computeInfoHash(id)` for every id in `p2pAllowedStreamSwarmIds(swarmId)` (both types × every
  name in `P2P_STREAM_RENDITIONS` = `RENDITIONS` + `audio`, a fixed small set, so no
  `KEYS.renditions` read). The ASCII hash recipe is reimplemented in a few lines and tested
  against `P2P_INFOHASH_VECTORS`, generated with the library's exported `computeInfoHash`
  (`index.ts:8`). An announce or scrape outside the set is refused
  (`"failure reason": "info_hash not allowed"`) and records nothing.
- **No token change.** `PlaybackClaims`, the Go mirror (`relay/internal/tokens/playback.go`) and
  `packages/tokens/vectors.json` stay as they are.

**Alternatives.** (a) `bid` and `p2p: true` claims in `PlaybackClaims` (the draft): it changes the
Go mirror and the vectors, and a claim cannot be withdrawn when a stream becomes gated
mid-session. Rejected at acceptance. (b) A Valkey key holding each channel's live broadcast id:
it does not close the gated-stream hole.

### 6. P2P bytes pay nothing

Heartbeat `bytesP2p` is stored (`services/api/src/routes/playback.ts:215`,
`packages/db/src/schema/delivery.ts:84`) and loaded into integrity's session stats
(`packages/integrity/src/jobs.ts:236`), and no rule, payout, patronage or egress credit reads it
today. The decision makes that permanent: `bytesP2p` and anything a client reports about P2P
(`bytesP2pUp`, `p2pPeers`, `p2pRejected`) are informational (stats, the indicator, capacity
planning). They never count toward relay payouts, patronage, viewer-hour or egress credit, or
integrity verdicts. The receipt cross-check stays based on the origin and relays, and the only
P2P input integrity takes is tracker evidence (`P2P_EVIDENCE`, `internal.ts:195`). A unit test in
`packages/integrity` pins that a session's verdict is unchanged when only `bytesP2p` changes.
**Alternative:** credit verified P2P upload (a "seeding" reward). Rejected: it cannot be verified
server-side and would be the easiest thing to farm.

### 7. Segments from peers are checked against origin digests

A peer in the same swarm could otherwise serve altered media to other viewers (a moderation risk,
not an integrity one). P1 closes it.

- **Transport: a digest endpoint on the origin.**
  `GET|HEAD /p2p-digest/live/<slug>[/<rendition>]/<file>?t=<token>` takes the same path grammar as
  `/hls/` (`parseMediaPath` on the rest of the path) and answers only for `segment` objects
  (playlists and LL-HLS parts get 404). The body is the SHA-256 of the exact bytes `/hls/` serves
  for that object, as 64 lowercase hex characters (`text/plain`,
  `cache-control: private, max-age=120`: media objects never change). The bytes come from the
  origin's `ContentStore` (same cache and coalescing, so at most one upstream fetch), and digests
  are memoized in a small bounded LRU. The token check is the signature, the expiry and the
  channel path, with any delivery `src`, so relay- and CDN-served viewers validate against the
  origin too. A digest request writes no `SegmentFetch` (it is not a segment fetch, so integrity
  is unchanged) and is counted as `origin.requests{route="p2p_digest"}`.
- **Only the origin serves digests**, never relays or the CDN: it is the trust anchor. Caddy
  routes `/p2p-digest/*` to the origin, and `PlaybackStart.p2p.digestUrl` is
  `${PLAYBACK_PUBLIC_URL}/p2p-digest`.
- **Player.** `validateP2PSegment(url, byteRange, data)` (`types.ts:524`) fetches the digest with
  the current token and compares it with `crypto.subtle.digest("SHA-256", data)`. A mismatch, a
  byte range, or a failed digest fetch returns `false` (fail closed): the loader drops the bytes
  and refetches the segment over HTTP. The peer that served a bad segment is disconnected. The
  player counts rejections in the heartbeat's informational `p2pRejected`, which the API exports
  as the metric `playback.p2p.rejected`.
- **Why not a playlist tag.** Tagging digests into the media playlist would make the origin fetch
  and hash every new segment before serving each LL-HLS playlist update (every 200 ms part),
  adding latency on the HTTP path for every viewer, P2P or not. The endpoint costs one ~64-byte
  response per P2P-delivered segment, only for P2P sessions.
- **Tests.** Unit tests for digest computation (origin) and validation (player, with tampered
  bytes). An origin integration test that the endpoint serves the right digest and refuses bad
  tokens, parts and playlists. The tampering case is unit-level in the player: a harness peer
  that serves altered segments would need a second implementation of the loader's peer protocol.
  The `viewers` scenario instead asserts that digests were fetched and nothing was rejected.

### What the P1 contract step lands (orchestrator)

The full list is `.claude/briefs/p1/contract-step.md`. In short:

- Env (`packages/config`, `.env.example`): `P2P_DEFAULT` (`off|on`, default `off`) in
  `playbackEnv`; a new `turnEnv` for the API with `P2P_STUN_URLS`, `P2P_TURN_URLS` (empty by
  default), `TURN_SHARED_SECRET` (generated by `init-env.ts`, required when `P2P_TURN_URLS` is
  set) and `TURN_CREDENTIAL_TTL_SECONDS`; `TURN_PORT`, `TURN_RELAY_PORT_MIN`/`MAX` and
  `TURN_EXTERNAL_IP` in `infraEnv`.
- Contracts: `PlaybackStart.p2p` gains `available` and `digestUrl`, and its doc is corrected for
  decision 1 (a reconnect after `TRACKER_TOKEN_MAX_AGE_SECONDS` falls back to HTTP); `IceServers`
  and the `p2p.iceServers` procedure; `Heartbeat` gains optional `bytesP2pUp`, `p2pPeers` and
  `p2pRejected` (informational under decision 6); `InstanceInfo.features.p2pDefault`; the route
  input's `p2pCapable` default (`packages/contracts/src/api/router.ts:655`, currently `true`)
  flips to `false`, so an old or third-party client never gets a tracker URL by accident;
  `KEYS.p2pGrant`, `P2P_GRANT_TTL_SECONDS`, and the browser-safe `@commonair/contracts/p2p` entry
  (`p2pStreamSwarmId`, `p2pAllowedStreamSwarmIds`, `P2P_STREAM_RENDITIONS`,
  `P2P_INFOHASH_VECTORS`). No `PlaybackClaims` change.
- Wiring: the grant in `playback.ts`, the `p2p` router stub, the `/p2p-digest/` dispatch line in
  the origin with a stub handler, the Caddy route, the tracker in every compose stack.
- Contract requests to other owners: `infra/tofu/**` (S1) adds `udp/3478` to the firewall and
  its test.

### Consequences of the amendment

- P1 can switch `p2pCapable` on for viewers who opt in, and `viewers` can show real `bytesP2p`
  with unchanged verdicts.
- With P2P opt-in, the egress saving is smaller than the draft expected until an operator sets
  `P2P_DEFAULT=on` or counsel clears the default.
- Two new client dependencies are pinned and vetted. coturn adds one image and one UDP port.
- Segments from peers are verified against origin digests (decision 7), at the cost of one small
  origin request per P2P-delivered segment.

### Decisions at acceptance (2026-10-27)

The user accepted the amendment with the orchestrator's recommended answers. Where an answer
differs from the draft, the text above was updated to match.

1. **Library:** `p2p-media-loader-core` and `p2p-media-loader-hlsjs` pinned at 4.0.0
   (Apache-2.0). As drafted.
2. **ICE:** the instance's own coturn, STUN only; the TURN relay off by default; no public STUN.
   As drafted.
3. **Default:** **changed from the draft.** P2P ships opt-in (off by default), with an operator
   setting `P2P_DEFAULT=off|on`, until counsel confirms an EU lawful basis for showing a viewer's
   IP address to peers. Still never for 18+ or gated streams, a visible indicator, the
   IP-disclosure notice before P2P first starts, one-click off, and off on metered connections
   and in data mode even when the operator default is on. Counsel has not reviewed this.
4. **Per-segment digests:** **in P1 scope** (the draft left it open). The origin publishes a
   SHA-256 per segment through `/p2p-digest/`, the player validates every P2P-delivered segment
   and refetches over HTTP on a mismatch, and bad peers are disconnected (decision 7).
5. **Tracker reconnect:** the 12-hour limit is accepted; a reconnect after it falls back to HTTP.
   As drafted.
6. **Draft vs briefs:** the briefs' design wins. **Changed from the draft:** a separate
   `p2p.iceServers` endpoint instead of fields on `PlaybackStart` and a heartbeat refresh; a
   per-session Valkey grant `KEYS.p2pGrant` instead of `bid`/`p2p` token claims, so no Go or
   vector change; the TURN username's id is an HMAC of the session id, not the session id.
7. **P2P bytes pay nothing.** As drafted.
