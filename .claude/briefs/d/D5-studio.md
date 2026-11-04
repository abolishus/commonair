<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# D5-studio: a control-room dashboard, grouped navigation, a mod view, trends and empty states

You are implementing unit D5-studio for CommonAir (repo: /Users/joshe/Repos/bcon). Before you
start, read:

- AGENTS.md, PLAN.md and docs/architecture.md;
- `.claude/briefs/d/README.md` and `D0-contract-step.md`;
- `.claude/briefs/_done-means.md`;
- the design review, findings **F21–F28**;
- **D5-capture's addendum**, its screenshots in `docs/design/2026-11-review/signed-in/`, and any
  F29+ findings it added. Fix what the addendum confirms; skip what it marks "not reproduced".
- the E4a boards `StreamManager.html`, `StreamSetup.html`, `Analytics.html`, `Revenue.html` and
  `Settings.html`.

Do not look outside the repository. This is **wave 3**: work on branch `d/d5-studio`, cut from the
sha with wave 2 merged. D3-watch runs beside you.

## Re-checked against `main` at wave 3 (2026-11-04)

- **D5 is split in two units that run side by side**, so each fits one context: this unit (the
  studio, its navigation, the mod view, analytics and money) and [D5-settings](D5-settings.md)
  (the seven settings pages, the admin pages and the co-op council and proposal empties). Their
  paths are disjoint; anything across the line is a contract request.
- The shared charts are `packages/ui/src/blocks/data/trend-chart.tsx` and `breakdown.tsx` (there
  is no `packages/ui/src/charts`). `components/chart.tsx` is shadcn's; leave it.
- D5-capture's addendum (`docs/design/2026-11-design-review.md`, "Addendum: signed-in pass"):
  F21, F22, F24–F26 confirmed; F23 and F28 "not reproduced" on staging, **but both code findings
  stand**, so do them. Of the new findings, this unit takes F29, F31 (the revenue ledger and the
  bot's commands table), F32, F33 (crew), F35 (studio pages), F38 (the dashboard avatar preview)
  and F39 (relays). F36's captions paging is a follow-up, not this wave.
- D4's request: `components/money/not-found.tsx` becomes a re-export of D4's shared
  `NotFoundState` (`components/not-found.tsx`), so the studio and admin pages that import it get
  the shared state with its action. Keep the export name; check the callers still type-check.
- The studio sidebar is rendered by `components/site-chrome.tsx` from `lib/nav.ts`; both studio
  and admin layouts use it.
- Line numbers below are still right on `main` (`analytics-page.tsx:289` and `:317`,
  `money/revenue.tsx:400`, `twitch-import/import-page.tsx:213`). `coop/council.tsx` and
  `coop/proposal.tsx` moved to D5-settings.
- `PENDING_HEAD` lists D3-watch's two routes and your `import.tsx`. Remove only the `import.tsx`
  line; D3-watch deletes its own two lines beside you.

## You own (write only these)

- `apps/web/src/routes/_studio/**`, `routes/_studio.tsx`, `routes/_admin.tsx` (the layout, for
  its navigation), and a new `routes/_app/mod.$channel.tsx` if the mod view lives outside the
  studio layout.
- `apps/web/src/components/{analytics,mod,attestations,studio}/**` (`studio` is new),
  `components/money/**` **except** `money/treasury.tsx` and `money/fraud-review.tsx`,
  `components/relays.tsx`, `components/stream-health-card.tsx`, `components/content-manager.tsx`
  (its empty state), `components/bot-studio/**` (the F31 table only),
  `components/twitch-import/import-page.tsx` (its empty state only), and in
  `components/site-chrome.tsx` the studio and admin sidebars only.
- `apps/web/src/lib/nav.ts`: the studio and admin sections only.
- `packages/ui/src/blocks/studio/**`, `packages/ui/src/blocks/data/{trend-chart,breakdown}.tsx`,
  `packages/ui/src/blocks/headers/page-header.tsx` (F29), with their stories.
- The `d5-studio` namespace.
- `apps/web/tests/d5-*.test.tsx` **except** `d5-settings*.test.tsx`, `harness/src/d/d5-studio.ts`,
  and in `tests/source-policy.test.ts` the width and `PageHeader` check and the `import.tsx`
  `PENDING_HEAD` line.

**Read-only:** `player/**` (you embed `<Player>` muted), `chat/**` (you embed `<ChatPanel>`),
`components/channel/**`, D5-settings' paths, contracts and services. A missing API field is a
**contract request**, with the exact field.

## Build

1. **The Stream manager as a control room (F21).** `/dashboard` becomes a `wide` grid:
   - a muted preview `<Player>`;
   - the live chat (`<ChatPanel>`);
   - an activity feed: follows, support, raids and giveaway winners, from the events the studio
     already receives. If no stream of those exists for the web, file a **contract request** and
     show the panel's `<EmptyState>`;
   - "Edit stream info": title, category (a combobox over `categories.list`) and tags, using the
     existing update procedure;
   - live stats: `<ViewerCount>`, uptime, and the health numbers (bitrate, fps, dropped frames)
     where `stream-health-card` has them, not only warning codes
     (`stream-health-card.tsx:96-112`);
   - quick actions: start a poll or prediction, go to Rehearse.

   Move the setup cards (key, DVR, simulcast, Discord, appearance, federation) to a new
   `/dashboard/settings` route, "Stream settings", linked from the grid. Drop the header actions
   that repeat the sidebar.

2. **Grouped navigation (F22).** `SidebarGroup` labels in `lib/nav.ts`:
   - Stream: Stream manager, Stream settings, Rehearse, Overlays, Captions, Relays.
   - Community: Chat safety, Bot, Interact, Mod view.
   - Content: Content, Analytics.
   - Money: Revenue, Crew.
   - Tools: Move, Import, Developer.

   Give admin the same treatment.

3. **The mod view (F23).**
   - Rename the studio "Chat" item to "Chat safety".
   - Add `/mod/$channel` for streamers and their mods: `<ChatPanel>` with moderation actions, the
     held queue (`components/mod/held-queue.tsx`), and recent mod actions. Gate it to people who
     can moderate that channel, and treat the server as the authority.
4. **Analytics and revenue trends (F24).**
   - Add a range `TrendChart` for verified hours watched, peak viewers and followers.
   - Add a revenue trend.
   - Show a previous-period delta on each `StatCard`, if the API returns the previous period; if
     not, file a **contract request**.
   - Charts must not rely on colour alone: add direct labels or dash patterns to the shared chart
     component (`analytics-page.tsx:317-319` today).
5. **Empty states (F25).**
   - Every `<EmptyState>` on a page its owner can fill gets a description and a primary action
     (the review lists them).
   - Convert the plain-text empties (`money/revenue.tsx:400`, `coop/council.tsx:130` and `:177`,
     `coop/proposal.tsx:328`, `twitch-import/import-page.tsx:213`) to `<EmptyState>`.
   - `newbie` is the seeded account that shows them all.
6. **One width and header rule (F26).**
   - Grids and boards use `wide`; everything else uses `default`.
   - `PageHeader` always lives in the route, always with a description.
   - A source-policy test enforces both for `_studio/**`.
7. **Settings navigation (F27)** is D5-settings'.
8. **Primitive slips (F28).**
   - Use `<ViewerCount>` for peak viewers (`analytics-page.tsx:289`, `attestations/panel.tsx:181`).
   - Use `<Skeleton*>` with `aria-busy` instead of the plain "Loading" text.
9. **Titles.** Every studio route gets a title (`import.tsx` is the last one missing).
10. **Addendum findings (F29, F31–F33, F35, F38, F39):**
    - F29: `PageHeader` stacks its actions under the title below `sm`, and a title never breaks
      inside a word.
    - F31: the revenue ledger and the bot's commands table render as stacked rows at 375 px, with
      the amount or actions on each row.
    - F32: revenue tier fields show errors after blur or submit, never on mount.
    - F33: crew's `datetime-local` becomes D4's date field (`components/birth-date-field.tsx` is
      the pattern; a general date field is yours to build in `components/studio/`) plus a time field.
    - F35: one note style inside cards on the studio pages.
    - F38: the dashboard avatar preview takes `<ChannelAvatar>`'s initial from the display name.
    - F39: relays' "Add a relay" spacing and numbered setup steps.

## Tests you must add

- `d5-dashboard.test.tsx`: grid panels present, the stream info edit (optimistic, with rollback on
  error), health numbers.
- `d5-nav.test.tsx`: group labels and order; admin groups.
- `d5-mod.test.tsx`: the gate (not a mod: no access), the held queue, mod actions.
- `d5-trends.test.tsx`: range switching, delta formatting (up, down, zero, no previous period),
  non-colour series cues.
- `d5-empty.test.tsx`: every owner-fillable `<EmptyState>` has an action (a test over the
  components).
- The source-policy check for width and `PageHeader`, and `import.tsx` out of `PENDING_HEAD`.
- `d5-addendum.test.tsx`: F29's header stacking, F32 (no error on mount), F33, F31's stacked rows.
- `harness/src/d/d5-studio.ts`, on the seeded stack:
  - as `demo_streamer1`, `/dashboard` shows the preview and chat;
  - as `newbie`, `/content` shows an `empty-state-action`.

## Done means

- The `_done-means.md` checks pass.
- The user's visual checklist: every page in D5-capture's list, retaken in both themes at 375 and
  1440 px, side by side with the capture.
