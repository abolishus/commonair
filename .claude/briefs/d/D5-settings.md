<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# D5-settings: settings navigation, admin page slips and the co-op empties

Split from [D5-studio](D5-studio.md) at the wave 3 re-check (2026-11-04), so each half fits one
context. You are implementing unit D5-settings for CommonAir (repo: /Users/joshe/Repos/bcon).
Before you start, read:

- AGENTS.md, PLAN.md and docs/architecture.md;
- `.claude/briefs/d/README.md`, `D0-contract-step.md` and `D5-studio.md` (your sibling; the
  shared rules there apply to you too);
- `.claude/briefs/_done-means.md`;
- the design review, findings **F25**, **F27** and **F28**, and **D5-capture's addendum**
  ("Addendum: signed-in pass" in `docs/design/2026-11-design-review.md`) with its screenshots in
  `docs/design/2026-11-review/signed-in/` (031–043, 044–056);
- the E4a board `Settings.html`.

Do not look outside the repository. This is **wave 3**: work on branch `d/d5-settings`, cut from
the sha the orchestrator gives you. D3-watch and D5-studio run beside you.

## You own (write only these)

- `apps/web/src/routes/_app/settings.*` (a new `settings.tsx` layout route included), and
  `apps/web/src/routes/_admin/**` **except** `admin.moderation.tsx`.
- `apps/web/src/components/settings/**` (new).
- The settings pages' components: `components/privacy-panels.tsx`,
  `components/notifications/**`, `components/dmca/copyright*`, `components/safety/appeals*`,
  `components/safety/enforcement*`, `components/support/subscription-list*`,
  `components/oauth/connections*`, `components/locale/preferences-page*`,
  `components/portability/grants*` and `components/blocks/blocked-users*`.
- The admin pages' components: `components/admin/**`, `components/safety/legal*`,
  `components/developer/admin-apps*`, `components/money/treasury.tsx`.
- `components/coop/council.tsx` and `components/coop/proposal.tsx`.
- The `d5-settings` namespace (new, empty, `en` and `es`; `en-XA` is generated).
- `apps/web/tests/d5-settings*.test.tsx` and `harness/src/d/d5-settings.ts` (a no-op stub,
  already wired into `d-surfaces`).

**Read-only:** everything else, including `lib/nav.ts` and `components/site-chrome.tsx` (the admin
sidebar groups are D5-studio's), `tests/source-policy.test.ts` (D5-studio's), `packages/ui`,
contracts and services. Another unit's file you need changed is a **contract request**, with the
exact change. Strings already in another namespace stay there; new strings go in `d5-settings`.

## Build

1. **Settings navigation (F27, "worse than described").** One shared settings layout for the
   seven pages (`/settings/privacy`, `connections`, `subscriptions`, `notifications`, `appeals`,
   `copyright`, `preferences`):
   - a `Tabs` row of links that marks the current page from the route (not an exact-string
     match that misses nested paths), and a `Select` at 375 px and below `sm`;
   - one width for all seven (`default`);
   - `PageHeader` in each route with a description.

   A pathless or `settings.tsx` layout route is fine. If it has no page of its own it needs
   either a `head()` or a place in `LAYOUT_ROUTES` (`tests/source-policy.test.ts`); the second is
   a contract request to D5-studio, so prefer giving it a `head()`.

2. **Account deletion in sight (F37).** Put download and delete in their own section near the top
   of privacy (or a separate "Account" tab), and move "Tell me if they move" to notifications.
3. **Long lists (F36, settings half).** Privacy's move notices and Notifications' "Channels you
   follow": a search field and the house "Load more" paging, plus "all on / all off" for move
   notices. The captions and admin queues are follow-ups.
4. **Admin slips:**
   - F33: `/admin/egress` and the legal page's "Filed at" use a design-system date and time field
     (D4's `components/birth-date-field.tsx` is the pattern), keeping the UTC note on egress;
   - F34: integrity flag codes and detail keys get catalogued labels and descriptions (the raw
     code stays, small, for search); egress formats sizes with the shared byte formatter ("0 B");
   - F31: the treasury table renders as stacked rows at 375 px, with amount, status and Confirm
     on each row;
   - F39: OAuth apps' "Suspended only" label next to its switch; egress' Show button at its own
     width.
5. **Settings slips:**
   - F38: subscriptions list channels by display name with `@username` secondary, and
     `<ChannelAvatar>` takes its initial from the display name;
   - F39: "restored after in 2 weeks" (a catalogue fix with a test on its interpolation), an
     ended suspension no longer reads "Until 17 hours ago", the notifications bell switch gets a
     visible label on the name line, and the viewer appeals' third empty state gets its heading;
   - F35: one note style inside cards (copyright's strike note).
6. **Co-op empties (F25).** Convert the plain-text empties (`coop/council.tsx:130` and `:177`,
   `coop/proposal.tsx:328`) to `<EmptyState>`, with an action where the viewer can act.
7. **Primitive slips (F28)** on your pages: `<Skeleton*>` with `aria-busy` instead of plain
   "Loading" text.
8. **Titles.** Every settings and admin route keeps or gets a `head()` title.

## Tests you must add

- `d5-settings-nav.test.tsx`: the tab row marks each of the seven pages, the `Select` changes
  page, one width.
- `d5-settings-privacy.test.tsx`: deletion near the top; list search, paging, all on / all off.
- `d5-settings-admin.test.tsx`: integrity labels, byte formatting, the date-time field, the
  treasury stacked rows.
- `d5-settings-copy.test.tsx`: the copyright interpolation, the ended suspension, F38 names.
- `d5-settings-empty.test.tsx`: the co-op empties are `<EmptyState>`.
- `harness/src/d/d5-settings.ts`, on the seeded stack: as `viewer1`, `/settings/privacy` shows the
  settings tab row and the delete control within the first viewport.

## Done means

- The `_done-means.md` checks pass.
- The user's visual checklist: shots 031–043 and 044–056 of D5-capture, retaken in both themes at
  375 and 1440 px, side by side with the capture.
