<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Watch experience: investigation report (watch)

Scope: `/_app/$channel` (live, offline, 18+), `$channel_.vods.$vodId`, `$channel_.clips.$clipId`,
`$channel_.giveaways.$giveawayId`, `embed.$channel`, `apps/web/src/player`, `apps/web/src/chat`.
Walked signed out on staging 2026-11-06 at 1440x900, 768x1024, 375x812 (dark; the light emulation
did not take, see WX-20). Channels: demo_streamer1 (Aurora Pixel, live, Art), demo_streamer2 (Lumen
Beats, live, Music), demo_streamer3 (Cedar Codes, live, 18+), demo_council1 (Sly Kettle, offline, no
VODs). No state changed: I only opened local menus (pinned strip, player settings).

Caveat: nine of us share one IP. From mid-session on, staging answered 429 to my API calls and
twice rendered a channel page as HTTP 500. That is itself a finding (WX-3), but some blank
thumbnails and one failed chat replay I saw are 429 side effects, not layout bugs.

## 1. What exists now

Most of the prior review's channel findings (F2–F6, F9, F11, F12) have landed. This is a far better
page than on 2026-11-03.

- **Live channel, 1440.** Player > ChannelHeader (avatar ring, name, LIVE, title, category link,
  tag chips, eye + "15" (sr "15 verified viewers"), uptime, followers; Follow, Support, Share,
  Report) > Tabs Home/Videos/Clips/About (`?tab=`). Home live = "Recent videos" and "Recent clips"
  shelves with View all. Chat column on the right (`lg:w-80`) with a goal strip ("Follower party
  81/100 +2"), which expands to Goal, Prediction ("Betting is closed…", bars with points and viewer
  counts, "Sign in to take part in predictions.") and Giveaway (prize, entries, "No purchase
  necessary…"). Composer row signed out: "Sign in to chat. [Sign in]" + the replay disclosure. Left
  rail "Live now".
- **Player.** Unified bar: mute + volume, play/pause, DVR, captions, caption style (Aa); right side
  settings, PiP, theatre (T), fullscreen (F). Settings = Quality (hidden when only one rendition,
  which is the case on staging), Data saver with budget radios, Keyboard shortcuts dialog. A
  coachmark "Quality and Data saver moved" sits over the player for every first-time visitor.
  Theatre keeps player and chat mounted.
- **Offline, no VODs (demo_council1).** Full 16:9 empty box "Sly Kettle is offline", header with
  "Offline" pill, "Last live 1 hour ago · Strategy Games", Follow/Support/Share/Report. Home = About
  card then "Channel info" panels (About me, Schedule, Chat rules). Chat column says "Chat is quiet
  until Sly Kettle goes live · Last message 1 hour ago" and still shows the composer row.
- **18+ (demo_streamer3).** Player replaced by "This stream is for adults (18+)… Sign in" (Sign in
  only); chat "Chat is behind the 18+ check. Confirm on the player…". The header and shelves still
  render; the VOD tiles show a film-icon placeholder (good, thumbnails withheld).
- **VOD page.** Player with time "0:02 / 29:29", speed, captions; title, category, "1 hour ago",
  length, Share popover (link + "Start at" checkbox); channel card with LIVE + viewers + "Watch
  live" + Follow; Chat replay column; "More from" grid (vanished under 429, WX-3).
- **Clip page.** Same layout, "0 views", "Clipped by Quill & Ink", Share copies at once, chat replay
  of the clip window, "More from Aurora Pixel".
- **Giveaway verify page** (code only; the API was rate-limited): PageHeader with the title and
  "…{channelSlug}…", commitment, seed, winners, entries, in-browser re-draw with match/mismatch
  Alert. No channel card or link back.
- **Embed.** Player only, letterboxed in `min-h-dvh`, same control bar, no channel identity or link
  out. `frame-ancestors *` on `/embed/*`.
- **Mobile 375.** Player > header (Follow, Support, Share, "...") > tabs > full-width clip tiles >
  Chat at the very bottom (~1000 px down). Tablet 768 is the same single column.

## 2. Findings

| ID    | Problem                                                                                                                                                                                                                                                                                             | Evidence                                                                                                                                                                                         | Sev  |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- |
| WX-1  | **Chat is below the fold on phones and tablets.** Under `lg` the column order is player, header, tabs, shelves, then chat. A phone viewer of a live stream sees no chat without scrolling past every tile, and the player scrolls away while they read it.                                          | 375x812 and 768x1024, /demo_streamer2; `$channel.tsx` returns `flex-col lg:flex-row` with `<aside>` last                                                                                         | high |
| WX-2  | **Signed-out conversion points all dead-end at bare `/signin`.** Follow, Support, the chat composer, prediction/poll/giveaway cards and the 18+ gate link to `/signin` without a redirect, and none offers Create account. The prediction card's "Sign in to take part" is plain text.              | `chat-panel.tsx:652`, `support-dialog.tsx:104`, `channel-follow.tsx:62`, `mature-gate.tsx:121`; i18n `chat.signInPrompt`, `chatPrediction.signIn`, `giveaways.card.signIn` (with growth-funnels) | high |
| WX-3  | **Rate-limited loads fail loudly or silently.** Under 429, SSR renders "Something went wrong" with HTTP 500; VOD chat replay shows "could not be loaded"; `WatchMore` returns `null` on error so "More from" vanishes. Viewers behind one NAT (schools, offices, events) will hit this.             | /demo_streamer2 at 375 returned 500; console 429s; `watch-more.tsx:61`                                                                                                                           | high |
| WX-4  | **Viewers cannot make clips.** `clips.create` (POST /channels/{channel}/clips, 5–60 s, live or VOD range) exists in the contract, but nothing in `apps/web/src` calls it. Clips are the main way content leaves a stream, and every seeded clip shows "0 views".                                    | `packages/contracts/src/api/router.ts:1010`; grep finds no caller                                                                                                                                | high |
| WX-5  | **Offline with no VOD is a large empty box.** The 16:9 "is offline" EmptyState takes the whole fold, and Follow is a small outline button in the header. There is no next stream (no schedule entity), no live alternatives in main, no clips shelf.                                                | /demo_council1 1440                                                                                                                                                                              | high |
| WX-6  | **The live Home tab hides the channel.** While live with VODs, About and panels move to the About tab, so a first-time viewer never sees bio, rules or links without clicking. The page ends after two shelves with no "more live" exit.                                                            | /demo_streamer1 1440 scrolled                                                                                                                                                                    | med  |
| WX-7  | **The chat column is mostly empty or mostly cards.** With "No messages yet" and 15 viewers, the column is a blank 700 px. Expanded, the strip (goal + prediction + giveaway) leaves room for one message. There is no welcome card, rules or "first message" prompt.                                | /demo_streamer1 1440, strip expanded                                                                                                                                                             | med  |
| WX-8  | **The "Quality and Data saver moved" coachmark shows to everyone.** It explains a move no viewer witnessed (no existing deployments) and covers much of the player at 320. Data saver Off still shows a selected budget radio, which reads as active.                                               | /demo_streamer1 1440, settings menu                                                                                                                                                              | med  |
| WX-9  | **Sharing is copy-link only.** No Web Share sheet on mobile (`navigator.share` is a browser API, not third-party), no embed code though `/embed` is frameable by anyone, and no share on the clip creation moment. The channel's Share and the VOD's Share are different components and placements. | `watch-meta.tsx:52`, `channel-meta.tsx` ShareButton                                                                                                                                              | med  |
| WX-10 | **The embed has no identity and no way home.** No channel name, LIVE count or "Watch on CommonAir" link, and offline it shows a bare "is offline". It is a free acquisition surface we don't use.                                                                                                   | /embed/demo_streamer1                                                                                                                                                                            | med  |
| WX-11 | **Clip pages lack the "watch the full moment" link.** A clip carries `windowStartedAt` but no link to the source VOD at that time. The 8 s clip also gets a full-height chat replay column that is mostly empty, and the clip doesn't loop or advance.                                              | clip page 1440                                                                                                                                                                                   | med  |
| WX-12 | **The giveaway verify page is an island.** No channel card, no link back, no "Watch live" or Follow, and it uses the slug in the intro instead of the display name. It is the page winners and doubters share.                                                                                      | `giveaways/verify-page.tsx:112`                                                                                                                                                                  | med  |
| WX-13 | **18+ gate: one path, and contradictory chat copy.** Signed out: only "Sign in"; chat says "Confirm on the player", which a signed-out viewer can't do; there is no "watch something else" exit. The header shows no mature marker before the gate.                                                 | /demo_streamer3 1440                                                                                                                                                                             | med  |
| WX-14 | **There is no structured schedule.** "Schedule" is a free-text panel, so nothing can show "Next stream Fri 19:00", add to calendar or drive the go-live notification.                                                                                                                               | `components/channel/panels.tsx:6`, contracts grep                                                                                                                                                | med  |
| WX-15 | **Panels show markdown as literal text.** The seeded "About me" shows `**cozy**`. Panels are plain text by design (safe), but creators will paste markdown. Also, the seed puts pixel-art copy on a strategy channel.                                                                               | /demo_council1 panels                                                                                                                                                                            | low  |
| WX-16 | **"Loading stream…" on a black box.** The live thumbnail exists (`broadcast.thumbnailUrl`) but is not used as a poster, so the jump from a home card to the channel loses continuity.                                                                                                               | /demo_streamer1 first paint                                                                                                                                                                      | low  |
| WX-17 | **No quality chip and no quality choice on staging.** With one rendition, Quality is hidden, so staging can't show the menu. The bar has no "720p / Auto" chip.                                                                                                                                     | `controls.tsx:209`                                                                                                                                                                               | low  |
| WX-18 | **"0 views" on every clip** is anti-social-proof.                                                                                                                                                                                                                                                   | clip tiles, clip page                                                                                                                                                                            | low  |
| WX-19 | **Mobile tab row shows a stray grey right edge.**                                                                                                                                                                                                                                                   | 375, also seen by responsive-a11y                                                                                                                                                                | low  |
| WX-20 | **The page did not follow `prefers-color-scheme: light`.** It stayed dark in emulation, likely because of a stored theme choice in the shared browser. I could not verify the light theme of the watch pages; check that separately.                                                                | 768 light emulation                                                                                                                                                                              | low  |
| WX-21 | **VOD expiry is invisible.** The API returns `expiresAt` (14 days), but the page doesn't say "Available until Nov 20", which would drive watch-now and clip-it urgency.                                                                                                                             | /api/channels/…/vods                                                                                                                                                                             | low  |

## 3. Proposals

### P1. Mobile and tablet watch layout (fixes WX-1, WX-19). M, very high impact

Below `lg`, live:

```
[ site header: scrolls away on watch routes (no sticky, no bottom nav) ]
┌──────────────── player 16:9, position: sticky; top: 0 ───────────────┐
└───────────────────────────────────────────────────────────────────────┘
[ (avatar) Lumen Beats ● LIVE  👁 8     [Follow]  (…) ]   one 48 px row
[  Chat  |  About this stream  ]                           Tabs (tablist)
┌ panel ───────────────────────────────────────────────────────────────┐
│ Chat (default when live): pinned strip (1 line) + log (role=log)      │
│ About: title, category, tags, uptime, Support, Share, then Home/      │
│ Videos/Clips/About sub-sections as today                               │
├───────────────────────────────────────────────────────────────────────┤
│ composer pinned bottom, keyboard-safe (visualViewport)                │
└───────────────────────────────────────────────────────────────────────┘
```

- Offline: the segmented control defaults to About; Chat shows the quiet state.
- With the composer focused, the compact row and the segmented control hide; the player stays.
- Landscape phone: the player fills the screen, with a chat overlay toggle.
- Rules agreed with responsive-a11y: Tabs semantics with arrow keys and no focus steal; the log
  gets "N new messages" when scrolled up (no auto-scroll); at 320 the name truncates, Follow stays
  44 px, and Share and Support move to the overflow; slider hit areas ≥24 px; the tab row gets a
  scroll-fade mask; no motion on panel swap.
- Components: `Tabs`, `DropdownMenu` (overflow), `ChannelAvatar`, `LiveBadge`, `ViewerCount`. New:
  `WatchLayout` (shared by channel, VOD and clip) that owns the sticky stage and the panel swap.
- Data: none new.

### P2. Signed-out conversion placement (WX-2, WX-13). S–M, very high impact

Funnel logic is growth-funnels' (`<AuthGatePrompt action>`, Create account primary,
`/signup?redirect=…&intent=…`, intent resumes as a one-tap confirm). Placement:

- **Header:** Follow is the one filled CTA in `--channel-accent`, then Support (outline), Share,
  then overflow. Once followed, Support takes the fill (art-director rule).
- **Chat composer row:** a composer-shaped row "Create a free account to chat" + secondary "Sign
  in". It replaces `chat.signInPrompt`.
- **Prediction, poll and giveaway cards:** the same prompt inline under the card ("Create an
  account to predict / vote / enter"), replacing the plain hint text.
- **Watch nudge:** after 5 minutes watching signed out, one dismissible strip under the player
  (never over the video, never on mobile while playing): "Enjoying {channel}? Follow to know when
  they're live." At most once per tab session (sessionStorage in try/catch); never while the 18+
  gate or a paywall is up.
- **18+ gate:** Create account (primary, `intent=watch`) + Sign in. Chat copy when signed out
  becomes "Sign in and confirm your age on the player to see chat". Below the gate, signed out:
  `LiveNowShelf` "Watch something else".
- **Clip button (P4):** `action=clip`.

### P3. Offline channel as a content surface (WX-5, WX-14, WX-6). M, high impact

```
[ Banner (or <MediaFallback> arcs motif in channel accent), 16:5 ]
[ Header: avatar · name · Offline · Last live 1 h ago · Strategy Games  [Follow★] [Support] … ]
┌ Follow hero card (no VOD) / OfflineHero latest VOD (has VOD) ───────┐
│ "Get notified when Sly Kettle goes live"  Next: Fri 19:00 (schedule) │
│ [Follow]  [Add to calendar (.ics)]                                   │
└──────────────────────────────────────────────────────────────────────┘
Tabs: Home | Videos | Clips | Schedule | About
Home: Popular clips shelf → Recent videos → About + panels → "Live now on CommonAir" (LiveNowShelf limit 4, sameCategoryFirst)
```

- The empty 16:9 box is gone when there is no VOD: the banner or `<MediaFallback>` plus the Follow
  hero card take its place.
- The chat column stays, with the quiet state, the last message time and the chat rules panel
  surfaced.
- **Contract request (orchestrator):** a `ChannelSchedule`, made of weekly recurring slots
  (`weekday`, `startLocal`, `durationMinutes`, `title?`, `categoryId?`) plus one-off entries and the
  channel `timezone`. Add `nextStreamAt` to `channels.get`. The `.ics` is generated server-side
  (first-party). Until the schedule exists, the card shows "Last live · category".
- Live Home gets a compact About card (bio first line, rules link, panels count) after the shelves,
  and ends with "More live in {category}" (`LiveNowShelf`, owned by discovery).
- Components: `EmptyState`, `RelativeTime`, `StreamCard`, `LiveNowShelf` (extended by discovery),
  `MediaFallback` (art-director).

### P4. Viewer clipping (WX-4, WX-18). M, high impact

- A "Clip" `<IconButton tooltip>` (key `X`) in the live, DVR and VOD control bars.
- It opens a `Dialog` with a preview of the last 30 s (a range slider of 5–60 s on a VOD), a title
  field, then Create.
- Success opens a share sheet ("Clip ready", Copy link, Share, Watch). The clip URL is
  `/$channel/clips/$id`.
- Signed out: `AuthGatePrompt action=clip`.
- Existing API: `clips.create` with `vodId`/`startOffset`/`durationSeconds`.
- Hide "0 views" below a threshold; show "New clip" instead (same rule as "Just started").

### P5. Chat column: fill it, calm it (WX-7). M, medium-high impact

- **Top:** the pinned strip collapses to one line and shows the highest-priority item (open
  prediction or poll > giveaway > goal). Expanded, it caps at 40% of the column height and scrolls
  inside itself.
- **Empty log:** a channel welcome card ("Welcome to Aurora Pixel's chat", the first 3 chat rules
  from the panel, the "Chat is saved with the VOD" note). Signed-in viewers get "Say hi 👋" as a
  composer suggestion. No fake messages.
- **Sticky:** at `lg`, chat is `position: sticky; top: header; height: 100svh - header` (today
  `chatColumnClass`), so it never ends above the fold and never scrolls with the page.
- Existing: `chat/pinned/strip.tsx`, `interact/*`, `EmptyState`.

### P6. Player polish (WX-8, WX-16, WX-17). S, medium impact

- Remove the "moved" coachmark.
- Show a "Data saver · Low" chip in the bar only while a budget is on.
- When Data saver is Off, disable the budget radios (or show them only once it is on).
- Use the live `thumbnailUrl` as the poster while loading, with a `view-transition-name` from
  discovery's card (none under reduced motion).
- Show an "Auto · 720p" quality chip when renditions > 1.
- Staging should run the transcode ladder so Quality can be reviewed.

### P7. Sharing and embed (WX-9, WX-10). S–M, medium impact

- **One `ShareMenu`** for channel, VOD and clip, as a `Popover`:
  - link field, plus "Start at" for VODs;
  - Copy link;
  - "Share…" (`navigator.share`, shown only when supported);
  - "Embed" (copies `<iframe src="{publicUrl}/embed/{slug}" …>`, plus VOD and clip embeds when
    those routes exist).
  - No third-party share buttons or intents that load remote scripts. Plain intent URLs are OK as
    links, but I recommend leaving them out (privacy).
- **Embed:**
  - A small top-left overlay with the avatar, name and LIVE, shown on hover and focus.
  - A bottom-right "Watch on CommonAir" link (`target=_blank`, `rel=noopener`).
  - Offline: the banner or `MediaFallback`, "Last live…" and the same link.
  - New routes `embed/vod/$id` and `embed/clip/$id` (L; optional).

### P8. VOD and clip page next steps (WX-11, WX-21, WX-3). S–M, medium impact

- **VOD:**
  - "Resume from 12:04" (localStorage `commonair.resume.v1`, agreed with discovery);
  - "Available until Nov 20" meta from `expiresAt`;
  - chapters later.
- **Clip:**
  - "Watch from this moment" links to the source VOD with `?t=` (contract request: `Clip.vodId`
    and `vodOffsetSeconds`, or derive them from `windowStartedAt`);
  - loop toggle on;
  - "Next clip" autoplay countdown, off under reduced motion;
  - for clips, chat replay collapses to a 240 px panel under the player on `lg` instead of a full
    column.
- **"More from":**
  - never `null` on error: render `<Skeleton>`, then a quiet "Couldn't load more videos · Retry";
  - when the channel is live, put a live tile first.
- **429 handling:**
  - the SSR loader maps RATE_LIMITED to a retry with backoff (honoring `retryAfterSeconds`), then a
    503 page that says "Busy right now, retrying…" and auto-retries, never a 500;
  - client fetches in watch surfaces honor `retryAfterSeconds`;
  - the anonymous limit should be reviewed for shared-IP audiences (an infra or orchestrator
    decision).

### P9. Giveaway verify page (WX-12). S, medium impact

- Top: a channel card (avatar, name, LIVE/"Watch live" or Follow), using the display name.
- Then a plain-language summary first ("3 entries · 1 winner · drawn 2 h ago · ✓ the draw checks
  out"), with the commitment and seed details in a `Collapsible` "How to check this yourself".
- "Back to {channel}" link at the end.

## 4. Funnel and conversion notes

| Entry                                       | Steps                                                                  | CTA at each step                                                                              | Drop-off risk                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Home/directory card → live channel          | land → watch → (5 min) nudge → follow prompt → signup → confirm follow | Follow (accent fill); nudge strip; AuthGatePrompt Create account; one-tap "Follow {channel}?" | Chat buried on mobile (WX-1); bare /signin (WX-2)                      |
| Shared clip/VOD link (cold)                 | land → play → channel card → Watch live / Follow / More from           | "Watch live" when live, else Follow; Share                                                    | No path from clip to the full VOD (WX-11); "More from" vanishes (WX-3) |
| Embed on a third-party site                 | play → hover identity → "Watch on CommonAir" → channel                 | link out                                                                                      | No link today (WX-10)                                                  |
| Offline channel (notification, old link)    | land → Follow hero / latest VOD → Live now shelf                       | Follow + .ics; LiveNowShelf                                                                   | Empty box today (WX-5)                                                 |
| Wants to chat                               | composer → AuthGatePrompt → signup → back with composer focused        | "Create a free account to chat"                                                               | Today: "Sign in" only, loses place                                     |
| Interactive card (prediction/poll/giveaway) | sees card → prompt under card → signup → back                          | "Create an account to predict/vote/enter"                                                     | Plain text hint today                                                  |
| Clip moment                                 | Clip button → dialog → share sheet                                     | Create clip → Copy/Share                                                                      | Feature missing (WX-4)                                                 |
| Support                                     | Support → dialog (split bar, "$3+ makes you a co-op member") → Stripe  | Support (fill after follow)                                                                   | Signed out → bare /signin                                              |

Measurement (agreed with growth-funnels): first-party aggregate counters keyed (surface, action,
step, day), with no user id, IP or cookie. Proposed surface ids: `watch.header.follow`,
`watch.nudge.follow`, `watch.chat.composer`, `watch.card.prediction|poll|giveaway`,
`watch.gate.18`, `watch.clip.create`, `watch.share.copy|native|embed`, `embed.watchOn`,
`offline.followHero`, `offline.ics`, `vod.watchLive`, `clip.fullVod`. Steps: `shown`, `click`,
`signup_start`, `resumed`, `completed`.

## 5. Cross-team decisions

- **growth-funnels:** `AuthGatePrompt` placement in the composer row, under the interactive cards,
  the 1x/tab 5-min follow nudge, and the offline Follow hero (agreed). Intent resumes as a one-tap
  confirm (agreed). Counters as above (agreed). Sent and awaiting reply: `intent=clip`, and Create
  account on the 18+ gate.
- **discovery:**
  - Offline cards link to `/$channel` (agreed).
  - `LiveNowShelf` is extended (limit, excludeSlug, sameCategoryFirst) and placed at the end of the
    offline page, under the signed-out 18+ gate, and as "More live in {category}" on live Home
    (agreed).
  - The player poster uses the card's thumbnailUrl (agreed).
  - Resume positions go to localStorage, which discovery reads (agreed).
- **responsive-a11y:** mobile watch layout accepted with 7 conditions, folded into P1 (agreed).
- **art-director:** on channel, VOD and clip pages the one fill is Follow, then Support, in
  `--channel-accent` (from the log). I need `<MediaFallback>` for the offline stage and the embed.
  Player chrome uses the `--overlay` tokens.
- **coop-trust:**
  - One trust badge in the header, on About and offline only: Creator council outranks
    Member-owner.
  - The "How we count" viewer link goes in the About tab and the VOD/clip channel card, not in a
    tooltip.
  - The support dialog line about co-op membership (agreed).
- **Contract requests (orchestrator):** `ChannelSchedule` + `nextStreamAt` (P3); `Clip.vodId` +
  offset (P8).
- **Reported to others:** account-admin's /following 500 is the 429 SSR issue (WX-3), not a slug
  bug.

## 6. References

- Twitch channel page (twitch.tv/lofigirl, twitch.tv/twitch, via market-research and the prior
  review): chat stays open offline with a gated input; slim pinned strips; Schedule tab; a sticky
  player with chat below it on mobile web. Borrowed the layout pattern only.
- Kick offline channel (via market-research): offline Home tab = videos, popular clips and
  "recently streamed" shelves. Borrowed the shelf order for P3.
- YouTube live (via market-research): signed-out chat replaced by a sign-in link. We place a
  richer in-place prompt instead.
- Owncast (via market-research): chat without an account. Noted as a contrast and not adopted,
  because of moderation load.
- Web Share API (MDN, a browser standard): native share sheet with no third-party code.

## Addendum: signed in as streamer1 (live, look only)

Seen at ~1067 px wide on /demo_streamer2 (as a viewer) and /demo_streamer1 (own channel). Nothing
clicked.

| ID    | Problem                                                                                                                                                                                                                                                                                                   | Evidence                                                       | Sev          |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------ |
| WX-22 | **The portability toggle takes prime space.** "Email me once if Lumen Beats moves" (a Switch) sits between the header and the tabs for every follower, on every visit. It is a set-once, niche preference.                                                                                                | /demo_streamer2 signed in; `$channel.tsx` `grant` in `details` | med          |
| WX-23 | **The owner's own channel has no studio shortcuts.** On their own page, Follow, Support and Report are hidden and only Share remains. There is no "Stream manager", "Edit channel" or "Clip/Highlights" entry, and nothing tells the owner this is their public view.                                     | /demo_streamer1 as streamer1; `$channel.tsx:262`               | med          |
| WX-24 | **Points have nowhere to go.** The composer shows "0 points" / "0 pixels" (also on the owner's own channel). There is no explanation of how points are earned and no redemption UI (no rewards routes in the contract or web). Points only feed predictions, so the chip is dead weight for most viewers. | chat composer; contract grep for redeem/rewards finds nothing  | med          |
| WX-25 | **Chat header controls are three unlabeled-looking icons** (calm, settings, watch room), plus a mod-queue count on the owner's view, all at 12–14 px. They need `<IconButton tooltip>` labels visible on hover and focus; check with responsive-a11y.                                                     | chat header                                                    | low          |
| WX-26 | **The "moved" coachmark also shows signed in** and sits on the player at every new browser.                                                                                                                                                                                                               | both views                                                     | low (see P6) |

Proposals:

- **P10 (S).** Move the portability grant into the Following button's menu: Following becomes a
  split button with a `DropdownMenu` (Notifications: All / Go-live only / Off; "Email me once if
  {channel} moves"; Unfollow via `ConfirmDialog`). This is also where growth-funnels' per-channel
  go-live notification choice lives.
  - On the first follow only, a one-time `Popover` anchored to Following asks "Get told when
    {channel} goes live?" with [Push] [Email] [Not now]. The account-level answer is remembered and
    the prompt never shows again. Email records consent per account-admin's spec
    (`consent_records`, RFC 8058). Counters: `notify.optin.firstFollow.push|email|dismiss` and
    `notify.level.change` (agreed with growth-funnels).
- **P11 (S).** Owner view: an "This is your public channel" `Alert`-free strip, i.e. a quiet row of
  `Button`s in the header actions: "Stream manager" (live) or "Go live setup" (offline), "Edit
  channel", "Studio". Hide the owner's own points chip. Coordinate with creator-studio
  (`LiveStatusBar` could link here).
- **P12 (M, contract).** Points: the chip becomes a `Popover` with "How you earn {pointsName}"
  (watch time, follow, chat), the balance and the open prediction. Redemption is a contract request
  for later (channel rewards with a moderation queue). Until it exists, hide the chip at 0 points
  with no open prediction.

## 7. Top 5 (ranked)

1. **P1: mobile and tablet watch layout.** Today chat sits ~1000 px down on a phone.
2. **P2: signed-out conversion placement** across the header, composer, cards and 18+ gate, with
   growth-funnels' `AuthGatePrompt`.
3. **P4: viewer clipping.** The API exists and there is no UI; it is the biggest content
   multiplier.
4. **P3: offline channel as a content surface,** plus the schedule contract.
5. **P8 + WX-3: VOD and clip next steps, and graceful 429 handling** (no 500s, no vanishing "More
   from").
