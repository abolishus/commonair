<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W1-data-mode: Any-Connection Mode (data budget, `dm` claim, origin playlist filter)

You are implementing unit W1-data-mode (the plan's W1b-data-mode) for CommonAir (repo:
/Users/joshe/Repos/bcon). Read AGENTS.md, PLAN.md and docs/architecture.md first, then
`.claude/briefs/next/W1-quick-wins.md`, `.claude/briefs/w1/contract-step.md` (all of it; §0, §1.1
`DATA_MODE`, §1.3 (`playback.start` `dataMode`, `PlaybackStart.dataMode`, `Heartbeat.dataMode`),
§1.7 (the `dm` claim, Go and vectors), §4.4, §8.3 (the budget table), §10 especially),
`docs/product/feature-wins.md` §4.6, **`docs/decisions/0018-data-mode-claim.md` (all of it: your
spec)**, `docs/decisions/0005-p2p-tracker.md` §3 (no P2P in data mode), `docs/testing/w1-selectors.md`
(Data mode ids, "Player seam", `integrity-basic` extension), the W1-player handover note (from the
orchestrator), `apps/web/src/i18n/README.md` and `.claude/briefs/_done-means.md`. Do not look outside
the repository. Work in your own git worktree on a branch named `w1/data-mode`, created from `main`
**after batch-4 wave 1 (including W1-player) has merged** (the orchestrator gives you the sha; run `git merge main` first if
main moved). Wave 2. Checked against `a43aa6b`; recheck line numbers against your base.

**Budgets accepted by the user (2026-10-30):** the constants in `DATA_MODE` (presets 50 / 800 /
1900 MB/h, overhead factor 1.15) and **no ladder change**. If they change later, only the
constants change. You do not run the stack: estimate
the overhead factor from the LL-HLS fixtures the origin tests already use (part and segment sizes
plus playlist polling against the advertised BANDWIDTH), report it, and give the user the live
check that measures it (bytes in `data-usage` against the variant's BANDWIDTH); do not change the
constant yourself.

## Why

A viewer on a 1 GB/month plan wants to set a data budget, play audio-only when the budget is that
small, see what they actually spend, and go back to video on Wi-Fi (feature-wins §4.6). ADR 0018
makes the budget a signed playback-token claim (`dm`, a bitrate ceiling) so the server side can
enforce what the client cannot: native HLS (WebKit) has no level capping, P2P must be off
server-side, DVR and VODs must refuse it, and data-mode sessions stay on the origin, where every
session is fetch-judged.

## You own (write only these)

- Player: `apps/web/src/player/budget.ts` (new), `apps/web/src/player/{stats,source}.ts`, and, handed
  over from W1-player after it merged, `apps/web/src/player/controller.ts`,
  `apps/web/src/player/player.tsx` and `apps/web/src/player/heartbeat.ts` (the heartbeat body gains
  `dataMode`) (data mode only: keep the seam's methods, the `targetLatency`/`rendition` query
  parameters and their behaviour),
  `apps/web/src/player/data-mode*.tsx` (new: toggle, budget picker, meter, notices)
- API: `services/api/src/routes/playback.ts` (minting and the no-P2P rule, ADR 0018 decisions 3 and
  6; the contract step already added `avoidCdn`, keep it)
- Origin: `services/origin/src/{auth,playlist,handler,refresh}.ts` (the filter, ADR 0018 decision 5;
  `playlist.ts` goes to W2-captions next and must keep your filter)
- i18n: `apps/web/src/i18n/locales/en/w1-data-mode.json`, `keys/w1-data-mode.gen.ts` (prefix `dataMode.`)
- Tests: `apps/web/tests/{budget,data-mode,player*,heartbeat}.test.ts(x)`,
  `services/api/tests/playback-data-mode*.int.test.ts` (new; `playback-w1.int.test.ts` is the
  contract step's, and `p2p-grant.int.test.ts` only where the no-P2P rule changes an existing case), `services/origin/tests/{playlist,auth,handler,refresh}*.test.ts` (the cases you add)
- Harness: `harness/src/w1/data-mode.ts` (`stepThrottledViewer`), `harness/tests/w1/data-mode.test.ts`
- Docs: `docs/viewers/data-mode.md` (new: what the budget does, the audio floor, what the meter
  counts, that DVR and VODs ignore it, that native players reload when it changes)

Read-only, in particular: `packages/contracts/**` (the claim, `DATA_MODE`, `dataModeCeilingBps`),
`packages/tokens/**` and `relay/**` (the orchestrator added `dm` to TS, Go and the vectors),
`services/api/src/playback/delivery.ts` (`originOnly`), `services/media/**` (the ladder: no change),
`packages/integrity/**` (no change: ADR 0018 decision 8), `apps/web/src/player/p2p/**`
(`p2pAllowed` already takes `dataMode`), `apps/web/src/chat/**`, `apps/web/src/player/media-clock.ts`,
`harness/src/w1/{steps,kit,selectors}.ts`, `harness/scenarios/integrity-basic.ts`. Anything else is
a **contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- `PlaybackClaims.dm`: integer 32 000–8 000 000; only with `src = "origin"` and a live path (both
  verifiers refuse anything else). `v` stays 1.
- `playback.start({ …, dataMode: number | null })`, `PlaybackStart.dataMode`,
  `Heartbeat.dataMode` (null = turn off, absent = unchanged), heartbeat output `token` / `switchTo`.
- `assignSource({ …, originOnly })` (contract step §4.4).
- `DATA_MODE` and `dataModeCeilingBps(mbPerHour)`; the budget table in contract step §8.3.
- Test ids and the `integrity-basic` `data-mode` extension in `docs/testing/w1-selectors.md`.

## What is there today (verified at `a43aa6b`; recheck against your base)

- `signFor` (`services/api/src/routes/playback.ts:66-79`, `signPlaybackToken` at :78) builds claims
  from the session, channel, path and assignment. `start` (:139-211) assigns a source (with
  `avoidCdn` after the contract step), writes the P2P grant when `p2pEnabled` (:186), mints, returns.
  `heartbeat` (:213-344) re-mints within 60 s of expiry (`REFRESH_BEFORE_SECONDS`, :25) and moves a
  session off a relay that left the set with `switchTo` (:313-327).
- Origin: `authorizeViewer` checks token, path and `src ∈ {origin, cdn}` (`services/origin/src/auth.ts:34-47`);
  the multivariant playlist is synthesized **only when renditions exist** (`handler.ts:120-141`),
  `synthesizeMultivariant` adds the 192 kbit/s derived audio-only variant only when there is no
  `audio` rendition (`playlist.ts:157`, `:222-229`); `cacheControl` (`handler.ts:143-150`); the
  refresher re-signs child tokens with `{ ...claims }` and caches one token per `sid`
  (`services/origin/src/refresh.ts:47-57`), so a changed `dm` could be served from a stale cached
  token.
- Ladder: `audio` rung 96 kbit/s AAC, 480p 1200 + 96, 720p 3000 + 128, 1080p 6000 + 160
  (`services/media/src/transcode/ladder.ts:22-27`); the ladder runs only from
  `TRANSCODE_VIEWER_THRESHOLD` (default 50) viewers (`packages/config/src/env.ts:257`).
- Player: hls.js or native (`controller.ts`), `VideoStats` (`stats.ts`), `player.tsx` calls
  `p2pAllowed({ …, dataMode: false, native })` (:94); `source.ts` decodes the token's `src`.

## Build

1. **Claim minting (`routes/playback.ts`, decisions 3, 4, 6).** `start`: `originOnly: input.dataMode
   !== null` into `assignSource`; `signFor` takes the ceiling and sets `dm` (omit when null);
   `p2pAvailable`/`p2pEnabled` also require `dataMode === null`; return `dataMode`. `heartbeat`:
   `dataMode` absent → carry the previous `dm` forward on every re-mint; present and different →
   re-mint at once (not at the refresh point). Turning it **on** for a relay or CDN session
   reassigns to the origin through the existing `switchTo` path (re-recording `assigned_source`,
   `relay_id` null) and deletes the P2P grant; turning it **off** keeps the session where it is.
   Keep the 18+ gate re-check and the throttled-beat early return as they are.
2. **Origin (`auth.ts`, `handler.ts`, `playlist.ts`, `refresh.ts`, decision 5).** `auth.ts` passes
   the claims through unchanged (the schema already refuses a malformed `dm`). `playlist.ts`: a pure
   `filterForDataMode(multivariant: string, dm: number): string` keeping video variants with
   `BANDWIDTH ≤ dm` and the audio-only variant(s) always, listing audio-only first when no video
   variant fits. `handler.ts`: for an `hls` puller with `claims.dm`, always synthesize (call
   `synthesizeMultivariant` with the source alone when no renditions exist, so a source-only channel
   gets its derived audio-only variant), then filter; respond `cache-control: private, no-store`.
   Media playlists and segments are never refused by rendition. `refresh.ts`: key the reuse cache on
   (`sid`, `dm`) so a token minted after a `dm` change is never replaced by an older one.
3. **Budget controller (`budget.ts`, pure).** Input: the budget in MB/h (preset or custom within
   `DATA_MODE.minMbPerHour`–`maxMbPerHour`), the levels (bitrate, audio-only flag), measured byte
   rates from `stats.ts`. Output: the ceiling (`dataModeCeilingBps`), the hls.js `autoLevelCapping`
   index (highest level with bitrate ≤ ceiling; the audio-only level when none fits), an estimate of
   MB/h for the chosen level (bitrate × 0.45 × `overheadFactor`), and "over budget" when even the
   floor exceeds it (the meter shows what is actually spent, decision 1). Defaults: `saveData` or
   `effectiveType` `slow-2g`/`2g`/`3g` (where the browser exposes them) suggest the Audio preset;
   the choice is the viewer's and is kept in `localStorage` (try/catch).
4. **Player (`controller.ts`, `player.tsx`, `data-mode*.tsx`).** Seam additions: `setDataMode(ceiling:
   number | null)` (next heartbeat sends `dataMode`; on the new token reload the multivariant:
   hls.js `loadSource`, native a source reload with the `data-mode-notice` `native-reload` note) and
   `dataUsage(): { bytes: number; mbPerHour: number }` from `stats.ts` (HTTP bytes this session; P2P
   is off in data mode). `playback.start` sends `dataMode` from the saved choice. `player.tsx` passes
   `dataMode: ceiling !== null` to `p2pAllowed`, sets `data-data-mode`, and renders the toggle,
   budget picker (`data-mode-budget-50|800|1900|custom`), meter (`data-usage`), estimate and
   notices: DVR (when W2 adds it) and VOD playback say data mode does not apply (`data-reason`
   `dvr|vod`). Accessible: labelled controls, keyboard, no colour-only state, 320 px, logical CSS.
5. **Harness `stepThrottledViewer(run: IntegrityExtension)`.** As `docs/testing/w1-selectors.md`
   "integrity-basic extension": one Chromium viewer throttled to 64 kbit/s (CDP
   `Network.emulateNetworkConditions`) and one WebKit viewer, both choosing the Audio preset in the
   UI; both play audio-only (the filtered playlist has no video variant under the ceiling), the
   meter stays within the estimate + 20 %, the sessions are on the origin and `verified` (and gate
   eligible) when the scenario's convergence check runs. WebKit cannot be throttled through CDP: use
   the harness proxy if it can shape bandwidth, otherwise assert only audio-only and verification
   for WebKit and say so in a comment.

## Tests you must add

- Origin unit tests: filter by ceiling (several ladders), audio-only always kept, no video variant
  fits (audio listed first), `no-store` on a `dm` multivariant, source-only channel gets a derived
  audio-only variant only for `dm` tokens (non-`dm` responses unchanged), the refresher never
  reuses a token across a `dm` change.
- API integration: `dm` minted on start and carried across refresh; an immediate re-mint on change;
  relay and CDN sessions moved to the origin with `switchTo` on turning it on; staying put on turning
  it off; no P2P grant with `dataMode` even when `p2pCapable`; a heartbeat turning it on deletes the
  grant; `PlaybackStart.dataMode` echoed.
- Budget unit tests: ceilings for each preset and the custom bounds (the §8.3 table), capping
  index selection, the audio floor and "over budget", `saveData` defaults, `localStorage` throwing.
- Player tests: `setDataMode` sends `dataMode` on the next beat and reloads on the new token (hls.js
  and native fakes); P2P not requested in data mode; the seam's other methods unchanged.
- The token vector cases are the orchestrator's (contract step §1.7); do not edit `packages/tokens`.

## Done means

Follow `.claude/briefs/_done-means.md`. CI on main is the gate: run only targeted checks
(`bun --bun vp test run` in `apps/web`, `services/origin` and `harness`; `bun --bun vp test run` and
`bun run test:int` in `services/api` and `services/origin`, one package's `test:int` at a time;
`bunx tsc -p` for each; `vp lint --deny-warnings` and `vp fmt` on your paths; `vp build`, `bun run
i18n:check` in `apps/web`; `reuse lint`). Never run `bun run verify`, `verify:full`, a harness
scenario against a stack, `podman compose` or `scripts/infra.ts`. `git status` shows only your
paths. Commit in your worktree (`git commit -s`, Conventional Commits, ending with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Final message: what you built, test
counts per package, branch and sha, contract requests (exact diffs), the overhead factor you
estimated, proposed PROGRESS text, anything left undone, and the commands the user runs live: `bun
harness/src/cli.ts run integrity-basic --set w1=data-mode` on the harness stack, plus a manual
check on a phone (or WebKit) that the Audio preset plays audio-only and the meter moves.
