<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Discovery: home, directory, categories, search, rail (discovery, DS)

Investigated 2026-11-06 on https://staging-stream.abolish.us (signed out, `/api/me` 401 throughout)
at 1440x900, 768x1024, 375x812, 320 wide, plus the route and component source. Read-only.
Builds on `docs/design/2026-11-design-review.md` (F1, F7, F8, F10, F18, F20), most of which has now
landed in some form.

## 1. What exists now

**Staging data at the time of the walk:** 2 channels live (Aurora Pixel / Art, 15 viewers; Lumen
Beats / Music, 9), 24 "recently live" channels, 16 categories (2 with anyone live, none with box
art), about 8 ready VODs and about 17 ready clips spread over 6 categories (all clips at 0 views).
This is the cold-start case, which is what most new instances will look like for months.

| Route                  | What it shows (staging)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Source                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `/`                    | Signed-out WelcomeStrip ("Welcome to CommonAir…" + Sign up + dismiss), **Spotlight** hero (one StreamCard capped at `max-w-4xl`, so about 30% of the row is empty at 1440), **Live now** (1 card in a 3-column grid: two thirds empty), **Categories** (only categories with live channels: 2 tall portrait glyph tiles in a 6-column grid), **Recently live** (24 tiles, 6 across; 17 are an initial on an accent field, 7 carry a VOD thumbnail). No clips, no VOD shelf, no co-op or creator pitch, no footer CTA. Page height ~2,600 px, of which ~1,100 px is the 24-tile wall. | `routes/_app/index.tsx`, `components/directory.tsx`, `lib/directory-sections.ts`       |
| `/directory`           | PageHeader "Browse", tabs Categories / Live channels, tag combobox, 16 portrait CategoryArt tiles (glyph on a tinted field). 14 of 16 say "0 channels live" and "0 viewers".                                                                                                                                                                                                                                                                                                                                                                                                         | `components/discovery/directory-page.tsx`                                              |
| `/directory/$category` | Art tile, name, "N channels live", viewers, tag chips; tabs Live channels / Videos / Clips (Clips has sort and range). Live tab with 0 live: EmptyState "Nobody is live in Cooking right now" + "Browse other categories". Music (1 live): one card, then nothing, while its 2 VODs and 5 clips sit behind tabs.                                                                                                                                                                                                                                                                     | `components/discovery/category-page.tsx`                                               |
| `/search`              | Empty query: a heading and one line, "Type a channel or category name to search." With `q`: Channels (avatar rows, followers or live category) then Categories.                                                                                                                                                                                                                                                                                                                                                                                                                      | `components/discovery/search-page.tsx`, `services/api/src/routes/directory.ts:352-375` |
| Rail (`AppRail`)       | Signed out: "Live now", top 10 by viewers (2 rows on staging, then empty grey to the footer). Signed in: Followed (live first, then offline by last live); follows nobody: Live now. On any route other than `/` it renders 6 skeleton rows and then pops to 2 (client fetch, layout shift). Collapses to avatars on `md`, moves into the sheet below `md`.                                                                                                                                                                                                                          | `components/discovery/rail.tsx`, `feed.ts`                                             |
| Header                 | Logo, Browse, Co-op, centred search with ⌘K palette (recent searches this tab, live channels, their categories), Sign up, Sign in. 375: logo, search icon, Sign in, menu (Sign up only in the strip).                                                                                                                                                                                                                                                                                                                                                                                | `components/site-chrome.tsx`, `discovery/header-search.tsx`                            |

**Signed in (streamer1 = demo_streamer1 / Aurora Pixel, live at the time), 1440 and 375:** no
hero; "Following" (Lumen Beats, 1 card in a 3-column row), "Live now" (the viewer's **own** live
channel, Aurora Pixel, with a "Popular" chip), Categories (2), "Offline channels you follow" (7
tiles, 3 with initials), then the same 24 Recently live. Rail: "Followed channels", 1 live + 7
offline with category and relative time (works well). Header: bell (58 unread) and avatar; no
"You're live" or studio shortcut on the home page.

API available to discovery (from `packages/contracts/src/api/router.ts:385-495, 925-1060`):
`directory.home` (spotlight, newAndLive, live, following, recentlyLive with `latestVod`,
followingOffline), `directory.live` (category, tag, language, sort incl. `recent`, paging),
`directory.random`, `directory.ranking` (governance-controlled explanation), `categories.list/get`
(with `tags`, `viewerCount`), `search`, `vods.listByCategory`, `clips.listByCategory` (sort, range),
per-channel VODs and clips. **Not used by the UI today:** `directory.random`, `directory.ranking`
(no "why this order" link on home), category VOD/clip lists outside the category tabs, `newAndLive`
beyond a shelf that is empty on staging. **Not available at all:** a cross-category VOD feed, a
cross-category clip feed, schedules/upcoming streams, watch progress, channel `createdAt` for
"new streamers" when offline, tag search.

## 2. Findings

**DS-1. Cold start makes the home page mostly empty grid and placeholder tiles.** With 2 live, the
hero leaves ~30% of its row empty, "Live now" leaves two thirds of its row empty, the Categories
shelf shows 2 of 16 categories, and the page's longest block is 24 recently-live tiles, 17 of them
an initial on a colour field. Evidence: `/` 1440 dark; `directory.tsx:94` (`liveChannels > 0`
filter), `directory.tsx:112` (`max-w-4xl` hero), `stream-cards.tsx:94-97` (fixed 3 columns). **High.**

**DS-2. The VODs and clips that exist never reach the home page.** ~8 ready VODs and ~17 clips are
only reachable via a category's Videos/Clips tab or a channel page. Recently live tiles show a VOD
thumbnail for 7 channels, mixed into a wall with 17 that have none. There is no cross-category
VOD or clip endpoint, so the home cannot build a "Latest videos" or "Fresh clips" shelf without N
calls. Evidence: `/api/categories/*/clips`, `/api/categories/*/vods`; router has no `/vods` or
`/clips` list. **High.**

**DS-3. Category pages hide their content behind tabs and dead-end when nobody is live.** Music
shows one live card and nothing below it, while its 2 VODs and 5 clips are a tab away. Cooking
says "Nobody is live" with no fallback, though 4+ Cooking channels were live in the last hour.
Evidence: `/directory/music`, `/directory/cooking` at 768 and 1440. **High.**

**DS-4. "0 channels live / 0 viewers" printed 14 times makes the directory read as dead.** Every
zero is shown as a badge on a tall 3:4 glyph tile; at 320 the first screen is 2 live and 2 zero
tiles. Evidence: `/directory` all viewports; `category-tiles.tsx` labels. **Med.**

**DS-5. Search misses obvious queries and ranks the wrong things first.** Tags are not searched
(`lofi` returns nothing while a live stream is tagged lofi); broadcast titles are not searched;
live channels are not boosted, and the live Music stream (Lumen Beats) is missing from `music`
entirely, because only channel name, title and description are matched, not the broadcast's category; viewer accounts with 0 followers and no
broadcasts fill results (`gecko`: 22 rows, 12 with 0 followers, none showing last live or
category). No VOD or clip results. Empty query is a blank page. Evidence: `/api/search?q=…`,
`services/api/src/routes/directory.ts:352-368`, `/search` and `/search?q=gecko` 1440. **High.**

**DS-6. The signed-out rail is two rows and a tall empty column.** Nothing for categories, recent
channels or a reason to sign up; on non-home routes it shows 6 skeleton rows then collapses to 2
(layout shift). Evidence: `/directory` 1440 first paint vs after load; `rail.tsx`,
`railSections` in `directory-sections.ts:216-235`. **Med.**

**DS-7. The signed-out pitch is one dismissible line.** WelcomeStrip is the only "why CommonAir"
on the page; nothing says co-op ownership, fair discovery or "start streaming", and nothing below
the fold invites sign-up. The Spotlight hint ("A smaller channel the fair-discovery ranking puts
first.") is the platform's best differentiator but is a muted line, with no link to
`directory.ranking`'s explanation. Evidence: `/` all viewports; `welcome-strip.tsx`. **High.**

**DS-8. StreamCard is low-density and its chips compete.** Three columns at 1440 with the rail
give ~360 px thumbnails; the reason chip ("Spotlight", "Popular") is a filled badge first in the
tag row, louder than the title. Inside a category page the card repeats the category name.
Evidence: `/`, `/directory/music`; `packages/ui/src/primitives/stream-card.tsx:228-237`. **Med.**

**DS-9. No personalisation for signed-in viewers beyond Following.** The home adds a Following
shelf and the rail lists follows; there is no "continue watching", no categories from what you
follow, no "new from channels you follow" (VODs/clips). Evidence: `homeLayout`
(`directory-sections.ts:66-104`), router (no watch progress). **Med.**

**DS-10. Recently-live includes channels that are not useful to show.** A channel with no title
("Nova Tide", `demo_viewer2`) appears; the list is unranked by follower count or VOD availability,
so the first row is six placeholder tiles. Evidence: `/api/directory` `recentlyLive`. **Low.**

**DS-11. Mobile home spends ~2 screens on two live cards before anything else.** At 375 the
Spotlight hero and a full-width Live now card each take ~600 px; categories and catch-up content
sit far below. Recently live is 12 rows of 2. Evidence: `/` 375. **Med.**

**DS-13. Transient HTTP 500 on SSR loaders under rate limiting.** account-admin saw `/following`
and `/notifications` return 500; watch re-fetched both as 404 and reproduced the 500 on a normal
live channel under the team's shared-IP 429s, so it is "a rate-limited SSR loader renders 500",
not a slug bug (watch filing). Relevant to discovery because every discovery page is an SSR
loader: a 429 should render the page's `loadFailed` state or retry, never a 500. **Med.**

**DS-14. Signed in, the viewer's own channel is recommended back to them.** streamer1's home lists
Aurora Pixel (their own live channel) under "Live now" with a "Popular" chip, and it would count as
a rail "Live now" row for a streamer who follows nobody. Evidence: `/` 1440 signed in as
demo_streamer1; `homeLayout` and `railSections` never exclude `me.channelSlug`. **Med.**

**DS-15. The signed-in home opens on a single card and has nothing personal beyond follows.**
First row is one Following card in a three-column grid, then one Live now card; no continue
watching, no "new videos from channels you follow" although 7 followed channels are offline and
some have VODs. Evidence: `/` 1440 and 375 signed in. **Med.**

**DS-16. Small targets and 10 px text on cards and home (from responsive-a11y).** Tag chips are
20 px tall, the category link under a tile ~16 px, and 13 text nodes on home render at 10 px
(viewer pills, rail counts): WCAG 2.5.8 target size and legibility. The home load-failure state
(seen under 429s) is a bare line, "The directory could not be loaded. Reload to try again.", with
no heading and no Retry. Evidence: responsive-a11y's audit of `/`; `stream-card.tsx` chip row,
`directory.tsx:96`. **Med.**

**DS-12. The empty states have one generic next step.** Home with nothing live offers Sign up or
Dashboard only; search "no results" offers no live channels or categories; category "nobody live"
offers "Browse other categories". Evidence: `directory.tsx:98-105`, `search-page.tsx:128-133`,
category empty. **Med.**

## 3. Proposals

All new UI uses art-director's v1 (`art-direction-v1.md`): square surfaces, zinc chrome, one brand
CTA per view, `Shelf` / `SectionHeader` / `MediaFallback` / `CategoryArt`, text-sm body, auto-fill
media grid (min tile 248 px, `gap-x-4 gap-y-6`). Strings via `t()`.

### P1. Home v2: a page that is full at 2 live and at 200 live (DS-1, 2, 7, 11) — L, very high

Signed out, top to bottom:

```
+--------------------------------------------------------------------------------+
| HERO (brand, arcs motif)                                                       |
|  display: "Live streaming, owned by the people on it"     [feature StreamCard  |
|  2 lines: co-op, fair discovery, no ads/trackers           62% thumb | title   |
|  [Create free account]  (ghost) Browse live                 channel, cat, tags |
|  quiet link: Stream on CommonAir -> /creators                                  |
|                                                            (outline) Watch now]|
+--------------------------------------------------------------------------------+
| Live now (SectionHeader + "See all" -> /directory?view=live)                   |
|  Shelf of StreamCards; if < 4 live, the row is completed with "Catch up" VOD    |
|  MediaCards labelled as videos (never pretending to be live)                   |
+--------------------------------------------------------------------------------+
| Browse categories  (compact 16:9 CategoryArt row: live ones first with counts, |
|  then the rest muted with "12 videos" or no count; See all -> /directory)      |
+--------------------------------------------------------------------------------+
| Per-category live shelves (existing rule: > 2 live in a category)              |
+--------------------------------------------------------------------------------+
| Catch up: latest videos (MediaCard kind=vod, Shelf, 8)                         |
+--------------------------------------------------------------------------------+
| Fresh clips (MediaCard kind=clip, Shelf, 8, sort top in 7d, fallback recent)   |
+--------------------------------------------------------------------------------+
| Owned by its streamers and viewers  (co-op band: 3 facts from transparency,    |
|  "How the co-op works" -> /coop/membership; not brand-filled)                  |
+--------------------------------------------------------------------------------+
| New on CommonAir / Say hi to new streamers (newAndLive live first, then        |
|  recently created channels that have streamed: ChannelChip row)                |
+--------------------------------------------------------------------------------+
| Recently live  (ChannelChip rows, max 12, VOD-having first, untitled dropped;  |
|  "See all" -> /directory?view=recent)                                          |
+--------------------------------------------------------------------------------+
| Start streaming band: "Go live on a platform you co-own" -> /signup?intent=stream |
+--------------------------------------------------------------------------------+
```

- Hero CTA "Create free account" -> `/signup` with no intent (post-verify tip "Follow 3 channels to
  fill your rail"); "Browse live" -> `/directory?view=live`; "Stream on CommonAir" -> `/creators`
  (a route that does not exist yet; owner to be named by the orchestrator). Header Sign up drops
  to outline while the hero is in view.
- When few are live, the hero subline can carry network facts instead of an empty-looking count
  (channels, hours streamed this week, members) from transparency data, as PeerTube/Mastodon do.
- Hero replaces WelcomeStrip **and** the separate Spotlight section (one featured stream, not
  two). With nothing live, the hero shows the newest VOD as the feature card with a "Recorded"
  badge, or the motif alone.
- Below 768: hero stacks (headline, CTA, feature card); Live now and Catch up become horizontal
  `Shelf`s (snap, 85% card width) so the page reaches categories in ~1.5 screens (DS-11).
- Primitives: `StreamCard`, new `StreamCard size="feature"`, new `MediaCard` (kind vod|clip),
  new `ChannelChip`, `CategoryArt` compact, `Shelf`, `SectionHeader`, `Hero`, `EmptyState`,
  `RelativeTime`, `ViewerCount`, `LiveBadge`, `OverlayBadge`, `Skeleton*`.
- Copy: plain and specific ("Catch up", "Fresh clips", "Say hi to new streamers"); the fair
  ranking line keeps its "why" and links to a small Dialog that renders `directory.ranking`'s
  `explanation` ("How we order this page").
- Data: existing `directory.home`, `categories.list` (drop the `liveChannels > 0` filter, sort
  live first). **Contract requests** (orchestrator): `GET /vods?sort=recent&limit` and
  `GET /clips?sort=top|recent&range=7d&limit` (public, ready, non-mature unless opted in,
  excluding restricted); `Category.vodCount` (or `recentMediaCount`) for muted tiles;
  `ChannelCard.createdAt` or a `directory.home.newChannels: ChannelCard[]`. Interim without
  contracts: Catch up from `recentlyLive.filter(c => c.latestVod)` (7 on staging today).

Signed in: no brand hero. Exclude `me.channelSlug` from every recommendation shelf and the rail's
Live now; instead, when the viewer's own channel is live, show creator-studio's `LiveStatusBar compact` at the top
(one row on --surface-raised: LiveBadge or "Rehearsing", ViewerCount, uptime, "Open stream
manager" -> `/dashboard`; props { state, viewers, startedAt, href }; same channels.get poll). Order: Following live (feature card for the top followed live if any),
**Continue watching** (P6), Live now, **From channels you follow** (latest VODs/clips of followed
channels), categories (followed channels' categories first), the rest as signed out without the
co-op/streaming bands for members (keep the streaming band for accounts with no channel).

### P2. Category page v2: "Overview" default tab (DS-3, 12) — M, high

```
[CategoryArt 3:4] Music                         1 live · 9 viewers
                  tags: beats lofi production
Tabs: Overview | Live channels | Videos | Clips
Overview:
  Live now in Music     (grid, or the empty line below)
  Latest videos         (Shelf, MediaCard vod, from vods.listByCategory)
  Top clips this week   (Shelf, MediaCard clip, clips.listByCategory sort=top range=7d)
  Recently live in Music (ChannelChip row)  <- contract request: directory.recent?category=
  More live elsewhere   (LiveNowShelf excludeCategory)
```

Nobody live: a one-line notice ("Nobody is live in Cooking right now") above the content, not a
full EmptyState; the full EmptyState only when the category has no live, no VODs, no clips and no
recent channels, and then offers "Live now elsewhere" (LiveNowShelf) and, for streamers, "Stream
Cooking" -> `/signup?intent=stream`. Hide the category name on cards inside its own page. Data:
existing endpoints plus a `category` filter on recently live (contract request:
`directory.recent({ category, limit })` returning `ChannelCard[]`).

### P3. Directory v2: lead with what is alive (DS-4) — S/M, med

- Categories view: two groups, "Live now" (live categories, existing tiles with counts) and "All
  categories" (muted CategoryArt, no zero badges; show "N videos" when the contract field lands).
- Add view "Recently live" (`?view=recent`, ChannelChip list, from `recentlyLive` paged) so the
  home "See all" has somewhere to go.
- A row of 4-6 top-level vertical chips (e.g. Gaming, Creative, Music, Talk, Learning) above the
  grid, filtering categories client-side by a static vertical map in the web app (no contract);
  with few categories, verticals make the page feel organised rather than sparse.
- Filters in URL params only: tag (exists), language (`directory.live` already accepts it), 18+
  toggle for signed-in confirmed adults (`includeMature`).
- "Surprise me" ghost button in the PageHeader actions using the unused `directory.random`
  (respects `includeMature=false`): a cheap, honest way into watching.

### P4. Search v2 (DS-5, 12) — M (web S, API M), high

- Empty query: recent searches (tab storage, exists), "Live now" (5 rows), "Popular categories"
  (compact CategoryArt), and tag chips from live streams.
- Results order: Live channels first (StreamCard rows), then Channels (only accounts that have
  streamed or have followers, with last live + category), then Categories, then Videos and Clips
  (MediaCard, top 6 each, "See all").
- Tags: a query that equals a live tag offers "Live with #lofi" -> `/directory?view=live&tag=lofi`.
- No results: "Nothing for ‘x’" + Live now shelf + Browse categories.
- **Contract request** (API): search broadcast titles and tags of live streams; boost live;
  exclude never-broadcast, zero-follower accounts unless the slug matches exactly; add
  `vods` and `clips` arrays (title match, ready/public). Response gains `live: StreamCard[]`.

### P5. Rail v2 (DS-6) — S/M, med

Signed out: "Live now" (as today, max 10), then "Recently live" (5 ChannelChips, compact), then
"Categories" (top 5 live-first, glyph + count), then a footer card "Follow channels to see them
here" + "Create account" (outline; the hero owns the brand fill) -> `/signup?intent=follow` per
growth-funnels' log entry (`rail.followNudge`). Signed in, follows nobody:
Live now + "Suggested" (top 5 by spotlight/new) instead of an empty Followed. Prime the rail from
the SSR loader on every `_app` route (or render skeleton rows = last known count from tab storage)
to stop the 6-to-2 pop. Collapsed `md`: live avatars only, with Tooltip names (exists).

### P5b. /following page (new, discovery-owned) — S/M, med

Today follows are visible only as rows inside `/settings/notifications`. New `_app/following.tsx`:
PageHeader "Following", Live now (StreamCard grid, live first), Offline (ChannelChip rows by last
live). Row controls are account-admin's spec: display name with @username secondary; on the
right a `Switch` "Go-live alerts" and an overflow `DropdownMenu` (`IconButton` tooltip "More for
{name}") holding Email and Push (Default / On / Off radios, Push hidden when the instance has push
off), "Tell me if they move" (checkbox, portability grants), a separator, then "Unfollow" ->
`ConfirmDialog`. Changes are optimistic with a `toast` on error (me.follows,
notifications.preferences.set per channel, channels.unfollow). Above the list: bulk "Alerts on /
off for all" (ConfirmDialog) and a filter box above 20 rows, `EmptyState` "Follow channels to see them here" + Live now shelf. Linked from the rail's
Followed "See all", the account menu and the mobile sheet. Data: `me.follows` +
`directory.home.following/followingOffline`. Signed out: redirect to sign-in with return.
Settings > Following points here, so there is no duplicate page; Settings > Notifications keeps only
the defaults matrix plus a "Per-channel alerts → Following" link.

### P6. Continue watching, first-party and private (DS-9) — S, med

Watch's VOD player writes `localStorage["commonair.resume.v1"]` = map `{kind:id -> {pos, dur,
updatedAt, slug}}`, capped at 20, written every ~10 s and on pagehide, cleared past 95% or under
30 s; clips are skipped (VODs only). Discovery reads it. Earlier sketch: store VOD resume positions in `localStorage` (per-viewer convenience, wrapped in try/catch,
works signed out; cap 20 entries, 30 days). Home shows "Continue watching" when entries exist,
MediaCard with a progress bar under the thumbnail. No server state, no new contract. Watch owns
writing the position from the VOD player; discovery owns reading it. A server-side variant can
come later if members ask for cross-device.

### P7. StreamCard and media tile cleanup (DS-8, 10) — S, med

- Reason becomes a quiet meta line under the channel ("Spotlight · fair discovery"), not a filled
  chip; tags stay outline chips, max 3; `showCategory={false}` on category pages.
- Auto-fill grid, min 248 px; `StreamCard size="feature"` (62/38, stacks < 768).
- One `MediaCard` (vod|clip) with StreamCard's footprint; fold `channel/video-grid.tsx` tiles into it.
- `ChannelChip` for offline channels: avatar (accent ring when live), name, "Last live 1 h ago",
  category link; links to `/$channel` with an optional "Latest video" secondary link.
- Accessibility (with responsive-a11y): the card stays one stretched link (already the pattern in
  `stream-card.tsx`); tag chips and the category slot link get `min-h-6` (24 px) with `gap-2`;
  at most 3 tags, none on ChannelChip; viewer and rail counts at 12 px `tabular-nums`, 10 px only
  over video on a scrim (art-director's micro rule).
- Load failure on every discovery page: `EmptyState` with an h2 title, a Retry button, and
  automatic retry with backoff (1 s, 3 s, 9 s) on 429/503 before showing it; an SSR 429 renders
  this state, never a 500 (DS-13).
- Recently live ranking client-side for now: drop channels with no title and no category, VOD
  first, then by `lastLiveAt`.

## 4. Funnel and conversion notes

Entry points: `/` (direct, shared links), `/directory` (header Browse), `/directory/$category`
(card and tag links, search), `/search` (header box, ⌘K), rail (every `_app` page).

| Step                   | CTA                                                                       | Drop-off risk                                    | Fix                                                    |
| ---------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------ |
| Land on `/` signed out | Hero "Create free account" (brand), "Browse live" (ghost), feature card   | Thin page at cold start reads as a dead platform | P1 fills rows with VODs, clips, categories, co-op band |
| Browse -> watch        | Card click (live, VOD, clip)                                              | Empty grids, zero badges, category dead ends     | P1-P3, LiveNowShelf at every dead end                  |
| Search -> watch        | Live-first results                                                        | Tag/title misses, viewer accounts                | P4                                                     |
| Watch -> sign up       | Follow/chat gates (watch + growth-funnels' AuthGatePrompt, intent=follow) | Out of discovery's scope                         | Rail footer card repeats the follow reason             |
| Viewer -> streamer     | "Start streaming" band, category "Stream Cooking"                         | No creator path on home today                    | `/signup?intent=stream` (creator-studio checklist)     |
| Viewer -> member       | Co-op band -> `/coop/membership` pitch                                    | Only in the header "Co-op" today                 | P1 band (coop-trust content)                           |

Measurement (growth-funnels' agreed first-party aggregate counters, keyed surface/action/step/day,
no ids, no cookies, no URL params): impressions per shelf when ≥50% visible once per page view
(`home.shelf.<id>.view`), clicks (`home.shelf.<id>.click`, `rail.<section>.click`,
`search.<group>.click`, `category.<tab>.click`), `search.empty`, `category.empty`,
`home.hero.signup`, `rail.followNudge.signup`, `home.streamBand.signup`. Key ratios: shelf CTR,
share of sessions reaching a watch page from `/`, search zero-result rate, signup per hero view.

## 5. Cross-team decisions

- Card/tile set: StreamCard reason as meta line; auto-fill grid min 248 px; `StreamCard
  size="feature"` 62/38; one `MediaCard` kind vod|clip; `ChannelChip`; CategoryArt 3:4 + compact
  16:9 + muted 0-live, no zero badge. (agreed with: art-director; logged by both)
- Signed-out Hero replaces WelcomeStrip + Spotlight section: brand "Create free account", ghost
  "Browse live", feature card inside with outline "Watch now"; header Sign up drops to outline
  while the hero is in view; no brand hero signed in. (agreed with: art-director, label from
  growth-funnels)
- Offline channel cards link to `/$channel` (watch's OfflineHero is the conversion moment); VOD
  and clip cards link to the media; extend existing `components/channel/live-now-shelf.tsx`
  (limit, excludeSlug, sameCategoryFirst) instead of a new shelf; watch places it on offline
  pages, under the 18+ gate and as "More live in <category>"; player poster = card thumbnail with
  view-transition only without reduced motion; no `?src=` params. (agreed with: watch)
- Home CTAs: hero "Create free account" -> `/signup` (no intent), "Browse live", quiet "Stream on
  CommonAir" -> `/creators` (unbuilt route); co-op band -> `/coop/membership` (coop-trust's public
  pitch); empty home and category "Start streaming" -> `/signup?intent=stream`; counters
  `home.shelf.<id>.view/click` per day with no channel id in the key. (agreed with: growth-funnels)
- `/following` page owned by discovery; account-admin specs row controls. (agreed with: account-admin)
- Own channel excluded from home shelves and rail; home shows `LiveStatusBar compact` when the
  viewer is live. (agreed with: creator-studio)
- Card a11y: 24 px minimum for tag chips and category links with gap-2, 12 px counts (10 px only
  over video with a scrim), EmptyState + Retry + backoff for load failures. (agreed with: responsive-a11y)
- Market-research input adopted: verticals above the category grid, a "new this week" shelf
  instead of any money leaderboard, quiet "Stream here" CTA in empty states, network facts at
  cold start, URL-param filters (language, 18+). Schedule shelf ("Live later today") deferred:
  no schedule data exists in the API.
- Continue watching reads watch's `commonair.resume.v1` localStorage map (VODs only); watch also
  shows "Resume from 12:04" on the VOD page. (agreed with: watch)

## 6. References

- twitch.tv home → a featured stream beside its metadata (the 62/38 feature card idea, not the
  carousel), and per-category live shelves. Already cited in the prior review.
- twitch.tv/directory/category/* → category header with tabs; borrowed only the idea that a
  category page leads with content, adapted into an "Overview" tab.
- YouTube home "Continue watching" shelf → resume row with a thin progress bar; we keep it local
  to the browser.
- Kick and Twitch search → live results grouped first; borrowed the ordering only.
- market-research teammate (see market-research.md): Twitch directory verticals, Kick featured
  shelves (leaderboards deliberately not borrowed), PeerTube/Mastodon cold-start network stats,
  Mastodon /servers filter set → verticals, network facts, URL filters.
- Owncast directory (directory.owncast.online) → a FOSS directory that lists recently live
  instances when few are live; borrowed the "never show an empty directory, show recent" stance.
  No assets or copy taken from any of them.

## 7. Top 5 (discovery)

1. **Home v2 (P1)**, signed out and signed in (own channel excluded, "You're live" row, continue
   watching, new from follows), with cold-start filling: hero, Catch up VODs, Fresh clips, all categories, co-op
   and streaming bands. Needs the cross-category VOD/clip list contract (interim from `latestVod`).
2. **Search v2 (P4)**: live-first, tags and titles, viewer-account filtering, empty-query content.
3. **Category Overview tab and no dead ends (P2)**, plus LiveNowShelf at every empty state.
4. **Card system (P7)**: MediaCard, ChannelChip, feature StreamCard, auto-fill density, quiet reason.
5. **Rail v2 (P5) and /following (P5b)**: recent channels, categories, the follow nudge, primed
   server-side; a real page for everything you follow.
