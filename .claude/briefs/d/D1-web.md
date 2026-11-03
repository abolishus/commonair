<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# D1-web: directory, category pages, search, the left rail and a fuller home page

You are implementing unit D1-web for CommonAir (repo: /Users/joshe/Repos/bcon). Before you start,
read:

- AGENTS.md (the design rules and house primitives are binding), PLAN.md and docs/architecture.md;
- `.claude/briefs/d/README.md`, with the user's answer to decision (a), the URL shape;
- `D0-contract-step.md`;
- `.claude/briefs/_done-means.md`;
- the design review, findings **F1, F7, F8, F10 (the UI fallback), F14 (moving the switcher) and
  F18**, with screenshots 02, 09, 15, 22 and 23;
- the E4a mockup boards `.claude/briefs/e4/boards/{Browse,Category,Search,Following,Main,Mobile}.html`.
  They are the house's own intended designs; follow them where they agree with the review.

Do not look outside the repository. This is **wave 2**: work on branch `d/d1-web`, cut from the
sha with D4 and D1-api merged. D2-channel, D2-player and D2-chat run beside you.

## You own (write only these)

- `apps/web/src/routes/_app/index.tsx`.
- `apps/web/src/routes/_app/directory.*` and `routes/_app/search.tsx` (new), named per decision (a).
- `apps/web/src/components/directory.tsx` and `components/discovery/**` (new).
- `apps/web/src/lib/directory-sections.ts`.
- `apps/web/src/components/site-chrome.tsx`.
- `apps/web/src/lib/nav.ts`: the public, header and account-menu sections only.
- `packages/ui/src/layouts/app-shell.tsx`.
- `packages/ui/src/blocks/media/category-tile.tsx` and its stories.
- The `d1-discovery` namespace.
- `apps/web/tests/d1-*.test.tsx` and `harness/src/d/d1-web.ts`.

**Read-only:** `$channel.tsx` and `components/channel/**` (D2-channel's), `player/**`, `chat/**`,
`packages/contracts/**` and `services/**`. Anything else is a **contract request**.

## Build

1. **The directory (F1)**, at `/directory`, using `CategoryGrid` and `CategoryTile` from
   `packages/ui` (unused today).
   - The tiles show box art, the name, a live viewer total and tag chips.
   - Sort by live channels, then viewers. Use the counts that D1-api corrected.
   - Filter by tag (a combobox), and a Categories / Live channels switch. Live channels is
     `directory.live` as a `<StreamCard>` grid.
   - When there is no box art (F10), the tile is a generated, token-coloured tile with a
     Hugeicons glyph per category kind. No hex: pick from the `--chart-*` or accent tokens by a
     stable hash of the slug.
   - Paginate with "Show more" (cursor), not infinite scroll, so the footer stays reachable.
2. **The category page (F1)**, at `/directory/$category`.
   - A header with the box art, name, live viewers, followers if the API returns them, and tags.
   - Tabs: Live, using `directory.live` with the category; Videos and Clips, if the API can list
     them by category. If it can't, leave those tabs out and file a **contract request**. Do not
     fetch per channel.
   - An unknown category shows D4's `NotFoundState`.
3. **Search (F1)**, at `/search?q=`.
   - Channel and category groups, from the `search` API.
   - The header gets a search field: centred on `lg`, an icon button opening a Sheet on mobile.
     It submits to `/search` and opens the existing `CommandPalette` on ⌘K or Ctrl-K.
   - The palette shows recent searches (session only, not persisted without the Preferences
     consent the theme already respects), live channels and categories.
   - The search box is debounced, and an empty query does nothing.
   - Results announce their count once, politely, in an `aria-live` region.
4. **The left rail (F7)**, using AppShell's sidebar variant (`app-shell.tsx:43-58`).
   - Signed out: "Live now" (the top 10 from `directory.home`).
   - Signed in: "Followed", live first, then offline, from `directory.home`'s `following` and
     `followingOffline`, which are already in the contract.
   - Each row has `<ChannelAvatar>`, the name, the category, and `<LiveBadge>` with
     `<ViewerCount>` or the time it was last live (`<RelativeTime>`).
   - The rail collapses to avatars on `md`, and becomes part of the mobile Sheet below `md`.
   - It remembers its collapsed state per tab: `localStorage` in a try/catch, and the page must
     work without it.
5. **The home page (F8).**
   - One hero, Spotlight: a large player-sized `<StreamCard>` with the title, category link and
     tags. It does not autoplay. A muted preview on hover is allowed only if the player already
     supports it cheaply, and never under reduced motion.
   - `directorySections()` dedupes across every shelf, not only the offline one
     (`lib/directory-sections.ts:23-52`).
   - A Categories shelf (6–8 tiles), then per-category live shelves when more than N channels are
     live in a category, each with a "Show all" link to the category page.
   - "Recently live" tiles show the latest VOD thumbnail and duration when there is one, with the
     initial-avatar tile as the fallback.
   - Show `@handle` when two display names on the page collide.
   - The signed-out welcome becomes a slim, dismissible strip (dismissal per tab).
6. **The header and the mobile Sheet (F14, F18).**
   - Move the theme switcher out of the header, into the account menu for members and to the
     bottom of the Sheet for visitors.
   - The header holds the logo, Browse (now `/directory`), search, and the account controls.
   - The Sheet holds search, Browse, Following (signed in), Live now, Categories, then the theme
     and language.
   - Repoint D4's "Browse live channels" route constant to `/directory`.
7. **Links everywhere.** Category names and tags on every card you render link to their category
   page or a tag filter. `StreamCard` in `packages/ui` is read-only for you: if it needs a link
   slot, that is a **contract request** for the orchestrator.

## Tests you must add

- `d1-sections.test.ts`: dedupe across all shelves, the per-category shelf threshold, handle
  disambiguation, and ordering. Exhaustive, including empty input.
- `d1-directory.test.tsx`: sort, the tag filter, the fallback tile (stable for the same slug), and
  "Show more".
- `d1-search.test.tsx`: debounce, the empty query, grouping, the `aria-live` count, and the ⌘K
  palette opening.
- `d1-rail.test.tsx`: signed out vs signed in, the live-first order, the collapsed state when
  storage throws.
- `d1-header.test.tsx`: the theme switcher in the account menu and the Sheet, not in the header.
- Storybook for `CategoryTile` and `CategoryGrid`: art and fallback, long names, 320 px, both
  themes.
- `harness/src/d/d1-web.ts`, on the seeded stack:
  - `/directory` lists every seeded category that has a live channel;
  - `/directory/art` shows `demo_streamer1`;
  - a search for "streamer" finds the three demo streamers;
  - the rail shows a live row.

## Done means

- The `_done-means.md` checks pass, including `vp build` for `apps/web`.
- No route is in `PENDING_HEAD`, and your new routes have titles.
- The user's visual checklist, in dark and light at 320, 375, 768 and 1440 px:
  - `/` (compare screenshots 02, 09 and 22);
  - `/directory`, `/directory/art` and `/search?q=streamer`;
  - the rail collapsed and expanded;
  - the mobile Sheet (compare 23);
  - a keyboard-only walk from `/` through search to a channel.
