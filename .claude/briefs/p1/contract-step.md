<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# P1 contract step (orchestrator only)

The steps the orchestrator takes before launching P1-tracker and P1-turn (wave 2) and P1-player
(wave 3). Cut from `.claude/briefs/next/P1-p2p-client.md` and
[ADR 0005](../../../docs/decisions/0005-p2p-tracker.md) amendment 1, **accepted 2026-10-27**
(its "Decisions at acceptance" section lists the answers). Every repository path and line number
was checked at `9c51c93`; wave 1 (E7) and the W0 contract step land first, so re-check the line
numbers before editing.

What the accepted amendment decides, and these briefs implement:

1. Client library: `p2p-media-loader-core` + `p2p-media-loader-hlsjs` **4.0.0**, exact pins,
   Apache-2.0.
2. ICE: the instance's own coturn, STUN only; the TURN relay off by default; no public STUN
   anywhere. ICE servers come from a separate `p2p.iceServers` endpoint; TURN credentials (only
   when an operator turns the relay on) are TURN REST credentials whose username id is an HMAC of
   the session id.
3. **Opt-in by default** (changed from the draft): `P2P_DEFAULT=off|on` (default `off`) is the
   operator's default for viewers who have not chosen, until counsel confirms an EU lawful basis
   for showing a viewer's IP to peers. Never for 18+/gated streams; a visible indicator; the IP
   disclosure before P2P first starts; one-click off; off on metered connections, touch-primary
   devices and in data mode even when the operator default is `on`.
4. Who may join: a per-session Valkey grant `KEYS.p2pGrant` (no `PlaybackClaims` change, no Go
   or vector change). Info hashes are derived server-side from the grant's swarm id; the tracker
   refuses others.
5. **Per-segment digests are in P1** (amendment decision 7): the origin serves a SHA-256 per
   segment at `/p2p-digest/…`; the player validates every P2P-delivered segment with
   `validateP2PSegment`, refetches over HTTP on a mismatch and disconnects the peer.
6. The 12 h tracker reconnect limit is accepted (HTTP fallback).
7. P2P bytes pay nothing. Receipt cross-checks stay origin- and relay-based; integrity trusts only
   tracker evidence (`P2P_EVIDENCE`), never heartbeat `bytesP2p`.

Order: steps 1–10 in one commit (`feat(p2p): P1 contract step`), `bun run verify` green, then
"In flight" in PROGRESS.md, then launch wave 2. Step 11 lands in the same commit with the new
assertions behind a parameter that defaults off until P1-player merges.

## 1. Dependencies: vet and add (units never `bun add`)

- Amendment facts (2026-10-27): `p2p-media-loader-core` and `-hlsjs` **4.0.0**, published
  2026-08-19, **Apache-2.0** (not MIT as the plan file says; on the allowlist), direct deps only
  `debug` (already in `bun.lock`), no install scripts, provenance attested; the hls.js adapter
  is built against `hls.js ^1.7.0` and plugs in as `fLoader`/`pLoader`.
- Re-run `bun scripts/vet-package.ts p2p-media-loader-core@4.0.0` and
  `… p2p-media-loader-hlsjs@4.0.0`; read every warning. Add both to `apps/web/package.json`
  `dependencies` with exact versions (hls.js is :27), `bun install`, commit `bun.lock`;
  `bun scripts/check-licenses.ts` and `check-supply-chain.ts` clean. Add both to ADR 0002's
  dependency table. Check `patches/hls.js@1.7.3.patch` (`package.json:84`) still applies.

## 2. coturn image: pin and license

- Amendment facts: `docker.io/coturn/coturn:4.18.0-trixie` (2026-09-08), BSD-3-Clause
  (`https://github.com/coturn/coturn/blob/4.18.0/LICENSE`), Debian trixie base.
- Add the `infra/image-licenses.json` entry (shape as `docker.io/library/postgres`, :2-7; notes
  name the base and the linked libraries: OpenSSL, libevent, hiredis, libpq).
- Resolve the digest (`skopeo inspect`, or `podman pull` + `podman image inspect`) and write
  `docker.io/coturn/coturn:4.18.0-trixie@sha256:<digest>` into P1-turn.md ("Contracts"). P1-turn
  uses exactly that string; `bun scripts/pin-images.ts` (report mode) then agrees.

## 3. Env: `packages/config/src/env.ts` and `.env.example` (a test enforces the sync)

API side: a **new `turnEnv` schema**, not `playbackEnv`, because
`scripts/selfhost/unit-env.ts:57-66` hands the origin all of `playbackEnv` and the origin must not
get the TURN secret. Add it to `ALL_ENV_SCHEMAS` (`env.ts:548`), to the API's `SCHEMAS` and
`ApiEnv` (`services/api/src/env.ts:31-51` and below), and regenerate
`infra/selfhost/env/commonair-api.keys` with `bun scripts/selfhost/unit-env.ts`. Names as in the
accepted amendment:

| Key                           | Schema                                                                           | `.env.example` (new block after the tracker block, :145-149) |
| ----------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `P2P_STUN_URLS`               | comma list → `string[]`, each `^stun:`; empty = none                             | `P2P_STUN_URLS=stun:localhost:3478`                          |
| `P2P_TURN_URLS`               | comma list → `string[]`, each `^turns?:`; empty = relay off                      | `P2P_TURN_URLS=`                                             |
| `TURN_SHARED_SECRET`          | `z.string().min(32).optional()`; the API requires it when `P2P_TURN_URLS` is set | `TURN_SHARED_SECRET=__generate__`                            |
| `TURN_CREDENTIAL_TTL_SECONDS` | int 300–86400, default `3600`                                                    | `TURN_CREDENTIAL_TTL_SECONDS=3600`                           |

The relay is **off by default** (amendment decision 2: a relayed peer's bytes cross the
droplet twice, so TURN saves no egress, and the DigitalOcean firewall test forbids port ranges).
STUN always runs.

The operator default, in **`playbackEnv`** next to `P2P_ENABLED` (`env.ts:353`; not secret, so
the origin receiving it through `playbackEnv` is harmless):

| Key           | Schema                                                                                                                                       | `.env.example` (after `P2P_ENABLED`, :136) |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `P2P_DEFAULT` | `z.enum(["off", "on"]).default("off")`; comment: the default for viewers who have not chosen; `on` only once counsel confirms a lawful basis | `P2P_DEFAULT=off`                          |

Compose/Quadlet side, in `infraEnv` (`env.ts:394-440`, all optional; `.env.example` under
`# --- infrastructure ---`, :162):

| Key                                           | Use                                                 | `.env.example`    |
| --------------------------------------------- | --------------------------------------------------- | ----------------- |
| `TURN_PORT`                                   | coturn listening port (STUN, and TURN when enabled) | `3478`            |
| `TURN_RELAY_PORT_MIN` / `TURN_RELAY_PORT_MAX` | relay range (UDP), used only when the relay is on   | `49160` / `49199` |
| `TURN_EXTERNAL_IP`                            | public address coturn advertises (empty: none)      | empty             |

`TURN_SHARED_SECRET` is also coturn's `static-auth-secret`. `scripts/init-env.ts` fills
`__generate__`; check `init-env --merge` adds it to an existing `.env`.

- Write `turnEnv` as `turnShape.superRefine(...)` (the `moderationEnv` pattern, `env.ts:313`):
  `P2P_TURN_URLS` non-empty without `TURN_SHARED_SECRET` refuses to start (fail closed). This is
  the startup check, so P1-turn needs no contract request for it.
- `TURN_EXTERNAL_IP` is **one** address. `MTX_WEBRTCADDITIONALHOSTS` can be a list (IPv4,IPv6), so
  P1-turn takes its first IPv4 entry; document that in the schema comment.
- Regenerate the configuration reference: `bun scripts/config-reference.ts`. It rewrites the
  generated block of `docs/self-hosting/configuration.md`, and `scripts/tests/config-reference.test.ts`
  fails if any schema or `.env.example` key is missing from it.

## 4. Contracts: `packages/contracts`

`src/api/entities.ts`:

- `PlaybackStart.p2p` (:249) gains two fields: `available: z.boolean()` (P2P is possible for
  this session at all: `P2P_ENABLED`, not native HLS, not gated; independent of `p2pCapable`, so
  the player can offer the opt-in switch) and `digestUrl: z.string()` (the origin's digest base,
  `${PLAYBACK_PUBLIC_URL}/p2p-digest`, also when `enabled` is false). `enabled` means the grant
  was written. Rewrite the doc (:244-248): `swarmId` is server chosen (the broadcast id,
  `services/api/src/routes/playback.ts:178`) and is the loader's `swarmId`; stream swarm ids and
  info hashes derive from it (below). Replace "on a tracker reconnect clients replace `t`" (the
  stock loader cannot: `announceTrackers` is fixed at construction): a reconnect after
  `TRACKER_TOKEN_MAX_AGE_SECONDS` falls back to HTTP. Document `digestUrl` (amendment decision 7):
  `GET <digestUrl>/live/<slug>[/<rendition>]/<file>?t=<token>` → 64 lowercase hex characters,
  the SHA-256 of the segment as `/hls/` serves it; served only by the origin.
- New `IceServers = z.object({ iceServers: z.array(z.object({ urls: z.array(z.string()).min(1),
  username: z.string().optional(), credential: z.string().optional() })), expiresAt:
  Timestamp.nullable() })` (`null` when nothing expires: STUN only).
- `Heartbeat` (:255-280), after `bytesP2p` (:263): optional `bytesP2pUp` (int ≥ 0, delta of bytes
  sent to peers), `p2pPeers` (int 0–64, open peer connections now) and `p2pRejected` (int ≥ 0,
  delta of P2P-delivered segments that failed digest validation). Doc: informational only;
  nothing that counts, pays or verifies reads them (amendment decision 6).
- `InstanceInfo.features` (:1039-1045) gains `p2pDefault: z.enum(["off", "on"])` (the operator's
  `P2P_DEFAULT`). The web app already loads `instance.info` in the root loader
  (`apps/web/src/server/bootstrap.ts:23`), so the player's policy reads it from there.

`src/api/router.ts`:

- `playback.start` input `p2pCapable` default (:655) flips from `true` to `false` (an old or
  third-party client never gets a tracker URL by accident; harness HTTP viewers already send
  `false`).
- New top-level namespace `p2p` after `playback` (:639-691):

```ts
p2p: {
  iceServers: base
    .meta({ access: "public", rateLimit: "playback" })
    .route({
      method: "POST",
      path: "/playback/ice-servers",
      summary: "ICE servers and time-limited TURN credentials for a P2P playback session",
      ...tag("Playback"),
    })
    .input(z.object({ sessionId: Id, token: z.string() }))
    .output(D.IceServers),
},
```

Refusals, documented on the procedure, the same as `playback.heartbeat`
(`services/api/src/routes/playback.ts:188-191`): `UNAUTHORIZED` for a bad token or a mismatched
`sid`, `NOT_FOUND` for an unknown session, `CONFLICT` for an ended one. Add `PRECONDITION_FAILED`
with `requirement: "p2p"` (`precondition("p2p")`, `services/api/src/lib/errors.ts:30`) for a
session without a grant.

`src/internal.ts`:

- `KEYS.p2pGrant(sessionId)` → `p2p:grant:<sid>`: STRING holding the session's swarm id. Written
  by the API at `playback.start` only when P2P is enabled for the session, TTL
  `P2P_GRANT_TTL_SECONDS = 43_200` (the default `TRACKER_TOKEN_MAX_AGE_SECONDS`), refreshed by
  each committed heartbeat. Read by the tracker (no grant, no socket) and by `p2p.iceServers`.
  Absent means no P2P for that session, whatever the client says.
- The browser imports the stream swarm id helpers and vectors, and `apps/web` imports nothing from
  `@commonair/contracts/internal` today (it holds Valkey keys and service-to-service schemas). So
  put the next two bullets in a new **browser-safe `src/p2p.ts`**, exported as
  `@commonair/contracts/p2p` (a new `exports` entry in `packages/contracts/package.json`, next to
  `./internal`, :18). Its only imports are `RENDITIONS` from `./enums.ts` and `./p2p-vectors.ts`.
  Re-export it from `internal.ts` so the tracker can use either entry.
- Stream swarm ids (amendment decision 5): the player sets the loader's
  `streamSwarmIdBuilder` to `p2pStreamSwarmId(swarmId, type, rendition)` =
  `` `ca1:${swarmId}:${type}:${rendition}` `` with `type` `main | secondary` and `rendition` the
  directory of the variant playlist (`services/origin/src/paths.ts:17-19`; none means `source`),
  `audio` for audio tracks. Export `P2P_STREAM_RENDITIONS = [...RENDITIONS, "audio"]` and
  `p2pAllowedStreamSwarmIds(swarmId)` (both types × every name: a fixed, small set, so the
  tracker needs no `KEYS.renditions` read). The info hash is the loader's own
  `computeInfoHash(streamSwarmId)` (20 ASCII characters, Base64 of 15 SHA-1 bytes, per the amendment).
- New `src/p2p-vectors.ts`: `P2P_INFOHASH_VECTORS` (`{ streamSwarmId, infoHash }[]` for two swarm
  ids, all types and names), **generated by calling the pinned library's exported
  `computeInfoHash`** in a throwaway Bun script; exported from the `p2p` entry (and through it,
  `internal`). P1-tracker
  reimplements the recipe against these vectors; P1-player tests the builder against them.
- Docs: `p2pChannelNet` (:175-182) and `p2pSwarmId` (:222-223) no longer say client-chosen; the
  per-channel network cap stays.

## 5. API: wiring and the gate (no unit owns these files)

- `services/api/src/routes/p2p.ts` (new): `export const p2p = { iceServers:
  os.p2p.iceServers.handler(() => notImplemented()) }` (`services/api/src/lib/errors.ts:36`).
  P1-turn owns it afterwards.
- `services/api/src/router.ts`: import and register `p2p` after `playback` (:23, :38).
- `services/api/src/routes/playback.ts`:
  - :138: `const isGated = await gated(deps, b, c)` once; the mature check uses it.
  - :152-153: `p2pAvailable = deps.env.P2P_ENABLED && !input.nativeHls && !isGated` and
    `p2pEnabled = p2pAvailable && input.p2pCapable`, with a comment: 18+, mature-category and
    T1-restricted streams never get P2P; `p2pCapable` is the player's opt-in policy (amendment
    decision 3), and the operator default is applied by the player from `instance.info`, so a
    viewer who has not opted in never gets a grant. There are no private or subscriber-only live
    streams at `9c51c93` (`visibility` is VOD-only, `packages/db/src/schema/media.ts:150`); whoever
    adds one adds it here.
  - the response's `p2p` gets `available: p2pAvailable` and
    `digestUrl: `${deps.env.PLAYBACK_PUBLIC_URL}/p2p-digest``; `trackerUrls` stay empty unless
    `p2pEnabled`.
  - after the insert (:155-172), when `p2pEnabled`: `SET KEYS.p2pGrant(sid) b.id EX
    P2P_GRANT_TTL_SECONDS`.
  - heartbeat tx (:266-270): `.expire(KEYS.p2pGrant(s.id), P2P_GRANT_TTL_SECONDS)` (no-op when
    absent). **Revocation:** a stream that becomes gated mid-session (T1 restriction, the mature
    flag set or a category change) must lose P2P. P1-tracker's re-check closes the socket when
    the grant is gone, but nothing deletes the grant today. In the heartbeat, for sessions whose
    grant exists, re-evaluate `gated` against the session's broadcast and channel, and `DEL` the
    grant instead of `EXPIRE` when the stream is gated. Sessions without a grant pay no extra
    query. This is required (amendment decision 5 relies on it); it is not deferrable.
  - `playback.end` (:322-337): add `.del(KEYS.p2pGrant(input.sessionId))` to its multi, so an
    ended session's tracker socket closes at the next re-check.
  - heartbeat: the new optional fields become metrics only (`playback.p2p.bytes{direction}`,
    `playback.p2p.peers`, `playback.p2p.rejected`). No DB column, no `recordHeartbeat` change
    (`packages/integrity` is W0-integrity's in wave 2).
- `services/api/src/routes/instance.ts` (:107-113, E7-admin's in wave 1, merged before this
  step): `features.p2pDefault: env.P2P_DEFAULT`, and add `P2P_DEFAULT` to whichever env schema
  the instance route reads (`playbackEnv` is already in the API's `SCHEMAS`).
- Integration tests in `services/api/tests/`: gated → `p2p.enabled: false` and
  `available: false`, no grant; not gated with `p2pCapable: false` → `available: true`,
  `enabled: false`, no grant; enabled → grant = `swarmId` with the TTL; `digestUrl` is
  `PLAYBACK_PUBLIC_URL` + `/p2p-digest`; `instance.info` reports `p2pDefault` (`off` by default); a heartbeat refreshes it; a stream restricted mid-session loses
  its grant at the next heartbeat; `playback.end` deletes it; `p2pCapable` omitted → disabled
  (the existing cases at `round3.int.test.ts:145-172` and `platform.int.test.ts:289-293` already
  pass `p2pCapable` or `nativeHls` explicitly); `p2p.iceServers` registered (stub answers
  `NOT_IMPLEMENTED`).
- Checked against the E7 and W0 briefs (2026-10-27): no unit owns `services/api/src/router.ts` or
  `routes/playback.ts` (W0-integrity and W0-media-exposure only read `playback.ts`). E7-admin owns
  `routes/instance.ts` in wave 1, which merges before this step.

## 6. Origin: the `/p2p-digest/` seam (amendment decision 7)

P1-tracker builds the digest endpoint in wave 2 as new files; W0-media-exposure owns
`services/origin/src/media.ts`, the new `vod.ts` and the route dispatch in `origin.ts` (:126-130)
in the same wave. So this step lands every shared line now, and P1-tracker touches only its own
new files afterwards.

- `services/origin/src/p2p-digest.ts` (new; P1-tracker owns it afterwards): `export const
  P2P_DIGEST_ROUTE = "/p2p-digest/"` and `export function createP2PDigestHandler(deps:
  P2PDigestDeps): P2PDigestFetch` with `P2PDigestDeps = { publicKey: CryptoKey; store:
  ContentStore; metrics?: OriginMetrics; logger?: Logger; now?: () => number }` and
  `P2PDigestFetch = (req: Request, rawPath: string) => Promise<Response>`. The stub answers
  `501` with the handler's CORS headers.
- `services/origin/src/origin.ts`: build it next to `mediaHandler` (:126) from
  `signingKey.publicKey`, `store`, `metrics`, `opts.logger`, `now`, and dispatch it in
  `fetchHandler` before the HLS fallback: `if (rawPath.startsWith(P2P_DIGEST_ROUTE)) return
  digestHandler(req, rawPath);`. **W0-media-exposure must keep this line** when it edits the
  dispatch (tell it in its brief before wave 2 launches).
- `infra/caddy/Caddyfile`: `handle /p2p-digest/* { reverse_proxy origin:3003 }` next to
  `handle /hls/*` (:180-182), the route table comment (:37-40 area, as the W0 step did for
  `/vod/*`), and the route in `infra/tests/caddy.test.ts`. The selfhost bundle ships the same
  Caddyfile. No relay (Go) or CDN change: digests come only from the origin, the trust anchor.
- CSP: none. In production the digest URL is same-origin through Caddy; in dev it is the origin's
  port, like `/hls/`.
- `services/origin/tests/p2p-digest.test.ts` (new; P1-tracker owns it afterwards): `/p2p-digest/…`
  reaches the stub (501) and `/hls/…` is unchanged. P1-tracker replaces the 501 assertion.

## 7. Move `services/tracker/src/ip.ts` into `@commonair/service`

What is there: `services/tracker/src/ip.ts` (162 lines) exports `parseIp` (:52), `inCidr` (:62),
`isValidCidr` (:75), `clientIp` (:89), `canonicalIp` (:131), `connectionKey` (:143),
`networkPrefix` (:156); its header (:7-10) records the request. Importers:
`services/tracker/src/tracker.ts:16`, `evidence.ts:20`, `env.ts:4`, `index.ts:6` (re-exports
`canonicalIp`, `clientIp`, `networkPrefix`; nothing imports `@commonair/tracker`), and
`services/tracker/tests/ip.test.ts:6`. `packages/service` exists (`src/index.ts` re-exports
`server.ts`, `valkey.ts`); every service, the tracker included, already depends on it.

- Create `packages/service/src/ip.ts` with the seven functions unchanged; `export * from
  "./ip.ts"` in its `index.ts`; move the test to `packages/service/tests/ip.test.ts`.
- Point the tracker's four imports at `@commonair/service`; drop the re-export from
  `services/tracker/src/index.ts`; delete `services/tracker/src/ip.ts` and its test.
- Optional, only if no E7 unit owns the files: `services/api/src/lib/ip.ts` re-exports `parseIp`,
  `inCidr`, `clientIp`, and `netrange.ts` re-exports `canonicalIp`, from `@commonair/service`
  (`looksProxied`, `isPublicAddress`, `rateLimitSubjectIp` stay). Do **not** merge `connectionKey`
  with `rateLimitSubjectIp`: they spell an IPv6 /64 differently and both spellings are stored as
  rate-limit subjects. Leave `services/origin/src/clientip.ts` (its own parsed-CIDR variant).

## 8. The tracker in every stack

- `compose.yaml:379-381`: drop `profiles: [p2p]` from `tracker` (`P2P_ENABLED` is true by
  default, `.env.example:136`: the feature is offered and viewers opt in, so opted-in players
  would get tracker URLs for a tracker that is not running); fix
  the header (:12-13, "p2p: + tracker (not built yet)") and `infra/tests/compose.test.ts:210`
  and its `optional` list (:211-212). Fix the other references to the profile too:
  `.env.example:145` ("compose profile p2p") and `HANDOFF.md:406`. `services/tracker/README.md:128`
  is P1-tracker's (Build 5).
- `scripts/infra.ts:26-32`: add `"tracker"` to `STACK_HEALTHY_SERVICES` (P1-turn sends
  `"coturn"` as a contract request).
- Quadlet already ships `commonair-tracker.container`; Caddy routes `/tracker*`
  (`infra/caddy/Caddyfile:201-202`).

## 9. Web seams for P1-player

- `apps/web/src/i18n/p2p.ts` (new, `export const p2pMessages = {} as const;`), spread into `en`
  in `apps/web/src/i18n/en.ts` (:4-16) like the other area catalogs. P1-player owns `p2p.ts`.
- Test ids in `harness/src/web/selectors.ts` (next to `PLAYER_SOURCES`, :302-304) and a new
  `docs/testing/p1-selectors.md`: `player-p2p` (indicator), `player-p2p-notice` (first-run IP
  notice), `player-p2p-dialog`, `player-p2p-toggle`, `privacy-p2p-toggle` (on
  `/settings/privacy`); `data-p2p` on `player` = `off | on | sharing` (`P2P_STATES`);
  localStorage `commonair:p2p` = `on | off` (`P2P_PREFERENCE_KEY`), plus `commonair:p2p-notice`
  = `seen` (`P2P_NOTICE_KEY`); `commonair:p2p` absent = the operator default
  (`instance.info` `features.p2pDefault`, `off` unless the operator set `P2P_DEFAULT=on`).
  The first-run notice appears only when that default is `on` and the viewer has not chosen;
  opting in through the dialog or the settings section shows the same disclosure next to the
  switch and sets `commonair:p2p-notice=seen`.
- `apps/web/src/server/security.ts:13` sets only `frame-ancestors`: no CSP change for the tracker
  WebSocket or WebRTC.

## 10. Legal text (`packages/db` is the orchestrator's)

- `packages/db/src/legal/privacy.md:23-32` mentions P2P bytes and HMAC'd networks; add a P2P
  section: sharing is off unless you turn it on (or the instance's operator made it the default,
  in which case a notice tells you before it starts); other viewers in the same swarm see your IP
  address while sharing is on; never on 18+ or restricted streams; how to switch it off (player
  and `/settings/privacy`). Draft text, not reviewed by counsel (amendment decision 3).
- `packages/db/src/legal/cookies.md` "Peer-to-peer delivery": the preference and notice flags are
  essential storage (privacy choices, like the consent record), so "off" holds when preferences
  are declined.
- Seed version: E7-legal's proposed `privacy.md`/`cookies.md` lines are applied at wave-1
  integration, before this step. Do not bump the shared `LEGAL_SEED_VERSION`
  (`packages/db/src/legal/index.ts:17`): use the per-kind `version` the W0 contract step adds to
  `SEED_META` for `privacy` and `cookies`. `privacy` has `requiresAcceptance: true`; check
  whether a new privacy version asks every user to re-accept, and say so in PROGRESS.md.
- The defaults are settled: `P2P_DEFAULT=off` until counsel confirms an EU lawful basis
  (counsel has not reviewed it). An operator who has that basis sets `P2P_DEFAULT=on`.

## 11. Harness: `viewers` with opted-in and default (not opted-in) Chromium viewers

Files: `harness/scenarios/viewers.ts`, `harness/src/platform.ts` (`openViewers`, :167-207),
`harness/src/browser-viewer.ts`, `harness/src/proxy.ts`, `harness/src/web/selectors.ts`, a harness
`harness/src/metrics.ts`, a harness compose override if needed, `harness/README.md`,
`harness/tests/`. Checked (2026-10-27): no wave-2 unit owns `platform.ts` or `proxy.ts`
(W0-clock and W0-integrity list them as not theirs).

What is there: `viewers` (82 lines) opens `chromium`/`webkit`/`http` viewers and checks
convergence, overshoot, stalls and decay. The harness player has no P2P loader
(`harness/player/player.ts:149-150`); only `player: "web"` (the real embed route,
`browser-viewer.ts:10-11`, option at :136-139, one viewer per page at :298) can run P2P, and
web viewers get no simulated address (`ip` is a harness-player parameter). The probe's
`bytesP2p` comes from `__harnessBytes`, which only the harness player sets
(`harness/player/probe.ts:160-168`), so it reads 0 for web viewers.

- **Params:** `p2p` (opted-in web Chromium viewers; default `0` until P1-player merges, then `10`)
  and `p2pDefault` (web Chromium viewers left at the default, which is off; default `1` when
  `p2p > 0`). `ViewerMix` gains `p2p?: { optedIn: number; atDefault: number }`; these always use
  `player: "web"`, whatever `HARNESS_PLAYER` says. The stack runs with `P2P_DEFAULT=off` (the
  default); the scenario asserts `instance.info` reports `p2pDefault: "off"` before it starts.
- **Preference:** opted-in viewers opt in explicitly: an init script per context sets
  `commonair:p2p=on` and `commonair:p2p-notice=seen` before the app loads. Default viewers get no
  init script: no storage keys at all, exactly like a first-time visitor.
- **WebRTC in headless Chromium:** add `--disable-features=WebRtcHideLocalIpsWithMdns` unless mDNS
  candidates resolve between pages without it, and an init script counting `RTCPeerConnection`
  constructions into `window.__harnessPeerConnections`.
- **Distinct networks at the tracker.** Integrity lowers the expected HTTP share only for sessions
  linked to a peer on another network (ADR 0005 decision 4). If all ten viewers reach the tracker
  from one address none is evidenced, and a viewer fed mostly by peers can trip
  `too_few_segments` (< 25 % of expected, `packages/integrity/src/signals/fetch.ts:20`), so
  verdicts would differ from the baseline. Add a WebSocket mode to `harness/src/proxy.ts` that
  reads `sid` from the `t` token body (base64url JSON, as `apps/web/src/player/source.ts:39-52`),
  maps it deterministically to a residential address (one /24 per session, from
  `platform.residential`'s pool) and forwards with `x-forwarded-for` through the trust path the
  API proxy already uses (`proxy.ts:7-12`). The harness override points `P2P_TRACKER_URL` at it
  on a fixed port.
- **Assertions** (P1 done), with `p2p=10`:
  - every viewer starts; the verified count converges to exactly N and never exceeds it;
  - `sum(playback_sessions.bytes_p2p) > 0` over the opted-in sessions (the database is the record);
  - digests checked: `origin.requests{route="p2p_digest",status="200"}` rose during the run and
    `playback.p2p.rejected` stayed 0 (new PromQL constants next to `ORIGIN_EGRESS_QUERY`). A
    tampering peer is not simulated: the tamper case is a P1-player unit test (amendment
    decision 7);
  - origin egress drops: opted-in sessions' `bytes_http / watch_seconds` is below the
    default viewers' baseline by a stated margin (start at 20 %, tune from the first runs, record it), and the
    run's `origin.egress.bytes` (`ORIGIN_EGRESS_QUERY`, `harness/src/metrics.ts:102`) is a metric;
  - verdicts unchanged: after scoring, opted-in sessions have the same verdict as default and
    HTTP sessions (all `verified`), none with a fetch reason;
  - the default viewer never connected to peers: its player shows `data-p2p="off"`,
    `__harnessPeerConnections === 0` on its page, and neither `KEYS.p2pGrant(sid)` nor
    `KEYS.p2pPeer(sid)` exists.
- Unit tests for the token-to-address mapping and the param defaults.

## After the step

- Fill the coturn image digest into P1-turn.md (the versions are fixed at 4.0.0 by the
  amendment; if the re-vet in step 1 refuses 4.0.0, stop and go back to the user, do not pick
  another version silently).
- Shared files in wave 2. W0-media-exposure owns `infra/README.md` (:224-231). So P1-turn does
  **not** edit it: it sends its Ports-table rows (`TURN_PORT` 3478/udp, and the relay range when
  the relay is on) as a contract request, and the orchestrator applies them after both units
  merge. W0-clock owns `infra/mediamtx/mediamtx.yml`. P1-turn owns `scripts/selfhost.sh` and
  `compose.yaml` this wave, so W0-clock's NTP check lands after P1-turn merges.
- Origin in wave 2: W0-media-exposure owns `services/origin/src/media.ts`, `vod.ts`, the dispatch
  in `origin.ts` and its own new test files; P1-tracker owns only
  `services/origin/src/p2p-digest*.ts` and `services/origin/tests/p2p-digest*.test.ts` (new
  files; step 6 landed every shared line). Add to W0-media-exposure's brief, before launch: keep
  the `P2P_DIGEST_ROUTE` dispatch line, and name no new file `p2p-digest*`.
- AGENTS.md rules for this step. No DB write here has a side effect for other systems: the grant
  is Valkey-only, and P2P bytes stay out of receipts. So there is no `events` row, and no
  moderator or admin action, so no `audit_log` row. Keep IPs, tokens and swarm ids out of the
  new metrics' labels.
- PROGRESS.md "In flight": P1-tracker and P1-turn (wave 2), P1-player (wave 3), with their paths.
- Launch "read and implement `.claude/briefs/p1/P1-tracker.md`" (branch `p1/tracker`) and
  "… `P1-turn.md`" (branch `p1/turn`), each in its own worktree from the contract commit;
  P1-player (`p1/player`) in wave 3 from a main with both merged.
- P1 done (after P1-player merges): flip `p2p` to `10`; the user runs
  `bun harness/src/cli.ts run viewers` and `bun run verify:full`; `integrity-basic` unchanged.
