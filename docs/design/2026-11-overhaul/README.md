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
