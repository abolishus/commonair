<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Creator studio: investigation report (creator-studio, prefix CS)

Date 2026-11-06. Scope: `apps/web/src/routes/_studio.tsx`, every `_studio/*` route and `overlay.*.tsx`.
Method: source read, plus a live walk on staging signed in as `streamer1` (live with a test pattern) at
1440×900 dark and 375×812 dark. Nothing was saved, toggled, rotated or sent. Staging was rate limiting
the shared IP (429s) during the walk, which turned out to be a finding in itself (CS-3).

Baseline: the 2026-11-03 review's studio findings F21–F36 mostly **landed in D5-studio** (`a001fbf9`,
`b2312748`). These are now in place: the control-room dashboard, `/dashboard/settings`, the grouped sidebar,
`/mod/$channel`, range trends with previous-period deltas, empty-state actions, PageHeader stacking,
stacked ledger rows at 375 px, and the paged captions editor. This report does not repeat those
findings. It covers what is still missing: **onboarding, the cockpit's priorities, insight, and growth.**

---

## 1. What exists now

| Route                                                                              | What I saw (live as streamer1, or from source)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sidebar (`_studio.tsx`, `lib/nav.ts:288-317`)                                      | Five groups (Stream, Community, Content, Money, Tools) and 17 items. Stream holds Stream manager, Stream settings, Rehearsal, Alerts & overlays, Captions and **Relays**. The Relays program serves bandwidth for patronage and has nothing to do with streaming.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `/dashboard`                                                                       | A 2/3 + 1/3 grid. Left: muted preview, "Stream health" (verified viewers 16, uptime, bitrate 951 kb/s, 30 fps, 0 dropped, 640×360) and **under it a large "No problems detected" empty state**, then "Edit stream info". Right: chat (full height), Quick actions (poll, rehearse, settings) and Activity ("Nothing yet"). At 1440×900 only the preview and the top of health are above the fold; the title editor is a full scroll down. While the API was throttled, three cards showed "could not be loaded. Reload the page" with no retry button, and the health card showed its **error and live numbers at the same time**. The player's "Quality and Data saver moved" coachmark covers the studio preview. |
| `/dashboard` 375 px                                                                | The header stacks correctly now (F29 fixed). The order is preview, then health, then info, then chat **below everything**. A phone streamer has to scroll past three cards to read chat.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `/dashboard/settings`                                                              | Stream setup (RTMP URL, key prefix, "Replace stream key"), Live rewind, Simulcast, Discord, Channel appearance and Fediverse, stacked in one column. It does **not** show the WHIP URL, the recommended encoder settings or the downloadable OBS profile, even though the API returns all three (`IngestInfo.whipUrl`, `IngestInfo.recommended`, `stream.obsConfig`: `packages/contracts/src/api/entities.ts:187-202`, `router.ts` `stream.obsConfig`). The only guidance is one sentence: "In OBS, set Service to Custom…".                                                                                                                                                                                        |
| `/rehearse`                                                                        | A good feature (private test run, a checklist, a report). It is a separate page that the dashboard links to only from Quick actions. With no key, it says "Create one on the dashboard" and links to `/dashboard`, but the key now lives on `/dashboard/settings` (`components/rehearsal/panel.tsx:167-169`).                                                                                                                                                                                                                                                                                                                                                                                                       |
| `/analytics`                                                                       | Six stat cards with deltas (verified, peak, unverified, excluded, cost; followers when available); "By day" uses a **line chart for daily sparse data**, flat at 0 for 29 days and then a spike, with decimal ticks (0.025). Below that: a broadcast picker, broadcast stat cards, "Audience over time" (three flat series with direct labels) and "Left out of your counts". The live broadcast is already listed, with **peak verified 4** while the dashboard says **16 verified viewers**. Loading is six text-line skeletons, not shaped like tiles or a chart.                                                                                                                                                |
| `/revenue`                                                                         | Four tiles: Available $0, Held $0, **Owed $18 in an amber highlight**, and Earned $711.36. There is no "Paid out" tile, so Earned $711 against $0 available and $0 held doesn't add up until you find the payout row in the ledger. The daily revenue chart uses a **smoothed line that implies values between days**. By source shows a stacked bar; subscribers by tier is a table. The ledger is 25 rows, and the detail column shows **raw processor ids** (`pi_harness…`) beside supporter names. The payout card says **"Payouts enabled" and also "The instance has not set up payouts yet"**. The tier editor sits at the very bottom, so earning setup comes after reporting.                              |
| `/content`                                                                         | A list of inline forms, one per VOD: a title input, a visibility select, Save and Delete, plus "Recording 0:00" / "Ready 25:29". There are **no thumbnails, view counts, watch links, clip counts or "make a clip/highlight" action**. The Clips tab works the same way.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `/overlays`                                                                        | Four alert cards (tip, follow, sub, raid), each with its own preview, form and Save, plus one "Overlay URL" card labelled **"Alerts URL"**. The **chat overlay (`/overlay/chat`) and goals overlay (`/overlay/goals`) take the same token, but no studio page mentions them**; I grepped and found no link anywhere. "Raid alerts fire once raids are available" is stale, because raids ship under Polls & raids. The page gives no browser-source size and no OBS steps.                                                                                                                                                                                                                                          |
| `/interact`                                                                        | Polls, predictions, raids and goals. Goals are only here; the dashboard has no goal progress.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `/mod/$channel`                                                                    | Chat, the held queue and recent actions (F23 landed).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `/chat`, `/bot`, `/captions`, `/crew`, `/relays`, `/move`, `/import`, `/developer` | Unchanged since review D5, apart from its fixes. Import appears only when `twitchImport` is on. Move and Import are buried under "Tools".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `overlay.alerts/chat/goals.tsx`                                                    | Transparent, chrome-free, token in the query string. They work, but the studio surfaces only one of the three.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Onboarding                                                                         | **There is none.** I grepped for onboard, checklist, getting started, wizard and first stream and found no hits in the studio. Every account gets a channel at signup (`services/api/src/auth/index.ts:50`), so every new user, viewer or not, lands in the same empty control room.                                                                                                                                                                                                                                                                                                                                                                                                                                |

---

## 2. Findings

**CS-1 (high) No path from zero to first stream.** A new account opens `/dashboard` to an offline
preview, "You are offline", an empty Edit stream info form, empty chat and an empty activity feed. The one
call to action is "Set up your stream" inside the health card, which leads to a settings page of six cards.
The steps a new streamer needs are spread across four pages: name and avatar (`/dashboard/settings`
appearance), title and category (`/dashboard` info), key (`/dashboard/settings`) and test (`/rehearse`).
Nothing shows progress. Evidence: `routes/_studio/dashboard.tsx`, `components/studio/stream-manager.tsx`,
`stream-health-card.tsx:169-176`.

**CS-2 (high) Encoder setup is one sentence; the API's guidance goes unused.** `stream.ingest` returns
`recommended` (codec, resolution, fps, bitrate, keyframe interval, rate control, audio bitrate, notes) and
`whipUrl`, and `stream.obsConfig` serves a downloadable OBS service file. The web uses none of them (no
hits for `recommended`, `whipUrl` or `obsConfig` in `apps/web/src`). Health warnings later tell the
streamer to "set the keyframe interval to 2 s", a fix that could have been the default from the start.
Evidence: `components/studio/stream-setup.tsx`, `i18n/locales/en/*: dashboard.streamSetupHint`.

**CS-3 (high) Transient errors strand the studio.** Under 429, a studio navigation bounced a signed-in
streamer to `/signin` with no return path (`/analytics` → `/signin`), because the server guard treats a
failed `/me` as signed out. account-admin found the root cause in `server/bootstrap.ts:80` and it is logged
as agreed. On `/dashboard`, "Edit stream info" fails once and stays failed, showing "Reload the page" with
no Retry (`components/studio/stream-info.tsx:120,207`). Health keeps its error banner over fresh numbers
(`stream-health-card.tsx:166-168`, where `failed` is set while `health` is kept). Mid-stream, this is the
worst place for "reload the page".

**CS-4 (high) The control room gets its priorities wrong for live work.**

- At 1440×900 the title and category editor and the live numbers are below the fold, under a full-width
  16:9 preview of the streamer's own stream.
- The "healthy" state repeats a 120 px empty state under the numbers.
- On a phone, chat comes fourth.
- There is no persistent live state (Live/Offline/Rehearsing, uptime, viewers) across studio pages, so on
  `/overlays` or `/interact` the streamer can't tell they're live.
- Evidence: `stream-manager.tsx:44-60`, live walk at 1440 and 375.

**CS-5 (med) The dashboard shows two "verified viewer" numbers that don't match.** Live health says 16
verified viewers; analytics for the same running broadcast says peak verified 4 (with 12 excluded). For a
platform whose pitch is honest counts, a mismatch on two adjacent pages is a trust bug. Either health is
counting before exclusions, or the label is wrong. Evidence: live walk; `stream-health-card.tsx`
`health.viewers.verified` vs `analytics.broadcast.totals`.

**CS-6 (med) Chat and goal overlays can't be found.** `/overlay/chat` and `/overlay/goals` exist and take
the same token, but `/overlays` shows only an "Alerts URL". There is no suggested browser-source size and
no OBS steps. Evidence: `components/overlays-studio.tsx:89`, `routes/overlay.chat.tsx`, `routes/overlay.goals.tsx`;
grep shows no link anywhere.

**CS-7 (med) Content is a row of forms, not a library.** It has no thumbnails, views, watch links or
per-VOD performance, and no "clip this" or "highlight" action. The creator can't see which videos worked
or act on them. Evidence: `/content` live; `packages/ui/src/blocks/studio/content-board.tsx`.

**CS-8 (med) Analytics charts use the wrong form, and the page gives no insight.**

- Daily sparse metrics (hours, peak, revenue) are drawn as continuous or smoothed lines. They should be
  bars.
- Decimal ticks still appear for hours (0.025).
- There are no "what to do next" insights: best time and day, average watch time per viewer, follows per
  hour streamed, which broadcast grew followers, top clips.
- `analytics.pnl` (revenue against serving cost, per broadcast) exists in the contract but isn't used on
  any page.
- Evidence: `analytics-page.tsx:170-260`, `revenue.tsx:155-215`, `router.ts` analytics.pnl.

**CS-9 (med) Revenue reads as a ledger, not as a creator's money page.**

- No "Paid out" tile, so the tiles don't reconcile.
- "Owed" uses the amber that art direction now reserves for brand.
- Raw `pi_…` ids sit in the detail column.
- The payout card contradicts itself ("Payouts enabled" plus "has not set up payouts").
- The earning setup (tiers) is below 25 ledger rows.
- No line says what share the creator keeps or who set it.
- A stray "x" renders after the payout progress hint (seen in page text; to verify).
- Evidence: `components/money/revenue.tsx:101-150, 540-583`; `routes/_studio/revenue.tsx:83-110`.

**CS-10 (med) After a stream, nothing happens.** No recap (duration, peak, new followers, top chatter
count, support received, clips made), no "share your VOD" step, and no "schedule your next stream", since
there is no schedule feature in the contract. The broadcast's analytics settle after 24 h, and the
dashboard offers nothing in the meantime. Twitch's "Stream Summary" and YouTube's post-live report fill
this moment, and it's the one where a new creator decides whether to come back (growth-funnels' metric
`second_live_within_14d`).

**CS-11 (med) The IA mixes jobs.**

- Relays (a bandwidth-for-patronage program) sits in "Stream".
- Channel identity is split: avatar and banner on Stream settings, title, socials and category on the
  dashboard editor, and name nowhere obvious.
- Move and Import ("switching" tools that matter most in a creator's first week) are under "Tools" at the
  bottom.
- The account menu still offers both "Dashboard" and "Relays" (`lib/nav.ts:228-229`).

**CS-12 (low) Stale or wrong copy and links.** "Create one on the dashboard" goes to the wrong page
(`rehearsal/panel.tsx:167`). "Raid alerts fire once raids are available" is stale (`ops.json:57`). The
preview coachmark ("Quality and Data saver moved") covers the studio preview, where it isn't relevant.

**CS-13 (low) Skeletons don't match the layout.** Analytics and revenue load as text-line skeletons, not
tile and chart shapes, so the layout jumps (F28 follow-up).

**CS-14 (low) The co-op is invisible in the studio.** Creators become streamer-class members automatically,
but the studio never says so (raised by coop-trust; the slot is agreed below).

---

## 3. Proposals

### P1. First-run "Ready to go live" checklist on `/dashboard` (CS-1, CS-2) — effort M, impact very high

Shown at the top of `/dashboard` (above the grid) until `first_live` is done. After that it becomes
"After your first stream" (3 steps) and can be dismissed. Opened from `?intent=stream|import`
(growth-funnels).

```
┌ Ready to go live ─────────────────────────────── 2 of 6 · about 10 min ┐
│ ✓ 1 Name your channel            ~1 min                                  │
│ ✓ 2 Title and category           ~1 min                                  │
│ ● 3 Get your stream key          ~2 min   [Create stream key] (brand)    │
│     Server URL  rtmp://…/live          [Copy]                            │
│     Stream key  ••••••••••••  [Reveal] [Copy]   Shown once.              │
│     EncoderGuide: [OBS] [Streamlabs] [vMix] [Phone (Larix)] [WHIP]       │
│       1. Settings → Stream → Service: Custom   2. Paste…  3. Output…     │
│       Recommended: H.264 · 1080p60 · 6000 kb/s · keyframe 2 s · CBR …    │
│       [Download OBS profile]                         Learn more →        │
│ ○ 4 Connect your encoder  "Waiting for your stream…" (live check, 10 s)  │
│ ○ 5 Rehearse privately (optional)   [Start a rehearsal]                  │
│ ○ 6 Go live   "Press Start Streaming in OBS. Support is on from day one."│
└──────────────────────────────────────────────────────────────────────────┘
```

- **Step ids** (agreed with growth-funnels, used as its funnel steps): `channel_profile`, `stream_info`,
  `stream_key`, `encoder_connected`, `rehearsal` (optional), `first_live`, plus `import_twitch` first when
  `intent=import` and `twitchImport` is on. After the first stream: turn on recording, set up tiers, add
  an alert overlay, share your channel (`second_live_within_14d` is measured by growth-funnels).
- **Behaviour.**
  - Each step is done when the server state says so, never when a click fires: a display name and
    avatar set; a title and category set; an active key prefix; a health sample seen; a rehearsal
    report; a broadcast row.
  - The current step expands inline, so the streamer never leaves the page.
  - Step 4 polls `stream.health` with the existing `pollWhileVisible` and turns green with the
    resolution, fps and bitrate it sees, then flags any mismatch with `recommended` using the existing
    warning copy.
  - Step 1 inlines a short version of the appearance card (display name, avatar), with the full card
    staying in settings.
  - A time estimate on each step (from market-research: Twitch Creator Camp's runtime labels; no
    badges).
- **Primitives.**
  - Existing: `Card`, `Tabs`, `Table`, `Button`, `Progress`, `<EmptyState>`, `<RelativeTime>`, `toast`
    and `<ConfirmDialog>` (for rotation).
  - New: `SetupChecklist` (packages/ui/blocks, agreed with art-director), `EncoderGuide` (Tabs, numbered
    steps and a Table; tool names only, no logos), and `CopyField` extended with Reveal
    (`packages/ui/src/blocks/forms/copy-field.tsx`, agreed; Rubik with tabular-nums, no monospace).
- **Data.**
  - Existing: `stream.ingest` (incl. `recommended`, `whipUrl`), `stream.obsConfig`, `stream.health`,
    `stream.rehearsal.*`, `channels.get`, and the stream-info client.
  - **New contract field (small):** `me.creatorProgress` or `stream.setupState` returning the six
    booleans in one call, so the checklist and growth-funnels' aggregate counters share one source.
    Today it would take five calls.
- **Copy.** Second person, plain, and one action per step. "Support is on from your first stream"
  (market-research MR-8: earning isn't a level to unlock). Never "Go live" as a button, because going
  live happens in the encoder.
- **Brand.** The single marigold fill is the current step's primary button (art-director).

### P2. Cockpit rebalanced: LiveStatusBar and a live-first layout (CS-4, CS-3) — effort M, impact high

```
┌ LiveStatusBar (sticky, --surface-raised, on every studio page) ─────────────────────────┐
│ ● LIVE 1:02:14 · 👁 16 verified · ▮▮▮ healthy · "Pixel art commissions…" [Edit] [Copy link] [View channel] │
└──────────────────────────────────────────────────────────────────────────────────────────┘
┌ left 2/3 ─────────────────────────────────┐ ┌ right 1/3 ─────────────────┐
│ StatTile row: Viewers · Followers today ·  │ │ Chat (fixed height,         │
│   Support today · Bitrate (sparklines)     │ │  mod actions)               │
│ Preview (16:9, max-h 40vh, collapsible)    │ │ Activity feed               │
│ Stream info (title/category/tags inline)   │ │ Goal (GoalBar studio var.)  │
│ Health: numbers; warnings only when any    │ │ Quick actions               │
└────────────────────────────────────────────┘ │ Co-op card (offline only)   │
                                               └─────────────────────────────┘
```

- **LiveStatusBar** (agreed with art-director):
  - It uses `<LiveBadge>` when live and the `StatusBadge` tones for Rehearsing and Offline.
  - It carries `<ViewerCount>`, uptime through `<RelativeTime>` in elapsed mode, and a health dot plus
    word (status is never shown by hue alone).
  - The title shows inline with an Edit popover.
  - A `compact` variant is reused on signed-in home by discovery (agreed).
- **Health card.**
  - Drop the "No problems detected" empty state when numbers are shown; the badge says "Healthy".
  - Warnings render as a `Callout` list with the fix hint.
- **Stat tiles.** A `StatTile` row with a 7-day `Sparkline` (aria-hidden; the number carries the
  meaning).
- **Preview.** Capped at about 40vh with a "Hide preview" toggle. Suppress the player coachmark in the
  studio (`renderPreview` passes a `studio` prop).
- **Below `lg`**, the order becomes LiveStatusBar, chat (as a `Tabs` pair: Chat | Activity), then stream
  info, then preview, then health. Phone streamers live in chat.
- **Errors** (CS-3): every studio load gets Retry plus automatic backoff on 429/503, matching the logged
  decision from discovery and responsive-a11y. Health shows "Last updated 40 s ago" (`<RelativeTime>`)
  instead of an error over fresh numbers. The session-guard fix belongs to account-admin
  (`server/bootstrap.ts:80`: only a 401 means signed out).
- **Width.** Boards (`/dashboard`, `/mod`, `/content`, `/overlays`) at 1600; forms at 1120 with 768
  inside (agreed with art-director).

### P3. Stream recap after each broadcast (CS-10) — effort M, impact high

When a broadcast ends, a "Stream recap" card takes the top of `/dashboard` until dismissed or until the
next stream starts. It shows:

- duration, peak and average viewers (marked "provisional, settles in 24 h", with a link to analytics);
- new followers (from `followsSince`);
- support received (`money.revenue` for the period);
- messages, and clips made;
- "Your VOD is ready: [Share] [Make a clip]".

After the _first_ stream it hosts coop-trust's one-time "You're a member-owner" Callout (agreed; copy keys
`coop.studio.welcome.*`) and the post-first-stream checklist.

- **Data.**
  - Existing: `analytics.broadcast`, `channels.followers`, `money.revenue`, and the clips list.
  - New: a `broadcast.summary` (messages count, clips count, peak unverified) would save four calls.
    That's optional.
- **Copy.** Factual, never hype ("12 new followers", not "Amazing stream!").

### P4. Overlays: all three, with OBS help (CS-6) — effort S, impact med-high

- Rename the URL card to "Overlay links".
- Show three `CopyField`s from the one token, Alerts, Chat and Goals, each with:
  - its recommended browser-source size (alerts 800×600, chat 400×800, goals 800×120);
  - a mini preview;
  - "How to add in OBS" (shared `EncoderGuide` steps for browser sources).
- Save the four alert cards with **one** sticky save bar, not four Save buttons. Use `Tabs` per alert type
  at 375 px.
- Fix the stale raid note.
- **Data:** the existing token, plus the URL paths. The token is shown once, so the page builds all three
  URLs at the moment of creation and explains that rotating replaces all three.

### P5. Content library (CS-7) — effort M, impact med

- **Layout.** A `MediaCard` grid (shared with discovery's `MediaCard kind=vod|clip`) with a thumbnail,
  duration, `<RelativeTime>`, visibility badge, views and a "Clips 3" count, plus an overflow menu (Edit,
  Make clip, Copy link, Delete via `<ConfirmDialog>`).
- **Editing.** It happens in a `Sheet`, so the page stops being a column of forms.
- **Sort and filter.** A filter bar sorts by newest, most watched or most clipped.
- **Empty state** (new creator): EmptyState v2 art variant, "Your broadcasts are saved here", with "Turn on
  recording" (existing action).
- **Data.**
  - Existing: the VOD and clip list endpoints, plus thumbnails if present.
  - **New field:** per-VOD `views` (verified VOD watch count) if it isn't already in the DTO.

### P6. Analytics that tell you what to do (CS-8, CS-13) — effort M, impact med

- **Chart form.**
  - Daily series become **bars** (`ChartCard` with a metric toggle; promoted, agreed).
  - Previous-period ghost bars appear behind them.
  - Integer ticks except for hours, with at most one decimal.
  - The per-broadcast audience stays a line.
- **"What's working" insight row** (computed client-side from `analytics.range`, deterministic, no ML):
  - best day and hour to stream (by verified hours per hour streamed);
  - average watch time per viewer;
  - follows per hour streamed;
  - the broadcast that grew followers most.
  - Each insight is a `StatTile` with one sentence and a link to the broadcast.
- **"Earnings vs cost"** card from `analytics.pnl`: revenue against serving cost per broadcast, framed as
  the co-op's transparency ("what your stream cost the co-op to serve").
- **Shaped skeletons:** tiles plus a chart block.
- **KPI order:** Verified watch time, Peak verified, Followers, Support, then the honesty metrics
  (unverified, excluded) in a second group labelled "How we counted".

### P7. Revenue page re-ordered (CS-9) — effort S–M, impact med

Sections, top to bottom:

1. **Tiles:** Earned this month, Paid out, Available (with progress to the minimum payout), Held, and Owed
   in the destructive/neutral tone (not amber).
2. **Share line:** "Your share: 90%, set by member vote" plus a "Fee history" link (coop-trust copy
   `money.revenue.shareNote`, percent from `platform.cut`).
3. **"Get paid more" setup row** (tiers, payout account), shown as **cards with status** above the
   reporting, while setup is incomplete.
4. **Trend:** daily **bars**.
5. **By source and by tier.**
6. **Ledger:** move processor ids into the Breakdown dialog. The detail column shows supporter, tier and
   message only.

Also fix the contradictory payout card: one status, one explanation, one action.
Data: existing.

### P8. IA clean-up (CS-11) — effort S, impact med

- Studio groups:
  - **Home**: Stream manager.
  - **Set up**: Channel (new: one page for name, avatar, banner, bio, socials and category defaults,
    merging appearance and the info editor's profile parts), Stream settings, Alerts & overlays,
    Rehearsal, Captions.
  - **Community**: Mod view, Chat safety, Channel bot, Polls & raids.
  - **Content**: Videos & clips, Analytics.
  - **Money**: Revenue, Crew.
  - **Grow**: Move channel, Import from Twitch, and later Schedule.
  - **Co-op & tools**: Relays, Developer.
- The account menu keeps "Creator studio" (renamed from "Dashboard") and drops Relays.
- Every page gets the PageHeader v2 eyebrow with its group name, so the hierarchy stays visible on a
  phone, where the sidebar is a sheet.

### P9. Copy and link fixes (CS-12) — effort S

- The rehearsal key link goes to `/dashboard/settings` (or to checklist step 3).
- Fix the stale raid note.
- Suppress the coachmark in the studio.
- Bring the "verified viewers" labels into line with CS-5 once the data owner says which number is
  correct. If health counts before exclusions, label it "Viewers now" with a "verified after checks"
  hint.

### P10. Later: stream schedule (growth) — effort L, impact high (needs a contract)

Neither the contract nor the web has a schedule. Discovery's "Live later" shelf and the channel's
Schedule tab (market-research) both depend on one. The studio side would be a `/schedule` page with
recurring slots and a "Next stream" line in the LiveStatusBar when offline. I flag it here as a
contract request for the orchestrator, not as part of this batch.

---

## 4. Funnel and conversion notes (creator side)

| Step                  | Entry                                                         | CTA                                         | Drop-off risk                                       | Measure (first-party, aggregate)          |
| --------------------- | ------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------- | ----------------------------------------- |
| 0                     | `/creators` (growth-funnels) or account menu "Creator studio" | "Start streaming" → `/signup?intent=stream` | The account menu says "Dashboard" to viewers        | `creators.hero.click` (growth-funnels)    |
| 1 `channel_profile`   | Checklist                                                     | Save name and avatar                        | Image upload friction                               | Step completion from rows                 |
| 2 `stream_info`       | Checklist                                                     | Save title and category                     | Category search                                     | Same                                      |
| 3 `stream_key`        | Checklist                                                     | **Create stream key** (brand)               | Key shown once and lost; "Custom service" confusion | Key row exists                            |
| 4 `encoder_connected` | Checklist                                                     | none (live check)                           | Wrong encoder settings, firewall, wrong URL         | First health sample                       |
| 5 `rehearsal`         | Checklist                                                     | Start a rehearsal                           | Optional, skipped                                   | Rehearsal report row                      |
| 6 `first_live`        | Encoder                                                       | —                                           | Fear of an empty room                               | First broadcast row                       |
| 7 recap               | `/dashboard`                                                  | Share VOD / make a clip                     | Nothing pulls them back                             | `second_live_within_14d` (growth-funnels) |

growth-funnels specifies the counters as (surface, action, step, day) aggregates with no user id, plus a
per-step median time from signup. Everything above is derived server-side from existing tables, so no
client beacon is needed. The admin view shows the step funnel. Re-entry points:

- the LiveStatusBar compact on home (discovery);
- the recap card;
- an email or in-app "Your VOD is ready" notification. That one is a contract request to the
  notifications owner.

---

## 5. Cross-team decisions

- **growth-funnels:**
  - checklist step ids;
  - `?intent=stream|import` lands on the right step;
  - sign-in goes to `/dashboard` only for accounts with a key or broadcast, otherwise `/`;
  - server-derived step counts plus median time from signup;
  - `second_live_within_14d` added.
  - Logged.
- **art-director:**
  - board widths 1600, forms 1120 with 768 inside;
  - studio brand CTA is the current first-run step, then "Share your channel", never on live or offline
    status;
  - new LiveStatusBar, SetupChecklist, Sparkline in StatTile, and ChartCard in blocks/data;
  - extend `CopyField` with Reveal and `GoalBar` with a studio variant;
  - EncoderGuide uses tool names only.
  - Logged.
- **account-admin:**
  - SettingsSection/Row on `/dashboard/settings`, with CopyField plus Reveal for the key and DangerZone
    for rotation;
  - QueueLayout gets a `compact` mode embedded in `/mod/$channel`;
  - the session guard treats only a 401 as signed out (fixes CS-3's bounce).
  - Logged.
- **coop-trust:**
  - Co-op card in the control room's right column when offline (in the LiveStatusBar overflow when
    live);
  - one-time member-owner Callout over the first recap;
  - revenue share line from `platform.cut`;
  - copy keys `coop.studio.*` and `money.revenue.shareNote`/`feeHistory`.
  - Logged.
- **discovery:** LiveStatusBar `compact` on signed-in home; your own channel excluded from shelves.
  Logged.
- **account-admin (account menu):** Your channel, Creator studio (replaces "Dashboard"), Following,
  Settings (one entry), Co-op membership, theme, separator, Sign out. Relays moves to the studio's
  "Co-op & tools" group. Note: every account gets a channel at signup (`services/api/src/auth/index.ts:50`),
  so "Creator studio" would show for everyone; it shows for everyone, and the checklist covers new
  creators. Logged.
- **market-research:** time estimates per step, no badges, "support is on from day one", OBS tab first,
  "Your share: 90%, set by member vote" line. Adopted.
- **Depends on:**
  - responsive-a11y: status shown as icon plus word; Retry plus backoff on 429;
  - discovery: `MediaCard kind=vod|clip` for P5;
  - art-director: EmptyState v2 art variant.

Contract requests (orchestrator):

1. `stream.setupState` (six booleans);
2. per-VOD `views`;
3. optional `broadcast.summary`;
4. Schedule (P10);
5. "VOD ready" notification;
6. answer CS-5: which number is "verified viewers" while live.

---

## 6. References

| Source                                                                                | What I borrowed                                                                                                                                            |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Twitch Stream Manager / Creator Dashboard (product knowledge, as in the prior review) | The panel cockpit with an always-visible live state and "Edit stream info", and the post-stream "Stream summary" moment (P2, P3). No layout or copy taken. |
| Twitch Creator Camp, twitch.tv/creatorcamp (via market-research)                      | A time estimate per learning step; rejected the badges (P1).                                                                                               |
| YouTube Studio (product knowledge)                                                    | The content library as a table or grid with per-video performance, and the post-live report (P3, P5).                                                      |
| Owncast admin and owncast.online (via market-research)                                | Tool-agnostic "works with OBS, Streamlabs, FFmpeg" framing and naming tools without logos (EncoderGuide).                                                  |
| Kick creator dashboard, help.kick.com (via market-research)                           | The counter-example: earnings gated behind achievements. We state "support is on from day one" instead.                                                    |
| Ko-fi (via market-research)                                                           | Show the channel URL early; it feeds step 1's display of `<instance>/<slug>`.                                                                              |
| OBS browser-source convention (general knowledge)                                     | Per-overlay recommended width and height (P4).                                                                                                             |

---

## 7. Top 5 (ranked)

1. **P1 first-run "Ready to go live" checklist** with an inline key, EncoderGuide, the API's recommended
   settings and OBS profile, and a live "encoder connected" check (CS-1, CS-2). It's the hand-off target
   for the whole creator funnel.
2. **P2 cockpit rebalance**: a sticky LiveStatusBar on every studio page, stream info and stats above the
   fold, chat first on phones, and Retry plus backoff instead of "reload the page" (CS-3, CS-4).
3. **P3 stream recap** after every broadcast, hosting the member-owner moment and the
   "share, clip, come back" loop (CS-10).
4. **P4 overlays**: surface the chat and goals overlays, with sizes, OBS help and one save bar (CS-6).
   Effort S.
5. **P7 + P6 money and analytics**: revenue tiles that reconcile, the share line, setup above reporting and
   no processor ids; bar charts for daily data, insight tiles and the unused `analytics.pnl` (CS-8, CS-9).
   Plus a fix for the verified-viewer mismatch (CS-5).
