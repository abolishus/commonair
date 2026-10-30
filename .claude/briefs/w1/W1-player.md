<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W1-player: the player seam, the presentation queue and sending media time

You are implementing unit W1-player (the browser half of the Timeline Spine) for CommonAir (repo:
/Users/joshe/Repos/bcon). Read AGENTS.md, PLAN.md and docs/architecture.md first, then
`.claude/briefs/next/W1-quick-wins.md`, `.claude/briefs/w1/contract-step.md` (all of it; §0 (the
Spine split), §1.3 `Heartbeat`, §1.4 the `send` frame, §8.1 `presentation.ts` and `media-clock.ts`,
§10 "Player seam" and `timeline-sync` step 2 especially), `docs/product/feature-wins.md` §4.3,
`docs/decisions/0012-media-clock.md` (part 1; amendment 1 decisions 1–3),
`docs/decisions/0016-live-dvr.md` (decision 6: what W2 will need from the seam),
`docs/testing/w1-selectors.md` and `.claude/briefs/_done-means.md`. Do not look outside the
repository. Work in your own git worktree on a branch named `w1/player`, created from the commit the
orchestrator gives you (after the W1 and N1 contract steps; run `git merge main` first if main
moved). Wave 1, beside W1-spine (server half) and W1-calm-chat (which codes against your
`presentation.ts` stub and owns `chat-panel.tsx`). Checked against `a43aa6b`; recheck line numbers
against your base.

**Split note.** The plan's W1-spine was split by the orchestrator into W1-spine (chat clamp,
replay, retention, latency writer) and this unit, because the files are disjoint and W1-data-mode
needs only the player half. `controller.ts`, `player.tsx` and `heartbeat.ts` are yours in wave 1
and are **handed to W1-data-mode** for wave 2: leave them clean and documented.

## Why

The server can only place chat on the media clock if the browser says where its playhead is.
`mediaTs` is the PDT under the sender's playhead, which ADR 0012 part 1 makes the same on every
rendition, so it does not depend on the viewer's own clock. W2 (DVR, captions, later watch rooms)
must build on a stable seam instead of each editing `controller.ts`, and alerts should fire when a
viewer's playhead reaches the moment, not when the server sends them.

## You own (write only these)

- `apps/web/src/player/controller.ts` (the seam), `apps/web/src/player/player.tsx` (registering the
  media clock, `data-playback-mode`), `apps/web/src/player/heartbeat.ts` (the `playbackMode` field),
  `apps/web/src/player/media-clock.ts` (stub)
- `apps/web/src/chat/presentation.ts` (stub with the final API; keep the exported signature),
  `apps/web/src/chat/connection.ts` (send `mediaTs` and `playbackMode`; keep the `onSettings` and
  `onSurge` events the contract step added)
- Tests: `apps/web/tests/{player-seam,media-clock,presentation,chat-connection}*.test.ts` (new) and
  the existing `heartbeat.test.ts` and P2P controller tests where your changes require it. The
  existing `chat-state.test.ts`/`chat-events.test.ts` (which also cover `ChatConnection`) are
  W1-calm-chat's: put every connection test of yours in a new `chat-connection*.test.ts`; if an
  existing case breaks, that is a contract request.
- Harness: `harness/src/w1/timeline-web.ts` (`timeline-sync` step 2), `harness/tests/w1/timeline-web.test.ts`
- Docs: the "Player seam" section text, proposed in your final message (the selectors doc is the
  orchestrator's)

Read-only, in particular: `apps/web/src/chat/{chat-panel.tsx,state.ts,view.ts}` (W1-calm-chat),
`apps/web/src/player/{source,stats,lifecycle}.ts`, `apps/web/src/player/p2p/**`,
`packages/contracts/**`, `services/**`, `harness/src/w1/{steps,kit,selectors}.ts`,
`harness/scenarios/timeline-sync.ts`. You write **no web strings** (no namespace). Anything else is a
**contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- `ClientFrame` `send`: optional `mediaTs` (ISO 8601 with offset) and `playbackMode` (`live|dvr`).
- `Heartbeat.playbackMode` (absent = `live`), `behindLiveSeconds` (send null in W1).
- `presentationQueue({ channel, creatorView }): PresentationQueue` with `present(item, show)`,
  `syncChat`, `dispose` (contract step §8.1), ADR 0012 decision 3.
- `media-clock.ts`: `playheadWallclock(channel): Date | null`, `playbackMode(channel): "live" | "dvr"`.
- The seam API in `docs/testing/w1-selectors.md` "Player seam".

## What is there today (verified at `a43aa6b`; recheck against your base)

- `PlayerController` (`apps/web/src/player/controller.ts`, 447 lines): hls.js over MSE or native HLS
  (`prefersNativeHls`, :102-107), `LL_HLS_CONFIG` `liveSyncDurationCount: 3` (:95), heartbeats
  (:379-406) built from `cumulative()` (:350-370), `latencySeconds()` from `hls.playingDate` or
  Safari `getStartDate() + currentTime` (:338-348), `switchTo` (:414-420).
- `player.tsx` (214 lines) mounts the controller and the P2P UI; `data-p2p` on the player element.
- `ChatConnection.send(body)` (`apps/web/src/chat/connection.ts:203-206`) sends `{ op: "send",
  channel, body, isAction: false, nonce }`.
- Chat and player are siblings on `/$channel` (`apps/web/src/routes/_app/$channel.tsx`): they share
  nothing today, hence the `media-clock.ts` registry.

## Build

1. **Seam (`controller.ts`).** Public methods: `playheadWallclock(): Date | null` (refactor
   `latencySeconds()` onto it: `hls.playingDate`, or native `getStartDate()` + `currentTime`; null
   before the first frame or without PDT); `seekToWallclock(t: Date): boolean` (hls.js: seek to
   the media time whose PDT is `t` if it is in the buffer window; native: `currentTime` from
   `getStartDate()`; false when out of range); `setTargetLatency(seconds: number): number` (hls.js
   `liveSyncDuration` in seconds, replacing `liveSyncDurationCount` for that session, returns the
   value applied; native returns the current latency and changes nothing); `onTextTrack(cb):
   () => void` (a hook W2-captions uses: fires on `textTracks` `addtrack`/cue changes; no-op
   source of tracks in W1); `playbackMode(): "live" | "dvr"` and `onPlaybackMode(cb): () => void`
   (always `live` in W1; W2-dvr switches it). Document each with a short why-comment and keep them
   framework-free (the file may move to `packages/player`).
2. **Heartbeat.** Send `playbackMode: this.playbackMode()` and `behindLiveSeconds: null` on every
   beat (`heartbeat.ts` types if needed). Nothing else in the heartbeat changes.
3. **Media clock registry (`media-clock.ts`).** `registerMediaClock(channel, source: { playheadWallclock(): Date | null; playbackMode(): "live" | "dvr" }): () => void`,
   `playheadWallclock(channel)`, `playbackMode(channel)`; the latest registration wins; unregister
   on unmount. `player.tsx` registers its controller, sets `data-playback-mode` on the player
   element and updates it from `onPlaybackMode`.
4. **Sending media time (`connection.ts`).** `send(body)` reads `playheadWallclock(channel)` and
   `playbackMode(channel)` at send time and adds `mediaTs` (ISO with offset; omitted when null) and
   `playbackMode` (omitted when `live`, to keep frames small). Embedded and overlay chats without a
   player send neither.
5. **Presentation queue (`presentation.ts`).** Implement the stub's API: `present` shows `own`
   items at once; `alert` items are held until `playheadWallclock(channel) >= mediaTs` (polling
   with `requestAnimationFrame` or a 250 ms timer, whichever is cheaper when the tab is hidden), at
   most 60 s, then shown; `chat` items are shown at once unless `syncChat` (per-device opt-in in
   `localStorage`, try/catch, default off); in `dvr` mode alerts are not held (shown at once,
   ADR 0012 decision 3, "go to the alert history only" is W2's UI); `creatorView: true` (the
   broadcaster's own page) never holds anything; items with `mediaTs: null` show at once. Keep
   order within a kind. `dispose` flushes nothing and clears timers.
6. **Harness `timeline-web.ts` (step 2).** Two Chromium viewers on `/$channel` of a live channel
   whose ladder runs (the kit forces it as `clock-skew` does), pinned to different rungs (hls.js
   level via the seam or `page.evaluate`) and to different latencies (`setTargetLatency(3)` and
   `(12)`); each sends a marker message through the chat input, and the step records the `mediaTs`
   the page put in its outgoing `send` frame (Playwright `page.on("websocket")` → `framesent`): that
   is the PDT the page reported at send time. No test-only global exists in `apps/web` and none is
   added; the echoed row's `data-media-ts` is the server's clamped value, so comparing against it
   would be circular. The page has no quality picker and no handle on the hls.js instance, so
   `player.tsx` reads two optional diagnostic query parameters from `location.search`:
   `targetLatency=<seconds>` (→ `setTargetLatency`, 1–30, else ignored) and `rendition=<name>`
   (pins the hls.js level whose rendition matches; ignored on native or when absent). Document them
   in the seam section you propose; the route file's search schema is untouched (read
   `location.search` directly). After the broadcast ends and
   the VOD is ready, `vods.chat` returns both markers in media-time order, each within 1 s of the
   recorded playhead (WebKit tolerance 1 s if the kit adds a WebKit viewer).

## Tests you must add

- Seam unit tests with a fake hls.js and a fake native video: `playheadWallclock` (hls, native,
  before first frame, no PDT), `seekToWallclock` in and out of range, `setTargetLatency` applied on
  hls.js and a no-op on native, `onPlaybackMode` subscription and unsubscription.
- The `targetLatency`/`rendition` query parameters applied, and invalid values ignored.
- Heartbeat body carries `playbackMode: "live"` and `behindLiveSeconds: null`; existing heartbeat
  and P2P controller tests stay green.
- Media clock: register, latest wins, unregister restores the previous one.
- Connection: `send` adds `mediaTs`/`playbackMode` from the registry, omits them without a player.
- Presentation queue, exhaustive with fake timers: own items immediate; alert held until the
  playhead passes, released at 60 s at the latest, immediate in `dvr`, immediate for the creator,
  immediate with null `mediaTs`; chat immediate unless `syncChat`; order kept; `localStorage`
  throwing.

## Done means

Follow `.claude/briefs/_done-means.md`. CI on main is the gate: run only targeted checks
(`bun --bun vp test run` in `apps/web` and `harness`; `bunx tsc -p apps/web`; `vp lint
--deny-warnings` and `vp fmt` on your paths; `vp build` in `apps/web`; `reuse lint`). Never run
`bun run verify`, `verify:full`, a harness scenario against a stack, `podman compose` or
`scripts/infra.ts`. `git status` shows only your paths. Commit in your worktree (`git commit -s`,
Conventional Commits, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`).
Final message: what you built, test counts per package, branch and sha, contract requests (exact
diffs), the seam documentation for `w1-selectors.md`, a handover note for W1-data-mode (where
`dataMode` plugs into start, heartbeat and reload), anything left undone, and the commands the user
runs live: `bun harness/src/cli.ts run timeline-sync --set steps=2` on the harness stack (after
W1-spine merged).
