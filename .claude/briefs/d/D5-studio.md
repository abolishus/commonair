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

## You own (write only these)

- `apps/web/src/routes/_studio/**`, `routes/_studio.tsx`, `routes/_admin.tsx`,
  `routes/_admin/**` and `routes/_app/settings.*`.
- `apps/web/src/components/{analytics,money,mod,attestations}/**`, `components/relays.tsx`,
  `components/stream-health-card.tsx`, `components/coop/council.tsx`,
  `components/coop/proposal.tsx`, `components/twitch-import/import-page.tsx` (its empty state
  only), and `components/settings/**` (new) and `components/studio/**` (new).
- `apps/web/src/lib/nav.ts`: the studio and admin sections only.
- `packages/ui/src/blocks/studio/**` and the chart components in `packages/ui`, with their
  stories.
- The `d5-studio` namespace.
- `apps/web/tests/d5-*.test.tsx`, `harness/src/d/d5-studio.ts`, and the width and `PageHeader`
  check added to `tests/source-policy.test.ts`.

**Read-only:** `player/**` (you embed `<Player>` muted), `chat/**` (you embed `<ChatPanel>`),
`components/channel/**`, contracts and services. A missing API field is a **contract request**,
with the exact field.

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
7. **Settings navigation (F27).** A shared settings layout with a `Tabs` row, a `Select` at
   375 px, and one width for all seven pages.
8. **Primitive slips (F28).**
   - Use `<ViewerCount>` for peak viewers (`analytics-page.tsx:289`, `attestations/panel.tsx:181`).
   - Use `<Skeleton*>` with `aria-busy` instead of the plain "Loading" text.
9. **Titles.** Every studio, admin and settings route gets a title. If `PENDING_HEAD` still lists
   `admin.moderation.tsx`, remove it; the list ends empty.

## Tests you must add

- `d5-dashboard.test.tsx`: grid panels present, the stream info edit (optimistic, with rollback on
  error), health numbers.
- `d5-nav.test.tsx`: group labels and order; admin groups.
- `d5-mod.test.tsx`: the gate (not a mod: no access), the held queue, mod actions.
- `d5-trends.test.tsx`: range switching, delta formatting (up, down, zero, no previous period),
  non-colour series cues.
- `d5-empty.test.tsx`: every owner-fillable `<EmptyState>` has an action (a test over the
  components).
- The source-policy check for width and `PageHeader`, and `PENDING_HEAD` ending empty.
- `harness/src/d/d5-studio.ts`, on the seeded stack:
  - as `demo_streamer1`, `/dashboard` shows the preview and chat;
  - as `newbie`, `/content` shows an `empty-state-action`.

## Done means

- The `_done-means.md` checks pass.
- The user's visual checklist: every page in D5-capture's list, retaken in both themes at 375 and
  1440 px, side by side with the capture.
