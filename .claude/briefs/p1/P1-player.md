<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# P1-player: the browser P2P loader, opt-in and indicator

You are implementing unit P1-player for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/P1-p2p-client.md`,
`.claude/briefs/p1/contract-step.md` (what the orchestrator already committed),
`.claude/briefs/p1/P1-tracker.md` and `P1-turn.md` (merged before you start),
[ADR 0005](../../../docs/decisions/0005-p2p-tracker.md) amendment 1 (decisions 1, 3, 4, 5 and 6
are yours to implement) and `docs/testing/p1-selectors.md`. Do not look outside the repository,
except the pinned `p2p-media-loader-*` packages under `node_modules` (their source is your API
reference). Work in your own git worktree on a branch named `p1/player`, from a main that has
P1-tracker and P1-turn merged.

If the ADR 0005 amendment changes at acceptance, the orchestrator updates this brief before launch.

## Why

`bytesP2p` is always 0: the web player has no P2P loader, so every viewer without a relay is
served by the origin, and DigitalOcean meters that egress (ADR 0025). The tracker, the grant and
coturn exist; this unit lets viewers who opt in share segments, under the amendment's privacy
rules, without changing what integrity counts or what anyone is paid.

## You own (write only these)

- `apps/web/src/player/p2p/**` (new): policy, preference, ICE fetch, engine wrapper, stats, the
  indicator/notice/dialog components.
- `apps/web/src/player/controller.ts` (the seam), `apps/web/src/player/heartbeat.ts` (new optional
  heartbeat fields), `apps/web/src/player/player.tsx` (indicator and notice in the controls).
- `apps/web/src/routes/_app/settings.privacy.tsx`: one new section with the P2P switch
  (the orchestrator confirms no E7 unit owns this file before launch).
- `apps/web/src/i18n/p2p.ts` (created by the contract step and registered in `en.ts`; your keys
  go here, never in `en.ts`).
- Tests: new `apps/web/tests/p2p-*.test.ts(x)`; edits to `apps/web/tests/heartbeat.test.ts` and
  `player-source.test.ts` if behavior there changes.

Not `apps/web/package.json` or `bun.lock` (dependencies are added), not `apps/web/vite.config.ts`
(a bundling change is a contract request), not `packages/ui/**` (compose existing `@commonair/ui`
exports; a new primitive is a contract request), not `harness/**`, `services/**`, `packages/**`,
not `apps/web/src/i18n/en.ts` or any other catalog. Anything you need outside your paths is a
**contract request** in your final message (the exact change), never an edit.

Harness: `viewers` (contract step 10) is the orchestrator's and already drives your test ids and
storage keys. You add no scenario and do not edit `harness/**`. If a selector or key must change,
send it as a contract request.

## Contracts you must honor (read-only for you)

- Dependencies: `p2p-media-loader-core@4.0.0` and `p2p-media-loader-hlsjs@4.0.0` (Apache-2.0,
  pinned at the contract step; the orchestrator corrects the version here if the vet changed it),
  `hls.js@1.7.3` (`apps/web/package.json:27`, patched by `patches/hls.js@1.7.3.patch`).
- `PlaybackStart.p2p` (`packages/contracts/src/api/entities.ts`, :249 at `9c51c93`):
  `{ enabled, trackerUrls, swarmId }`. `enabled` false → no engine at all. Set the loader's
  `swarmId` to it and its `streamSwarmIdBuilder` to `p2pStreamSwarmId(swarmId, type, rendition)`
  from `@commonair/contracts/p2p`, the browser-safe entry the contract step added (never import
  `@commonair/contracts/internal` into the web bundle): `ca1:<swarmId>:<main|secondary>:<rendition>`,
  rendition = the variant playlist's directory (`services/origin/src/paths.ts:17-19`), none =
  `source`, audio tracks = `audio`. The library's default builder hashes bitrate/codecs/frame rate, which the
  tracker cannot reproduce, and the playlist URL carries this viewer's token: either default puts
  every viewer in a swarm the tracker refuses.
- `playback.start` input `p2pCapable` (default now `false`, `router.ts:655`): send `true` only
  when the policy allows P2P **and** the path is hls.js, not native HLS.
- `p2p.iceServers` (`POST /playback/ice-servers`, `{ sessionId, token }` →
  `{ iceServers, expiresAt | null }`; refusals `UNAUTHORIZED`, `NOT_FOUND`, `CONFLICT`,
  `PRECONDITION_FAILED` `requirement: "p2p"`): the **only** ICE servers. The library defaults to three
  public trackers and Google/Twilio STUN (the amendment cites `core.ts:69-79`): always set
  `announceTrackers` and `rtcConfig`, and never let a default survive. An empty list means host
  candidates only. A refusal or network error means no P2P for this session (HTTP only).
- `Heartbeat`: `bytesP2p` (delta of bytes received from peers), optional `bytesP2pUp` (delta of
  bytes sent) and `p2pPeers` (open peer connections now). `bytesHttp` is **HTTP bytes only**.
  All P2P numbers are informational: nothing that counts, pays or verifies reads them.
- Test ids and states (`harness/src/web/selectors.ts`, `docs/testing/p1-selectors.md`):
  `player-p2p` (indicator), `player-p2p-notice` (first-run notice), `player-p2p-dialog`,
  `player-p2p-toggle`, `privacy-p2p-toggle`; `data-p2p` on `player` = `off | on | sharing`;
  localStorage `commonair:p2p` = `on | off` and `commonair:p2p-notice` = `seen` (absent = device
  default / notice not yet shown). The harness sets both keys before the app loads.
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

1. **Policy** (`p2p/policy.ts`, pure): `p2pAllowed({ preference, finePointer, saveData,
   cellular, dataMode, native })`. Preference `off` → never; `on` → yes unless native HLS; absent →
   the device default (amendment decision 3): on when `matchMedia("(pointer: fine)")` matches,
   `navigator.connection.saveData` is not true and `connection.type` is not `cellular`; where
   `navigator.connection` is missing (Firefox, Safari) the pointer test decides; off whenever data
   mode is on (W1b does not exist yet: a parameter, `false` for now). The server adds the rest
   (18+, mature, restricted, `P2P_ENABLED`) by answering `p2p.enabled: false`.
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
6. **Lifecycle.** `switchTo` keeps the swarm (same broadcast, other HTTP source). `stop()` destroys
   the engine (peer connections and tracker socket) before `playback.end`. When `expiresAt` is set,
   call `p2p.iceServers` again at about 80 % of the TTL and apply it with the runtime `rtcConfig`
   (the amendment cites `DynamicCoreConfig`, `types.ts:120-135`). Turning P2P off applies
   `isP2PDisabled` at runtime, no reload. A tracker refusal or repeated socket failure turns P2P off
   for the session silently (HTTP continues; `data-p2p` = `on`, not `sharing`).
7. **Notice, indicator, switch** (amendment decisions 3 and 4):
   - **First-run notice** (`player-p2p-notice`): the first time P2P would start on a device, a
     one-line dismissible notice in the player ("Sharing with other viewers shows them your IP
     address"), with the off switch in it. P2P starts only after the notice has shown; dismissing
     sets `commonair:p2p-notice=seen`.
   - `data-p2p` on the player: `off` (not allowed, opted out, server said no), `on` (allowed, no
     peer yet), `sharing` (≥ 1 peer connection).
   - **Indicator** (`player-p2p`): an `IconButton` with a tooltip in the controls (Hugeicons, no
     `title=`), visible whenever P2P is allowed for the session, including when the viewer turned
     it off; while active it shows peers and bytes shared. `PlayerControl`
     (`packages/ui/src/blocks/media/player-chrome.tsx:18-28`) does not forward `data-*`, so use
     `IconButton` from `@commonair/ui` directly with the same `className="text-overlay-foreground"`.
     Controls render only while `state === "playing"` (`player.tsx:113-121`); keep the notice
     outside that condition if P2P can start before playback does.
   - It opens a `Dialog` (`@commonair/ui/components/dialog`, `player-p2p-dialog`): other viewers
     of this stream can see your IP address while sharing is on; never on 18+ or restricted
     streams; a link to the privacy policy;
     one `Switch` (`@commonair/ui/components/switch`, `player-p2p-toggle`) that stops the engine
     at once and persists `off`. No `alert`/`confirm`, and use `toast` from
     `@commonair/ui/toast` if you notify at all.
   - `/settings/privacy` gains a "Peer-to-peer sharing" section with the same switch
     (`privacy-p2p-toggle`), stating it is per device.
   - Every string in `apps/web/src/i18n/p2p.ts` via `t()`; keyboard reachable, visible focus,
     `prefers-reduced-motion`, works at 320 px (the embed too).
   - AGENTS.md privacy: no peer ids, IP candidates, SDP or tokens in `console` output, in the
     heartbeat or in anything stored. Colors only as CSS variable tokens; dark and light themes.
8. **Start flag**: `playback.start` sends `p2pCapable = policy allows && !native`.

Out of scope unless the amendment's open question 3 says otherwise: per-segment digests through
`validateP2PSegment`.

## Tests you must add

- `apps/web/tests/p2p-policy.test.ts`: every branch (preference on/off/absent × fine/coarse
  pointer × saveData × cellular × missing `navigator.connection` × dataMode × native).
- `apps/web/tests/p2p-preference.test.ts`: storage present, absent, throwing; the notice flag;
  the change event.
- `apps/web/tests/p2p-engine.test.ts` (fake loader, no WebRTC): the config built from
  `PlaybackStart.p2p` + ICE servers; **no default tracker or STUN server survives** (assert the
  final config's `announceTrackers` and `rtcConfig.iceServers` equal ours exactly, also for an
  empty list); `streamSwarmIdBuilder` output for main/audio/rendition playlists matches
  `P2P_INFOHASH_VECTORS`' stream ids; ICE fetch failure → plain hls.js; tracker refusal → off;
  the token hook rewrites `t`; credential refresh before `expiresAt`.
- `apps/web/tests/heartbeat.test.ts`: `bytesP2p`/`bytesP2pUp` deltas, throttled carry-over,
  `p2pPeers` as a gauge, no P2P-delivered fragment in `bytesHttp`.
- `apps/web/tests/p2p-indicator.test.tsx`: the notice shows once and P2P waits for it; `data-p2p`
  states; the dialog text and toggle; toggling off persists and stops the engine; the settings
  section follows a toggle made in the player; nothing renders as `sharing` when the server said
  `enabled: false`.

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
refuses from the real client), what is left undone (account-level preference sync, data mode,
segment digests), and the commands the user should run live:
`bun harness/src/cli.ts run viewers --set p2p=10`, plus a manual check of the notice, indicator,
dialog and settings switch on the channel page and the embed.
