<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# mockups-product: in-product mockups (round 2)

**In short:** there are eight self-contained HTML pages in `round2/mockups/product/`, with 38 states
between them. Each page has a state picker and a dark/light switch. They are built on
mockups-acquisition's shared `tokens.css` and `shell.js`, with direction-check's contrast rules
applied. I checked every page in both themes at 1440, 375 and 320. The 320 check also confirms
none of them scroll sideways.

View: `cd round2/mockups && python3 -m http.server 4175 --bind 127.0.0.1`, then
http://127.0.0.1:4175/product/ (the index links every state). Add `?state=<id>&theme=light|dark`
to a URL to pin a state and theme.

## 1. Pages and states

| Page                       | States (`?state=`)                                                                              | Covers                       |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------- |
| `channel-live.html`        | following, menu, firstfollow, notfollowing, signedout, quiet, points                            | D4.3, D4.4, D4.7, D2.1, D3.8 |
| `channel-live-mobile.html` | chat, about, typing, firstfollow, firstfollow-ios, checkout-pending, checkout-return, signedout | D4.1, D4.3, D2.6             |
| `channel-offline.html`     | schedule, noschedule, never, signedout                                                          | D3.8, D4.7                   |
| `studio-dashboard.html`    | new (checklist, step 3), waiting (step 4 live check), live (LiveStatusBar), recap               | D5.1, D5.2, D5.3, D5.8       |
| `mod-view.html`            | normal, raid, switcher                                                                          | D7.5 compact, ux-journeys #4 |
| `settings.html`            | account, security, privacy, delete, scheduled                                                   | D7.1, D7.2, D7.4             |
| `admin-queue.html`         | case, bulk, empty, nomatch                                                                      | D7.5 QueueLayout             |
| `index.html`               | the list of all states                                                                          |                              |

Shared files:

- `extra.css`: product-only components (watch layout, chat, menus, switch, checklist,
  LiveStatusBar, settings rows, QueueLayout).
- `product.js`: the state picker, tabs, switches and sprite icons.
- `icons.svg`: 81 real Hugeicons, built from the repo's `@hugeicons/core-free-icons` 4.3.5 (MIT).

Content comes from staging, which I looked at as streamer1 and changed nothing:

- **Lumen Beats:** live, Music, 8 verified viewers, 1,178 followers, the goal "New friends goal
  32/50", and seeded chat such as `demo_v00587`.
- **Sly Kettle:** offline, Strategy Games, 791 followers, Creator council. Its panels and rules are
  the seeded ones.
- **The rail:** Velvet Gecko, Fern Ledger and the other seeded channels.
- **The studio:** the real recommended encoder values from `services/api/src/stream/ingest.ts:6-21`.

## 2. Design decisions beyond round 1

1. **The first-follow prompt's main button is neutral.**
   - Push uses the zinc primary, Email is an outline button, and Not now is a ghost button.
   - Support keeps the one accent fill. This follows direction-check rule 4, which also applies to
     accent fills.
   - On phones the prompt is a bottom sheet instead of a popover.
2. **On iOS before install, push never appears as a dead option.**
   - The sheet offers "Email me", plus a hint: "Add to Home Screen for phone alerts".
   - This came from ux-journeys.
3. **The Following button is two parts.**
   - The left part shows the bell state. The chevron opens the menu.
   - On phones, only the bell and the chevron show, which keeps the 56 px row from squeezing the
     name.
   - The menu follows voice-copy: "Alerts: All streams" or "Off", a switch for "Email me if they
     move", then Unfollow (red, with a ConfirmDialog).
4. **The player bar gets a Clip button** (key X, with a tooltip). Below 640 px, Captions, PiP,
   Theatre and the volume slider move out of the bar.
5. **The offline hero sits beside the latest video in a 62/38 split,** reusing the feature-card
   ratio.
   - The schedule shows as a date block in the channel accent, with "Add to calendar" as a ghost
     button.
   - Fallbacks: no schedule ("Last live… Follow to hear when they're back") and never live (the
     arcs MediaFallback replaces the video).
   - Chat stays visible offline: quiet, with the rules, and the input disabled ("Chat opens when
     they go live").
6. **The trust badge is outlined, never filled:** Member-owner on live About, Creator council on the
   offline header.
7. **The checklist is capped at 1120 px inside the 1600 px studio board,** because the form fields
   look lost at full width.
   - Its one brand fill is "Create stream key".
   - Done steps keep an "Edit" or "Replace" ghost action, so nothing is a dead end.
   - Voice-copy's corrected subtitle is used ("2 of 6 steps done"). There is no time-to-finish
     claim; the per-step estimates stay.
8. **The LiveStatusBar has three forms.**
   - Live: badge, uptime, verified count, a health word with a bars icon, and the title with an
     Edit button.
   - Offline: "Not set up yet · 2 of 6 steps done".
   - Recap: "Last live 20 minutes ago".
   - Below 640 px its actions shrink to icon buttons and the title wraps to its own row.
9. **The recap is a first-stream recap.** The member-owner notice is a brand-subtle Callout, not a
   fill.
   - "Bring your Twitch viewers" with the follow link comes from ux-journeys. It needs a
     "Grow › Bring your audience" studio item instead of "Move channel".
   - Recap numbers are labelled provisional.
10. **The studio phone layout puts chat first,** using CSS `order`. A "Studio ›" breadcrumb button
    replaces the sidebar.
11. **Settings use the shared `SettingsRow`.** The label and hint sit on the left and the control on
    the right, stacking below 640.
    - The email is masked, with a "Verified" badge (icon and word).
    - Sessions show only the browser and system, never an IP, with a line saying so.
    - DangerZone is a destructive ring with no fill. The account page's DangerZone links to Privacy
      & data, so deletion has one home.
12. **The delete dialog is one AlertDialog with three numbered parts:** the impact list, "download
    first", and typing the username.
    - The final button reads "Delete in 30 days". The number comes from the deletion grace
      setting and is never hard-coded; 30 is the value ux-journeys found in
      `services/api/src/moderation/deletion.ts:16`, which voice-copy could not confirm in config.
    - It stays disabled until parts 2 and 3 are done.
    - The "scheduled" banner is a sunken strip with a red top rule, shown on every settings page.
13. **Admin QueueLayout:**
    - Rows show the due time on the right, in red with weight only when it is under an hour.
    - The assignee is a neutral badge.
    - Evidence frames are blurred, with "Show" buttons. Revealing a frame writes to the history.
    - Bulk mode swaps the detail pane for a note on what may not be done in bulk.
    - The decision card's Decide button carries its `e` key hint.
14. **Mod view:**
    - A chat-modes toolbar (Slow, Followers only, Emotes only, Surge, Clear chat).
    - An incoming-raid strip with one-tap Followers-only for 10 minutes, and Surge mode.
    - A "Channels you moderate" switcher in the status bar.
    - The held queue reuses the compact QueueLayout rows.
15. **The checkout return (ux-journeys).**
    - First "Payment received. Confirming…", until the webhook confirms the payment.
    - Then "Thanks. Lumen Beats gets about $4.50 of your $5.00 sub each month." It says "about" because the 90% is worked out after sales tax.
    - Then "You'll be a co-op member within the hour", shown only for subs of $3 or more, because membership sync is hourly. The
      mockup never promises membership straight away.

## 3. Open questions

Settled during round 2 and now in the mockups:

- **Header avatar and icons.** `shell.js` now takes `data-avatar` and `data-accent`; signed-in
  pages show "A" in pink (Aurora Pixel). Both mockup sets now use the same Hugeicons paths. I
  added arrowRight, arrowDown, book, code, chat and sparkle to the sprite for mockups-acquisition.
- **Viewer count (F6), per viewer-count.**
  - Every live surface says "{n} watching". The channel page adds a "Verified viewers · How we
    count" link.
  - The dashboard tile is "Watching now" with "Peak so far 11", plus the hint "Watching now counts
    verified viewers right now. Final numbers settle after the stream."
  - The recap says "Peak so far" and "Average watching", and notes that final figures appear 24
    hours after the stream ends.
- **Deletion impact.** Deletion doesn't cancel paid subscriptions or end co-op membership today.
  - The dialog now uses voice-copy's interim line instead: "deleting your account doesn't cancel
    subscriptions yet. Cancel them on your subscriptions page first."
  - That line is marked "Depends on fix F0", and the co-op share line is removed.
  - The removed, kept and payout lines are voice-copy's `privacy.deletion.preview.*` strings.
- **Delete button.** It renders "Delete in 30 days", but the number comes from the deletion grace
  setting (`privacy.deletion.confirm`).
- **Checkout return.**
  - It says "about {amount}", because the 90% is worked out after sales tax, and it uses "each
    month".
  - The success message shows only after the webhook confirms. Until then: "Payment received.
    Confirming…".
  - The member line shows only for subs of $3 or more.
- **Points (scope-calls option B).** `channel-live.html?state=points` shows the change.
  - The composer has a neutral outline chip with a sparkle icon (no coin) and the balance.
  - Its popover shows the balance, and says points are "earned only from verified live watch time"
    (10 every 5 minutes, up to 1,000 a day), with today's progress toward the cap.
  - It lists what points can be spent on now: the open prediction, an extra poll vote, and paid
    bot commands.
  - The chip is hidden at zero when there's nothing to spend, and on the owner's own channel.
- **Signed-out chat gate.** "Create account" stays the neutral primary, as the orchestrator agreed.

Still open:

1. The **Schedule tab** is shown in the tab row. It should stay hidden until the
   `ChannelSchedule` contract request lands.
2. **Points name and spend list:** the mockup calls Lumen Beats' points "notes", as a
   channel-chosen `{name}`. The paid commands and their costs are examples, until we check what
   `bot.commands` returns to viewers.

## 4. Coordination

- **mockups-acquisition:** I use their `tokens.css`, `shell.js`, fonts, mockbar, header and scene
  classes. I don't copy them.
- **direction-check:** I applied all seven rules: brand ring in light, the focus offset, 14/600 CTA
  labels, no brand beside primary, a non-amber accent (violet and sky), 12 px admin meta, and
  warnings with an icon and a word.
- **voice-copy:**
  - Checklist labels and hints, including both corrections.
  - The first-follow prompt, the Following menu, the offline hero and its fallbacks.
  - The chat welcome, the Security intros, and the queue empty and no-match states.
  - The deletion banner.
- **ux-journeys:** all five extra screens are in. The ids are in the table above.

## 5. References

None from outside. Everything comes from the round 1 reports, the repo and staging.
