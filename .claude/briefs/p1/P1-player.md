<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# P1-player: the browser P2P loader, opt-in and indicator

You are implementing unit P1-player for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/P1-p2p-client.md`,
`.claude/briefs/p1/contract-step.md` (what the orchestrator already committed),
`.claude/briefs/p1/P1-tracker.md` and `P1-turn.md` (merged before you start),
[ADR 0005](../../../docs/decisions/0005-p2p-tracker.md) amendment 1 (accepted 2026-10-27;
decisions 1, 3, 4, 5, 6 and 7 are yours to implement, and its "Decisions at acceptance" section
lists what changed from the draft) and `docs/testing/p1-selectors.md`. Do not look outside the repository,
except the pinned `p2p-media-loader-*` packages under `node_modules` (their source is your API
reference). Work in your own git worktree on a branch named `p1/player`, from a main that has
P1-tracker and P1-turn merged.

## Why

`bytesP2p` is always 0: the web player has no P2P loader, so every viewer without a relay is
served by the origin, and DigitalOcean meters that egress (ADR 0025). The tracker, the grant and
coturn exist, and the origin serves per-segment digests; this unit lets viewers who opt in share
segments, under the amendment's privacy rules (opt-in by default, decision 3), checks every
segment a peer delivers against the origin's digest (decision 7), and changes nothing in what
integrity counts or what anyone is paid.

## You own (write only these)

- `apps/web/src/player/p2p/**` (new): policy, preference, ICE fetch, engine wrapper, stats, the
  indicator/notice/dialog components.
- `apps/web/src/player/controller.ts` (the seam), `apps/web/src/player/heartbeat.ts` (new optional
  heartbeat fields), `apps/web/src/player/player.tsx` (indicator and notice in the controls).
- `apps/web/src/routes/_app/settings.privacy.tsx`: one new section with the P2P switch (checked
  2026-10-27: no E7 or W0 brief owns this file).
- `apps/web/src/i18n/p2p.ts` (created by the contract step and registered in `en.ts`; your keys
  go here, never in `en.ts`).
- Tests: new `apps/web/tests/p2p-*.test.ts(x)`; edits to `apps/web/tests/heartbeat.test.ts` and
  `player-source.test.ts` if behavior there changes.

Not `apps/web/package.json` or `bun.lock` (dependencies are added), not `apps/web/vite.config.ts`
(a bundling change is a contract request), not `packages/ui/**` (compose existing `@commonair/ui`
exports; a new primitive is a contract request), not `harness/**`, `services/**`, `packages/**`,
not `apps/web/src/i18n/en.ts` or any other catalog. Anything you need outside your paths is a
**contract request** in your final message (the exact change), never an edit.

Harness: `viewers` (contract step 11) is the orchestrator's and already drives your test ids and
storage keys. You add no scenario and do not edit `harness/**`. If a selector or key must change,
send it as a contract request.

## Contracts you must honor (read-only for you)

- Dependencies: `p2p-media-loader-core@4.0.0` and `p2p-media-loader-hlsjs@4.0.0` (Apache-2.0,
  exact pins added at the contract step; amendment decision 1),
  `hls.js@1.7.3` (`apps/web/package.json:27`, patched by `patches/hls.js@1.7.3.patch`).
- `PlaybackStart.p2p` (`packages/contracts/src/api/entities.ts`, :249 at `9c51c93`, extended by
  the contract step): `{ enabled, available, trackerUrls, swarmId, digestUrl }`. `enabled` false
  → no engine at all. `available` says whether P2P is possible for this session at all
  (`P2P_ENABLED`, hls.js, not gated), whatever the viewer chose: it decides whether the player
  offers the switch. `digestUrl` is the origin's digest base (Build 9). Set the loader's
  `swarmId` to it and its `streamSwarmIdBuilder` to `p2pStreamSwarmId(swarmId, type, rendition)`
  from `@commonair/contracts/p2p`, the browser-safe entry the contract step added (never import
  `@commonair/contracts/internal` into the web bundle): `ca1:<swarmId>:<main|secondary>:<rendition>`,
  rendition = the variant playlist's directory (`services/origin/src/paths.ts:17-19`), none =
  `source`, audio tracks = `audio`. The library's default builder hashes bitrate/codecs/frame rate, which the
  tracker cannot reproduce, and the playlist URL carries this viewer's token: either default puts
  every viewer in a swarm the tracker refuses.
- `playback.start` input `p2pCapable` (default now `false`, `router.ts:655`): send `true` only
  when the policy allows P2P **and** the path is hls.js, not native HLS. Without it the API writes
  no grant, so the tracker and `p2p.iceServers` refuse the session.
- `instance.info` `features.p2pDefault` (`off | on`, the operator's `P2P_DEFAULT`, default `off`),
  already in the root loader's data (`apps/web/src/server/bootstrap.ts:23`): the policy's default
  for a viewer who has not chosen.
- `p2p.iceServers` (`POST /playback/ice-servers`, `{ sessionId, token }` →
  `{ iceServers, expiresAt | null }`; refusals `UNAUTHORIZED`, `NOT_FOUND`, `CONFLICT`,
  `PRECONDITION_FAILED` `requirement: "p2p"`): the **only** ICE servers. The library defaults to three
  public trackers and Google/Twilio STUN (the amendment cites `core.ts:69-79`): always set
  `announceTrackers` and `rtcConfig`, and never let a default survive. An empty list means host
  candidates only. A refusal or network error means no P2P for this session (HTTP only).
- `Heartbeat`: `bytesP2p` (delta of bytes received from peers), optional `bytesP2pUp` (delta of
  bytes sent), `p2pPeers` (open peer connections now) and `p2pRejected` (delta of P2P-delivered
  segments that failed digest validation). `bytesHttp` is **HTTP bytes only**.
  All P2P numbers are informational: nothing that counts, pays or verifies reads them.
- Test ids and states (`harness/src/web/selectors.ts`, `docs/testing/p1-selectors.md`):
  `player-p2p` (indicator), `player-p2p-notice` (first-run notice), `player-p2p-dialog`,
  `player-p2p-toggle`, `privacy-p2p-toggle`; `data-p2p` on `player` = `off | on | sharing`;
  localStorage `commonair:p2p` = `on | off` and `commonair:p2p-notice` = `seen` (absent = the
  operator default / notice not yet shown). The harness sets `commonair:p2p=on` and the notice key
  for opted-in viewers, and nothing at all for default viewers, which must stay `data-p2p="off"`
  and never construct an `RTCPeerConnection`.
- The digest endpoint (contract step 6, built by P1-tracker):
  `GET <digestUrl>/live/<slug>[/<rendition>]/<file>?t=<token>` → `200 text/plain`, 64 lowercase
  hex characters, the SHA-256 of the segment exactly as `/hls/` serves it; 404 for playlists,
  parts and unknown objects; 403 for a bad token. Served only by the origin (also for relay- and
  CDN-served sessions); the path after `/live/` is the same as the segment's path on any source.
- The tracker refuses sockets without a grant (403), hashes outside the derived set, and tokens
  older than 12 h (`TRACKER_TOKEN_MAX_AGE_SECONDS`); the stock loader reconnects with the same URL
  (`announceTrackers` is not dynamic), so after 12 h P2P stops and HTTP continues. Accepted by the
  amendment.

## What is there today (verified at `9c51c93`)

- `controller.ts` (252 lines): `start()` (:71-108) imports hls.js, picks native vs MSE
  (`prefersNativeHls`, :45-49), calls `playback.start` with `p2pCapable: false` (:82-83), then
  `attachHls` (:119-148): `xhrSetup` puts the current token on every request (:127-131); bytes
  come from `FRAG_LOADED` (`frag.stats.loaded`) and `LEVEL_LOADED` (:133-138). `cumulative()` sends
  `bytesP2p: 0` (:173-186). `switchTo` reloads the source on a relay → origin move (:222-228).
  `stop()` destroys hls.js and ends the session (:234-251).
- `heartbeat.ts`: `CumulativeStats`/`HeartbeatDelta` (:14-36); `HeartbeatAccountant` sends deltas
  since the last acknowledged beat and carries throttled ones (:40-82); `withToken` (:89-95).
- `source.ts:13-19`: `data-source` is never `p2p` (P2P is a loader, not a playlist source). Keep it.
- `player.tsx`: creates the controller (:57-69); controls are one `PlayerControl` mute button
  (:112-121) in `PlayerChrome` (`@commonair/ui/blocks/media`); strings via `t()`. The embed route
  uses the same component (and is what the harness drives).
- `settings.privacy.tsx` (`/settings/privacy`, signed-in): export and deletion sections.
- Streams are MediaMTX **low-latency HLS**: 1 s segments, 200 ms parts, 7 segments in the
  playlist (`infra/mediamtx/mediamtx.yml:63-66`); hls.js runs `lowLatencyMode: true`,
  `liveSyncDurationCount: 3` (:120-122). Parts are a poor fit for P2P (Build 5).

## Build

1. **Policy** (`p2p/policy.ts`, pure, amendment decision 3): `p2pAllowed({ preference,
   operatorDefault, finePointer, saveData, cellular, dataMode, native })`. Native HLS or data mode
   → never (W1b data mode does not exist yet: a parameter, `false` for now). Preference `off` →
   never; `on` (the viewer opted in) → yes. Absent → the operator default: `off` → no (the
   shipped default, opt-in until counsel confirms an EU lawful basis); `on` → yes only when
   `matchMedia("(pointer: fine)")` matches, `navigator.connection.saveData` is not true and
   `connection.type` is not `cellular`, where a missing `navigator.connection` (Firefox, Safari)
   leaves the pointer test to decide. The server adds the rest (18+, mature, restricted,
   `P2P_ENABLED`) through `available`/`enabled`.
2. **Preference and notice** (`p2p/preference.ts`): read/write the two localStorage keys, every
   access in try/catch (blocked storage, partitioned storage in embeds) falling back to "absent";
   a change event so every player on the page and the settings section follow a toggle.
3. **Engine** (`p2p/engine.ts`), loaded by dynamic `import()` only when `p2p.enabled` (keep it out
   of the main chunk, as hls.js is): the hlsjs integration around hls.js at `attachHls`, with
   `swarmId`, `streamSwarmIdBuilder`, `announceTrackers: trackerUrls`, `rtcConfig: { iceServers }`
   from `p2p.iceServers` (fetched once before the engine starts; on failure plain hls.js). HTTP
   segment requests the loader makes itself must carry the **current** token (find the loader's
   request hook; `xhrSetup` no longer covers them) via `withToken`. Confirm in the pinned source
   how peers identify segments (it must not be the tokenized URL); if it is the URL, stop and
   report it.
4. **Accounting.** From the loader's events: bytes by source (`http`/`p2p`), bytes uploaded, peer
   connects/disconnects. `bytesHttp` = playlist bytes (as now) + segment bytes the loader fetched
   over HTTP; `bytesP2p` = segment bytes from peers; never count a segment twice (hls.js still fires
   `FRAG_LOADED` for P2P-delivered fragments). `bytesP2pUp` goes through `HeartbeatAccountant` as a
   delta; `p2pPeers` is a gauge, sent as is.
5. **Latency vs sharing.** With 1 s LL-HLS segments, peers have little to share at the live edge.
   Measure with the pinned loader and pick a configuration for P2P sessions only (for example
   `lowLatencyMode: false`, a larger `liveSyncDuration`, the loader's high-demand and HTTP time
   windows); non-P2P sessions stay exactly as today. Report the latency added and the expected
   P2P share: the amendment must state the trade-off, and a MediaMTX change (not yours) may follow.
   Only whole segments may come from peers: the origin publishes digests for segments, not LL-HLS
   parts (a part would always fail validation and be fetched twice).
6. **Lifecycle.** `switchTo` keeps the swarm (same broadcast, other HTTP source). `stop()` destroys
   the engine (peer connections and tracker socket) before `playback.end`. When `expiresAt` is set,
   call `p2p.iceServers` again at about 80 % of the TTL and apply it with the runtime `rtcConfig`
   (the amendment cites `DynamicCoreConfig`, `types.ts:120-135`). Turning P2P off applies
   `isP2PDisabled` at runtime, no reload. Turning it **on** during a session (opting in, when this
   session started without a grant) takes effect at the next playback start: the dialog and the
   settings section say so; never restart the session silently. A tracker refusal or repeated
   socket failure turns P2P off for the session silently (HTTP continues; `data-p2p` = `on`, not
   `sharing`).
7. **Notice, indicator, switch** (amendment decisions 3 and 4):
   - **The disclosure always comes first.** P2P never starts before the viewer has seen "Sharing
     with other viewers shows them your IP address". Opting in happens in the dialog or the
     settings section, which state it next to the switch; switching on there sets
     `commonair:p2p-notice=seen`.
   - **First-run notice** (`player-p2p-notice`): only when the operator default is `on` and the
     viewer has made no choice, the first time P2P would start on the device, a one-line
     dismissible notice in the player with the off switch in it. P2P starts only after the notice
     has shown; dismissing sets `commonair:p2p-notice=seen`. With the shipped default (`off`) it
     never appears.
   - `data-p2p` on the player: `off` (not allowed, not opted in, opted out, server said no), `on`
     (P2P running for the session, no peer yet), `sharing` (≥ 1 peer connection).
   - **Indicator** (`player-p2p`): an `IconButton` with a tooltip in the controls (Hugeicons, no
     `title=`), visible whenever `p2p.available` is true, whether or not the viewer opted in, so
     the opt-in is one click away; while active it shows peers and bytes shared. `PlayerControl`
     (`packages/ui/src/blocks/media/player-chrome.tsx:18-28`) does not forward `data-*`, so use
     `IconButton` from `@commonair/ui` directly with the same `className="text-overlay-foreground"`.
     Controls render only while `state === "playing"` (`player.tsx:113-121`); keep the notice
     outside that condition if P2P can start before playback does.
   - It opens a `Dialog` (`@commonair/ui/components/dialog`, `player-p2p-dialog`): sharing is off
     unless you turn it on; other viewers of this stream can see your IP address while sharing is
     on; never on 18+ or restricted streams; a link to the privacy policy; one `Switch`
     (`@commonair/ui/components/switch`, `player-p2p-toggle`). Off stops the engine at once and
     persists `off`; on persists `on` and applies from the next playback start. No `alert`/`confirm`, and use `toast` from
     `@commonair/ui/toast` if you notify at all.
   - `/settings/privacy` gains a "Peer-to-peer sharing" section with the same switch
     (`privacy-p2p-toggle`), stating it is per device.
   - Every string in `apps/web/src/i18n/p2p.ts` via `t()`; keyboard reachable, visible focus,
     `prefers-reduced-motion`, works at 320 px (the embed too).
   - AGENTS.md privacy: no peer ids, IP candidates, SDP or tokens in `console` output, in the
     heartbeat or in anything stored. Colors only as CSS variable tokens; dark and light themes.
8. **Start flag**: `playback.start` sends `p2pCapable = policy allows && !native`.
9. **Segment digests** (`p2p/digest.ts`, amendment decision 7): set the loader's
   `validateP2PSegment(url, byteRange, data)` (`types.ts:524` in the amendment's reading; confirm
   in the pinned source) for every P2P-delivered segment. Build the digest URL from `digestUrl` and
   the segment URL's path after `/live/` (strip the source's route prefix and query), with the
   **current** token as `t`; fetch it, compare with `crypto.subtle.digest("SHA-256", data)` as
   lowercase hex. Return `false` (fail closed) on a mismatch, a non-200, a network error, a
   malformed body, or any `byteRange`. Confirm in the pinned source that `false` makes the loader
   drop the bytes and fetch the segment over HTTP, and what it does to the peer. The peer that
   sent a bad segment must be disconnected: if the loader does not do it, do it through the
   loader's API; if neither is possible, stop and report it as a contract request (a `bun patch`
   of the loader, like the hls.js one). Count rejections into `p2pRejected` (a delta through
   `HeartbeatAccountant`). Cache digests per object for the session (small bounded map); bytes
   of digest requests count in `bytesHttp`. No URL, token or digest in `console` output.

## Tests you must add

- `apps/web/tests/p2p-policy.test.ts`: every branch (preference on/off/absent × operator
  default off/on × fine/coarse pointer × saveData × cellular × missing `navigator.connection` ×
  dataMode × native); with the operator default `off` and no preference, P2P is never allowed.
- `apps/web/tests/p2p-digest.test.ts` (the tamper test; there is no harness tamperer): matching
  bytes → `true`; one flipped byte → `false`, the rejection counted and the peer disconnected (or
  the loader's own handling asserted); a byte range, a 404, a 403, a network error and a malformed
  body → `false`; the digest URL is built correctly from origin, relay and CDN segment URLs and
  carries the current token; one fetch per object per session.
- `apps/web/tests/p2p-preference.test.ts`: storage present, absent, throwing; the notice flag;
  the change event.
- `apps/web/tests/p2p-engine.test.ts` (fake loader, no WebRTC): the config built from
  `PlaybackStart.p2p` + ICE servers; **no default tracker or STUN server survives** (assert the
  final config's `announceTrackers` and `rtcConfig.iceServers` equal ours exactly, also for an
  empty list); `streamSwarmIdBuilder` output for main/audio/rendition playlists matches
  `P2P_INFOHASH_VECTORS`' stream ids; ICE fetch failure → plain hls.js; tracker refusal → off;
  the token hook rewrites `t`; credential refresh before `expiresAt`.
- `apps/web/tests/heartbeat.test.ts`: `bytesP2p`/`bytesP2pUp`/`p2pRejected` deltas, throttled
  carry-over, `p2pPeers` as a gauge, no P2P-delivered fragment in `bytesHttp`.
- `apps/web/tests/p2p-indicator.test.tsx`: with the operator default `off` and no preference, no
  notice, `data-p2p="off"`, no engine, but the indicator offers the switch when `available`;
  with the default `on`, the notice shows once and P2P waits for it; `data-p2p` states; the
  dialog text and toggle; toggling off persists and stops the engine; toggling on persists and
  says it applies next start; the settings section follows a toggle made in the player; nothing
  renders as `sharing` when the server said `enabled: false`; no indicator when `available` is
  false.

## Done means

Follow `.claude/briefs/_done-means.md`. This batch the orchestrator runs the gate: run only
`bun run --filter @commonair/web test` (and `test:int` if you touched what it covers),
`bunx tsc -p apps/web --noEmit`, `vp lint --deny-warnings` and `vp fmt` on your paths, and
`vp build` in `apps/web` (check the engine lands in its own chunk). Never run `bun run verify`, a
dev server, a browser, `podman` or harness scenarios: the user runs the browser checks and
`viewers`. `git status` shows only your paths. Commit in your worktree (`git commit -s`,
Conventional Commits, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).

Final message: what you built, test counts, branch and sha, chunk sizes from `vp build`, the
Build 5 configuration and numbers, how peers identify segments in the pinned loader, contract
requests (bundler config, a `@commonair/ui` primitive, MediaMTX settings, anything the tracker
refuses from the real client, a loader patch if bad peers cannot be disconnected), how the
pinned loader handles a failed `validateP2PSegment`, what is left undone (account-level
preference sync, data mode), and the commands the user should run live:
`bun harness/src/cli.ts run viewers --set p2p=10`, plus a manual check of the notice, indicator,
dialog and settings switch on the channel page and the embed.

## Contract step as landed

Your base is main after "merge: P1 contract step" (`223b192`), which contains E7 and the W0 contract step. Recheck line numbers against it.

- Use `PlaybackStart.p2p.available` and `.digestUrl`, and read `features.p2pDefault` from `instance.info`.
- Send `p2pCapable` explicitly; it now defaults to false.
- Build the swarm ids from `@commonair/contracts/p2p` and test the builder against `P2P_INFOHASH_VECTORS`.
- The optional heartbeat fields are `bytesP2pUp`, `p2pPeers` (at most 64) and `p2pRejected`.
- The test ids, storage keys and rules are in `docs/testing/p1-selectors.md`. When you render the ids, add that doc to `apps/web/tests/selectors.test.ts` and spread `P1_TEST_IDS` into `TEST_IDS`.
- You own `apps/web/src/i18n/p2p.ts`.
- When P1 is done, flip `P2P_VIEWERS_DEFAULT` in `harness/src/p2p.ts` to 10. From then on the viewers scenario hard-asserts `data-p2p="off"` for default viewers, and a default-only run checks it softly.
