<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W2-dvr: free live DVR (origin `/dvr/` route, catching-up counts, player scrubber)

You are implementing unit W2-dvr for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/batch6/README.md` (decisions (b), (f),
(g), (n), (p), path ownership and shared rules are binding), `.claude/briefs/w2/contract-step.md`
(§1.3 `PlaybackStart.dvrWindowSeconds` / `dvrPlaylistUrl`, §1.4 `SegmentFetch.mode`, §1.5 the DVR
token path and `dvr/` state predicate, §2.1 DVR columns, §4 seams), `docs/product/feature-wins.md`
§4.12, `docs/decisions/0016-live-dvr.md` (decisions 1–8 are your spec), ADR 0018 decision 7,
`docs/testing/w1-selectors.md` "Player seam", `docs/testing/w2-selectors.md` and
`.claude/briefs/_done-means.md`. Do not look outside the repository. **Wave 1**, own git worktree,
branch `w2/dvr` from the contract step's sha (`git merge main` first if main moved). W2-captions
runs beside you and owns `services/origin/src/playlist.ts` (you import `rewritePlaylist` read-only)
and the `captions` line of `playback.start` (through its `captionTracksFor` hook). Paths checked at
`8fc2c974`; recheck line numbers against your base.

## Why

Twitch's rewind is for subscribers. Ours is free, honest about "watching live" versus "catching
up", never rewinds into content the viewer could not watch as a VOD, and never leaves a removed
segment reachable for more than 5 s (feature-wins §4.12).

## You own (write only these)

- `services/origin/src/dvr.ts` (registered 404 stub) and `services/origin/tests/dvr*`
- `packages/integrity/src/{concurrency,signals/fetch}.ts` and their tests
- The DVR fields in `services/api/src/routes/playback.ts`: `playback.start`'s DVR token and URL;
  heartbeat `playback_mode` / `dvr_seconds` recording and DVR token refresh. Tests in
  `services/api/tests/playback-dvr*`. Do not touch the `captions` line.
- `apps/web/src/player/dvr*`, `apps/web/src/components/dvr-settings*`, tests `apps/web/tests/dvr*`
- `apps/web/src/i18n/locales/{en,es}/w2-dvr.json`, `apps/web/src/i18n/keys/w2-dvr.gen.ts`
- `harness/scenarios/live-dvr.ts` (fill the stub), `harness/src/w2/dvr/**`, `harness/tests/w2/dvr*`

Read-only: `services/origin/src/{origin,handler,paths,playlist,vod,auth,accounting}.ts`,
`packages/integrity/src/{constants,jobs,store,types}.ts`, `services/worker/src/{counters.ts,segments/**}`,
`apps/web/src/player/{controller,heartbeat,media-clock}.ts`, `player.tsx`, `data-mode.tsx`,
`packages/{contracts,db,config,tokens}/**`, `relay/**`. Anything else is a **contract request**.

## Contracts you must honor (read-only for you)

- `PlaybackStart.dvrWindowSeconds` (0 = no DVR), `dvrPlaylistUrl` (nullable); `Heartbeat.playbackMode`
  and `behindLiveSeconds` (`entities.ts:303-306`); `playback_sessions.playback_mode`, `.dvr_seconds`;
  `channels.dvr_enabled` (default true), `.dvr_window_seconds` (default 1800); `DVR_MAX_WINDOW_SECONDS`
  (7200, api + origin).
- `dvrTokenPath` and the `dvr/` state predicate (`@commonair/contracts/storage`); the token `dm`
  refine rejects `dvr/` paths (`tokens.ts:42-49`, Go mirror `relay/internal/tokens/playback.go`).
- `SegmentFetch.mode` (`live | dvr`, absent = live); the exported `SegmentLog` hook; the origin route
  registry; `VodStateCache` (`services/origin/src/vod.ts:80`, 5 s TTL `:42`); `broadcasts.kind`.

## What is there today (verified at `8fc2c974`)

Seam: `seekToWallclock` (`controller.ts:269`), `playbackMode` / `onPlaybackMode` / `setPlaybackMode`
(`:336-355`; `setPlaybackMode` only flips the flag and notifies, it loads nothing), heartbeat uses
`playbackFields(this.playbackMode())` (`:705`; `heartbeat.ts:121` takes `behindLiveSeconds`, which the
controller never passes). `player.tsx` already passes `dvr={playbackMode === "dvr"}` to the data-mode
panel (`:319`; notice at `data-mode.tsx:142-247`). Recordings live under private `recordings/<vodId>/`
(`storage.ts:20`). The relay token binding refuses anything outside the token's `live/<slug>` path
(`playback.go:184-191`) and the relay registers only `/hls/` (`relay/internal/server/server.go:202`).
Public viewer counts are `verdict = 'verified'` rows in `services/worker/src/counters.ts:57`; integrity
reads live sessions in `packages/integrity/src/jobs.ts:115` and fetch counters in `store.ts:75-127`.

## Build

1. **Origin `/dvr/<vodId>/<file>`** (GET, HEAD). Token: genuine, unexpired, `path = dvr/<vodId>`,
   `src = origin`; refuse a token carrying `dm` (decision 7) and any other `src`. State per request
   through `VodStateCache` and the `dvr/` predicate: VOD `recording`, not removed, broadcast live, not
   T1-restricted, not a rehearsal, channel not suspended, DVR enabled; anything else 404 (so removal
   or T0 answers 404 within 5 s on every instance). Playlist: read only `recordings/<vodId>/index.m3u8`
   (never `vods/`), cut to `min(channel window, DVR_MAX_WINDOW_SECONDS)` by PDT from the newest
   segment, fix `EXT-X-MEDIA-SEQUENCE`, no `ENDLIST`, URIs rewritten with `rewritePlaylist` carrying the
   token. Segments: only names the playlist lists and inside the window; an in-progress (not yet
   uploaded) segment is 404. `cache-control: private, no-store`. Every playlist and segment served goes
   to `SegmentLog` with `mode: "dvr"`, the session id and `obj`.
2. **`playback.start`.** DVR only when the broadcast is `live` (not rehearsal), records a VOD
   (`recording`), the channel has DVR on, the caller passed the live gates (mature, restricted) **and**
   `vodShown` admits them for that VOD, and the session has no data mode. Then mint a 120 s origin
   token for `dvr/<vodId>` bound to the same session, `dvrWindowSeconds = min(window, cap)`,
   `dvrPlaylistUrl` on `PLAYBACK_PUBLIC_URL` even for relay- or CDN-assigned sessions (DVR is
   origin-only). Otherwise `0` / `null`. VODs off ⇒ 0.
3. **Heartbeat.** Record `playback_mode`; add credited seconds to `dvr_seconds` in `dvr` mode; refresh
   the DVR token beside the live one. A `dvr` claim from a session without a DVR grant is recorded
   as claimed and left to the fetch signal (no fetches, so it cannot verify).
4. **Integrity.** `concurrency.ts`: `LiveSession.mode`; `dvr` sessions are not live viewers (no
   concurrency rank, discovery, transcode thresholds or patronage hours) but supersede rules still apply.
   `signals/fetch.ts`: judge each mode's claimed seconds against that mode's fetches (ADR 0016
   decision 6); a session claiming `live` while fetching only `/dvr/` fails `no_media_fetched`; mixed
   sessions judge each part; absent mode = live; DVR seconds still count toward the verified-watch gate.
5. **Player (`player/dvr*`).** Scrubber (`role="slider"`, arrows ±10 s, PageUp/Down ±60 s, Home =
   window start), "back to live" button and `L`/End, behind-live readout, "source quality only" note;
   hidden when `dvrWindowSeconds` is 0 or data mode is on. Uses the seam only (`setPlaybackMode`,
   `seekToWallclock`, `playheadWallclock`); never edits `controller.ts`. Reduced motion respected.
6. **Studio (`components/dvr-settings*`).** DVR on/off (`dvr-enabled`), window choice up to the instance
   cap (`dvr-window`), the note that DVR needs VODs (turning VODs on turns DVR on), source-only and
   origin-only notes. Strings in `w2-dvr`, `en` and `es` in the same change.

## Tests you must add

- Origin unit and integration (real Valkey, Garage via the storage client, Postgres): window cut and
  media sequence, token path/src/expiry/`dm` refusals, state refusals (removed, T1, ended, rehearsal,
  suspended, DVR off), segment outside the window or not listed, `vods/` never read, HEAD, headers,
  `SegmentLog` entries with `mode: "dvr"`, 404 within the cache TTL after removal.
- Integrity unit, exhaustive: per-mode fetch judgement (live-only, DVR-only, mixed, mode lie, absent
  mode, threshold edges); concurrency excludes DVR sessions, supersede unchanged.
- API integration: DVR grant matrix (public / subscribers / private VOD × stranger / subscriber /
  owner, mature, restricted, data mode, VODs off, DVR off, rehearsal, relay-assigned), window clamp,
  heartbeat recording and token refresh.
- Web unit: scrubber keyboard, back-to-live, hidden in data mode and with window 0.
- Harness `live-dvr`: DVR heartbeats verify but are not live viewers; an in-progress segment is 404
  via `/media`; after removal or T0 `/dvr/` is 404 within 5 s; a relay request for a DVR path is
  refused (no relay code change); a `subscribers` VOD's DVR refuses a non-subscriber; a `dm` token is
  refused; VODs off ⇒ `dvrWindowSeconds` 0.

## Contract requests to expect (file them with the exact diff if your base lacks them)

- **Seam:** `setPlaybackMode` cannot play DVR. Ask for `enterDvr(playlistUrl): Promise<boolean>` /
  `exitDvr()` on `PlayerController` (load the DVR playlist in the same hls.js instance, keep heartbeats
  and played seconds, swap back to the live URL) and `behindLiveSeconds` passed to `playbackFields`.
- Heartbeat output `dvrToken?: string`.
- `LiveSession.mode` filled in `packages/integrity/src/jobs.ts:115`; per-mode fetch counters and
  `HeartbeatSample.mode` in `packages/integrity/src/{store,types}.ts`; `playback_mode = 'live'` in
  `services/worker/src/counters.ts:57` plus a "catching up" count (key and entity field).
- A DVR controls slot in `player.tsx` and a `DvrSettings` mount on a studio page; the channel settings
  handler that persists `dvr` and clamps the window to the cap; the cap exposed to the web app.

## Done means

Follow `.claude/briefs/_done-means.md`: `bun run test` / `test:int` in `services/origin`,
`services/api`, `packages/integrity` (one `test:int` at a time); `bunx tsc -p` each; `bun --bun vp test
run` in `apps/web` and `harness`; `vp lint --deny-warnings` and `vp fmt` on your paths; `vp build` in
`apps/web`; i18n check and `tests/i18n.test.ts`; `reuse lint`. Never `podman compose`,
`scripts/infra.ts` or a scenario. `git status` shows only your paths; commit `git commit -s`. Tell the
user to run `bun scripts/infra.ts stack --harness`, `bun harness/src/cli.ts run live-dvr`, then check
by hand: join a live channel with VODs on, drag back 20 minutes, press L; the studio DVR settings;
both under `en`, `es` and `en-XA`, 320 px, dark and light, keyboard only.
