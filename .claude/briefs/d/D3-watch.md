<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# D3-watch: VOD and clip pages with context, a channel card and "More from"

You are implementing unit D3-watch for CommonAir (repo: /Users/joshe/Repos/bcon). Before you start,
read:

- AGENTS.md;
- `.claude/briefs/d/README.md` and `D0-contract-step.md`;
- `.claude/briefs/_done-means.md`;
- the design review, finding **F11**, with screenshots 11, 12 and 20;
- the E4a boards `Vod.html` and `Clip.html`;
- D2-channel's `components/channel/video-grid.tsx` and D2-player's control bar, both merged.

Do not look outside the repository. This is **wave 3**: work on branch `d/d3-watch`, cut from the
sha with wave 2 merged.

## You own (write only these)

- `apps/web/src/routes/_app/$channel_.vods.$vodId.tsx` and `$channel_.clips.$clipId.tsx`.
- `apps/web/src/components/vod-watch/**`, except `vod-player.tsx`, which is D2-player's.
- `apps/web/src/components/watch/**` (new).
- The `d3-watch` namespace.
- `apps/web/tests/d3-*.test.tsx` and `harness/src/d/d3-watch.ts`.

**Read-only:**

- `components/channel/**`. Reuse `video-grid.tsx` as it is; if it needs a prop, that is a
  **contract request**.
- `player/**`, `chat/**` (chat replay stays as it is), contracts, services.

## Build

1. **Metadata under the player** (`watch-meta`).
   - The title, a category link, `<RelativeTime>` for the recording or clip time, the duration,
     views (when the API returns them, and the clip API does), and Share. Share is an
     `<IconButton tooltip>` that copies the canonical URL; for a VOD it can include the current
     time as `?t=`, toggled by a checkbox in a small `Popover`.
   - Clips also show "Clipped by <ChannelAvatar> <name>" when the API gives the clipper.
2. **The channel card** (`watch-channel-card`).
   - `<ChannelAvatar>`, the name, the follower count, and the existing follow button component.
   - When the channel is live now: `<LiveBadge>` with `<ViewerCount>` and a "Watch live" button.
     Poll no more often than the channel page does.
3. **"More from <channel>"** (`watch-more-grid`).
   - Below: D2-channel's video grid, with VODs on a VOD page and clips on a clip page, excluding
     the current item.
   - Six items, with a "See all" link to the channel's Videos or Clips tab.
4. **Titles.** Each route's `head()` comes from loader data: "<VOD title> · <channel> · <site>".
   Remove both routes from `PENDING_HEAD`. The list should then be empty, or name only D5-studio
   files.
5. **Not available.** A missing or private VOD or clip uses D4's `NotFoundState`, with "Back to
   <channel>" (compare 19).

## Tests you must add

- `d3-meta.test.tsx`: each field present or absent, depending on the data; Share with and without
  the timestamp.
- `d3-card.test.tsx`: the live and offline states.
- `d3-more.test.tsx`: the current item excluded, the six-item cap, the "See all" link.
- `d3-titles.test.tsx`.
- `harness/src/d/d3-watch.ts`, on the seeded stack: a `demo_streamer1` VOD shows `watch-meta`,
  `watch-channel-card` with "Watch live" while live, and `watch-more-grid`.

## Done means

- The `_done-means.md` checks pass.
- The user's visual checklist, in both themes at 375 and 1440 px:
  - a VOD page (compare 11 and 12);
  - a clip page (compare 20);
  - a missing VOD (compare 19);
  - Share with a timestamp.
