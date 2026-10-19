<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

You are implementing **E4a U5 — content cards, player chrome and chat shell** for CommonAir
(repo: /Users/joshe/Repos/bcon). Read AGENTS.md ("Design rules (web)", "House primitives"),
PLAN.md (E4a row), `packages/ui/README.md`, `packages/ui/DEVIATIONS.md`, then
`.claude/briefs/e4/_common.md` and `.claude/briefs/e4/_compositions.md` (both are part of this
brief). Also read (do not edit) `apps/web/src/chat/chat-panel.tsx`, `apps/web/src/chat/mod-menu.tsx`,
`apps/web/src/player/player.tsx`, `apps/web/src/routes/_app/$channel.tsx`,
`apps/web/src/routes/_app/index.tsx` and `docs/testing/e1-selectors.md`, `e2-selectors.md`,
`e3-selectors.md`: your blocks must be able to carry everything those render today. Do not look
outside the repository. You work in your own git worktree: run `git merge main --no-edit` first,
then `bun install` if `node_modules` is missing. Other units build shells/headers (U2), data blocks
(U3: `PollCard`, `ProgressRow`, `ListPanel` are theirs) and form blocks (U4) in parallel; do not
build those.

Canvas: <https://claude.ai/artifact/Ve5J5XjRZV42eRE2cdReVd>. Boards you cover: **Main** (featured
player split, "New and live"/"Live now" grids with "Show more", categories row), **Browse**
(category tiles with "N live" overlay + tag), **Category** (category header, live grid with Mature
overlay), **Search** (channel result rows, category result chips, video cards), **Following**
(live grid with uptime overlay, offline channel rows, followed categories), **Channel** (player
chrome live, stream info header with actions, chat panel with pinned message, poll slot, badges,
composer), **ChannelAbout** (offline header, offline stage in the player, recent broadcasts and
clips cards), **Vod** (VOD chrome with scrubber + chapter markers, VOD header, chat replay with
timestamps, read-only footer), **Clip** (clip preview chrome, trim strip, "more from" compact
cards), **Mobile** (phone channel: compact header actions, chat under tabs, send button),
**Support** (channel context behind the dialog), **StreamManager** (muted preview), **Content**
(thumbnail cell in the videos table), **Overlays** (alert preview stage), **Community** (chat-line
look in the queue), **ChatBot** (emote tiles). Condensed copies:
`.claude/briefs/e4/boards/<Board>.html`, sample data in `.claude/briefs/e4/boards/data/`.

## You own (write only these)

- `packages/ui/src/blocks/media/**`, `packages/ui/stories/media/**`, `packages/ui/tests/media/**`

## Contracts you must honor (read-only for you)

- `packages/ui/src/components/**` (U1: `aspect-ratio`, `card`, `item`, `slider`, `scroll-area`,
  `input-group`, `tabs`, `tooltip`, `dropdown-menu`, `hover-card`, `skeleton`, `empty`),
  house primitives (`StreamCard` + `StreamCardSkeleton` — keep using them for live tiles, do not
  fork them; `OverlayBadge`, `LiveBadge`, `ViewerCount`, `ChannelAvatar`, `StatusBadge`,
  `AccentButton`, `IconButton`, `RelativeTime`, `EmptyState`, `Skeleton*`), tokens `--chat-1…12`,
  `--overlay*`, `--live*`, `--channel-accent*`. DTOs in `@commonair/contracts/dto` (`StreamCard`,
  chat message shapes) where they fit.
- Test ids the app must be able to keep through your blocks: `player`, `player-video` (the app
  passes its own `<video>` as a child), `offline-state`, `live-badge`, `directory`,
  `directory-section` (+ `data-section`), `directory-empty`, `stream-card` (+ `data-channel`, inside
  `StreamCard`), `channel-link`, `follow-button`, `follower-count` (+ `data-count`), `chat`
  (+ `data-state`), `chat-message` (+ `data-author`, `data-id`, `data-deleted`), `chat-notice`
  (+ `data-code`), `chat-message-actions`, `chat-input`, `chat-send`, `chat-signin-prompt`,
  `data-source` on the player. Forward `data-*` on roots, rows, inputs and buttons.

## Build

1. **`StreamGrid`**: responsive grid of `StreamCard`s (`streams`, `render` link factory, `lazy`
   for rows below the fold), `loading` → `StreamCardSkeleton`s, `empty` slot (`EmptyState`),
   `footer` (Show more), `columns` density variant; forwards `data-*` per section.
2. **`CategoryTile`**: box art (`AspectRatio` 3:4) — image or accent-tinted glyph fallback under
   `data-accent`, `OverlayBadge` ("N live"), name, viewers (`formatCompactNumber`), tags; `size:
   default | sm` (Main/Following rows) and `layout: tile | chip` (Search result chips: small box
   art + name + meta in a row). **`CategoryGrid`**.
3. **`MediaCard`**: thumbnail (`AspectRatio` 16:9, accent fallback), overlay badges positioned by
   slot (`kind` top-start: Clip/Highlight/Past broadcast; `duration` bottom-end; `ago` bottom-start;
   `mature` top-end), title (2-line clamp), meta lines (channel · views, "clipped by"), optional
   avatar; `variant: vod | clip | highlight | upload`; `layout: card | compact` (horizontal: Clip
   "More from", Content table thumbnail cell). Link via `href`/`render`. **`MediaGrid`**.
4. **`ChannelHeader`**: avatar (live ring when live), name as `h1`/`h2` (`headingLevel`), badges
   (Co-op member, Offline), stream title, category link + tags, `actions` slot (Follow
   `AccentButton`, Subscribe/Tip outline, Share/More `IconButton`s, notifications bell), `stats`
   (verified `ViewerCount` + followers + "last live"); variants `live | offline | vod | compact`
   (Mobile: stacked, full-width buttons; VOD: title as heading with channel · date · views meta).
   Also **`CategoryHeader`** (Category board) sharing the same internals (box art in place of
   avatar) — one component with a `media` slot is fine; no copies.
5. **`PlayerChrome`**: the frame around the app's `<video>` (`children`), `AspectRatio` 16:9,
   `overlay` slots (`topStart`, `topEnd` for badges: quality, CC, Past broadcast, chapter,
   Preview·muted, `OverlayBadge`/`LiveBadge`/`ViewerCount overlay`), `controls` bar built from
   `PlayerControl` (`IconButton` on the overlay tokens, labels as props, pressed state for toggles)
   and groups (start: play/pause, back 10 s, mute + volume `Slider`; middle: live badge + time /
   "1.8 s behind"; end: speed, clip, settings, PiP, theatre, fullscreen), optional `scrubber`
   (`Slider` with chapter markers, `aria-valuetext` "1:12:40 of 2:58:12"), `stage` slot for the
   offline/next-stream card and the muted-preview overlay, controls auto-hide (show on focus-within
   and pointer, never hidden from keyboard; reduced motion → no fade), keyboard shortcuts left to
   the app. `variant: live | vod | clip | preview | offline`. Pure presentation: no hls.js, no
   timers that fetch.
6. **`ChatPanel`** shell: `header` (title, collapse `IconButton`, viewer list `IconButton`),
   `pinned` slot (pinned message, the app's `PollCard` from U3), `log` (`ScrollArea`,
   `role="log"`, `aria-live="polite"`, stick-to-bottom with a "new messages" jump button when the
   user scrolled up), `footer` slot; `variant: live | replay | mobile`; forwards `data-testid` /
   `data-state`. **`ChatMessage`**: badges (`ChatBadge` kinds broadcaster/moderator/subscriber/
   member/vip with tokens and sr labels from props), author name colored `text-chat-N` from a
   `colorIndex` prop (1–12), separator, body (action style), `timestamp` (replay), `highlight`
   (gift/sub events), `deleted` (placeholder text prop), `notice` variant (system notice), an
   `actions` slot (the app's moderation menu), `data-*` forwarding. **`ChatComposer`**:
   `InputGroup` (input + emote `InputGroupButton`), optional points button, settings, mode note
   ("Slow mode 3s"), send `Button` (or `IconButton` on mobile), `disabled`, `signin` slot (the
   sign-in prompt replaces the composer). **`ChatReplayFooter`** = a footer note.
7. **`ClipTrimmer`** (Clip board): frame strip of `Skeleton`/thumbnails with a range `Slider` (two
   thumbs, labels "Start handle, 0:27"/"End handle, 0:57" from props), min/max duration, current
   duration `Badge`. Use shadcn `Slider` with two values; no custom handles.
8. **`AlertPreview`** (Overlays): stage with the alert (avatar, "Fernsby tipped $5.00", message)
   and an optional goal slot; transparent-checker background is NOT needed — use `bg-muted`.
9. **`EmoteTile`** / **`EmoteGrid`** (ChatBot): accent glyph tiles (`role="img"` only via the
   underlying component's API — use `Avatar`/`ChannelAvatar` square variant if U1 provides one,
   otherwise compose `AspectRatio` + text with an `aria-label` on a non-interactive `figure`), and an
   upload `IconButton`.

## Tests you must add

- Behaviour: StreamGrid loading/empty, MediaCard badge slots and compact layout, ChannelHeader
  variants and heading levels, PlayerChrome controls labelled + pressed states + scrubber
  `aria-valuetext` + controls visible on keyboard focus, ChatPanel stick-to-bottom + jump button,
  ChatMessage badges/colors/deleted/notice + `data-*`, ChatComposer submit/disabled/signin slot,
  ClipTrimmer two-thumb keyboard. SSR + hydration without warnings for every block.

## Stories

One story file per block under `stories/media/`, with fixtures from the boards (Main grids, Channel
player + chat with 14 messages, Vod chrome + replay, Clip trimmer, Mobile channel), each with
`Light` and `Mobile320` stories, plus loading/empty/offline states.

## Done means

Per `_common.md` "Done means". Also list every export for `src/blocks/media/index.ts` (you write it).
