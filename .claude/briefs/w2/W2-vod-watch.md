<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# W2-vod-watch: public VOD and clip watch pages with the chat replay panel

You are implementing unit W2-vod-watch for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/batch6/README.md` (decisions (e) and (p),
path ownership and shared rules are binding), `.claude/briefs/w2/contract-step.md` (§5 web
placeholders, `SEED_ROUTES`; §6 the `timeline-sync` extension; §7 `w2-selectors.md`),
`.claude/briefs/next/W2-feature-wave.md` ("W2-dvr / chat replay"), `docs/product/feature-wins.md` §4.3
(Replay) and §4.5, ADR 0012 amendment 1 (decisions 5–7), `docs/streamers/chat-replay.md`,
`docs/testing/w1-selectors.md` "Player seam", `docs/testing/w2-selectors.md` and
`.claude/briefs/_done-means.md`. Do not look outside the repository. **Wave 2**, own git worktree,
branch `w2/vod-watch` from `main` after wave 1 merged (W2-captions' and W2-dvr's player files are
on it, read-only for you). Paths checked at `8fc2c974`; recheck line numbers against your base.

## Why

W1 shipped `vods.chat` / `clips.chat` but no page shows them: there is no public VOD or clip watch
page (`apps/web/src/routes/_app` has only `$channel.tsx` for channel pages). Replay chat lined up with
the video, without undoing moderation or blocks, is the point of the Timeline Spine (feature-wins §4.3).

## You own (write only these)

- `apps/web/src/routes/_app/$channel.vods.$vodId.tsx` and `$channel.clips.$clipId.tsx` (content of
  the contract step's placeholders; keep the route ids, search schema and loader shape it set)
- `apps/web/src/chat/replay/**`, `apps/web/src/components/vod-watch/**`
- `apps/web/src/i18n/locales/{en,es}/w2-replay.json`, `apps/web/src/i18n/keys/w2-replay.gen.ts`
- Tests: `apps/web/tests/{vod-watch,chat-replay}*.test.ts(x)`
- Harness: `harness/src/w2/replay.ts` (the `timeline-sync` replay-panel step), `harness/tests/w2/replay*`

Read-only: `apps/web/src/player/**` (including `controller.ts`, `captions*`, `dvr*`),
`apps/web/src/chat/{chat-event-row.tsx,messages.ts,blocks.ts,view.ts}`, `components/safety/**`
(`MatureGate`, `RestrictedStream`), `routes/_app/$channel.tsx`, `packages/{contracts,ui}/**`,
`services/**`, `harness/src/{w1,w2/steps,seed/routes}.ts`, `harness/scenarios/timeline-sync.ts`. You
write no server code. Anything else is a **contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- `vods.get` / `clips.get` (`Vod.playlistUrl`, `visibility`, `status`, `captions`; `Clip.url` is an
  MP4, `clips/<id>.mp4`); `NOT_FOUND` when the caller may not watch; the existing mature-gate error.
- `vods.chat` / `clips.chat` (`router.ts:825-829`, `:878-885`), input `{id, cursor?, limit 1–500}`
  (`router.ts:57-61`), output `ChatReplayPage` (`entities.ts:571-584`): items are `ChatMessage` plus
  `at` and `catchingUp`, ordered by `(at, id)`; `nextCursor`; `retained`. The server already hides
  deleted, held, cleared, banned and suspended authors' lines and the signed-in caller's blocks
  (`services/api/src/chat-replay/query.ts:60`, `:90`); a reply whose quoted line is hidden has
  `replyTo: null`. Signed-in replay is `private, no-store`.
- The test ids and the replay-panel step in `docs/testing/w2-selectors.md`; nav entries and
  `SEED_ROUTES` rows (seed-media publishes `vodId` and `clipId` in `store.extra`) from the contract step.

## Build

1. **Pages.** `/$channel/vods/$vodId` and `/$channel/clips/$clipId`: load the entity; a channel slug
   that does not match the route, `NOT_FOUND`, `deleted`, `failed` or removed ⇒ `<EmptyState>`
   not-found (never reveal that a private or `subscribers` VOD exists); `processing` / `recording` ⇒
   "not ready yet"; the mature and restricted gates reuse `components/safety`. Title, channel link
   (`<ChannelAvatar>`), `<RelativeTime>`, duration; `<Skeleton*>` while loading. Panel beside the player
   from `lg`, below it on narrow screens; 320 px with a 16 px gutter and no horizontal scroll.
2. **VOD player (`components/vod-watch/vod-player.tsx`).** `PlayerController` is bound to a live
   `playback.start` session, so VODs get their own small player: hls.js through a dynamic `import()`
   (already a dependency; no new package), native HLS where `prefersNativeHls` (import it read-only)
   says so. It exposes `playheadWallclock()` (`hls.playingDate` / `getStartDate() + currentTime`; VOD
   playlists carry PDT) and `seekToWallclock()`. Captions: `Vod.captions` tracks as subtitle tracks,
   with W2-captions' toggle if it accepts a plain `<video>`, else a minimal toggle of your own. Clips:
   an MP4 `<video>`; wall clock = the clip window start + `currentTime` (see contract requests).
3. **Replay panel (`chat/replay/**`).** A pure model (testable without React): pages fetched forward
   with `nextCursor` and kept in order; lines shown are those with `at` ≤ playhead wall clock, in
   `(at, id)` order; prefetch keeps about 2 minutes ahead; seeking back trims by binary search, seeking
   forward pages on (show a loading row); refetch on sign-in change. `catchingUp` lines carry a
   visible "said while catching up" label (`replay-catching-up`); `retained: false` with no items ⇒ a
   notice that chat for this video is no longer kept (`replay-not-retained`); no messages ⇒
   `<EmptyState>`. Also hide authors the viewer blocks during the visit (`chat/blocks.ts`
   `subscribeBlocks`). Render rows with the existing chat row component if its props fit, `data-at`
   and `data-message-id` on each row. Clicking a row's time seeks the player. `role="log"` without
   live announcements (replay must not flood a screen reader); reduced motion respected.
4. **Strings** in `w2-replay` only (`en` and `es` in the same change, `bun run i18n:gen`); no literals
   (the `en-XA` scan visits these pages).
5. **Harness `replay.ts`.** The `timeline-sync` replay-panel step: after steps 1 and 3 leave a VOD
   with marker messages, a Chromium viewer opens the VOD page, plays and seeks; rows appear in
   `data-at` order and only once the playhead passes them (read `video.currentTime` and the panel via
   the DOM, no test globals); a catching-up line is labelled; a line by an author the viewer blocked is
   absent; a stranger gets not-found on a `subscribers` VOD; an aged-out VOD (backdated rows plus the
   `chat-retention` ops tick) shows the not-retained notice; the clip page shows the clip window's chat.

## Tests you must add

- Replay model, exhaustive with fake time: ordering across pages and equal `at`, reveal at the
  playhead boundary (exactly equal, one microsecond before), seek back and forward, cursor end,
  `retained` false with and without items, `catchingUp`, `replyTo: null`, block added mid-visit,
  a fetch error then retry, an empty broadcast.
- VOD player: wall clock from hls and native fakes, null before the first frame, seek in and out of
  range; clip wall-clock mapping.
- Pages (render tests): each state (not found, private, subscribers stranger, processing, failed,
  removed, mature gate), captions toggle present only with tracks, selectors from `w2-selectors.md`.

## Contract requests to expect (file them with the exact diff if your base lacks them)

- `Clip` has no wall-clock window start, so clip chat cannot be placed: ask for
  `Clip.windowStartedAt: Timestamp` (broadcast `started_at + start_offset`, the value `clips.chat` uses).
- `ChatReplayInput` can only page forward: ask for an optional `from: Timestamp` (start at the first
  `(at, id)` ≥ `from`) so a seek deep into a long VOD is one request, not hundreds.
- If the contract step's placeholders lack the mature-gate loader data you need, the loader change.

## Done means

Follow `.claude/briefs/_done-means.md`: `bun --bun vp test run` in `apps/web` and `harness`; `bunx
tsc -p apps/web --noEmit`; `vp lint --deny-warnings` and `vp fmt` on your paths; `vp build` in
`apps/web`; `cd apps/web && bun run i18n:check && bun --bun vp test run tests/i18n.test.ts tests/selectors.test.ts`;
`reuse lint`. Never `podman compose`, `scripts/infra.ts` or a scenario. `git status` shows only your
paths; commit `git commit -s`. Tell the user to run `bun scripts/infra.ts stack --harness` and `bun
harness/src/cli.ts run timeline-sync` (the replay-panel step), then check by hand a VOD and a clip page
from the seed (`SEED_ROUTES`) signed out, signed in, as a blocker, on a `subscribers` VOD, with
captions on, under `en`, `es` and `en-XA`, 320 px, dark and light, keyboard only.
