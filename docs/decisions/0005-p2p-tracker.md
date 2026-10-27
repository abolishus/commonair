<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# ADR 0005: Native WebTorrent tracker and server-side P2P evidence

- Status: accepted (amends ADR 0003 decision 10 and PLAN open decision D2); amendment 1 (the
  browser P2P client) proposed 2026-10-27, below
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

- Status: proposed (2026-10-27)
- Date: 2026-10-27 (package and image facts checked on 2026-10-27)

### Context

The tracker exists; the player does not use it. `apps/web/src/player/controller.ts:83` sends
`p2pCapable: false` and `:180` reports `bytesP2p: 0`. The API already hands out a tracker URL
carrying the playback token (`services/api/src/routes/playback.ts:46-50`, `:178`) and uses the
broadcast id as `swarmId`. Until P1 ships, every viewer without a relay is served from the
origin, and DigitalOcean meters that egress (ADR 0025). P1 (`.claude/briefs/next/P1-p2p-client.md`)
needs six decisions first. Library line numbers below are from the published 4.0.0 tarballs.

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

- **A. p2p-media-loader-core + -hlsjs 4.0.0, exact pins (recommended).** It is the client the
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

**Decision (recommended).**

- **coturn ships in compose and Quadlet as `commonair-coturn`**, pinned like every image:
  `docker.io/coturn/coturn:4.18.0-trixie@sha256:…`, written by `bun scripts/pin-images.ts --write`,
  with an `infra/image-licenses.json` entry. The license is BSD-3-Clause and the source is
  `https://github.com/coturn/coturn/blob/4.18.0/LICENSE`. The notes record the Debian trixie base
  and the linked client libraries (OpenSSL, libevent, hiredis, libpq and others), which P1-turn
  checks in the image.
- **STUN always, on 3478/udp**, so the firewall and its test gain one single port. No public
  STUN anywhere: the client's `rtcConfig.iceServers` holds only the instance's own URLs.
- **The TURN relay is off by default** (`P2P_TURN_URLS` empty). Peers that cannot connect
  directly fall back to HTTP, the same bytes and price as without P2P. When an operator turns
  TURN on, coturn runs with `use-auth-secret`, `static-auth-secret`, `denied-peer-ip` for every
  private and loopback range, `no-multicast-peers`, `user-quota`, `total-quota` and `max-bps`.
  A relay port range also needs an operator-chosen firewall rule.
- **Time-limited credentials (TURN REST API).** The API mints them for each playback session:
  `username = "<expiry epoch s>:<sessionId>"` and
  `credential = base64(HMAC-SHA1(TURN_SHARED_SECRET, username))`, with
  `TURN_CREDENTIAL_TTL_SECONDS` (default 3 600). The heartbeat response re-mints them in the last
  quarter of their life, and the player applies them through the runtime `rtcConfig`
  (`types.ts:135`). New connections pick up the fresh credentials. coturn checks the expiry on
  allocation refresh, so an old relayed connection drops when its credentials expire, and the
  loader falls back to HTTP.

**Alternatives.** (a) TURN on by default: more peers connect, but it costs egress and a firewall
range for no saving. That is useful only for future features where peers need each other, not
the origin (W3 watch rooms). (b) STUN only, with no TURN support at all: simpler, but a later
TURN user would need a new ADR. (c) Public STUN: rejected, it is a third party learning every
viewer's address (against AGENTS.md non-negotiables 3 and 4).

### 3. Defaults: on for desktop, off when metered, never for gated streams

- **On by default** where the device is not a phone or tablet (`matchMedia("(pointer: fine)")`),
  `navigator.connection.saveData` is not true and `navigator.connection.type` is not
  `"cellular"`. Where `navigator.connection` is missing (Firefox, Safari), the pointer test
  decides. **Off** on touch-primary devices, on metered connections and whenever W1b data mode is
  on. Native HLS (WebKit) already gets no P2P (`playback.ts:152-153`).
- The viewer's choice is per device (`localStorage`, wrapped in try/catch), because "metered"
  depends on the device. The toggle is in the player's settings menu and on `/settings/privacy`.
  Turning it off sets `isP2PDisabled` at runtime (`types.ts:125`), with no reload.
- **Visible indicator** while P2P is active: a player chip with peers and bytes shared, with
  strings in the catalog.
- **Never for gated streams, enforced on the server.** `p2pEnabled` (`playback.ts:153`) also
  requires `!gated(...)` (`:117-125`, 18+, mature category, T1 restriction). The tracker enforces
  it too, through the token claim in decision 5, so a confirmed adult cannot build the URL by hand
  from the playlist token. Private and subscriber-only live streams do not exist yet (`visibility`
  is only on media rows, `packages/db/src/schema/media.ts:150`). The rule binds whoever adds them.

**Alternative.** Strict opt-in (off until the viewer turns it on): cleaner for privacy, but most
viewers never change defaults, so it would save little egress. The choice depends on 4.

### 4. Peers see each other's IP address

WebRTC candidates carry the public (server-reflexive) address. The tracker relays them inside
the SDP; it never stores them (decision 3 keeps only an HMAC of the prefix).

- **Recommended.** The first time P2P would start on a device, the player shows a one-line
  dismissible notice ("Sharing with other viewers shows them your IP address") with the off
  switch in it. P2P starts only after that notice has shown. The instance's `privacy` legal
  document (`LEGAL_DOCUMENT_KINDS`, `packages/contracts/src/enums.ts:166`) gains a P2P section,
  and the operator guide says so. Turning it off is one click, in the notice and in the menu.
- **Alternatives.** (a) Strict opt-in (decision 3's alternative). (b) Relay-only ICE
  (`iceTransportPolicy: "relay"`) hides addresses, but it is TURN for everyone, which is
  decision 2's egress cost. Rejected.

### 5. Allowed info hashes are derived on the server

Closes the "client-chosen info hashes" note (`HANDOFF.md:439-440`).

- **Client.** It sets `swarmId` to `PlaybackStart.p2p.swarmId` (the broadcast id) and a
  `streamSwarmIdBuilder` that returns `ca1:<swarmId>:<main|secondary>:<rendition>`. The rendition
  comes from the variant playlist URL (`runtimeId`, `p2p-media-loader-hlsjs`
  `segment-manager.ts:27`), whose directory names it (`services/origin/src/paths.ts:19`; no
  directory means `source`), and audio tracks use `audio`. The library's default derivation
  hashes bitrate, codecs and frame rate, which the server cannot reproduce for the encoder-chosen
  source rendition.
- **Tracker.** It computes the allowed set as `computeInfoHash("ca1:<bid>:<type>:<r>")` for r in
  `source`, `KEYS.renditions(cid)` (`packages/contracts/src/internal.ts:137`) and `audio`. The
  ASCII hash recipe is reimplemented in a few lines, with a vector test against the library's
  exported `computeInfoHash` (`index.ts:8`). An announce or scrape outside the set is refused
  (`"failure reason": "unknown swarm"`).
- **Contract.** `PlaybackClaims` (`packages/contracts/src/tokens.ts:19-33`) gains an optional
  `bid` (broadcast id) and `p2p: true`, minted only when `p2pEnabled`. The tracker refuses a
  token without `p2p`, so gated, opted-out and native-HLS sessions cannot join, and a token from
  a previous broadcast cannot join the next broadcast's swarms. Like W1b's `dataMode`, the change
  goes into the Go mirror (`relay/internal/tokens/playback.go`) and the `packages/tokens`
  vectors.

**Alternative.** A Valkey key holding each channel's live broadcast id, read by the tracker,
with no claim change. That costs one more lookup per upgrade and does not close the gated-stream
hole.

### 6. P2P bytes pay nothing

Heartbeat `bytesP2p` is stored (`services/api/src/routes/playback.ts:215`,
`packages/db/src/schema/delivery.ts:84`) and loaded into integrity's session stats
(`packages/integrity/src/jobs.ts:236`), and no rule, payout, patronage or egress credit reads it
today. The decision makes that permanent: `bytesP2p` and anything a client reports about P2P
are informational (stats, the indicator, capacity planning). They never count toward relay
payouts, patronage, viewer-hour or egress credit, or integrity verdicts. The receipt cross-check
stays based on the origin and relays, and the only P2P input integrity takes is tracker evidence
(`P2P_EVIDENCE`, `internal.ts:195`). A unit test in `packages/integrity` pins that a session's
verdict is unchanged when only `bytesP2p` changes. **Alternative:** credit verified P2P upload
(a "seeding" reward). Rejected: it cannot be verified server-side and would be the easiest thing
to farm.

### What the P1 contract step lands (orchestrator)

- `PlaybackStart.p2p` gains `iceServers: { urls: string[]; username?: string; credential?: string }[]`
  and `credentialExpiresAt: Timestamp | null`. Credentials ride on playback start, with no separate
  endpoint or extra round trip. The heartbeat response gains an optional `p2p.iceServers` refresh.
  The `entities.ts:245-248` comment is corrected as described under decision 1.
- `PlaybackClaims` gains `bid?` and `p2p?: true`, in TS, Go and vectors (decision 5).
- `Heartbeat` keeps `bytesP2p` (`entities.ts:263`) and gains `bytesP2pUp` (non-negative integer)
  for the indicator and capacity numbers, documented as informational under decision 6. The route
  input's `p2pCapable` default (`packages/contracts/src/api/router.ts:655`, currently `true`)
  flips to `false`, so an old or third-party client never gets a tracker URL by accident.
- Env, in `packages/config` and `.env.example`: `P2P_STUN_URLS` (defaults to the instance's own
  host on 3478), `P2P_TURN_URLS` (empty by default), `TURN_SHARED_SECRET` (generated by
  `init-env.ts`), `TURN_CREDENTIAL_TTL_SECONDS`.
- Contract requests to other owners: `infra/tofu/**` (S1) adds `udp/3478` to the firewall and
  its test; `infra/caddy` is unchanged.

### Consequences of the amendment

- P1 can switch `p2pCapable` on, and `viewers` can show real `bytesP2p` with unchanged verdicts.
- Two new client dependencies are pinned and vetted. coturn adds one image and one UDP port.
- **Segments from peers are not verified against the origin.** A malicious peer in the same
  swarm could serve altered media to other viewers (a moderation risk, not an integrity one).
  The swarm is limited to authenticated, heartbeating sessions of one broadcast, which limits
  this but does not stop it. The fix is `validateP2PSegment` (`types.ts:524`) checking a
  per-segment digest from the origin. That is open question 3.

### Open questions (amendment 1)

1. Default on for desktop (with the first-run IP notice) or strict opt-in? It needs counsel's
   view for EU viewers: sharing an IP with other users is processing that needs a lawful basis.
2. TURN relay off by default (recommended), or on for our own instance with quotas?
3. Does P1 include per-segment digests for `validateP2PSegment` (origin publishes a SHA-256 per
   segment, the player checks it), or does P2P ship first with the risk recorded?
4. Accept the 12-hour tracker reconnect limit, or patch the socket pool now?
