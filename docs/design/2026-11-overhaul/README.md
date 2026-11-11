<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# CommonAir design overhaul: merged plan (2026-11-06)

Merged from nine investigation reports (art-director, discovery, watch, growth-funnels,
creator-studio, coop-trust, account-admin, responsive-a11y, market-research). They were made on
staging (seeded, signed out and then as `streamer1`), from source, and from outside research. 66
cross-team decisions are in `decisions-log.md`, all agreed by the teammates concerned. Nothing in
the repo or on staging was changed.

**Where it starts.** Since the 2026-11-03 review, the platform caught up on the Twitch basics:
directory, categories, search, channel tabs, full player chrome, video and clip pages, and a
studio control room. What it lacks now is the layer that **sells and retains**:

- no brand;
- a home page that is empty when few channels are live;
- every signed-out action dead-ends at a bare `/signin`;
- no page that pitches streaming here or joining the co-op;
- no onboarding for new streamers;
- no security settings;
- no way to measure any of it.

## Positioning (market-research, coop-trust)

Lead with the money and the ownership, and be precise about both:

- **What we can say:** 90% from the first sub, no audience gate to turn on support, card fees not
  taken from the creator, the fee set by members' vote with a dated public history, and the
  platform owned by its creators.
- **What we can't say:** "highest share" (Kick pays 95% of a sub, after a status gate), "no
  thresholds" (payouts have a $25 minimum, a 7-day hold and a monthly schedule), or any "share
  of surplus" promise while the co-op runs a deficit.
- **Competitor figures** on `/creators` carry a source and a "last checked" date.

## Visual direction: "Open Broadcast" (art-director; spec in `art-direction-v1.md`)

- Zinc greys and square corners (`--radius: 0`; 27 stray rounded corners removed). One
  **marigold** brand colour (`--brand` oklch(0.83 0.155 84), #f7bd36, with zinc-950 text) on
  **exactly one call to action per screen**. No streaming competitor uses golden yellow.
- On creator pages (channel, video, clip) that one filled call to action is Follow, then Support,
  in the **channel's accent colour**, never the brand colour. Never the brand on Sign in,
  Report, settings, admin or destructive actions.
- **Body text goes from 12 px to 14 px.** That is the largest single quality lift: 12 px is used
  448 times today against 279 for 14 px. Page titles 24 px, section titles 18 px, tile titles
  14 px, plus a display size for marketing pages.
- **Five surface levels:** page, sunken, card, raised, overlay. Dark mode steps up with a lighter
  fill and a thin ring, light mode with a shadow. Cards never sit inside cards.
- **New tokens:** motion timings of 120, 200 and 320 ms, and page widths. The light theme is
  generated once (today it is copied by hand three times). `--warning` moves to orange so it
  never reads as the brand.
- **Art system, all self-hosted inline SVG from tokens:** Arcs, SignalBars, EmptyArt,
  MediaFallback and CategoryArt. It replaces the grey letter tiles, the bare error and empty
  states, and the grey loading blocks.
- **One shell for every area:** a full-width header with the nav below it, so the logo stops
  moving between public, studio and admin pages.
- **Breakpoints:** 640, 768, 1024, 1280 and 1536 px, with content capped at 1600 px. Boards in the
  studio are 1600 wide, forms 1120 (768 inside), admin tables 1120.
- **One focus style everywhere:** ring-2 with an offset. Nine form controls move off ring-1.
  Status colours always come with an icon and a word. 10 px text only over video, on a scrim.

## Fix first (bugs the team found; small, and some block the rest)

| #   | Bug                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Where                                                                                       | Found by                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | -------------------------------- |
| F0  | **Fixed 2026-11-06 (`deletion/money.ts`): the user's and their channel's subscriptions end now, checkout is refused while a deletion is scheduled. Follow-up: no prorated refund is made for unused paid time (treasurer by hand); decide a policy.** **Deleting an account didn't cancel paid subscriptions or end co-op membership**, so renewals most likely keep charging. Neither the request nor the deletion job touches them. Cancel at the payment provider, end membership and refund the share before deletion completes. | `services/api/src/routes/me.ts:280-310`, `services/worker/src/deletion/account-deletion.ts` | ux-journeys (round 2)            |
| F1  | Any error from `/me`, a 429 included, counts as signed out, so signed-in users are sent to `/signin`. Only a 401 should; otherwise keep the page and show a Retry.                                                                                                                                                                                                                                                                                                                                                                   | `apps/web/src/server/bootstrap.ts:80`                                                       | 5 agents                         |
| F2  | A rate-limited server-side page load renders "Something went wrong" as a 500; shelves vanish silently.                                                                                                                                                                                                                                                                                                                                                                                                                               | SSR loaders                                                                                 | watch, discovery                 |
| F3  | One failed request blanks the whole page. Make each section fail on its own with a Retry.                                                                                                                                                                                                                                                                                                                                                                                                                                            | `/coop`, `/coop/council`, `/coop/settings`, notifications                                   | coop-trust, account-admin        |
| F4  | The transparency "Where every dollar went" bar adds creator earnings and co-op costs together, so it shows "Creators 27%" instead of 90%.                                                                                                                                                                                                                                                                                                                                                                                            | `transparency.tsx`                                                                          | coop-trust                       |
| F5  | The "two-factor enabled" email links to `/settings/security`, which returns 404.                                                                                                                                                                                                                                                                                                                                                                                                                                                     | live mail                                                                                   | account-admin                    |
| F6  | Not a counting bug: 16 and 4 came from two broadcasts with the same title (see decision 2). The real fixes: the health card skips the live-mode filter, the owner's own viewing counts, and a 4-second encoder drop splits a broadcast.                                                                                                                                                                                                                                                                                              | `services/api/src/lib/viewers.ts`, `services/api/src/media/hooks.ts`                        | creator-studio, viewer-count     |
| F7  | Home recommends the signed-in streamer's own channel to them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | home, rail                                                                                  | discovery                        |
| F8  | streamer1's inbox has 58 unread "vote open" items created within a minute, some already closed, none naming its proposal.                                                                                                                                                                                                                                                                                                                                                                                                            | notifications                                                                               | account-admin                    |
| F9  | Cooking says "Nobody is live" while Cooking channels were live in the last hour. Tags and stream titles aren't searched (`lofi` returns nothing).                                                                                                                                                                                                                                                                                                                                                                                    | category, search                                                                            | discovery                        |
| F10 | Reserve marketing usernames (`creators`, `fees`, `faq`, `join`, …) now, while there are no users. `/creators` currently says "This channel does not exist".                                                                                                                                                                                                                                                                                                                                                                          | signup                                                                                      | growth-funnels                   |
| F11 | Sign-in and the email verification link both land on `/dashboard`, viewers included. The page guards drop the return path.                                                                                                                                                                                                                                                                                                                                                                                                           | auth, `lib/auth.ts:50`                                                                      | growth-funnels, ux-journeys      |
| F12 | After checkout, the payment provider returns the payer to the same page whether they paid or cancelled, so nothing confirms the payment.                                                                                                                                                                                                                                                                                                                                                                                             | `services/api/src/money/checkout.ts:103-106`                                                | ux-journeys                      |
| F13 | No page serves link-preview tags, so every shared clip, channel and proposal shows as a bare URL.                                                                                                                                                                                                                                                                                                                                                                                                                                    | all public routes                                                                           | ux-journeys, mockups-acquisition |

## Batches

Each batch is one unit of work, in this order. D1 is the foundation the rest build on. D2
through D7 can then run side by side; overlapping files are noted.

### D1. Design foundation (art-director's top 5) — M–L

1. The `--brand` token, `Button variant="brand"`, and a lint or review rule for "one filled call to
   action per screen".
2. The type migration to a 14 px body, and the type scale.
3. Surface, width and motion tokens; strip the stray radii; generate the light theme once.
4. The art system components, replacing placeholders, empty and error states, and loading blocks.
5. The card set:
   - `StreamCard size="feature"` (62/38, stacks below 768);
   - one `MediaCard kind="vod"|"clip"`;
   - a `ChannelChip` row for offline channels;
   - `CategoryArt` (3:4 portrait, 16:9 compact, and a muted state at 0 live with no zero badge).

   Grids auto-fill at a minimum of 248 px.

6. The shell:
   - The header has a compact Sign up and Sign in at every width. Below 400 px the name collapses to the logo mark.
   - A **bottom tab bar below 768 px on browsing pages only**: Home, Browse, Following or Co-op, You. It is hidden on watch, sign-in, studio, settings and admin pages, and while the keyboard is open.
   - A three-column footer: Create, Co-op, Legal.
7. One focus rule, larger tap targets (sliders at 24 px or more, icons at 40 to 44 px below 768).

### D2. Acquisition and conversion (growth-funnels, coop-trust, market-research) — L, very high

1. **`<AuthGatePrompt action>`:** one prompt for every signed-out action: follow, chat, support,
   predict, clip and the 18+ gate.
   - "Create account" is the main button and "Sign in" the second, both carrying `?redirect` and `?intent`.
   - After verification the visitor lands back on the page with a one-tap confirm. It never follows or pays on its own.
   - The intent list: none, follow, chat, support, predict, clip, watch, stream, import, join.
2. **The sign-up page changes with intent** (its headline names the action that brought the
   visitor). It says the account is free and what it gives. "Already a member?" becomes "Have an
   account?".
3. **Signed-out home hero:** one real live stream at feature size, a display headline, a "Create
   free account" brand button, "Browse live" as a ghost button, a quiet "Stream on CommonAir" link,
   and a co-op promise strip with one hard number.
4. **`/creators`:** an honest fee calculator as the hero (CommonAir against Twitch, YouTube, Kick,
   Patreon and Ko-fi, each figure sourced and dated). Under it: how it works, import from Twitch,
   ownership, an FAQ, then a "claim your channel" field that pre-fills sign-up
   (`intent=stream`).
5. **Public membership pitch** on `/coop/membership`, plus a join band on `/coop`.
   - It states the $5 refundable share, that a $3+/month subscription qualifies, and that streamers join automatically.
   - `/coop/patronage` and `/coop/jury` get public explainers instead of a redirect.
6. **In the support dialog:** an estimated breakdown of where the money goes, and "a $3+
   subscription makes you a co-op member", ending in a "Welcome to the co-op" success state.
7. **Public Terms, Privacy and Guidelines pages.** Today they open only inside the sign-up dialog.
8. **First-party measurement with no tracking:**
   - Most funnel steps are counted nightly from existing rows.
   - Button views and clicks go to `POST /api/metrics/ui` as `{surface, action, step}`, checked against a closed list in the contract. The request carries no cookie and no user id, and counts are daily totals.
   - A new `users.signup_intent` column and an `account.created` event.
   - Results show on `/admin/growth`, with headline numbers on `/transparency`.
9. Optional: a double opt-in interest list (creator interest, co-op news), sent through our own
   mail.

### D3. Content and discovery (discovery, watch) — L, very high

1. **Home v2 that is full at 2 channels live and at 200:**
   - the hero, or a compact live-status bar when you are live yourself;
   - Live now and Continue watching;
   - Catch up (videos) and Fresh clips;
   - all categories, then a co-op band, then a start-streaming band.

   "Recently live" shrinks to `ChannelChip` rows.

2. **Category Overview tab** as the default: live, then recently live, then videos, then clips. No
   dead ends.
3. **Directory v2:** lead with what's live, with no "0 live" badges.
4. **Search v2:** search tags and stream titles, rank live channels first, demote 0-follower
   viewer accounts, and give empty queries a page.
5. **The left rail:** a fuller signed-out version and steady loading rows, plus a new
   **`/following`** page (Live now, then offline rows with alert controls).
6. **Continue watching:** watch writes resume points to the browser
   (`commonair.resume.v1`, 20 at most, videos only) and discovery reads them. Nothing goes to the
   server.
7. **A Clip button for viewers** in the live and video player bars. `clips.create` already exists
   and nothing calls it. This is the biggest gain in new content for the effort.
8. **The offline channel as a content page:**
   - a Follow hero with the next stream;
   - the latest video, clips and panels;
   - the Live now shelf at the end.

   Panels render markdown, not literal text.

9. **Video and clip pages:** next-up and "More from" shelves that degrade properly. A clip offers
   "Watch from this moment" in the full video. Sharing goes beyond copying the link. The embed
   gets the channel name and "Watch on CommonAir". The giveaway verify page links back to its
   channel.

### D4. The watch page (watch, responsive-a11y) — M, very high

1. **Phone and tablet layout below 1024 px:**
   - a sticky 16:9 player and a compact header row;
   - a "Chat | About" tab switch, with chat as the default while live;
   - the chat box pinned to the bottom.

   The site header scrolls away and there is no bottom bar on this page. Chat is `role=log` with an "N new messages" pill. Today chat starts about 1000 px down.

2. Remove the "Quality and Data saver moved" note that covers the player.
3. **The Following button gets a menu:** alert level, "email me if they move", and Unfollow
   with a confirmation. After a viewer's **first follow only**, a one-time prompt asks whether
   to be told when that channel goes live: Push, Email or Not now. That prompt also stands in for
   the push-notification offer.
4. Calm the chat column. Polls, predictions and giveaways stay a slim pinned strip.
5. **Points:** the points chip becomes a popover explaining how points are earned. Redeeming
   points is a contract request.
6. **Owner shortcuts on their own channel:** stream manager and edit.
7. **Trust marks:** a neutral council or member-owner badge on About and offline pages. The
   viewer count says "Verified viewers", with a "How we count" link.

### D5. Creator studio (creator-studio) — L, very high

1. **A "Ready to go live" checklist on `/dashboard`.** The steps:
   - `channel_profile`
   - `stream_info`
   - `stream_key`
   - `encoder_connected` (a live check)
   - `rehearsal` (optional)
   - `first_live`
   - `import_twitch`, when the sign-up intent was import

   The page shows the WHIP URL, the recommended encoder settings and the OBS profile, which the API already returns. The step ids double as funnel steps.

2. **A sticky live-status bar on every studio page.** The dashboard is reordered for live work:
   the title editor and live numbers above the fold, and chat earlier on phones. Show Retry, not
   "Reload the page".
3. **A stream recap after each broadcast.** It also carries the one-time "you're a member-owner"
   notice.
4. **Overlays:** show all three links (alerts, chat, goals) with browser-source sizes.
5. **Content library:** thumbnails and view counts instead of a column of forms.
6. **Analytics:** daily charts as bars, and use `analytics.pnl`.
7. **Revenue:** the tiles add up (add "Paid out"), no raw payment-processor ids, and the payout
   card stops contradicting itself.
8. **Studio navigation:**
   - The groups become Home, Set up, Community, Content, Money, Grow, and Co-op & tools.
   - **The account menu** becomes: Your channel, Creator studio, Following, Settings, Co-op membership, theme, Sign out. Relays moves into the studio.

### D6. The co-op and trust (coop-trust) — M–L, high

1. **Transparency as a selling point:**
   - a numbers strip at the top;
   - the fee promise with a dated comparison;
   - two separate bars, one for the revenue split and one for co-op spending (this fixes F4);
   - an honest note on the deficit;
   - a short list of co-op commitments.

   A money-flow diagram comes later.

2. **Readable governance:**
   - plain-language settings ("Creators keep 90%");
   - proposal changes shown as "90% → 85%";
   - form fields instead of typing JSON;
   - proposal cards with deadline, author and result;
   - vote results as bars with threshold marks;
   - a timeline with the current step and next deadline;
   - a neutral lock badge on protected decisions.
3. **Council and board pages with people on them.** Governance lists become rows you can tap.
4. **A co-op card in the studio.** Revenue reads the cut from `platform.cut`, never a hard-coded
   number.

### D7. Account, retention, admin and the installable app (account-admin, responsive-a11y) — L, high

1. **The settings shell:**
   - A left section nav at 1024 px and up, and a select menu below that.
   - The groups: Account (Account, Security, Preferences), Activity (Notifications, Following, Subscriptions), Safety (Privacy & data, Appeals, Copyright), Apps.
   - Bare `/settings` goes to `/settings/account`.
   - One section-and-row pattern on every page, and a "danger zone" style for deletion.
2. **`/settings/account`:** display name, avatar, and email sharing. **`/settings/security`:**
   two-factor, passkeys, password, email change and sessions. The server already supports them.
3. **Notifications:** a grid of every notification type against in-app, email and push. A full
   `/inbox` page. An opt-in weekly "What you missed" email (unticked by default, with consent
   recorded).
4. **Account deletion:** a preview of what happens to subscriptions, payouts and the co-op share;
   a "download first" step; the grace period stated; and a banner while deletion is pending.
5. **The admin console:**
   - an admin home with queue counts;
   - one `QueueLayout` for every queue (a 384 px list beside a detail pane), with filters, counts, keyboard navigation, bulk actions and claiming;
   - `/admin/audit` and `/admin/users/$username`.

   The studio mod view reuses the queue layout in a compact form.

6. **The installable app (PWA):** a fuller manifest (description, shortcuts, screenshots), an
   offline page, and "Install CommonAir" always in the menus. It's offered in context only after a
   second visit with 3+ minutes watched; that check stays in the browser.

## Contract and schema requests (orchestrator)

- **Discovery:**
  - lists of videos and clips across all categories (`vods?sort=recent`, `clips?sort=recent`);
  - a video count per category;
  - `directory.recent?category=`;
  - search over tags, stream titles, videos and clips, with live boost;
  - the channel creation date.
- **Watch:**
  - `ChannelSchedule` (weekly slots plus one-offs, in the channel's time zone) and `nextStreamAt`;
  - `Clip.vodId` and the offset into it;
  - points redemption.
- **Growth:**
  - `POST /api/metrics/ui` and its closed list of names;
  - two counter tables;
  - `users.signup_intent`;
  - an `account.created` event;
  - `?intent` and `?username` on sign-up.
- **Studio:**
  - `stream.setupState` (or `me.creatorProgress`);
  - per-video `views`;
  - a "your video is ready" notification;
  - the schedule (shared with watch).
- **Co-op:**
  - an optional treasurer note on each transparency month;
  - the title of the proposal that last changed each setting.
- **Account and admin:**
  - auth routes for two-factor, passkeys, sessions, and password and email change;
  - better-auth `changeEmail`;
  - wider notification preference types (governance, payout, weekly);
  - a `types` filter on notifications;
  - `me.deletion.preview`;
  - `admin.overview` counts;
  - `moderation.assign` and an assignee field;
  - an audited admin email reveal;
  - a viewer avatar upload.

## Decisions (accepted 2026-11-06)

A second team of seven investigated the four open decisions and pushed the design further (full
reports in `round2/`). The maintainer accepted all four recommendations below on 2026-11-06; they
are now part of the plan.

### 1. The direction (accepted): approve "Open Broadcast" with five changes (direction-check)

**Contrast passes WCAG AA** for every proposed pair once the usage rules apply, so no colour
value changes:

- brand button text on the marigold, 11.7:1;
- light-theme brand text, 5.1 to 5.6:1;
- 14 px body text, 14 to 20:1;
- every channel accent, with the lowest at 4.99:1.

A side-by-side prototype in both themes is in `round2/direction-check/`. It also covers the
light-theme check round 1 could not do.

The five changes:

1. **Brand button rules:**
   - 14 px semibold labels.
   - A 1 px `--brand-text` ring in light theme. Without it the button is 1.71:1 on white.
   - The focus ring always at a 2 px offset (`button.tsx:10` has none today).
   - Never directly beside another filled button.
2. **Move the dark-theme amber channel accent** (and its chat and chart uses) from #fbbf24 to
   lemon #fde047. Today it is 1.02:1 against the brand, so amber channels read as the brand.
3. **14 px for reading text only:** paragraphs, help text, card bodies and form hints. Table
   cells, key-value lists and metadata stay at 12 px. A full sweep would push about 14 studio,
   admin and money tables into horizontal scrolling. Square corners cost no space.
4. **Optional:** dark muted text from oklch 0.705 to 0.74, for APCA.
5. **Extend `tokens.test.ts`** to cover these pairs, plus a guard that no channel, chat or chart
   colour sits within reach of the brand.

### 2. The viewer count (accepted): both numbers were right; one live number, one settled number (viewer-count)

The seed restarts a dead publisher, and every restart opens a new broadcast:

- **16** was the broadcast live at the time.
- **4** was the settled peak of an earlier 59-second one.

Analytics lists only ended broadcasts, and its picker shows no duration, so the stub looked like
the live stream.

**Recommendation (S–M):**

- **While live,** every surface shows the worker's count (`viewerCount()`):
  - Cards and the channel page say "{n} watching", with "Verified viewers · How we count" on the
    channel page.
  - The dashboard shows "Watching now" and "Peak so far", with "final numbers settle after the
    stream".
- **After the stream,** the settled rollup (`broadcast_audience_totals`) is the truth for
  analytics, the recap and attestations.

**Fixes:**

- The health card uses the live-mode filter.
- The owner is excluded from the live count and the rollup. This changes attested figures, so it
  needs an amendment to ADR 0014.
- `stream.health` gains a "peak so far" field (the data is already in
  `broadcasts.peak_verified_viewers`, unread).
- Analytics gets a "Live now" row, and the picker shows each broadcast's duration.
- **Separately (M):** a reconnect grace for live broadcasts in `media/hooks.ts`, which removes
  the root cause.
- **Separately (S–M):** seeded broadcasts get rollup rows.

### 3. The interest list (accepted): later, and tied to accounts (scope-calls)

- **No audience yet:** there are no real users, and `/creators` doesn't exist.
- **It costs M, not S.** Every list today belongs to an account. A list for people without
  accounts needs:
  - a new unsubscribe token subject and a confirm flow;
  - bot protection (an open form can be used to mail a victim);
  - export and deletion for non-users, which ADR 0004 doesn't cover;
  - an age check and a privacy-policy section;
  - care for the sender reputation that go-live and password-reset mail depend on.
- **Accounts already cover most of it:** creator interest is sign-up with `intent=stream`.
- **Later, the cheap version:** an account-bound "email me once when X ships" preference with a
  fixed topic list (S), once `/creators` is live and a named gap exists.
- **D2.9 is dropped from this overhaul.**
- **Do not cite** the seeded "members rejected a newsletter" proposal anywhere. It is random seed
  filler (`harness/src/seed/coop/plan.ts:266`).

### 4. Points redemption (accepted): later; explain the points we have now (scope-calls)

**Why keep the chip:**

- **Points can already be spent** on predictions, extra poll votes and paid bot commands. The bot
  commands spend points in one transaction that refuses overdrafts.
- **Hiding the chip** would hide the balance people bet with.
- **The counting is trustworthy:** points come only from verified watch time, and the owner's own
  viewing is excluded. viewer-count confirmed both.

**Now (S, in D4.5):**

- The chip opens a popover with the balance, "earned only from verified live watch time", the
  daily cap, and today's ways to spend.
- It is hidden at zero when there's nothing to spend, and on your own channel.
- The coin icon goes, because it reads as money.
- Round 1's line that "follows and chat earn points" was wrong.

**Redemption:**

- **When to build it:**
  - 60 days after launch with at least 10 channels using points;
  - and viewers spending under 10% of what they earn, or three streamer requests, or a member
    proposal.
- **It needs** moderation assignment (D7.5) first.
- **Start with fixed rewards that take no free text.** Custom-text rewards only after the reward
  rules in the terms are signed off.

## Round 2 design additions

### High-fidelity mockups

Working HTML, in both themes, with real seeded content. They are built on the corrected tokens,
voice-copy's copy and real Hugeicons.

- **Acquisition** (mockups-acquisition, 8 pages):
  - the home page at 9, 2 and 0 channels live;
  - `/creators` with a working, sourced fee calculator;
  - `/import`, the membership pitch and `/coop` with the join band;
  - sign-up for all 10 intents;
  - the sign-up prompt in place for every action, plus a clip page as a first visit.
- **Product** (mockups-product, 8 pages, 37 states):
  - the live channel on desktop and mobile, the offline channel, and the mod view with a raid;
  - the studio checklist, the live state and the recap;
  - settings (Account, Security, Privacy and the delete flow) and an admin queue.

Design decisions they made beyond round 1:

- Below 768 px, Sign in moves into the bottom tab bar.
- While a sign-up prompt is open, the page's own Follow button drops to an outline.
- The "Live now" row backfills with labelled videos when fewer than four channels are live.
  Categories never show "0 live".
- The hero shows a poster with Play, never autoplay.
- On iOS before the app is installed, the first-follow prompt never offers Push; it offers email
  and an Add to Home Screen hint.
- The Following button is split into a bell and a menu.
- On the offline page, the next stream is a date block with "Add to calendar".
- Checklist steps that are done keep an Edit action, so nothing becomes a dead end.
- The delete dialog shows what changes, offers a download first, then asks for the username. Its
  button reads "Delete in 30 days".
- Sessions show browser and system, never an IP.

Corrections the mockups surfaced, now applied:

- Streamer membership also needs 10 streaming hours.
- The membership FAQ uses the real vote thresholds.
- The Twitch import ships switched off (ADR 0031) and never brings followers, past videos or a
  schedule.

### Six user journeys, and the gaps between screens (ux-journeys)

Six journeys, today and after the plan, each with a table, a flow diagram and links to the
mockups:

- a clip visitor who becomes a follower;
- a Twitch streamer switching;
- a returning follower on mobile;
- a $3 sub that becomes membership and a first vote;
- a moderator during a raid;
- an account deletion.

The plan fixes the first screen of almost every journey but left the moments between screens
unowned. Each gap fix folds into the batch that creates the promise:

| Gap                                                                                                                                         | Fix                                                                                                                                                                                                         | Batch      |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| No checkout success signal                                                                                                                  | Separate success and cancel return URLs, and a "confirming…" state (F12)                                                                                                                                    | D2         |
| New members can't vote on open proposals (electorate frozen at open, `policy.ts:75`); sub membership waits for the hourly sync, unannounced | Pick "Your first vote" from the data; start membership in the payment webhook; add a `membership` notification                                                                                              | D2, D6     |
| No link previews                                                                                                                            | Link-preview tags and a 1200×630 still on clip, video, channel and proposal pages (F13)                                                                                                                     | D3         |
| Verification lands viewers in the studio                                                                                                    | Extend F11 to the verification link                                                                                                                                                                         | Fix first  |
| Moderation barely planned                                                                                                                   | A chat-mode menu (slow, followers-only, emote-only, clear); a mod-view link for non-owner mods; an incoming-raid alert; "Delete message"; timeout lengths; outcomes for reporters; notice to new moderators | D4, D5, D7 |
| iPhone push needs the app on the Home Screen                                                                                                | First-follow prompt offers email and an install hint there                                                                                                                                                  | D4         |
| Follow links read as "leaving"                                                                                                              | "Bring your audience" step in the first-run checklist and a studio Grow item                                                                                                                                | D5         |
| Deletion keeps billing                                                                                                                      | F0                                                                                                                                                                                                          | Fix first  |

### Voice, glossary and copy (voice-copy)

**The catalog audit** covered 5,114 English strings:

- "Member" means three things. "Already a member?" means having an account, and watch rooms have
  "members" too.
- Saved streams have four names (VOD, video, past broadcast, recording); the glossary picks
  "video".
- 33 strings use gambling words ("bet") for predictions; they should say "predict".
- Errors are dead ends: 50 of 100 load-failure strings give no next step, and "Try again" is
  worded 10 different ways.
- Members are asked to type JSON.

**Recommendation: a words pass in D1** (about 250 strings, plus their `es` translations; S–M). It
covers:

- the voice and tone guide, with round 1's honesty rules made binding;
- a glossary of about 35 terms;
- one error pattern: "{section} didn't load" plus Retry, under one shared Retry key.

Every later batch uses the report's ready-made i18n keys for each key moment.

### Open questions left by round 2 (answer or accept the default)

1. **ADR 0031 leaves naming Twitch on our pages for post-launch review.** Default: `/creators`
   hides its import section while the import is off, and says "Tools other platforms don't have".
2. **The co-op proof number:** "earned by creators" ($4,294.80 on staging), labelled as such,
   rather than "paid out" ($297). Default: earned.
3. **The calculator's assumptions** need market-research's sign-off before `/creators` ships:
   - Patreon and Ko-fi card processing at 2.9% + 30¢;
   - a $10 average tip;
   - Twitch Bits left out.
4. **The deficit note's claim** that creators' 90% never covers the gap needs coop-trust and the
   treasurer to confirm it.
5. **The username claim field** needs a rate-limited "is this name free?" endpoint (a contract
   request).

## Remaining waves

Wave 1 shipped D1 (tokens, art and the card set, the shell, the words pass), the fix-first list
F0 to F13 and their integration glue. The mockups now live outside the repo (font and icon
licensing) at `~/CommonAir-design/round2-mockups/` (`acquisition/` and `product/`); serve them
with `python3 -m http.server 4174 --bind 127.0.0.1` from that folder.

### How every wave runs

1. **Contracts and schema first.** The orchestrator lands the wave's contract and schema requests
   (the "Contract and schema requests" section above) on `main` before any unit starts, so units
   build against fixed contracts.
2. **Units in parallel worktrees.** A Workflow runs one unit per git worktree with strict file
   ownership: implement, then an independent diff review, then a fix pass for the confirmed
   findings. Adapt the wave-1 script
   (`~/.claude/projects/-Users-joshe-Repos-bcon/0dc0e617-c75a-41c7-9572-9538f0d60d50/workflows/scripts/overhaul-wave-1-wf_02804aca-05d.js`),
   pointing its mockup path at the folder above.
3. **One integration agent** merges the branches and applies the cross-unit contract requests.
4. **Push `main`; CI must be green before the next wave starts.**

Lessons from wave 1, for every brief and the integration step:

- Each unit creates its own new i18n namespace files (`apps/web/src/i18n/locales/{en,es}/<unit>.json`)
  instead of editing shared catalogs; integration runs `bun run --filter @commonair/web i18n:gen`.
- When env vars change, regenerate the self-host env key lists (`bun scripts/selfhost/unit-env.ts`)
  and check the selfhost seed-mode parity test.
- Before pushing, run the unit tests of every touched package (targeted, never the full gate).

### Wave 2: acquisition and content (D2 + D3)

**Shipped 2026-11-11.** The contract step was `1a737cb1`. The eight units and their integration were merged at
`8ff06f86`. The CI follow-ups were `cf8f47f5`, `df296ec5`, `e24ceb33`, `4bd85b5b`, `3785caad` and `05b41857`. CI on
`05b41857` (run 42982878240, dispatched on a branch while wave 3 merged on `main`) passed static,
unit, relay and every harness shard that ran, `core` with `e4b-money` among them. The rest are
explained in `docs/operators/flakes.md`. What the CI follow-ups changed:

- the wave's pages now meet the source and intl policies, through named `@utility` classes in
  `apps/web/src/styles.css`;
- every page load makes two fewer API calls. `e4b-money` had stalled on 429s because ordinary page
  traffic filled a member's 120-a-minute `default` bucket;
- rate-limit bucket entries now name their procedure, which helps diagnose the next 429 stall.

What was left, and where it went:

- **To wave 3 (in its brief):**
  - one-tap confirms after sign-up for the chat, support, predict, clip and watch intents
    (`CONFIRMABLE_INTENTS` holds only follow);
  - AuthGatePrompt on the rail's signed-out follow;
  - a browser check of the signed-out Clip button and of the second Follow on an offline channel.
- **To wave 4:**
  - an opt-in history, so that `notify_optin` counts first opt-ins exactly;
  - a test for `apiSupportClient.memberRule` against the API.
- **To wave 5:** Go 1.27.4 for GO-2026-6859. Its dated exception in `supply-chain.json` expires on
  2026-11-18.

- **Sign-up and the gate:**
  - the AuthGatePrompt for every signed-out action (follow, chat, support, predict, clip, 18+,
    report);
  - intent-aware sign-up.
- **Acquisition pages:**
  - the home hero, its CTA marked `data-filled-cta`;
  - `/creators` with the sourced fee calculator;
  - the public membership pitch and the `/coop` join band;
  - the support dialog's money breakdown and its "$3+ makes you a member" line;
  - public Terms, Privacy and Guidelines pages;
  - first-party funnel counters and `/admin/growth`.
- **Content and discovery:**
  - home v2, the category Overview, directory and search v2, rail v2 and `/following`;
  - Continue watching and the viewer Clip button;
  - the offline channel as a content page;
  - video and clip next-up shelves.
- **The journey gaps:**
  - the post-checkout welcome;
  - membership started from the payment webhook, with a `membership` notification;
  - "first vote" messaging from the real electorate.
- **The cookie banner redesign:**
  - Move it from the top to a floating bottom-corner card: bottom-right on desktop, a bottom
    sheet inside the 16 px gutter on phones.
  - Keep it above the bottom tab bar and never over the player.
  - Use a raised D1 surface and copy from the voice guide, with a privacy link.
  - "Accept" and "Decline non-essential" carry equal weight, and neither uses the brand fill.
    "Choose" opens a per-category dialog.
  - It is non-modal and needs no scroll lock. It is reachable by keyboard without stealing focus
    on load, and Escape means no choice.
  - Respect reduced motion, and keep the existing consent records (`apps/web/src/components/consent/`).
  - Tests at 320, 375, 768 and 1440 px.
- **Wave 1 leftovers:**
  - The home hero and AuthGatePrompt CTAs carry `data-filled-cta`, with a test that the header's
    Sign up turns to an outline next to the AuthGatePrompt.
  - The `/following` tab link points at the page this wave builds.

### Wave 3: watching and creating (D4 + D5)

**Shipped 2026-11-11.** The contract step was `277cf3b6`: `stream.setupState`/`setupMark`,
`me.moderates`, `vods.recordView`/`clips.recordView`, the `vod_ready` notification, migration 0056
(`vods.views`, `channel_setup_steps`), and the fields `firstFollow`, `Channel.ownerCoop`,
`RevenueSummary.paidOut` and `LoyaltyBalance.accrual`. Seven units ran in two workflow passes,
because three worktrees failed to start the first time. The first four (d4-layout, d4-chat, d4-follow,
d5-dashboard) were integrated at `2c2730b7`, which added `Channel.viewer.notify` for the bell. The
other three (d5-shell, d5-content, d5-money) were integrated at `10007dbf`. CI follow-ups were
`562b4cd4`, `a6164f5c`, `fa49fee3` and `629faceb`. CI on `629faceb` (run 42993074762) was green on
rerun: attempt 1 failed only on the known `multi-instance` network settle. Recorded calls:

- `Channel.ownerCoop` makes public only that the owner is a member-owner now, or holds a council
  seat now.
- Views count at most once per viewer per item per UTC day. Signed-out viewers are deduplicated by a
  daily-salted address hash that lives only in Valkey. Views are not integrity-checked, so they are
  labelled "views", never "verified".
- `vod_ready` is in-app only until D7 adds a `creator` preference. The media seed seeds it, so the
  platform inbox seed keeps skipping it.
- Bulk wave moderation and points redemption stayed out of the wave.

What was left, and where it went:

- **To the maintainer (browser checks, never run):**
  - the sticky player at 320 × 568;
  - focus after Follow, Unfollow and the intent confirms;
  - the signed-out Clip button's prompt;
  - the offline channel's single Follow;
  - the studio preview's 40 vh cap.

  Unit tests cover each one in happy-dom, which has no layout engine.

- **To wave 4:**
  - a "How we count" page for verified viewers (D6 transparency v2), then the link from
    `VerifiedViewers` (`components/watch-layout`);
  - bulk wave moderation, `chat.bans.bulk` (J5-d), with an audit and outbox row per target and
    capped at the wave size;
  - a `Get paid` checklist step from an `instance.features.payouts` bootstrap flag (J2-h).
- **To wave 5:**
  - the subscribers-only chat reason before typing (J3-d; the panel has no "subscribed" fact);
  - `LoyaltyBalance.earnedToday` for "Today: N of {cap}";
  - `stream.lastBroadcast`, for exact recap counts (the recap stops after 1000 items);
  - the J2-e share prompt on the first encoder connection, through the LiveStatusBar's
    `LiveStatusSlot`.

The plan as written:

- **D4, the watch page:**
  - the mobile watch layout (a sticky player, Chat | About);
  - the Following split-button menu, and the one-time first-follow alert prompt (on iPhone before
    install: email and an install hint, no Push);
  - a calmer chat column;
  - the points popover;
  - owner shortcuts and trust badges;
  - moderator tools: the chat-mode menu, Delete message, timeout lengths, the incoming-raid alert.
- **D5, the studio:**
  - the "Ready to go live" checklist, including "Bring your audience";
  - the LiveStatusBar and a rebalanced dashboard;
  - the stream recap;
  - all three overlay links;
  - the content library, analytics as bars, revenue tiles that add up;
  - the studio nav regroup, and a mod-view link for moderators who do not own the channel.

### Wave 4: the co-op, account and staff (D6 + D7)

**Shipped 2026-11-11.** The contract step was `7414d32b`, with `2447254f` (the shared
`SettingsSection`, `SettingsRow` and `DangerZone`) and test fixes up to `5d4bc2b3`; its CI (run
43024463583) was green on rerun. What the step added:

- preference types for go-live, governance, payout, creator and the weekly digest, stored in their
  own enum (0057 merged the old `proposal`/`vote_open` rows into `governance`);
- `users.first_notify_optin_at`, set once by triggers (0058);
- case claiming (`moderation_cases.assignee_id`, staff only by trigger);
- `transparency_notes`, `notification_digest_sends` and the markable `get_paid` step;
- the `report_outcome` and `moderator_added` types;
- the `AUTH_ROUTES` for security;
- stubs for `me.deletion.preview`, `chat.bans.bulk`, `transparency.setNote`, `admin.overview`,
  `admin.user`, `admin.revealEmail` and `moderation.assign`, and a `staff` access level.

Nine units ran in one workflow pass (d6-transparency, d6-governance, d6-studio, d7-settings,
d7-security, d7-notify, d7-admin, d7-mod, d7-pwa), merged at `a979e7d6`..`78c38f34` with the
integration fixes up to `f3d0b2cb`. d7-security added one dependency, `uqr@0.1.2` (MIT), for the
two-factor QR code. CI follow-ups were `9ba429ad`, `da9b31f5`, `83914864`, `50e449e6`,
`55af9739`, `852d5252`, `aaecc5e8` and `ab074420`. `55af9739` fixed a real stall: the settings
shell read appeals, copyright notices and the deletion request on every settings page load, which
filled `e4b-money`'s payer bucket with 429s. `Me.settingsSummary` now carries all three, so the
shell makes no requests of its own. Two more were also real: `aaecc5e8` taught `account-deletion` the new dialog's "I downloaded my data" step, and
`ab074420` stopped the en-XA scanner flagging another run's username. `852d5252` fixed the
`postgres-health.int` slow-replay flake after its second recurrence. CI on `ab074420` (run
43071355872) was green on the first attempt, harness included; every earlier attempt is explained
in `docs/operators/flakes.md`.

Recorded calls (conservative defaults; the maintainer can revisit):

- **Notifications:**
  - Governance email is not offered until a governance mailer exists (wave 5); its unsubscribe
    list keeps its rows.
  - Payout notices always reach the inbox, as financial records. The payout email follows its
    preference, which is on by default as it always was.
  - Governance and creator in-app preferences apply when the inbox is read.
  - The weekly digest goes out on Mondays from 09:00 UTC (members have no stored time zone), lists
    only servable public media, and is skipped when empty. Its opt-in is recorded in
    `consent_records` under its own policy version.
  - Go-live display names and avatars are joined at read time, never stored.
- **Transparency:**
  - The deficit note states only the ledger figures. It says who covers the gap only through the
    treasurer's own note, and never what creators' 90% does (open question 4 stays open).
  - "How we count" says the creator's own player still counts, because leaving the owner out has
    not shipped (wave 5).
  - The month-note audit row stores the note's length, never its text.
- **Settings:**
  - The avatar reuses the channel upload, since every account has a channel.
  - The deletion preview shows a legal hold only for litigation holds, never for holds that could
    tip someone off.
  - The autoplay-previews switch is gone until a preview player reads it.
  - `features.payouts` is on for both adapters.
  - Get paid applies after the first stream, never blocks `complete`, and can be closed with
    "Not now" or "I've contacted the treasurer".
- **Staff:**
  - Only open cases can be claimed. Nobody claims a case about themselves, and a moderator cannot
    take over another's claim.
  - Bulk actions are dismissals and assignment only, one audit row each.
  - An email reveal is audited with the admin's reason and no address in the details.
  - The audit CSV defuses formula cells.
- **Moderation:** `chat.bans.bulk` only times people out, never bans, and skips the owner, staff and
  moderators. `report_outcome` is sent once per report (the first decision wins), never to the
  reported account. `moderator_added` is not sent again for a role already held.

What was left, and where it went:

- **To the maintainer (browser checks, never run):**
  - `/settings/security`: set up two-step with a real authenticator app, sign in with a code, add a
    passkey, and use "Sign out everywhere else";
  - the settings shell at 1024 px (side nav) and 375 px (select), the deletion banner, and the
    three-step delete dialog;
  - the notifications grid stacked at 320 px, and `/inbox` filters;
  - the admin queue layout's keyboard shortcuts (j/k, Enter, e, ?) and the list-only view below
    1024 px;
  - the PWA install offer after a second visit with 3 minutes watched, the offline page, and the
    iOS Add to Home Screen hint;
  - the transparency v2 bars and table fallbacks, and the council grid's Show all;
  - the visual check of the security and notifications page headers, and of the portability grants
    section after it moved from a Card to a SettingsSection.
- **To wave 5:**
  - Nothing sends the new-sign-in email. d7-security removed an over-eager sender: it needs a
    `session.create.after` hook that skips already-authenticated requests, and an int test.
  - Moving the per-channel go-live overrides from `/settings/notifications` to `/following`.
  - A governance mailer (vote opened, result published), then offering governance email.
  - Server-side date filters for `safety.auditLog`, and `AdminQueueCount.nextDueAt`.
  - The studio mod view on `QueueLayout`; `components/coop/admin.tsx` on the admin width rule after
    a visual check.
  - `docs/testing/b8-selectors.md`: document `/admin/appeals?case=` and the `appealq-*` ids.
  - Small optional contract tidy-ups the units asked for: `PREFERENCE_MEDIA.payout` without
    `in_app` (it is always on), `NOTIFY_JOBS` entries for the digest and video-ready sweeps,
    `Bootstrap.instance.payouts`, and rendering the PWA screenshot SVGs to PNG at build.
  - A `beforeinstallprompt` fired before the shell bundle runs is still missed (it would need an
    inline script).

The plan as written:

- **D6, the co-op:**
  - from wave 2: a test for `apiSupportClient.memberRule` (the support dialog's member line) against the API;
  - transparency v2, with a "How we count" section for verified viewers (from wave 3: the watch
    page's `VerifiedViewers` links to it once it exists);
  - from wave 3: a `Get paid` checklist step from an `instance.features.payouts` flag (J2-h);
  - plain-language governance (no JSON, "90% → 85%", proposal cards, vote bars, timelines);
  - council pages;
  - the studio co-op card.
- **D7, account and admin:**
  - from wave 2: an opt-in history (or a first-opt-in column), so that the `notify_optin` growth metric counts first opt-ins exactly;
  - the settings shell and `/settings/account`;
  - `/settings/security` (two-factor, passkeys, sessions; this also closes the dead email link);
  - the notifications grid, `/inbox` and the weekly digest;
  - the deletion preview;
  - the admin home, QueueLayout, `/admin/audit` and `/admin/users/$username`;
  - the installable app: the manifest, the offline page and the install offer;
  - report outcomes and the made-moderator notice;
  - from wave 3: bulk wave moderation, `chat.bans.bulk` (J5-d).

### Wave 5: cleanup and the deferred decisions

**Shipped 2026-11-11.** The contract step was `6552ef20`, with `790b702d` and `14044f72`. It added:

- the channel schedule: migration 0059 (`channel_schedules`, `channel_schedule_slots`, `channel_schedule_one_offs`) and the 0060 triggers (a known time zone, at most 21 slots and 100 one-offs, a skip names a slot of the same channel);
- `LoyaltyBalance.earnedToday` (the caller's own balance only), `stream.lastBroadcast`, `Channel.viewer.subscribed`, `Channel.nextStreamAt`;
- the audit log's `from`/`to`, `AdminQueueCount.nextDueAt`;
- the deletion marker `subscriptions.renewal_stopped_by_deletion_id`, `coop.shares.askRefundDetails`, and ADR 0042;
- the new `NOTIFY_JOBS` and UI metric names.

Seven units ran in one workflow pass (w5-viewers, w5-schedule, w5-deletion, w5-watch, w5-studio, w5-notify, w5-admin), merged at `dbfbf7d2`..`be7b7003` with the integration fixes up to `3d04c229`. The 14 px sweep ran after them on the merged result and was merged at `13c70418`. No unit added a dependency or an env var. CI follow-ups were `4f30a430` and `9f1233cc` (two chat flakes fixed at their third occurrence), `b5debc56` and `4b07c7c5`. CI on `__HEAD__` (run **RUN**) was green; every earlier attempt is explained in `docs/operators/flakes.md`.

What shipped:

- **Viewer counts:** the signed-in channel owner is left out of the live count, the health card, the rollup and attestations. ADR 0014 has an amendment.
- **Schedule:** the studio `/schedule` page (weekly slots in the channel's time zone, one-offs, skips); the offline channel's next-stream card with "Add to calendar" (one `.ics`) and "Subscribe in calendar" (a first-party `webcal:` feed); the weekly schedule on About, fetched only when About opens.
- **Deletion (ADR 0042):** renewal stops when a deletion is requested; cancelling the deletion turns back on exactly what it turned off; treasurers see members leaving and can have the platform ask them for refund details.
- **Watch:** the subscribers-only reason before typing (J3-d), "Today: N of {cap}" in the points popover, and the per-channel go-live alerts on `/following`.
- **Studio:** exact recap counts from `stream.lastBroadcast` (fewer requests than the paging it replaced), the J2-e share prompt on the first encoder connection, and the studio mod view on `QueueLayout`.
- **Notifications:** the new-sign-in email (at most one per member per 10 minutes, never for refreshes or the first session); the governance mailer (vote opened to the electorate, result published to active members); governance email is offered; payout in-app is always on.
- **Staff:** audit-log date filters (UTC days, in the URL), "Next due" on the admin queue tiles, `/admin/coop` on the admin width rule, and the b8 selectors doc for `/admin/appeals?case=`.
- **The 14 px sweep:** reading text (paragraphs, help text, card, dialog, popover and empty-state bodies, form hints) moved to 14 px from the shared primitives out. Tables, key-value lists, metadata, chart captions, keyboard hints, chat and player chrome, and form controls stay at 12 px.

Recorded calls (conservative defaults; the maintainer can revisit):

- **Deletion money (ADR 0042):**
  - No automatic proration. Renewal stops at the request, so paid time runs out during the 30-day grace; `past_due` subscriptions end at once, as a member's own cancel does.
  - A provider that cannot stop a renewal refuses the request, so no deletion is ever pending while a card can renew. A provider outage at cancel leaves the subscription ending on both sides and never blocks keeping the account.
  - A deletion never waits on a share refund. The treasurer asks through the platform (at most once a day per share, audited by id); the member replies to the instance's general contact, since there is no treasury address; after deletion the refund stays owed by share id.
- **Viewer counts:** only the owner's signed-in sessions are left out; the copy says exactly that. Matching the owner's devices or address is a follow-up in the amendment.
- **Schedule:** schedule edits are ordinary owner actions (no audit row). The next-stream card shows the time but no category, to add no request. The time zone picker is a curated list (the intl policy forbids `Intl.supportedValuesOf`).
- **Chat gate:** VIPs are exempt before typing, as the server is; staff are not locked out before typing. The button says "Sub to chat" (voice guide).
- **Notifications:** governance email is opt-in, and a vote-opened mail is never sent after voting closed. The new-sign-in mail says the account "was just signed in to", since nothing tracks devices.
- **Studio:** recap chat counts include held and deleted messages (they were sent); `lastBroadcast` skips rehearsals, like `lastLiveAt`.

What was left, and where it went:

- **To the maintainer (browser checks, never run):**
  - `/schedule` at 320 and 1440 px, the time zone picker, and saving with a one-off in progress;
  - the offline channel's next-stream card, "Add to calendar" in a real calendar app, and the `webcal:` feed subscription;
  - the subscribers-only gate and "Sub to chat"; the points popover's "Today" line;
  - `/following`'s per-channel alerts (the Select inside the Popover) at 320 px;
  - the share prompt on a first go-live (Copy link, the share sheet on a phone);
  - the studio mod view on `QueueLayout` at 1024 px and below;
  - the delete dialog's new copy and the treasury's "Members leaving" panel;
  - the notifications grid (governance email, payout "Always") at 320 px;
  - `/admin/audit` date inputs, the queue tiles' "Next due", and `/admin/coop` at its new width;
  - the 14 px sweep across the app in both themes, above all the studio, admin and money pages.
- **Small follow-ups (not built):**
  - Go 1.27.4 for GO-2026-6859, due on or after 2026-11-17: the toolchain, the golang image pins (`bun scripts/pin-images.ts --write`) and CI's `GO_VERSION`, then remove the dated exception in `supply-chain.json`, which expires on 2026-11-18.
  - A `channel.schedule.updated` event; `browserTimeZone()`/`timeZoneNames()` in `packages/ui` so the picker can list every zone.
  - A `leaving` filter on `coop.shares.list` (the treasury tab now reads every page of held shares, capped at 50); a treasury contact address (`TREASURY_EMAIL`).
  - The raid viewer count (`packages/interact/src/raids.ts`) still includes the owner.
  - `NOTIFY_DEFAULTS.payout.in_app` and `SettingsClient.follows`/`setBell` are unused leftovers.
  - A member who subscribes mid-session stays gated until the next chat join (the Stripe redirect reloads, so the common path is fine).
  - The PWA screenshot SVGs are not rendered to PNG at build, and a `beforeinstallprompt` fired before the shell bundle runs is still missed.
- **Parked by decision:** the interest list and points redemption (decisions 3 and 4).

**The overhaul plan is complete:** waves 1 to 5 have shipped. What remains is the maintainer's browser checks above, the dated Go upgrade, the small follow-ups listed, and the two parked decisions.

The plan as written:

- the app-wide 14 px reading-text sweep;
- the ADR 0014 amendment, plus leaving the owner out of viewer counts;
- the `ChannelSchedule` contract (next stream, Add to calendar);
- a proration policy for unused paid time at deletion;
- how treasurers reach deleted members to refund bank-transfer shares;
- from wave 3: the subscribers-only chat reason before typing (J3-d), `LoyaltyBalance.earnedToday`,
  `stream.lastBroadcast` for exact recap counts, and the J2-e first-connection share prompt;
- from wave 4: the new-sign-in email sender, the per-channel go-live overrides on `/following`, a
  governance mailer, audit-log date filters and `nextDueAt`, the studio mod view on `QueueLayout`,
  the b8 selectors doc, and the small contract tidy-ups (the wave 4 "To wave 5" list);
- the interest list and points redemption stay parked until their triggers (decisions 3 and 4);
- from wave 2: Go 1.27.4 for GO-2026-6859 on or after 2026-11-17, for the toolchain, the golang image
  pins and CI's `GO_VERSION`; then remove the dated exception in `supply-chain.json`.

## What these passes did not cover

- **The admin consoles:** reviewed from source and mocked, never walked live; `streamer1` is not an
  admin.
- **The mod view of another channel:** journey 5 is from source.
- **768 and 320 px on the live signed-in pages:** spot-checked. The mockups cover 320.
- **Staging under load:** nine agents on one IP tripped the rate limit, which is how F1 to F3
  surfaced. Some screenshots show error states for that reason.

## Files (this folder)

- Reports: `art-director.md`, `discovery.md`, `watch.md`, `growth-funnels.md`, `creator-studio.md`,
  `coop-trust.md`, `account-admin.md`, `responsive-a11y.md`, `market-research.md`. Each has full
  findings, ASCII wireframes, the components it uses, copy direction, and its references.
- `art-direction-v1.md` is the visual spec. `decisions-log.md` holds all 66 cross-team agreements.
- `round2/`:
  - Reports: `direction-check.md`, `viewer-count.md`, `scope-calls.md`, `ux-journeys.md`,
    `voice-copy.md`, `mockups-acquisition.md` and `mockups-product.md`.
  - `direction-check/contrast-out.md`: every contrast pair and its result. The contrast script, the prototype and both mockup sets stay outside the repo for now.
