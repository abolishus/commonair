<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# D2-channel: channel tabs, an offline page, live metadata and a header that holds at 320 px

You are implementing unit D2-channel for CommonAir (repo: /Users/joshe/Repos/bcon). Before you
start, read:

- AGENTS.md, PLAN.md and docs/architecture.md;
- `.claude/briefs/d/README.md` and `D0-contract-step.md`;
- `.claude/briefs/_done-means.md`;
- the design review, findings **F2, F4, F9, F12 (the UI half) and F13 (the channel page)**, with
  screenshots 03, 06, 10, 13 and 24;
- B8-web's merged work on `$channel.tsx` and `components/channel/{panels,banner}*`
  (`.claude/briefs/b8/B8-web.md` §1);
- the E4a boards `Channel.html` and `ChannelAbout.html`.

Do not look outside the repository. This is **wave 2**: work on branch `d/d2-channel`, cut from the
sha with D4 and all of batch 8's web units merged. D1-web, D2-player and D2-chat run beside you.

## You own (write only these)

- `apps/web/src/routes/_app/$channel.tsx`.
- `apps/web/src/components/channel/**`, including B8-web's panels and banner. Place them; don't
  rewrite them.
- `packages/ui/src/blocks/media/channel-header.tsx` and its stories.
- The `d2-channel` namespace, and B8-web's `b8-channel` if a key must move.
- `apps/web/tests/d2-channel*.test.tsx` and `harness/src/d/d2-channel.ts`.

**Read-only:**

- `player/**` (D2-player's). You place `<Player>` and pass its props; theatre mode is D2-player's
  state, and you expose a layout slot for it (see 5).
- `chat/**` (D2-chat's). You place `<ChatPanel>`; its height and its strip are D2-chat's.
- `packages/ui` apart from `channel-header`, contracts and services.

## Build

1. **Channel tabs (F2).** Use `Tabs` under the channel header, driven by search params
   (`?tab=videos`), so each tab is linkable and Back works:
   - **Home:**
     - when live, the player and chat as today, then a Videos shelf and a Clips shelf;
     - when offline, see 2.
   - **Videos:** a grid of the channel's VODs: thumbnail, duration, title, `<RelativeTime>`, and
     views if the API returns them. Paginated with "Show more". Build it as
     `components/channel/video-grid.tsx`; D3-watch reuses it for "More from".
   - **Clips:** the same grid for clips, with a range filter (7 days, 30 days, all) if the API
     takes one. Without it, newest first.
   - **About:** the bio, follower count, social links, B8-web's panels, and the banner on top.
   - Each grid's empty state is an `<EmptyState>`. When the viewer owns the channel it carries an
     action ("Go live and your broadcast is saved here" → Stream manager), and none for visitors.
2. **The offline page (F2).**
   - The banner, "Last live <RelativeTime> · <category>" from `Channel.lastLiveAt`, the latest
     VOD as the hero (the VOD player in its poster state, linking to the VOD page), then the
     Videos shelf.
   - Offline chat is D2-chat's.
   - A channel with no VODs keeps today's offline card plus the About content.
3. **The header at narrow widths (F4).**
   - Fix `channel-header.tsx:67` and `:94`: give the text column a minimum basis, or use the
     `compact` layout below `sm`, so the actions wrap onto their own row and the name and title
     stay readable.
   - On phones, Report moves into an overflow `DropdownMenu` (`<IconButton tooltip>`).
   - Add Storybook stories at 320, 375 and 1440 px, with a long name and a long title.
4. **Live metadata (F9, F12).**
   - Under the title: the category as a link (to D1-web's category route, from the shared route
     constants), tags as `Badge` links, uptime from the broadcast's `startedAt`, and a Share
     `<IconButton tooltip>` that copies the canonical URL and confirms with `toast.success`.
   - Uptime is a `<RelativeTime>` duration variant. If the primitive has no duration mode, file a
     **contract request** for `packages/ui`, and format with `formatDuration` meanwhile, if it
     exists.
   - Below a threshold of verified viewers, show a "Just started" label next to `<LiveBadge>`
     instead of the eye and "0". The threshold is a named constant. `<ViewerCount>` itself stays
     verified-only.
5. **The theatre slot.** Give the page layout a `theatre` mode: the player spans the viewport
   width and chat docks to the right, or is toggled per decision (b). Read it from D2-player's
   exported `useTheatre()` hook. If D2-player hasn't merged when you start, agree on the hook's
   shape through the orchestrator: a `{ theatre: boolean, setTheatre }` context in
   `player/theatre.ts`.
6. **Not found (F13).** The unknown-channel state (`ChannelNotFound` in `$channel.tsx`, an
   `EmptyState` today) adopts D4's `ChannelNotFoundState` from `components/not-found.tsx` (D4's
   open request), with a Live now shelf below it. `$channel.tsx` already has a `head()` (batch 8's
   integration added `titleHead(t("channelPage.title", …))`) and is no longer in `PENDING_HEAD`;
   make the title live-aware from loader data: "<name> (live) · <site>" or "<name> · <site>".

## Tests you must add

- `d2-channel-tabs.test.tsx`: search-param routing, Back, each tab's empty state as owner and as
  visitor.
- `d2-channel-offline.test.tsx`: last live, the VOD hero, the no-VOD fallback.
- `d2-channel-header.test.tsx`: the actions wrap and the name stays visible at 320 px (check the
  computed layout in a DOM test, or use the Storybook test runner if the repo has one), and
  Report is in the overflow menu on phones.
- `d2-channel-meta.test.tsx`: the category link, tags, uptime formatting at the boundaries
  (0 s, 59 s, 1 h, 48 h), Share's copy and toast, and the "Just started" threshold.
- `harness/src/d/d2-channel.ts`, on the seeded stack:
  - `demo_streamer1`'s Videos tab lists VODs;
  - an offline demo channel shows `channel-offline-hero`;
  - About shows panels once B8-web and D1-seed are merged.

## Done means

- The `_done-means.md` checks pass.
- The user's visual checklist, in dark and light at 320, 375 and 1440 px:
  - `/demo_streamer1` on every tab (compare 03 and 06);
  - an offline channel (compare 10);
  - the header at 375 px (compare 13 and 24);
  - theatre mode;
  - a keyboard walk through the tabs.
