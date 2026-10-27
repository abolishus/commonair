<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# P1 contract step (orchestrator only)

The steps the orchestrator takes before launching P1-tracker and P1-turn (wave 2) and P1-player
(wave 3). Cut from `.claude/briefs/next/P1-p2p-client.md` and
[ADR 0005](../../../docs/decisions/0005-p2p-tracker.md) amendment 1 (proposed 2026-10-27, being
drafted in parallel; its library and image facts are quoted below). Every repository path and
line number was checked at `9c51c93`. **If the amendment changes at acceptance, update this file
and the three unit briefs before launch.**

What the briefs assume the amendment decides:

1. Client library: `p2p-media-loader-core` + `p2p-media-loader-hlsjs`, pinned and vetted.
2. ICE: the instance's own coturn is the only default ICE server. No public STUN anywhere. TURN
   credentials are time-limited TURN REST credentials minted by the API.
3. Default on for desktop; off on touch-primary devices, metered connections and in data mode
   (W1b, not built); never for 18+ gated, restricted or private/subscriber streams; a visible
   indicator; IP disclosure and a one-click off.
4. Info hashes are derived server-side from the channel's swarm id; the tracker refuses others.
5. P2P bytes pay nothing. Receipt cross-checks stay origin- and relay-based; integrity trusts only
   tracker evidence (`P2P_EVIDENCE`), never heartbeat `bytesP2p`.

**Two places where these briefs and the amendment draft differ; settle both at acceptance:**

- _Credentials._ The orchestrator's plan is a separate `p2p.iceServers` endpoint (below, step 4).
  The draft puts `iceServers` + `credentialExpiresAt` on `PlaybackStart.p2p` and refreshes them in
  the heartbeat response. Either works with the loader's runtime `rtcConfig`; if the draft wins,
  replace step 4's procedure with those fields and move P1-turn's handler into a helper the
  contract step calls from `playback.ts`.
- _Who may join._ These briefs use a per-session **grant key** in Valkey (`KEYS.p2pGrant`, step
  4): written only when P2P is enabled for the session, refreshed by heartbeats, revocable. The
  draft adds `bid` and `p2p: true` claims to `PlaybackClaims`, which also changes the Go relay
  mirror (`relay/internal/tokens/playback.go`) and `packages/tokens/vectors.json`. The draft
  rejects a per-**channel** key; a per-session grant closes the same gated-stream hole (no grant
  for gated sessions) without a token change, and can be withdrawn mid-session. If the claims win,
  P1-tracker reads `bid`/`p2p` from the verified token instead of the grant.

Order: steps 1–9 in one commit (`feat(p2p): P1 contract step`), `bun run verify` green, then
"In flight" in PROGRESS.md, then launch wave 2. Step 10 lands in the same commit with the new
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
`infra/selfhost/env/commonair-api.keys` with `bun scripts/selfhost/unit-env.ts`. Names follow the
amendment draft:

| Key                           | Schema                                                                           | `.env.example` (new block after the tracker block, :145-149) |
| ----------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `P2P_STUN_URLS`               | comma list → `string[]`, each `^stun:`; empty = none                             | `P2P_STUN_URLS=stun:localhost:3478`                          |
| `P2P_TURN_URLS`               | comma list → `string[]`, each `^turns?:`; empty = relay off                      | `P2P_TURN_URLS=`                                             |
| `TURN_SHARED_SECRET`          | `z.string().min(32).optional()`; the API requires it when `P2P_TURN_URLS` is set | `TURN_SHARED_SECRET=__generate__`                            |
| `TURN_CREDENTIAL_TTL_SECONDS` | int 300–86400, default `3600`                                                    | `TURN_CREDENTIAL_TTL_SECONDS=3600`                           |

The relay is **off by default** (amendment draft decision 2: a relayed peer's bytes cross the
droplet twice, so TURN saves no egress, and the DigitalOcean firewall test forbids port ranges).
STUN always runs.

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

- `PlaybackStart.p2p` (:249) keeps its shape. Rewrite the doc (:244-248): `swarmId` is server
  chosen (the broadcast id, `services/api/src/routes/playback.ts:178`) and is the loader's
  `swarmId`; stream swarm ids and info hashes derive from it (below). Replace "on a tracker
  reconnect clients replace `t`" (the stock loader cannot: `announceTrackers` is fixed at
  construction): a reconnect after `TRACKER_TOKEN_MAX_AGE_SECONDS` falls back to HTTP.
- New `IceServers = z.object({ iceServers: z.array(z.object({ urls: z.array(z.string()).min(1),
  username: z.string().optional(), credential: z.string().optional() })), expiresAt:
  Timestamp.nullable() })` (`null` when nothing expires: STUN only).
- `Heartbeat` (:255-280), after `bytesP2p` (:263): optional `bytesP2pUp` (int ≥ 0, delta of bytes
  sent to peers) and `p2pPeers` (int 0–64, open peer connections now). Doc: informational only;
  nothing that counts, pays or verifies reads them (amendment decision 6).

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
- Stream swarm ids (amendment draft decision 5): the player sets the loader's
  `streamSwarmIdBuilder` to `p2pStreamSwarmId(swarmId, type, rendition)` =
  `` `ca1:${swarmId}:${type}:${rendition}` `` with `type` `main | secondary` and `rendition` the
  directory of the variant playlist (`services/origin/src/paths.ts:17-19`; none means `source`),
  `audio` for audio tracks. Export `P2P_STREAM_RENDITIONS = [...RENDITIONS, "audio"]` and
  `p2pAllowedStreamSwarmIds(swarmId)` (both types × every name: a fixed, small set, so the
  tracker needs no `KEYS.renditions` read). The info hash is the loader's own
  `computeInfoHash(streamSwarmId)` (20 ASCII characters, Base64 of 15 SHA-1 bytes, per the draft).
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
  - :152-153: `p2pEnabled = deps.env.P2P_ENABLED && input.p2pCapable && !input.nativeHls &&
    !isGated`, with a comment: 18+, mature-category and T1-restricted streams never get P2P. There
    are no private or subscriber-only live streams at `9c51c93` (`visibility` is VOD-only,
    `packages/db/src/schema/media.ts:150`); whoever adds one adds it here.
  - after the insert (:155-172), when `p2pEnabled`: `SET KEYS.p2pGrant(sid) b.id EX
    P2P_GRANT_TTL_SECONDS`.
  - heartbeat tx (:266-270): `.expire(KEYS.p2pGrant(s.id), P2P_GRANT_TTL_SECONDS)` (no-op when
    absent). **Revocation:** a stream that becomes gated mid-session (T1 restriction, the mature
    flag set or a category change) must lose P2P. P1-tracker's re-check closes the socket when
    the grant is gone, but nothing deletes the grant today. In the heartbeat, for sessions whose
    grant exists, re-evaluate `gated` against the session's broadcast and channel, and `DEL` the
    grant instead of `EXPIRE` when the stream is gated. Sessions without a grant pay no extra
    query. If you defer this, drop the "stream that became gated" example from P1-tracker
    Build 3 and record the gap in the amendment.
  - `playback.end` (:322-337): add `.del(KEYS.p2pGrant(input.sessionId))` to its multi, so an
    ended session's tracker socket closes at the next re-check.
  - heartbeat: the new optional fields become metrics only (`playback.p2p.bytes{direction}`,
    `playback.p2p.peers`). No DB column, no `recordHeartbeat` change (`packages/integrity` is
    W0-integrity's in wave 2).
- Integration tests in `services/api/tests/`: gated → `p2p.enabled: false`, no grant; enabled →
  grant = `swarmId` with the TTL; a heartbeat refreshes it; a stream restricted mid-session loses
  its grant at the next heartbeat; `playback.end` deletes it; `p2pCapable` omitted → disabled
  (the existing cases at `round3.int.test.ts:145-172` and `platform.int.test.ts:289-293` already
  pass `p2pCapable` or `nativeHls` explicitly); `p2p.iceServers` registered (stub answers
  `NOT_IMPLEMENTED`).
- First check that no in-flight E7 or W0 brief owns `router.ts` or `playback.ts`; if one does,
  merge it before this step.

## 6. Move `services/tracker/src/ip.ts` into `@commonair/service`

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

## 7. The tracker in every stack

- `compose.yaml:379-381`: drop `profiles: [p2p]` from `tracker` (P2P is on by default,
  `.env.example:136`, so today players get tracker URLs for a tracker that is not running); fix
  the header (:12-13, "p2p: + tracker (not built yet)") and `infra/tests/compose.test.ts:210`
  and its `optional` list (:211-212). Fix the other references to the profile too:
  `.env.example:145` ("compose profile p2p") and `HANDOFF.md:406`. `services/tracker/README.md:128`
  is P1-tracker's (Build 5).
- `scripts/infra.ts:26-32`: add `"tracker"` to `STACK_HEALTHY_SERVICES` (P1-turn sends
  `"coturn"` as a contract request).
- Quadlet already ships `commonair-tracker.container`; Caddy routes `/tracker*`
  (`infra/caddy/Caddyfile:201-202`).

## 8. Web seams for P1-player

- `apps/web/src/i18n/p2p.ts` (new, `export const p2pMessages = {} as const;`), spread into `en`
  in `apps/web/src/i18n/en.ts` (:4-16) like the other area catalogs. P1-player owns `p2p.ts`.
- Test ids in `harness/src/web/selectors.ts` (next to `PLAYER_SOURCES`, :302-304) and a new
  `docs/testing/p1-selectors.md`: `player-p2p` (indicator), `player-p2p-notice` (first-run IP
  notice), `player-p2p-dialog`, `player-p2p-toggle`, `privacy-p2p-toggle` (on
  `/settings/privacy`); `data-p2p` on `player` = `off | on | sharing` (`P2P_STATES`);
  localStorage `commonair:p2p` = `on | off` (`P2P_PREFERENCE_KEY`), plus `commonair:p2p-notice`
  = `seen` (`P2P_NOTICE_KEY`); absent = device default / notice not yet shown.
- `apps/web/src/server/security.ts:13` sets only `frame-ancestors`: no CSP change for the tracker
  WebSocket or WebRTC.

## 9. Legal text (`packages/db` is the orchestrator's)

- `packages/db/src/legal/privacy.md:23-32` mentions P2P bytes and HMAC'd networks; add a P2P
  section: other viewers in the same swarm see your IP address while sharing is on; never on 18+
  or restricted streams; how to switch it off (player and `/settings/privacy`).
- `packages/db/src/legal/cookies.md` "Peer-to-peer delivery": the preference and notice flags are
  essential storage (privacy choices, like the consent record), so "off" holds when preferences
  are declined.
- Check whether body changes need a new `LEGAL_SEED_VERSION` (`packages/db/src/legal/index.ts:17`)
  and coordinate with E7-legal. Open question 1 of the amendment (counsel on the EU lawful basis
  for default-on) may change step 8's defaults.

## 10. Harness: `viewers` with opted-in and opted-out Chromium viewers

Files: `harness/scenarios/viewers.ts`, `harness/src/platform.ts` (`openViewers`, :167-207),
`harness/src/browser-viewer.ts`, `harness/src/proxy.ts`, `harness/src/web/selectors.ts`, a harness
compose override if needed, `harness/README.md`, `harness/tests/`. Check that no wave-2 unit
(W0-clock's `clock-skew`) owns `platform.ts` or `proxy.ts`.

What is there: `viewers` (82 lines) opens `chromium`/`webkit`/`http` viewers and checks
convergence, overshoot, stalls and decay. The harness player has no P2P loader
(`harness/player/player.ts:149-150`); only `player: "web"` (the real embed route,
`browser-viewer.ts:10-11`, option at :136-139, one viewer per page at :298) can run P2P, and
web viewers get no simulated address (`ip` is a harness-player parameter). The probe's
`bytesP2p` comes from `__harnessBytes`, which only the harness player sets
(`harness/player/probe.ts:160-168`), so it reads 0 for web viewers.

- **Params:** `p2p` (opted-in web Chromium viewers; default `0` until P1-player merges, then `10`)
  and `p2pOptOut` (default `1` when `p2p > 0`). `ViewerMix` gains `p2p?: { in: number; out: number }`;
  these always use `player: "web"`, whatever `HARNESS_PLAYER` says.
- **Preference:** an init script per context sets `commonair:p2p` (`on`/`off`) and
  `commonair:p2p-notice=seen` before the app loads.
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
  - origin egress drops: opted-in sessions' `bytes_http / watch_seconds` is below the opted-out
    baseline by a stated margin (start at 20 %, tune from the first runs, record it), and the
    run's `origin.egress.bytes` (`ORIGIN_EGRESS_QUERY`, `harness/src/metrics.ts:102`) is a metric;
  - verdicts unchanged: after scoring, opted-in sessions have the same verdict as opted-out and
    HTTP sessions (all `verified`), none with a fetch reason;
  - the opted-out viewer never connected to peers: `__harnessPeerConnections === 0` on its page,
    and neither `KEYS.p2pGrant(sid)` nor `KEYS.p2pPeer(sid)` exists.
- Unit tests for the token-to-address mapping and the param defaults.

## After the step

- Fill the pinned versions into P1-player.md and the coturn image string into P1-turn.md.
- Shared files in wave 2. W0-media-exposure owns `infra/README.md` (:224-231). So P1-turn does
  **not** edit it: it sends its Ports-table rows (`TURN_PORT` 3478/udp, and the relay range when
  the relay is on) as a contract request, and the orchestrator applies them after both units
  merge. W0-clock owns `infra/mediamtx/mediamtx.yml`. P1-turn owns `scripts/selfhost.sh` and
  `compose.yaml` this wave, so W0-clock's NTP check lands after P1-turn merges.
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
