<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# P1-tracker: derived info hashes, the P2P grant and origin segment digests

You are implementing unit P1-tracker for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/P1-p2p-client.md`,
`.claude/briefs/p1/contract-step.md` (what the orchestrator already committed),
[ADR 0005](../../../docs/decisions/0005-p2p-tracker.md) and its amendment 1 (accepted 2026-10-27;
decisions 5 and 7 are yours), and `services/tracker/README.md`. Do not look outside the repository, except the pinned
`p2p-media-loader-*` packages under `node_modules` (read-only, to check what the client sends).
Work in your own git worktree on a branch named `p1/tracker`, from the P1 contract commit.

## Why

The tracker (ADR 0005) accepts any 20-byte `info_hash` a client sends, so a client can open
junk swarms, and a socket authenticated for a stream the server never offered P2P for (18+
gated, restricted, opted out) can still announce. The amendment makes info hashes server-derived
from the channel's swarm id and puts the decision "may this session use P2P" on the server (the
`p2pGrant` key the API writes). The P2P web client (P1-player, wave 3) is also the first real
client: ADR 0005:60-62 left the interop check with it as a follow-up. Your job is to make the
tracker enforce the grant and the derived hashes, and to fix what the pinned client sends that the
tracker does not yet accept, before P1-player integrates.

A peer could also serve altered media to other viewers. The amendment (decision 7) closes that
with per-segment digests: the origin serves the SHA-256 of each segment at `/p2p-digest/…`, and
the player checks every P2P-delivered segment against it. You build the origin side.

## You own (write only these)

- `services/tracker/**` (source, tests, README). `src/ip.ts` and `tests/ip.test.ts` are gone:
  the contract step moved them into `@commonair/service` (`packages/service/src/ip.ts`).
- `services/origin/src/p2p-digest.ts` (the contract step's stub) and any new
  `services/origin/src/p2p-digest-*.ts` you split out; new `services/origin/tests/p2p-digest.test.ts`
  and `services/origin/tests/p2p-digest.int.test.ts`. The contract step's 501 assertion lives in
  `p2p-digest.test.ts`; replace it.

Nothing else. In particular not `packages/contracts/**`, `packages/service/**`,
`packages/integrity/**` (W0-integrity's in this wave), `services/api/**`, `compose.yaml`,
`infra/**`, `harness/**`, and in the origin not `origin.ts` (the contract step already wired your
handler; W0-media-exposure owns the dispatch this wave), `media.ts`, `vod.ts` (W0-media-exposure),
`paths.ts`, `handler.ts`, `content.ts`, `auth.ts`, `metrics.ts` or any other existing origin file.
Changes there are contract requests.

## Contracts you must honor (read-only for you)

- `packages/contracts/src/internal.ts`: `KEYS.p2pGrant(sid)` (STRING: the session's swarm id;
  written by the API at `playback.start` only when P2P is enabled; TTL `P2P_GRANT_TTL_SECONDS`,
  refreshed by heartbeats), `p2pStreamSwarmId`/`p2pAllowedStreamSwarmIds(swarmId)`
  (`ca1:<swarmId>:<main|secondary>:<rendition>`, rendition in `P2P_STREAM_RENDITIONS` =
  `RENDITIONS` + `audio`), `P2P_INFOHASH_VECTORS` (`src/p2p-vectors.ts`, generated with the pinned
  library's exported `computeInfoHash`: 20 ASCII characters, Base64 of 15 SHA-1 bytes); these
  three live in the browser-safe `@commonair/contracts/p2p` entry and are re-exported from
  `internal`. Also
  the unchanged `KEYS.p2pPeer`/`p2pLinks`/`p2pSwarm`/`p2pChannelNet`, `P2P_EVIDENCE`,
  `p2pSwarmId` (:155-223 at `9c51c93`, shifted by the contract step).
- `packages/contracts/src/tokens.ts:19-34` `PlaybackClaims` (`sid`, `cid`, `path`, `src`, `iat`,
  `exp`): no broadcast id in the token, which is why the grant carries the swarm id. The accepted
  amendment (decision 5) keeps it that way: no `bid`/`p2p` claims, no Go or vector change.
- `@commonair/service`: `canonicalIp`, `clientIp`, `connectionKey`, `isValidCidr`,
  `networkPrefix` (moved unchanged from the tracker).
- `trackerEnv` (`packages/config/src/env.ts:492-504`): `TRACKER_MAX_CONNECTIONS`,
  `TRACKER_MAX_CONNECTIONS_PER_IP`, `TRACKER_MAX_NUMWANT`, `TRACKER_TOKEN_MAX_AGE_SECONDS`. A new
  variable is a contract request (with its `.env.example` line).
- Evidence semantics (README "Evidence", integrity's `packages/integrity/src/p2p.ts`) do not
  change: same keys, same fields, same TTLs. Integrity must keep scoring the same way.
- P2P bytes pay nothing and the tracker never sees bytes; nothing here touches receipts.
- The API deletes the grant at `playback.end` and when a stream becomes gated mid-session
  (contract step 5), so the grant can vanish under an open socket.
- AGENTS.md: no IPs, tokens, peer ids or SDP in logs or metric labels (refusal reasons only, as
  `refuse` does today, `src/tracker.ts:148-153`). The tracker writes no database rows, so no
  `events` or `audit_log` rows apply.
- The digest seam (contract step 6): `services/origin/src/p2p-digest.ts` exports
  `P2P_DIGEST_ROUTE = "/p2p-digest/"` and `createP2PDigestHandler(deps: P2PDigestDeps):
  P2PDigestFetch` with `P2PDigestDeps = { publicKey, store: ContentStore, metrics?, logger?, now? }`
  and `P2PDigestFetch = (req, rawPath) => Promise<Response>`. `origin.ts` builds and dispatches it;
  keep both signatures (a change is a contract request). Caddy routes `/p2p-digest/*` to the
  origin. `PlaybackStart.p2p.digestUrl` is `${PLAYBACK_PUBLIC_URL}/p2p-digest`; the player
  requests `<digestUrl>/live/<slug>[/<rendition>]/<file>?t=<token>`.
- Origin internals you call but do not change: `parseMediaPath` (`src/paths.ts`, it accepts only
  the `ROUTES` prefixes), `ContentStore.get(ref)` (`src/content.ts`), `verifyPlaybackToken` from
  `@commonair/tokens`, `OriginMetrics.request(route, kind, source, status)` (route is a free
  string), the CORS headers the HLS handler uses (`src/handler.ts:57-63`; copy them, do not
  export them).
- Harness: the `viewers` scenario and every `harness/**` file are the orchestrator's (contract
  step 11). You add no harness scenario; put what it should assert in your final message.

## What is there today (verified at `9c51c93`)

- Upgrade (`src/tracker.ts:160-224`): resolves the client address (`:163-164`), holds a
  connection slot (`:165-170`), verifies the token (`:174-180`), refuses a duplicate session
  (`:184-185`, one socket per session, a newer `iat` replaces it), checks the heartbeat in
  `KEYS.viewers(cid)` (`:187-193`), builds `SocketData` with `net: evidence.networkHash(ip)` (`:203`).
  Refusals go through `refuse(status, reason)` (`:147-152`), counted in
  `tracker.upgrades.refused{reason}`.
- Frames (`src/protocol.ts`): `info_hash` must be a 20-char binary string (`:100-109`);
  `LIMITS.maxSwarmsPerSocket` is 4 (`:14`). Frame errors go through `frameError` (`tracker.ts:226-229`)
  as `{"failure reason": …}`, socket kept open.
- Swarms (`src/swarm.ts:5-10`): keyed `p2pSwarmId(channelId, hex(info_hash))`; any hash accepted.
- Evidence (`src/evidence.ts:13-16`): "client-chosen info hashes make per-swarm counts
  meaningless", hence the per-channel network cap.
- Tests: `tests/protocol.test.ts`, `swarm.test.ts`, `auth.test.ts`, `exchanges.test.ts` (unit),
  `tracker.int.test.ts` (454 lines, real Valkey, a test client in `tests/client.ts`).
- The API hands out `wss://<host>/tracker?t=<token>` (`services/api/src/routes/playback.ts:46-50`)
  and `swarmId: b.id` (:178); Caddy strips `/tracker` (`infra/caddy/Caddyfile:201-202`).

## Build

1. **The grant at upgrade.** After the heartbeat check, `GET KEYS.p2pGrant(sid)`. Absent →
   `refuse(403, "p2p_not_granted")`. A Valkey error → `refuse(503, "unavailable")`, as the
   heartbeat lookup does. Keep the slot accounting and the `taken()` re-check race-free (the
   existing pattern at :184-194). Store the swarm id on `SocketData`.
2. **Derived info hashes.** `src/infohash.ts`: from a swarm id, the set of allowed info hashes:
   `p2pAllowedStreamSwarmIds(swarmId)` through the loader's hash recipe, reimplemented in a few
   lines (read it in the pinned `p2p-media-loader-core`; the amendment cites
   `stream-identity.ts:125-127`). Do not import the browser library into the tracker. Cache per
   swarm id (a small bounded LRU: many sockets share one). An announce or scrape with any other
   `info_hash` gets
   `{"failure reason": "info_hash not allowed", info_hash}` and records nothing (no swarm join, no
   evidence); count it in `tracker.frames.refused{reason}`. Must match
   `P2P_INFOHASH_VECTORS` exactly.
3. **Re-check the grant** with the heartbeat re-check (`tracker.ts:238-250`, at most every
   30 s): a grant that disappeared (P2P switched off for the session, e.g. a stream that became
   gated) closes the socket with 1008, like a lapsed heartbeat.
4. **Interop with the pinned client.** Read the pinned `p2p-media-loader-core` (and the
   tracker-client package it uses) under `node_modules` and list every frame it sends and every
   field it reads back. Fix mismatches in the tracker, keeping the ADR 0005 subset tight. Check at
   least (the amendment's reading of 4.0.0 is in brackets; the file:line citations are the
   amendment's and were not checkable at `9c51c93`, because `node_modules` did not have the
   library yet; confirm each against the code):
   - **sockets per session** [pooled per tracker URL, `webtorrent-socket-pool/index.ts:31-35`,
     so one socket per session]: if it is not, the one-socket-per-session rule (409
     `duplicate_session`) breaks it; then allow one socket per derived stream swarm, keep "a newer
     `iat` replaces" per stream, and say so in your final message;
   - **swarms per socket** [each rendition and the audio track is its own swarm]: a session holds
     at most `LIMITS.maxSwarmsPerSocket` = 4 (`protocol.ts:14`, refused at `swarm.ts:142`). Check
     the client sends `event: "stopped"` when hls.js switches level; if it does not, the fifth
     switch is refused: decide between raising the limit to the allowed set's size or dropping
     the oldest swarm of the socket, and test it;
   - **fields** [`announce` with `info_hash`, `peer_id`, `numwant`, `uploaded`, `downloaded`,
     `offers`, `event` and an echoed `trackerid`; answers with `to_peer_id`/`offer_id`,
     `webtorrent-client/index.ts:545-570`, `:608-616`]: anything the parser refuses
     (`protocol.ts:107-146`), and the response fields the client reads (`interval`, `complete`,
     `incomplete`, `info_hash`, `peer_id` on relayed offers and answers, `trackerid` if needed);
   - **info hash encoding** [20 ASCII characters, which pass `isBinaryId`, `protocol.ts:66-70`]:
     the evidence keys use `hex(info_hash)`; keep that (it stays 40 hex characters);
   - **reconnect** [same URL, `websocket-client/index.ts:74`]: tokens older than
     `TRACKER_TOKEN_MAX_AGE_SECONDS` are refused as today; the player then stays on HTTP.
     Pin each confirmed frame shape as a fixture in `tests/` with a comment naming the library file
     and version it came from.
5. **Docs.** `services/tracker/README.md`: the grant check (new row in the Authentication table),
   the allowed-hash rule (Protocol subset), the new refusal reasons and counters, remove
   "client-chosen", and replace `podman compose --profile p2p up` (:128): the contract step
   removed the profile, so the tracker runs in every stack. Update the `src/evidence.ts:13-16` and
   `src/swarm.ts:5-10` comments likewise.
6. **Origin segment digests** (`services/origin/src/p2p-digest.ts`, amendment decision 7):
   - `GET|HEAD /p2p-digest/live/<slug>[/<rendition>]/<file>?t=<token>`. Strip the route prefix
     and parse the rest with `parseMediaPath("/hls/" + rest)`; anything outside the grammar, a
     `playlist` or a `part` → 404 without touching upstream. `OPTIONS` answers the CORS
     preflight like the HLS handler.
   - Token: `verifyPlaybackToken` (signature, expiry) and `claims.path === channelPath`, with
     **any** `src` (unlike `authorizeViewer`, which refuses `relay`): relay- and CDN-served
     viewers validate against the origin too. Any token failure → 403 `forbidden: <reason>`, as
     the HLS handler answers viewers (`src/handler.ts:94`).
   - Bytes: `store.get({ upstreamPath, file, kind: "segment" })`, the same cache and coalescing
     as `/hls/`, so at most one upstream fetch. Upstream 404 → 404; other upstream errors → 502
     as the HLS handler maps them (`src/handler.ts:174`, `:220`). Hash with `crypto.subtle.digest("SHA-256", body)`; memoize
     digests in a small bounded LRU keyed by `upstreamPath/file` (media objects never change).
   - Response: `200 text/plain; charset=utf-8`, body 64 lowercase hex characters,
     `cache-control: private, max-age=120`, the CORS headers; `HEAD` without a body.
   - Accounting: write **no** `SegmentFetch` (a digest is not a segment fetch; integrity's counts
     must not change) and no production record beyond what `ContentStore` already does for an
     upstream fetch. Count `metrics.request("p2p_digest", "segment", claims.src, status)` and
     `metrics.egress("p2p_digest", bytes)`. No IPs, tokens or paths in logs or labels.
   - Document the endpoint in `services/origin/README.md`'s route list **as a contract request**
     (not your file), and in `services/tracker/README.md` next to the grant (why: amendment
     decision 7).

## Tests you must add

- `tests/infohash.test.ts`: every `P2P_INFOHASH_VECTORS` entry; two swarm ids share no hash; the
  cache returns the same set; an unknown type or rendition name is not allowed.
- `tests/protocol.test.ts` / new fixture tests: every frame shape from step 4 parses; refused
  shapes stay refused.
- `tests/tracker.int.test.ts` (real Valkey, extend the existing helpers in `tests/client.ts`):
  no grant → 403 `p2p_not_granted`; grant present → announce to a derived hash works and writes
  evidence exactly as before; announce/scrape with a non-derived hash → failure reason, no
  `p2pPeer`/`p2pSwarm`/`p2pChannelNet` writes; grant deleted → socket closed 1008 at the next
  re-check; Valkey error on the grant read → 503; a level switch sequence (stopped + new swarm,
  or more than four swarms) behaves as you decided in step 4; the multi-socket rule if you
  changed it (limit, replacement per stream, still one evidence record per session).
- Existing tests keep passing with grants set up in their fixtures.
- `services/origin/tests/p2p-digest.test.ts` (unit, a fake `ContentStore` is fine here): the
  digest equals an independently computed SHA-256 (`node:crypto`) of the served bytes; lowercase
  hex, 64 characters; memoized (one hash per object); playlists, parts, bad grammar → 404 with no
  store call; missing, expired, wrong-path tokens refused; a `relay` or `cdn` token accepted;
  `HEAD` has no body; no `SegmentFetch` is recorded.
- `services/origin/tests/p2p-digest.int.test.ts` (real Postgres and Valkey, `createTestDatabase()`):
  `createOrigin` against a local `Bun.serve` stand-in for MediaMTX that serves the
  `tests/fixtures.ts` playlists and fixed segment bytes (no podman: `origin.int.test.ts` needs a
  real MediaMTX and is not yours to run); `/p2p-digest/` returns the SHA-256 of exactly what
  `/hls/` returns for the same segment with the same token; a second request makes no second
  upstream fetch; the `segments` stream gets no entry for digest requests.
- The tamper path (a peer serving altered bytes) is P1-player's unit test; no harness tamperer.

## Done means

Follow `.claude/briefs/_done-means.md`. This batch the orchestrator runs the gate: run only
`bun run --filter @commonair/tracker test`, `bun run --filter @commonair/tracker test:int` (the data
services are up at the `.env.example` defaults; do not run other packages' `test:int` at the same
time), `bun run --filter @commonair/origin test`, `bun --bun vp test run
services/origin/tests/p2p-digest.int.test.ts` (never the origin's whole `test:int`: it starts
MediaMTX under podman), `bunx tsc -p services/tracker --noEmit`, `bunx tsc -p services/origin
--noEmit`, and `vp lint --deny-warnings` and `vp fmt` on your paths. Never run `bun run verify`, `podman`, `scripts/infra.ts` or harness
scenarios. `git status` shows only `services/tracker/**` and your `services/origin` files. Commit in your worktree
(`git commit -s`, Conventional Commits, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).

Final message: what you built, test counts (unit, int), branch and sha, the frame list from step 4
with what you changed, the digest endpoint's behavior and test counts, contract requests (exact
changes in files you do not own, e.g. a contracts doc that the multi-socket change contradicts, a
vector that disagrees with the library, the `services/origin/README.md` route line), what is
left undone, and the commands the user should run live (the `viewers` scenario with `--set p2p=10`
once P1-player merges).
