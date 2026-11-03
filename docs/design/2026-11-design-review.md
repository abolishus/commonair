<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Design review: web app against Twitch (November 2026)

A visual and UX review of `apps/web` on staging (`v0.1.0-rc.9`, medium-scale seed, 2026-11-03
04:35–05:10 UTC), compared with Twitch's public pages. It proposes milestone batches for
[PLAN.md](../../PLAN.md) and changes no code.

**How it was done.** Public surfaces were walked signed out in the built-in browser at 1440×900,
768×1024 and 375×812, in both themes. The tool's permission policy blocked typing the shared seed
password into the sign-in form, so this pass reviewed the signed-in surfaces from the route
source (studio, settings, moderation and admin). Those findings say "code" instead of citing a
screenshot, and a signed-in visual pass is the first item of batch D5. The Twitch pages were read
signed out, with no cookies accepted, and no assets were copied. Screenshots of our own app are in
[`2026-11-review/`](2026-11-review/).

**Known, not a finding:** on staging, `/chat` answers 426. The fix is `fe6b9923` on `main`, not
yet released.

## Summary

CommonAir's _unique_ surfaces are good: the co-op overview, transparency, chat replay beside VODs
and clips, and the giveaway and prediction cards are clear, dense and honest. The gap is the
**core watch-and-discover loop that Twitch users expect**:

- There is no directory, category page, search or channel profile.
- The channel page is a player and chat with nothing around them.
- The player has no fullscreen, theatre or quality menu.

Most of the data for all of this is already seeded and served by the API (`/api/categories`,
`/api/directory/live`, `/api/search`, `/api/channels/{c}/vods`, `/api/channels/{c}/clips`). The web
app just never asks for it. The biggest gains are therefore mostly web work on existing contracts.

### Top 10 gains

| #   | Gain                                                                                        | Finding | Effort | Impact    |
| --- | ------------------------------------------------------------------------------------------- | ------- | ------ | --------- |
| 1   | Browse directory, category pages and search (the API already serves all three)              | F1      | L      | Very high |
| 2   | Channel page tabs: Home, Videos, Clips, About (panels and banner); offline page with VODs   | F2      | M–L    | Very high |
| 3   | Player chrome: fullscreen, theatre mode, quality in a settings menu, visible controls       | F3      | M      | Very high |
| 4   | Fix the 375 px channel header that crushes the name and title to one character              | F4      | S      | High      |
| 5   | Move Data saver from a permanent card into the player settings menu                         | F5      | S      | High      |
| 6   | Chat fills the column; predictions and giveaways collapse to a slim pinned strip            | F6      | M      | High      |
| 7   | Left rail of live and followed channels, using the AppShell sidebar variant we already have | F7      | M      | High      |
| 8   | Richer front page: one hero, no duplicate shelves, category shelf, thumbnails on recent     | F8      | M      | High      |
| 9   | Live metadata under the player: category link, tags, uptime, share                          | F9      | S–M    | High      |
| 10  | A per-page document title on every route (WCAG 2.4.2), and the skip link first              | F15–F16 | S      | High      |

## Open UI and design work in the plans

Not all of the UI work is done. The E4a design system is complete in code
([PROGRESS.md:1803-1817](../../PROGRESS.md)), and so are the E4b money pages, the E5 co-op pages and
the batch 6 and 7 pages. This is what is still open:

**Scheduled but not built**

- **B8-web** ([.claude/briefs/batch8/README.md:58](../../.claude/briefs/batch8/README.md), brief
  `.claude/briefs/b8/B8-web.md`):
  - channel panels and the banner on `$channel.tsx`, which has the data (`bannerUrl`,
    [PROGRESS.md:903](../../PROGRESS.md)) but renders neither;
  - a link from a jury flag to its case;
  - betting on predictions during the grace window;
  - the replay deep seek keeping its loaded span;
  - giveaway CR9.
- **B8-player** ([.claude/briefs/batch8/README.md:59](../../.claude/briefs/batch8/README.md)):
  - `edgeWallclock` for watch rooms;
  - DVR moving off a departed relay.

**Visual checks never signed off**

- Batch 7 pages in en, es and en-XA, at 320 px, in both themes and keyboard only
  ([.claude/briefs/batch8/README.md:466](../../.claude/briefs/batch8/README.md)).
- Every release candidate (`:470`).
- W2 pages ([PROGRESS.md:369](../../PROGRESS.md), `:386-387`).
- The N2 RTL Storybook pass and the es and en-XA pass (`:430-431`).
- E6 (`:1603-1606`), the E5 co-op boards (`:1673-1675`), the E4b Support views (`:1737`) and the E4a
  Storybook and browser checks (`:1817`).

**In the plan scope but never built**

- PLAN 3A ([PLAN.md:88](../../PLAN.md)) promises "theatre, PiP, shortcuts", a health panel, a
  command palette and onboarding:
  - `apps/web/src` has no fullscreen, theatre or PiP code, and keyboard shortcuts exist only in the
    DVR controls;
  - `CommandPalette` is in `packages/ui` but nothing in `apps/web` uses it;
  - there is no viewer health panel and no onboarding.
- The E4a mockup boards for Browse, Category, Search, Following, Status, ChannelAbout and
  Community (`.claude/briefs/e4/boards/`) have no routes.
- Showing offline and recently live followed channels on `/` was noted as needing an API change
  ([HANDOFF.md:356](../../HANDOFF.md)). The "recently live" half has since shipped (screenshot 09),
  but nothing exists for "following".

Batches D1–D5 below absorb the "never built" items. They leave B8-web and B8-player where they
are.

## Findings

Each finding lists the surface, the evidence (a screenshot in `2026-11-review/` or a code
reference), what Twitch does, the recommendation, the effort (S is under a day, M a few days, L a
week or more) and the impact. All recommendations stay inside the AGENTS.md design rules: shadcn
on Base UI, Rubik only, colors only as tokens, the house primitives, no third-party code.

### Discovery

#### F1. No directory, category pages or search

- **Surface:** the header's Browse link, and every page.
- **Evidence:**
  - "Browse" links to `/`, the same page as the logo.
  - `apps/web/src/routes/_app/` has no `browse`, `directory`, `category`, `search` or `following`
    route.
  - Tags and category names on cards are plain text, not links (02).
  - The API serves `categories.list/get`, `directory.live/random/ranking` and `search`
    (`packages/contracts/src/api/router.ts:375-480`). The seed has 15+ categories.
- **Twitch:**
  - [twitch.tv/directory](https://www.twitch.tv/directory) has a category grid with box art,
    viewer counts and tag chips, a "Search Category Tags" filter, sort, and a Categories / Live
    Channels switch.
  - [/directory/category/music](https://www.twitch.tv/directory/category/music) has a header with
    viewers, followers and parent tags, then tabs for Live Channels, Upcoming, Videos and Clips,
    then language and tag filters and sort.
  - [/search?term=lofi](https://www.twitch.tv/search?term=lofi) groups results into Channels and
    "People searching for … also watch".
  - Search sits centred in the header on every page.
- **Recommendation:**
  - Add `/directory`: a category grid built from `<StreamCard>`'s card shape, sorted by live
    channels.
  - Add `/directory/$category`: a live grid, then Videos and Clips tabs.
  - Add `/search`: channels and categories.
  - Put a search field in the header and wire it to the existing `CommandPalette` (⌘K), which
    PLAN 3A already asks for.
  - Make category names and tags links everywhere.
  - Build the boards that already exist in `.claude/briefs/e4/boards/`.
- **Effort:** L. **Impact:** very high. Without these, the seeded catalogue (90+ channels, VODs,
  clips) can only be reached from the front page.

#### F7. No persistent rail of live and followed channels

- **Surface:** the app shell (02, 03).
- **Twitch:** every page has a left rail. It lists "Live Channels" (avatar, name, category, red
  dot, viewer count) and, on a channel, "\<Channel\> Viewers Also Watch"
  ([twitch.tv/lofigirl](https://www.twitch.tv/lofigirl)). The rail collapses to avatars.
- **Recommendation:**
  - Use AppShell's sidebar variant (`packages/ui/src/layouts/app-shell.tsx:43-58`, already a
    collapsible-to-icons `Sidebar`).
  - Signed out, it shows Live now; signed in, Followed, live first. On narrow screens it collapses
    to icons and becomes a Sheet at 375 px.
  - Use `<ChannelAvatar>`, `<LiveBadge>` and `<ViewerCount>`.
  - The "following" data is the API gap noted in HANDOFF.md:356.
- **Effort:** M. **Impact:** high (wayfinding and a sense of activity on every page).

#### F8. The front page is thin and repeats itself

- **Surface:** home (02, 09, 22).
- **Evidence:**
  - "Spotlight" and "Live now" show the same two streams.
  - "Recently live" is 24 text-only tiles with initials, though every one of those channels has
    VOD thumbnails in the API.
  - One display name ("Nimble Thistle") appears twice with no handle to tell the two apart.
  - A signed-out welcome block repeats the header's Sign up and Sign in.
  - On mobile it pushes the first stream below the fold (22).
- **Twitch:** [twitch.tv](https://www.twitch.tv/) opens on one hero carousel with an autoplaying
  muted preview and a channel blurb. It follows with "Live channels we think you'll like",
  "Categories we think you'll like" (box art and viewers), then per-category shelves ("Just
  Chatting & IRL", "Music") with "Show all".
- **Recommendation:**
  - Make Spotlight a single hero: the large player-sized `<StreamCard>` with title, category and
    tags.
  - Remove streams already shown from Live now. `directorySections()` dedupes only the offline
    shelf (`apps/web/src/lib/directory-sections.ts:23-52`).
  - Add a categories shelf, and per-category live shelves when more than N channels are live.
  - Give recent tiles their latest VOD thumbnail and duration, and show `@handle` when display
    names collide.
  - Make the signed-out welcome a slim dismissible strip (Twitch uses a bottom banner).
- **Effort:** M. **Impact:** high.

#### F10. Seeded media identity is missing

- **Surface:** every card and avatar.
- **Evidence:** every avatar is an initial (09). `boxArtUrl` is `null` for every category
  (`/api/categories`).
- **Twitch:** avatars and box art carry most of the visual richness of every page.
- **Recommendation:**
  - In the seed, generate avatars and category art: CC0 generated SVG or WebP, made by the harness,
    never fetched.
  - In the UI, give categories a generated, token-coloured tile with a Hugeicons glyph when there
    is no art, so the directory still looks designed.
- **Effort:** S for the seed, S for the fallback tile. **Impact:** medium-high (the cheapest
  "nicer and fuller" win).

### Channel page

#### F2. The channel page is only a player and chat; offline channels are a dead end

- **Surface:** `/$channel`, live and offline (03, 10).
- **Evidence:**
  - `$channel.tsx` (167 lines) renders the player, `ChannelHeader`, the follow-grant toggle and
    chat. There are no VODs, clips, about, panels, banner or schedule, though
    `/api/channels/demo_streamer1/vods` and `/clips` return thumbnails and durations.
  - An offline channel shows "Indigo Puffin is offline" and nothing else (10).
  - VOD and clip pages exist (11, 20) but nothing links to them.
- **Twitch:** the channel has Home, About, Clips, Videos, Schedule and Chat tabs
  ([twitch.tv/jonathanong/videos](https://www.twitch.tv/jonathanong/videos)). An offline or
  "about" view shows the bio, follower count, social links and panels
  ([/about](https://www.twitch.tv/jonathanong/about)). Below a live player sit About and panels
  ([twitch.tv/lofigirl](https://www.twitch.tv/lofigirl)).
- **Recommendation:**
  - Add a `Tabs` row under the channel header: Home (live or latest VOD, recent videos, clips),
    Videos, Clips, About (bio, panels, banner, links).
  - Offline, show the banner, "Last live 4 hours ago · Music", the latest VOD as the hero and a
    Videos shelf.
  - This takes in B8-web's panels and banner.
- **Effort:** M–L. **Impact:** very high (VODs and clips are seeded and invisible).

#### F4. The channel header collapses at 375 px

- **Surface:** `/$channel` on mobile (13, 24).
- **Evidence:**
  - The name and stream title shrink to a single glyph ("/", "I") while Follow, Support and Report
    keep their width.
  - Cause: the text column is `min-w-0 flex-1` (`packages/ui/src/blocks/media/channel-header.tsx:67`)
    and the actions are `shrink-0` (`:94`). Flex shrinks the text to zero before the wrap ever
    happens.
- **Twitch:** the name, title and category stay readable and the actions sit beside or under them
  ([twitch.tv/lofigirl](https://www.twitch.tv/lofigirl)).
- **Recommendation:** give the text column a minimum basis (for example `basis-48`), or switch to
  the `compact` layout below `sm`, so the actions wrap to their own row. On phones, put Report in
  an overflow `DropdownMenu`. Add a 320 px story for `ChannelHeader`.
- **Effort:** S. **Impact:** high (a visible bug on the most-viewed page).

#### F5. Data saver is a permanent card under the player

- **Surface:** `/$channel` (03, 06, 13).
- **Evidence:** a seven-control card sits between the player and the channel name for every
  viewer (`apps/web/src/player/player.tsx:354`). At 1440×900 it pushes the channel header below
  the fold. On mobile it fills a whole screen.
- **Twitch:** quality (for example "720p60") is a chip in the control bar plus a settings gear
  menu ([twitch.tv](https://www.twitch.tv/) hero player).
- **Recommendation:**
  - Move Data saver into a player settings `Popover` or `DropdownMenu`.
  - While a budget is on, show a small "Data saver · Low" chip in the control row.
  - Keep the first-run explanation as a one-time hint.
  - The W1 data-mode feature stays; only its placement changes.
- **Effort:** S. **Impact:** high (above-the-fold space on the main page).

#### F6. Chat is a short box crowded by its cards

- **Surface:** chat panel, live (03, 04, 06).
- **Evidence:**
  - The panel has a fixed height of `h-112 lg:h-160` (`$channel.tsx:153`), so at 1440×900 it ends
    above the fold line and doesn't fill the column.
  - The prediction and giveaway cards take about 70% of it, leaving room for one message (04).
  - The 18+ and offline states repeat "No messages yet" in a mostly empty panel (08, 10).
- **Twitch:** chat runs the full viewport height beside the player. Predictions, goals and promos
  sit as slim, dismissible strips at the top, each expandable
  ([twitch.tv/lofigirl](https://www.twitch.tv/lofigirl)). The input row carries the points
  balance and settings.
- **Recommendation:**
  - Make the chat column sticky at `100svh` minus the header on `lg`.
  - Collapse predictions, polls and giveaways into a one-line pinned strip, expandable, the
    highest-priority one first.
  - Offline, swap "No messages yet" for the channel's last message time or a "Chat opens when
    Indigo goes live" `<EmptyState>`.
- **Effort:** M. **Impact:** high.

#### F9. Live metadata is missing under the player

- **Surface:** `ChannelHeader` (03, 06).
- **Evidence:** no category, no tags, no uptime, no share. The viewer count reads "0" with an eye
  icon (see F12).
- **Twitch:** under the player: name with a verified check, title, a category link, tag chips, the
  viewer count in red, uptime ("45:25:41"), share and an overflow menu
  ([twitch.tv/lofigirl](https://www.twitch.tv/lofigirl)).
- **Recommendation:** add a category link, tag `Badge`s (links once F1 lands), uptime from
  `startedAt` (a `<RelativeTime>` variant) and a Share `<IconButton tooltip>` that copies the URL
  with `toast.success`.
- **Effort:** S–M. **Impact:** high.

#### F3. The player has no fullscreen, theatre, PiP or quality menu

- **Surface:** live and VOD player (07, 12).
- **Evidence:**
  - Searching `apps/web/src` and `packages/ui/src` finds no `fullscreen`, theatre or PiP code. The
    VOD control row is scrubber, play, mute and captions (12).
  - On desktop live, hovering showed no control bar in our capture (07); on mobile it shows mute,
    captions and settings (13).
  - PLAN 3A ([PLAN.md:88](../../PLAN.md)) lists theatre, PiP and shortcuts.
- **Twitch:** the control bar has play, volume, a quality chip, settings, theatre and fullscreen,
  and it appears on hover and focus ([twitch.tv](https://www.twitch.tv/),
  [/videos/2915699009](https://www.twitch.tv/videos/2915699009)). The VOD shows elapsed and total
  time on the bar.
- **Recommendation:**
  - One control bar for live, DVR and VOD, appearing on hover, focus and tap: play, volume with a
    slider, live edge or time, captions, settings (quality, data saver, speed for VOD), PiP,
    theatre and fullscreen.
  - Keyboard: `space`/`k`, `m`, `f`, `t`, `c`, arrows, all listed in a `?` dialog.
  - Theatre mode widens the player to the viewport and keeps chat docked.
- **Effort:** M. **Impact:** very high (table stakes for a video site).

#### F12. "0 viewers" makes live channels look dead

- **Surface:** home cards and the channel header (02, 03).
- **Evidence:** the seeded live streams show an eye and "0" (the count is verified viewers only,
  and the seed has none).
- **Twitch:** the viewer count is the main social-proof signal, in red on every card.
- **Recommendation:**
  - Below a threshold, show `<LiveBadge>` with "Just started" or "New" instead of a bare 0.
  - Make the seed's `seed live` produce verified viewers so staging shows real numbers.
  - Keep `<ViewerCount>` honest: verified viewers only.
- **Effort:** S. **Impact:** medium.

### Watch pages

#### F11. VOD and clip pages lack context and next steps

- **Surface:** `/$channel/vods/$id` (11, 12) and `/$channel/clips/$id` (20).
- **Evidence:**
  - The VOD page has a title, the channel, "3 hours ago", the length and chat replay, which is
    well done.
  - It has no category, views, description, share, follow, "Watch live" (when the channel is
    live), or more videos.
  - The clip page also omits views, though the API returns them, and has no share and no more
    clips.
  - The page below the player is otherwise empty.
- **Twitch:**
  - The VOD page ([/videos/2915699009](https://www.twitch.tv/videos/2915699009)) shows age, title,
    category, views and share. A channel card has Follow and "LIVE with 285 viewers / Watch live",
    with "All videos" below.
  - Clips ([/jonathanong/clips](https://www.twitch.tv/jonathanong/clips)) sort by range ("7d").
- **Recommendation:**
  - Under the player: title, category link, `<RelativeTime>`, views, Share.
  - A compact channel card with Follow and, when live, a `<LiveBadge>` "Watch live" button.
  - Then a "More from \<channel\>" grid (VODs or clips) built from `<StreamCard>`'s VOD variant.
- **Effort:** M. **Impact:** medium-high.

### Polish, states and accessibility

#### F15. Every page has the same document title

- **Surface:** all routes.
- **Evidence:**
  - Channel, VOD, clip, co-op, transparency and signup are all titled "Live streaming, owned by
    the people who make it".
  - Besides the root (`apps/web/src/routes/__root.tsx:33`) and the three overlays, only 4 routes
    set `head()`: `activate`, `oauth2.authorize`, `settings.connections` and
    `settings.preferences`. No studio, admin, co-op or channel route does. Screen-reader users and
    anyone with several tabs open cannot tell the pages apart (WCAG 2.4.2).
- **Twitch:** titles like "LofiGirl - Twitch", "Music - Twitch", "About JonathanOng - Twitch".
- **Recommendation:**
  - Give every route a `head()` with an i18n `pageTitle` key: "\<page\> · \<SITE.name\>".
  - For channel, VOD and clip pages, derive the title from loader data, for example "Aurora Pixel
    (live) · CommonAir".
  - Add a source-policy test that fails when a route has no `head`.
- **Effort:** S. **Impact:** high (accessibility, SEO, sharing).

#### F16. The skip link comes after the header

- **Surface:** the AppShell without a sidebar (every public page).
- **Evidence:** `packages/ui/src/layouts/app-shell.tsx:61-62` renders `{header}` before the skip
  link. The first Tab lands on the logo, then the nav and the theme buttons, and only then on
  "Skip to content".
- **Recommendation:** render `skip` before `header`, as the sidebar branch already does (`:50`).
- **Effort:** S. **Impact:** medium (WCAG 2.4.1).

#### F13. Error and not-found states are bare

- **Surface:** an unknown channel (18) and a missing VOD (19).
- **Evidence:** an icon and one line ("This channel does not exist"), with no explanation and no
  way forward. `ChannelNotFound` passes `<EmptyState>` only a title (`$channel.tsx:161-166`).
- **Twitch:** a friendly sentence and a "Browse channels" button
  ([twitch.tv/this-channel-should-not-exist-xyz123](https://www.twitch.tv/this-channel-should-not-exist-xyz123)).
- **Recommendation:** every not-found and error `<EmptyState>` gets a description and an action:
  "Browse live channels", or "Back to \<channel\>" for a missing VOD. Below the 404, show a
  Live now shelf. Apply the same pattern to the root error boundary.
- **Effort:** S. **Impact:** medium.

#### F14. Theme controls take header space, and a navigation can flash

- **Surface:** the header (02, 15, 21).
- **Evidence:**
  - Three always-visible icon buttons (Dark, Light, System) sit next to Sign up.
  - In light mode, several captures taken right after a navigation show the header still in its
    server-rendered state (Dark selected, nav links and Sign in faded) for a second or more, and
    inputs without borders on `/signup` (21).
  - Computed styles were correct once the page settled.
- **Twitch:** the theme lives in the user menu. The header holds the logo, Browse, search and the
  account controls.
- **Recommendation:**
  - Move the theme switcher into the account menu, and into the mobile Sheet for signed-out
    users.
  - Set the theme class in the server-rendered `<html>` from the cookie, or an inline
    pre-hydration script, and disable color transitions until the app has hydrated.
  - Verify with a throttled-CPU recording.
- **Effort:** S. **Impact:** medium.

#### F17. Signup and sign-in are bare forms

- **Surface:** `/signup` (21) and `/signin` (05).
- **Evidence:**
  - Signup is a single narrow column on a blank page, with a native `mm/dd/yyyy` date input and
    a green "Verified" anti-bot box styled unlike everything else.
  - Sign-in has email and password only, with no "forgot password" link in view.
- **Twitch:** signup and login are a modal over the page the visitor was on, so the context
  stays.
- **Recommendation:**
  - On `lg`, use two columns: the form, plus a short co-op pitch (member-owned, transparent
    books, link to `/transparency`).
  - Use the design system's date field or three `Select`s instead of the native input.
  - Restyle the anti-bot widget container with tokens.
  - Show "Forgot password?" under the password field.
  - Keep full pages (no modal) for accessibility, but return the visitor to where they came
    from.
- **Effort:** S–M. **Impact:** medium.

#### F18. The mobile menu is nearly empty

- **Surface:** the mobile Sheet (23).
- **Evidence:** Browse (which goes home), Co-op, the theme buttons, and Sign up.
- **Recommendation:** once F1 and F7 land, the Sheet holds search, Browse, Following, Live now and
  categories, with theme and language at the bottom.
- **Effort:** S (after F1). **Impact:** medium.

#### F19. The co-op overview has no end

- **Surface:** `/coop` (16).
- **Evidence:** "Recent decisions" renders every decision; the page is 4,169 px tall. The seed's
  repeated titles, such as "(2)" and "(3)", make it look like a bug.
- **Twitch:** no equivalent. The co-op and transparency pages are CommonAir's strongest original
  design: a clear class bar, council list, participation meter and ledger breakdown (16, 17).
- **Recommendation:** show the 5 latest decisions with a "See all decisions" link to
  `/coop/proposals?status=decided`. Make the seed's proposal titles unique.
- **Effort:** S. **Impact:** low-medium.

#### F20. Category live counts read 0 while a channel is live in the category

- **Surface:** the `/api/categories` data that future directory pages will show.
- **Evidence:** "Art" reports `liveChannels: 0` while `demo_streamer1` is live in Art (search
  confirms it).
- **Recommendation:** check how the count is derived (a cache, or the mature filter?) before F1
  builds on it.
- **Effort:** S. **Impact:** medium (F1 depends on it).

### Studio, settings, moderation and admin (from code)

Signed-in screens could not be captured in this pass (see "How it was done"), so these findings
come from reading the route code. Twitch's Creator Dashboard and Stream Manager need a signed-in
account and were not crawled, so the Twitch column below is general product knowledge and should be
checked in D5.

#### F21. The studio dashboard is a settings page, not a control room

- **Surface:** `/dashboard`.
- **Evidence:**
  - A narrow column of stacked cards: label notices, stream health, stream setup, DVR,
    simulcast, the Discord webhook, appearance and federation (`apps/web/src/routes/_studio/dashboard.tsx:39-63`).
  - There is no preview player, live chat, viewer count, activity feed, or title and category
    editor.
  - Stream health lists warning codes without bitrate or fps figures
    (`components/stream-health-card.tsx:96-112`).
  - The header actions (Revenue, Relays, View channel) repeat the sidebar.
- **Twitch:** Stream Manager is a panel grid: a stream preview, chat, an activity feed (follows,
  subs, raids), quick actions, and "Edit stream info" with title, category and tags, plus a
  session summary.
- **Recommendation:**
  - Split the page. `/dashboard` becomes a `wide` grid: a muted preview player, chat, an activity
    feed from the existing events, a title, category and tags editor, live stats with
    `<ViewerCount>`, and health numbers.
  - The setup cards (key, DVR, simulcast, Discord, appearance, federation) move to a "Stream
    settings" page.
- **Effort:** M–L. **Impact:** high for streamers.

#### F22. The studio navigation is one flat list of 15 items

- **Surface:** the studio sidebar.
- **Evidence:** Stream Manager, Rehearse, Overlays, Interact, Bot, Chat, Captions, Content,
  Analytics, Revenue, Crew, Relays, Move, Import and Developer, with no group labels
  (`apps/web/src/lib/nav.ts:229-247`). Admin has the same flat pattern (`routes/_admin.tsx:158-160`).
- **Twitch:** the creator dashboard groups its navigation (Stream Manager, Insights, Community,
  Content, Settings, and so on).
- **Recommendation:** use `SidebarGroup` labels:
  - Stream: Stream manager, Rehearse, Overlays, Captions, Relays.
  - Community: Chat safety, Bot, Interact.
  - Content: Content, Analytics.
  - Money: Revenue, Crew.
  - Tools: Move, Import, Developer.
- **Effort:** S. **Impact:** medium.

#### F23. Studio `/chat` is chat-safety settings, with no moderator view of live chat

- **Surface:** `/chat`.
- **Evidence:** the page renders the verified-watch gate and surge-guard settings
  (`routes/_studio/chat.tsx`, `components/chat-gate/chat-gate-settings.tsx:134-215`). No studio
  page shows live chat with moderation tools. (The 426 on staging is the known `fe6b9923` issue.)
- **Twitch:** a popout chat and a mod view (chat, mod actions, the AutoMod queue, the user list)
  that streamers and mods keep open while live.
- **Recommendation:**
  - Rename the nav item "Chat safety".
  - Add a mod view, `/mod/$channel`, built from `ChatPanel` plus the held-message queue that
    already exists (`components/mod/held-queue.tsx`) and the recent mod actions.
- **Effort:** M. **Impact:** medium-high.

#### F24. Analytics has one chart, for one broadcast

- **Surface:** `/analytics` and `/revenue`.
- **Evidence:**
  - The range summary is stat cards only (`components/analytics/analytics-page.tsx:127-148`).
  - The only chart is per-minute viewers for a single selected broadcast (`:313-350`). Its three
    series are told apart by `--chart-*` colour alone (`:317-319`).
  - Revenue is cards and tables, with no trend (`routes/_studio/revenue.tsx:83-106`).
- **Twitch:** channel analytics charts each metric (average viewers, followers, revenue) over the
  chosen range, with comparison to the previous period.
- **Recommendation:**
  - Add a range `TrendChart` for verified hours watched, peak viewers and followers, and a revenue
    trend with a previous-period delta on each `StatCard`.
  - Give the chart series direct labels or dash patterns, so they don't rely on colour alone
    (the same chart, in `packages/ui`).
- **Effort:** M. **Impact:** medium.

#### F25. Most empty states have no next step

- **Surface:** the studio, co-op and admin.
- **Evidence:**
  - Only 7 of about 85 `<EmptyState>` uses pass an `action`.
  - None of the studio content pages do: the content board (`packages/ui/src/blocks/studio/content-board.tsx:273,300`),
    crew (`components/money/crew.tsx:550`), relays (`components/relays.tsx:92`) and analytics
    (`analytics-page.tsx:89`).
  - Some empties are plain text, not `<EmptyState>`: `components/money/revenue.tsx:400`,
    `components/coop/council.tsx:130,177`, `components/coop/proposal.tsx:328` and
    `components/twitch-import/import-page.tsx:213`.
- **Twitch:** empty creator pages explain the feature and link to the action that fills them, such
  as "Go live", "Create a clip" or "Set up".
- **Recommendation:**
  - Every `<EmptyState>` on a page the owner can fill gets a description and a primary action.
    Examples: "No VODs yet. Go live and your broadcast is saved here", with "Open stream manager";
    and "No relays", with "Add a relay" focusing the form.
  - Convert the plain-text empties to `<EmptyState>`.
  - The `newbie` seed account shows every one of these, so D5 can capture them.
- **Effort:** S–M. **Impact:** medium-high (first-run experience for every new streamer).

#### F26. Page widths and headers differ across studio pages

- **Surface:** the studio.
- **Evidence:**
  - Wide: bot, chat, content, interact, overlays, captions.
  - Narrow: dashboard, rehearse, move, import.
  - Default: analytics, crew, relays, revenue, developer.
  - Rehearse, Move, Import and Analytics render `PageHeader` inside a component, not in the route.
  - The dashboard is the only studio page whose `PageHeader` has no description.
- **Recommendation:**
  - One rule: grids and boards are `wide`, everything else `default`. Forms stay readable with a
    max-width inside the card.
  - The `PageHeader` always lives in the route, always with a description.
  - Add a source-policy test for both.
- **Effort:** S. **Impact:** low-medium (it reads as polish).

#### F27. Settings have no navigation of their own

- **Surface:** `/settings/*`.
- **Evidence:** the seven settings pages are reachable only from the account menu
  (`lib/nav.ts:203-209`), and their widths vary (privacy is narrow, `settings.privacy.tsx:26`).
- **Twitch:** settings use a tab row (Profile, Prime, Security and Privacy, Notifications,
  Connections, and so on).
- **Recommendation:** add a shared settings layout with a `Tabs` row (a `Select` at 375 px) and
  one width.
- **Effort:** S. **Impact:** medium.

#### F28. Small primitive and accessibility slips

- **Surface:** analytics, attestations, co-op and the VOD player.
- **Evidence:**
  - Peak concurrent viewers are formatted with `formatNumber` instead of `<ViewerCount>`
    (`components/analytics/analytics-page.tsx:289`, `components/attestations/panel.tsx:181`).
  - "Loading" appears as plain text without `aria-busy` or a skeleton
    (`components/coop/overview.tsx:191`, `components/vod-watch/vod-player.tsx:237`).
- **Recommendation:** use the house primitives and `<Skeleton*>` with `aria-busy` on the
  container.
- **Effort:** S. **Impact:** low-medium.

## Proposed milestone batches

New ids use a **D** (design) prefix, which is not taken in
[.claude/briefs/next/README.md](../../.claude/briefs/next/README.md). Each batch would get a brief
under `.claude/briefs/d/` and a row in that table. It would also be added to PLAN.md's
"After rc.1" list ([PLAN.md:121-129](../../PLAN.md)) as "D1–D5 (design review 2026-11)". D4 can
start at once. D1 and D2 are independent of each other. D3 needs D2's tabs.

| Id  | Name                      | Findings                                                                           | Effort | Gated on                                                                             | Done when                                                                                                                                                                                                                                                                          |
| --- | ------------------------- | ---------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Discovery                 | F1, F7, F8, F10, F18, F20                                                          | L      | the F20 count check; the "following" API gap (HANDOFF.md:356) for the signed-in rail | `/directory`, `/directory/$category` and `/search` render seeded data; the header has search and ⌘K; the left rail shows live channels; the home page has a hero, no duplicate shelves, a categories shelf and recent tiles with thumbnails; the seed has avatars and category art |
| D2  | Channel and player        | F2, F3, F4, F5, F6, F9, F12 (plus B8-web's panels and banner, if B8 hasn't landed) | L      | none (web only on existing contracts)                                                | channel tabs (Home, Videos, Clips, About); an offline page with VODs; one player control bar with fullscreen, theatre, PiP, a settings menu and shortcuts; Data saver in that menu; chat full-height with collapsible cards; live metadata row; 320 px story for `ChannelHeader`   |
| D3  | Watch pages               | F11                                                                                | M      | D2's VOD and clip grid                                                               | the VOD and clip pages show metadata, share, a channel card with Watch live, and a "more from" grid                                                                                                                                                                                |
| D4  | Polish and accessibility  | F13, F14, F15, F16, F17, F19                                                       | S–M    | none                                                                                 | every route sets a title (enforced by test); the skip link comes first; every error state has an action; theme in the account menu with no flash; signup two-column with a design-system date field; co-op decisions capped                                                        |
| D5  | Signed-in pass and studio | F21–F28, plus the signed-in visual checks still open in PROGRESS.md                | M      | a reviewer signed in as each seeded role                                             | screenshots of every studio, settings, moderation and admin page in both themes at 375 and 1440 px; studio findings fixed; the open visual-check sign-offs recorded in PROGRESS.md                                                                                                 |

## Twitch pages consulted

All were read signed out on 2026-11-03. No assets were copied.

- [twitch.tv](https://www.twitch.tv/): the hero carousel, the left rail, category and per-category
  shelves.
- [twitch.tv/directory](https://www.twitch.tv/directory): the category grid, tag filter, sort,
  and Games, IRL, Music and Creative pills.
- [twitch.tv/directory/category/music](https://www.twitch.tv/directory/category/music): the
  category header, Live, Upcoming, Videos and Clips tabs, filters.
- [twitch.tv/lofigirl](https://www.twitch.tv/lofigirl): the live channel; the metadata row, About,
  panels and full-height chat.
- [twitch.tv/jonathanong/videos](https://www.twitch.tv/jonathanong/videos),
  [/about](https://www.twitch.tv/jonathanong/about) and
  [/clips](https://www.twitch.tv/jonathanong/clips): profile tabs, About and the clip range filter.
- [twitch.tv/videos/2915699009](https://www.twitch.tv/videos/2915699009): VOD metadata, the
  channel card, the control bar and chat on videos.
- [twitch.tv/search?term=lofi](https://www.twitch.tv/search?term=lofi): grouped search results.
- [twitch.tv/this-channel-should-not-exist-xyz123](https://www.twitch.tv/this-channel-should-not-exist-xyz123):
  the not-found state.

## Screenshot index

| File                                       | What                                          |
| ------------------------------------------ | --------------------------------------------- |
| 01-home-cookie-banner.jpg                  | first visit, storage banner                   |
| 02-home-desktop.jpg                        | home, 1440 px, dark                           |
| 03-channel-live-streamer1.jpg              | live channel, prediction and giveaway in chat |
| 04-channel-live-streamer1-scrolled.jpg     | the same, scrolled: one chat line visible     |
| 05-signin.jpg                              | sign-in                                       |
| 06-channel-live-streamer2.jpg              | live channel with a prediction                |
| 07-live-player-hover.png                   | live player on hover, no control bar captured |
| 08-channel-streamer3-18plus-gate.jpg       | 18+ gate, signed out                          |
| 09-home-recently-live.jpg                  | Recently live: text-only tiles                |
| 10-channel-offline-no-vods.jpg             | offline channel: nothing below the player     |
| 11-vod-page.jpg                            | VOD page                                      |
| 12-vod-player-controls.jpg                 | VOD control bar and chat replay               |
| 13-mobile-channel-live-header-collapse.jpg | 375 px channel header collapse (light)        |
| 14-channel-live-light.jpg                  | live channel, light theme                     |
| 15-home-light-header.png                   | light header once settled                     |
| 16-coop-overview-light.jpg                 | co-op overview                                |
| 17-transparency-light.jpg                  | transparency                                  |
| 18-error-channel-not-found.jpg             | unknown channel                               |
| 19-error-vod-not-available.jpg             | missing VOD                                   |
| 20-clip-page.jpg                           | clip page                                     |
| 21-signup-light.png                        | signup                                        |
| 22-mobile-home-light.jpg                   | home at 375 px                                |
| 23-mobile-menu-light.jpg                   | mobile menu Sheet                             |
| 24-mobile-channel-live-dark.jpg            | 375 px channel header collapse (dark)         |

## Addendum: signed-in pass

**How it was done.** On 2026-11-03 the user signed in on staging (`staging-stream.abolish.us`,
`v0.1.0-rc.9`, medium-scale seed, `seed live` running so streamer1–3 were live) in a headed
Chromium, one role at a time, and a script captured each page in both themes at 1440×900 and
375×812, full page up to three viewports tall, after dismissing the cookie banner with "Essential
only". Roles: `demo_streamer1` (a streamer with data) and `newbie` (empty everywhere) for the 15
studio pages; `viewer1` for `/settings/*` and `/coop/membership`; `viewer2` (seeded appeals and
copyright data) for those two pages; `mod` for `/admin/moderation`, `/admin/appeals` and
`/coop/jury`; `admin` for every `/admin/*` page and `/treasury`. The 216 JPEGs are in
[`2026-11-review/signed-in/`](2026-11-review/signed-in/), named
`NNN-<role>-<page>-<theme>-<width>.jpg`. Below, a reference such as `001 d1440` means
`001-…-dark-1440.jpg` (`l` is light, `375` is the phone width). This pass reviewed the dark 1440
shot of every page and the 375 and light shots where layout or contrast was in question.

**Unusable shots** (the page did not render; none shows the sign-in page):

- `/chat`, all eight ([006](2026-11-review/signed-in/006-streamer1-chat-dark-1440.jpg),
  [021](2026-11-review/signed-in/021-newbie-chat-dark-1440.jpg)): the raw JSON
  `{"error":"websocket_required"}`. This is the known 426 (`fe6b9923`, not released on rc.9), so
  the studio chat page and the held queue were not captured.
- `/admin/legal` and `/treasury`, all eight
  ([046](2026-11-review/signed-in/046-admin-admin-legal-dark-1440.jpg),
  [054](2026-11-review/signed-in/054-admin-treasury-dark-1440.jpg)): "Page not found". Not a bug:
  the legal queue is for the `legal` role only and the treasury for treasurers only
  (`routes/_admin/admin.legal.tsx:15`, `routes/_admin/treasury.tsx`). Recapture as
  `demo_treasurer` and `demo_legal` (both seeded fixed accounts).
- [035 d375](2026-11-review/signed-in/035-viewer1-settings-notifications-dark-375.jpg): "Your
  notification settings could not be loaded" (the 429). The other three notifications shots are
  fine.
- [019 d375](2026-11-review/signed-in/019-newbie-interact-dark-375.jpg): "This page could not be
  loaded" (the 429). The other three are fine.

**Capture artifact, not a finding:** on full-page shots the studio and admin sidebars stop after
the first viewport (for example [001 d1440](2026-11-review/signed-in/001-streamer1-dashboard-dark-1440.jpg)),
because the sidebar is fixed to the viewport.

### F21–F28 against the screenshots

| Finding                               | Verdict              | Evidence and notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F21 dashboard is a settings page      | confirmed            | [001 d1440](2026-11-review/signed-in/001-streamer1-dashboard-dark-1440.jpg): streamer1 is live, yet the page is a narrow column of stream health, setup, rewind, simulcast, Discord, appearance and fediverse cards. No preview, chat, viewer count or title editor. Health says "No problems detected" with no bitrate or fps. Revenue, Relays and View your channel repeat the sidebar. The 375 header is worse (F29).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| F22 flat studio navigation            | confirmed            | Every studio shot, for example [008 d1440](2026-11-review/signed-in/008-streamer1-content-dark-1440.jpg): 15 items, no group labels. The labels have changed since the code read ("Alerts & overlays", "Polls & raids", "Channel bot", "Chat safety", "Videos & clips", "Move channel", "Import from Twitch"). Admin is flat too, nine items ([044 d1440](2026-11-review/signed-in/044-admin-admin-moderation-dark-1440.jpg)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| F23 `/chat` is settings, no mod view  | not reproduced       | The page did not render on staging (the known 426; [006](2026-11-review/signed-in/006-streamer1-chat-dark-1440.jpg)). The rename half is done: the sidebar already says "Chat safety". The mod-view half still stands from code; recapture after the next release.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| F24 one chart, for one broadcast      | confirmed            | [009 d1440](2026-11-review/signed-in/009-streamer1-analytics-dark-1440.jpg): the period is four stat cards; the only chart is one broadcast's audience, and its three series differ only by colour (also in light, [009 l1440](2026-11-review/signed-in/009-streamer1-analytics-light-1440.jpg)). The y axis has fractional viewer ticks (0.25, 0.5, 0.75). Revenue ([010 d1440](2026-11-review/signed-in/010-streamer1-revenue-dark-1440.jpg)) has a by-source bar, but no trend.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| F25 empty states without a next step  | confirmed            | newbie: Videos & clips ([023](2026-11-review/signed-in/023-newbie-content-dark-1440.jpg)) says "Turn on recording" with no link; Analytics ([024](2026-11-review/signed-in/024-newbie-analytics-dark-1440.jpg)), the revenue ledger ([025](2026-11-review/signed-in/025-newbie-revenue-dark-1440.jpg)), Crew ([026](2026-11-review/signed-in/026-newbie-crew-dark-1440.jpg)) and Relays ([027](2026-11-review/signed-in/027-newbie-relays-dark-1440.jpg)) have no action. Import shows "No panels yet" as plain text ([014](2026-11-review/signed-in/014-streamer1-import-dark-1440.jpg)). The empties say what to do in words ("Propose one above", "Add a target below"), but none offers the button.                                                                                                                                                                                                                               |
| F26 widths and headers differ         | confirmed            | Three left edges: wide pages start at 272 px (overlays, interact, bot, captions, content: [003](2026-11-review/signed-in/003-streamer1-overlays-dark-1440.jpg), [008](2026-11-review/signed-in/008-streamer1-content-dark-1440.jpg)); default pages at 288 px (analytics, revenue, crew, relays, developer: [011](2026-11-review/signed-in/011-streamer1-crew-dark-1440.jpg)); narrow pages are centred at 480 px (rehearse, move, import, dashboard: [002](2026-11-review/signed-in/002-streamer1-rehearse-dark-1440.jpg), [013](2026-11-review/signed-in/013-streamer1-move-dark-1440.jpg)). Admin repeats it (272 for moderation, egress and co-op; 288 for DMCA, integrity, incidents; centred for federation). The dashboard header has no description. Page titles also differ from their nav labels: "Creator dashboard" / Stream manager, "Rehearse" / Rehearsal, "Your relays" / Relays, "Move your channel" / Move channel. |
| F27 settings have no navigation       | worse than described | No settings navigation on any of the seven pages, and three different widths: privacy and preferences are narrow ([031](2026-11-review/signed-in/031-viewer1-settings-privacy-dark-1440.jpg), [033](2026-11-review/signed-in/033-viewer1-settings-preferences-dark-1440.jpg)); connections, subscriptions, notifications, appeals and copyright start at 160 px ([032](2026-11-review/signed-in/032-viewer1-settings-connections-dark-1440.jpg)); `/coop/membership` starts at 96 px ([038](2026-11-review/signed-in/038-viewer1-coop-membership-dark-1440.jpg)). Privacy says "Download your data or delete your account", but a list of 100+ follow toggles pushes the delete control below three viewports (F37).                                                                                                                                                                                                                  |
| F28 primitive and accessibility slips | not reproduced       | Not visible in settled screenshots: the loading text appears only before data arrives, and "Peak verified viewers 1" ([009](2026-11-review/signed-in/009-streamer1-analytics-dark-1440.jpg)) looks the same whether it comes from `formatNumber` or `<ViewerCount>`. The code finding stands.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### New findings

#### F29. The dashboard title breaks mid-word at 375 px

- **Surface:** `/dashboard` at 375 px.
- **Evidence:** "Creator dashboard" wraps into "Cre / ator / das / hbo / ard" because the three header
  actions keep their width beside it ([001 d375](2026-11-review/signed-in/001-streamer1-dashboard-dark-375.jpg),
  [001 l375](2026-11-review/signed-in/001-streamer1-dashboard-light-375.jpg),
  [016 d375](2026-11-review/signed-in/016-newbie-dashboard-dark-375.jpg)).
- **Recommendation:** `PageHeader` stacks its actions under the title below `sm`, and the title never
  breaks inside a word. Drop the actions that repeat the sidebar (F21).
- **Effort:** S. **Impact:** high (the first studio page on a phone).

#### F30. The co-op tab row always highlights Overview

- **Surface:** the co-op pages.
- **Evidence:** on `/coop/membership` ([038 d1440](2026-11-review/signed-in/038-viewer1-coop-membership-dark-1440.jpg))
  and `/coop/jury` ([043 d1440](2026-11-review/signed-in/043-mod-coop-jury-dark-1440.jpg)) the
  selected tab is Overview. PROGRESS records this as fixed by an exact link match (`4df5d9b`), so
  this is a regression or the fix missed these pages.
- **Recommendation:** match the active tab on the route, and add a test that each `/coop/*` page
  selects its own tab.
- **Effort:** S. **Impact:** medium.

#### F31. Tab rows and wide tables clip at 375 px with no cue

- **Surface:** tab rows and tables on phones.
- **Evidence:**
  - The co-op tabs end at "Jury Se…" ([038 l375](2026-11-review/signed-in/038-viewer1-coop-membership-light-375.jpg)),
    and the moderation tabs at "Takedown" ([044 d375](2026-11-review/signed-in/044-admin-admin-moderation-dark-375.jpg)).
  - The revenue ledger shows Date, Type and part of Detail; gross, deductions, net and
    Breakdown are off screen ([010 d375](2026-11-review/signed-in/010-streamer1-revenue-dark-375.jpg)).
  - The bot's commands table hides uses, status and the edit and delete actions
    ([005 d375](2026-11-review/signed-in/005-streamer1-bot-dark-375.jpg)).
- **Recommendation:** tab rows become a `Select` (or scroll with an edge fade) below `sm`. Tables
  whose key columns are money or actions render as stacked rows at 375 px, with the amount and
  actions on each row.
- **Effort:** M. **Impact:** medium-high.

#### F32. Validation errors show before the user has done anything

- **Surface:** `/revenue`, subscription tiers.
- **Evidence:** for `newbie` the three tier name fields are red with "Give this tier a name" on
  first load ([025 d1440](2026-11-review/signed-in/025-newbie-revenue-dark-1440.jpg)).
- **Recommendation:** show field errors after blur or submit, not on mount.
- **Effort:** S. **Impact:** medium (a new streamer's first look at revenue reads as an error).

#### F33. Browser date-time inputs instead of the design-system field

- **Surface:** `/crew` and `/admin/egress`.
- **Evidence:** native `datetime-local` controls ("mm/dd/yyyy, --:-- --") with the browser's
  calendar icon ([011 d1440](2026-11-review/signed-in/011-streamer1-crew-dark-1440.jpg),
  [049 d1440](2026-11-review/signed-in/049-admin-admin-egress-dark-1440.jpg)). D4 replaced the same
  control on signup.
- **Recommendation:** use the date field D4 built, plus a time field, with the UTC note kept on
  egress.
- **Effort:** S. **Impact:** low-medium.

#### F34. Raw keys and codes in admin pages

- **Surface:** `/admin/integrity` and `/admin/egress`.
- **Evidence:**
  - An integrity flag shows its code `relay_issuance_unknown` as its title and lists raw keys
    `receiptId`, `tolerance`, `gapMinutes`, `bytesIssued`, `bytesReported`, `bytesVerified`
    ([048 d1440](2026-11-review/signed-in/048-admin-admin-integrity-dark-1440.jpg)).
  - Egress prints "0 byte" ([049 d1440](2026-11-review/signed-in/049-admin-admin-egress-dark-1440.jpg)).
- **Recommendation:** catalogue a label and description for each flag code and detail key (with the
  raw code shown small for search). Format sizes with the shared byte formatter ("0 B").
- **Effort:** S. **Impact:** medium (these strings bypass `t()`).

#### F35. Body text jumps between two sizes inside the same card

- **Surface:** the studio and settings, and the footer.
- **Evidence:**
  - Some notes render at the base size among `text-sm` help text: the three rewind notes and
    "Not set up." on the dashboard ([001 d1440](2026-11-review/signed-in/001-streamer1-dashboard-dark-1440.jpg));
    the stream key line on rehearse ([002](2026-11-review/signed-in/002-streamer1-rehearse-dark-1440.jpg));
    the subscriptions note on move ([013](2026-11-review/signed-in/013-streamer1-move-dark-1440.jpg));
    the raid protection note ([004](2026-11-review/signed-in/004-streamer1-interact-dark-1440.jpg));
    "What it means" on crew ([011](2026-11-review/signed-in/011-streamer1-crew-dark-1440.jpg)); the
    strike note on copyright ([040](2026-11-review/signed-in/040-viewer2-settings-copyright-dark-1440.jpg)).
  - On captions the draft-privacy note sits loose between two cards, outside both
    ([007 d1440](2026-11-review/signed-in/007-streamer1-captions-dark-1440.jpg)).
  - In the footer, the links are larger than "Cookie settings" and the language button beside
    them (every page).
- **Recommendation:** one paragraph style inside cards (`text-sm text-muted-foreground` for notes,
  or a `Callout` for the important ones), and one footer link size.
- **Effort:** S. **Impact:** medium (it is visible on almost every page).

#### F36. Lists that grow without limit

- **Surface:** privacy, notifications, captions, admin apps and the appeals queue.
- **Evidence:**
  - Privacy's "Tell me if they move" and Notifications' "Channels you follow" list every followed
    channel with a control each, 100+ rows with no search or bulk action
    ([031](2026-11-review/signed-in/031-viewer1-settings-privacy-dark-1440.jpg),
    [035](2026-11-review/signed-in/035-viewer1-settings-notifications-dark-1440.jpg)).
  - Captions renders every cue of a VOD as an input ([007](2026-11-review/signed-in/007-streamer1-captions-dark-1440.jpg)).
  - OAuth apps and the appeals queue render every item fully expanded, each appeal with its own
    textarea ([052](2026-11-review/signed-in/052-admin-admin-apps-dark-1440.jpg),
    [042](2026-11-review/signed-in/042-mod-admin-appeals-dark-1440.jpg)).
- **Recommendation:** a search field and paging (the house "Load more") on the two settings lists,
  with "all on / all off" for move notices; captions paged by time with a search; queue items
  collapsed to a row that opens a detail panel.
- **Effort:** M. **Impact:** medium.

#### F37. Account deletion is out of sight

- **Surface:** `/settings/privacy`.
- **Evidence:** the page title promises "Download your data or delete your account", but after the
  follow-notice list the delete control is not within three viewports at either width
  ([031 d1440](2026-11-review/signed-in/031-viewer1-settings-privacy-dark-1440.jpg),
  [031 d375](2026-11-review/signed-in/031-viewer1-settings-privacy-dark-375.jpg)).
- **Recommendation:** with F27's settings layout, put account deletion in its own section near the
  top of privacy or on an "Account" page, and move "Tell me if they move" to notifications.
- **Effort:** S. **Impact:** medium (a legal right should be easy to find).

#### F38. People appear under two names

- **Surface:** settings and admin.
- **Evidence:** Subscriptions lists channels by username with a "D" avatar on every row
  (demo_streamer1, demo_council2), while the payments table on the same page uses display names
  (Aurora Pixel, Lumen Beats) ([034 d1440](2026-11-review/signed-in/034-viewer1-settings-subscriptions-dark-1440.jpg)).
  The dashboard's avatar preview shows "A" while the header avatar shows "D"
  ([001 d1440](2026-11-review/signed-in/001-streamer1-dashboard-dark-1440.jpg)).
- **Recommendation:** show the display name with `@username` secondary, and take `<ChannelAvatar>`'s
  initial from the display name everywhere.
- **Effort:** S. **Impact:** low-medium.

#### F39. Small copy and layout slips

- **Surface:** several pages.
- **Evidence:**
  - "Your material is restored after in 2 weeks" ([040](2026-11-review/signed-in/040-viewer2-settings-copyright-dark-1440.jpg)).
  - An ended suspension still reads "Account suspended … Until 17 hours ago"
    ([039](2026-11-review/signed-in/039-viewer2-settings-appeals-dark-1440.jpg)).
  - The jury page tells staff to use "the switch above", which they do not have
    ([043](2026-11-review/signed-in/043-mod-coop-jury-dark-1440.jpg)).
  - OAuth apps' "Suspended only" label sits about 450 px from its switch
    ([052](2026-11-review/signed-in/052-admin-admin-apps-dark-1440.jpg)).
  - Relays: "Add a relay" runs into the "Relay name" label, and the three setup steps are boxes
    with no numbers ([012](2026-11-review/signed-in/012-streamer1-relays-dark-1440.jpg)).
  - Egress' Show button stretches over a whole column ([049](2026-11-review/signed-in/049-admin-admin-egress-dark-1440.jpg)).
  - Notifications: each channel's bell switch has no visible label and sits below the name line
    ([035](2026-11-review/signed-in/035-viewer1-settings-notifications-dark-1440.jpg)).
  - Viewer appeals: the third empty state has no section heading
    ([036](2026-11-review/signed-in/036-viewer1-settings-appeals-dark-1440.jpg)).
- **Recommendation:** fix each in place. The copyright string needs a catalogue fix with a test on
  its interpolation.
- **Effort:** S. **Impact:** low.

### Open PROGRESS.md sign-offs

The screenshots are in English only, at 375 px rather than 320 px, with no keyboard pass. None of
these sign-offs closes in full; the table says what each still needs.

| Sign-off               | Asks for                                                                                                                            | Covered by                                                                                                                                                                                                                                                                                    | Still needed                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| W2 (`PROGRESS.md:369`) | browser, visual and `en-XA` checks of the wave-2 pages (attestations panel, group appeals, VOD and clip watch, the verify page)     | the attestations panel and "Left out of your counts" on `/analytics`: [009](2026-11-review/signed-in/009-streamer1-analytics-dark-1440.jpg), [009 l1440](2026-11-review/signed-in/009-streamer1-analytics-light-1440.jpg), [024](2026-11-review/signed-in/024-newbie-analytics-dark-1440.jpg) | a broadcast with exclusions (the appeal dialog), VOD and clip watch pages, `/attestations/verify`, `en-XA`                              |
| W2 (`:386-387`)        | visual, `es` and `en-XA` checks of the W2 pages                                                                                     | English visuals of rehearse (002, 017), captions (007, 022) and analytics (009, 024), both themes, both widths                                                                                                                                                                                | `es` and `en-XA`                                                                                                                        |
| N2 (`:430-431`)        | visual checks under `es` and `en-XA`, a fluent read of the Spanish                                                                  | not covered (English only)                                                                                                                                                                                                                                                                    | everything                                                                                                                              |
| E6 (`:1603-1606`)      | browser checks of `/dashboard` simulcast, `/overlays`, `/content`, `/settings/privacy`, `/overlay/alerts`; both themes, 320 px, OBS | `/dashboard` simulcast (001, 016), `/overlays` (003, 018), `/content` (008, 023), `/settings/privacy` (031), each in both themes at 1440 and 375                                                                                                                                              | `/overlay/alerts?token=…` and the OBS browser source, 320 px, Storybook                                                                 |
| E5 (`:1673-1675`)      | `/coop/*`, `/treasury` shares and patronage tabs, `/admin/coop`, `/transparency`; both themes, 320 px, keyboard                     | `/coop/membership` (038), `/coop/jury` (043), `/admin/coop` (053)                                                                                                                                                                                                                             | the other `/coop/*` tabs, `/treasury` (054 is not-found as `admin`; use `demo_treasurer`), `/transparency`, 320 px, keyboard, Storybook |
| E4b (`:1737`)          | the money pages in both themes and on mobile                                                                                        | `/revenue` (010, 025), `/crew` (011, 026), `/settings/subscriptions` (034)                                                                                                                                                                                                                    | the channel Support page and gift controls, `/treasury`, 320 px                                                                         |
| E4a (`:1817`)          | browser checks of the design-system migration                                                                                       | every usable shot above (studio, settings, moderation, admin; both themes, both widths)                                                                                                                                                                                                       | Storybook, and the gate                                                                                                                 |
