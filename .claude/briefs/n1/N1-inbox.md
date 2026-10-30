<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N1-inbox: the notification bell, unread count, preferences API and settings page

You are implementing unit N1-inbox for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/N1-notifications-pwa.md`,
`docs/decisions/0028-notifications.md` (decision 4), `.claude/briefs/n1/contract-step.md` (§1.3
`NOTIFY_DEFAULTS` and `GoLiveNotificationPayload`, §1.4 `NotificationPreferences`, §1.5
`notifications.unreadCount` and `notifications.preferences`, §2.2-2.3, §5.1, §7, §8 bell and
settings ids and step 5, §12), `docs/testing/n1-selectors.md`, `apps/web/src/i18n/README.md`
("How to add a namespace") and `.claude/briefs/_done-means.md`. Do not look outside the
repository. Work in your own git worktree on a branch named `n1/inbox`, created from `main` after batch-4 wave 1 (the six W1 units) merged; the orchestrator gives you the sha, which contains the W1 and N1 contract steps; run `git merge main` first if main moved. Batch 4, wave 2, beside N1-fanout, N1-email,
N1-push, N1-pwa and W1-data-mode. N1-fanout writes the rows your bell shows in the same wave:
build against the contract with fixtures; the harness step runs once both merged.

## Why

In-app notifications exist (`me.notifications`, `me.markNotificationsRead`) but the web app has
no bell and no list, so a member never sees them, go-live or otherwise. And a member has no way
to choose how go-live reaches them: ADR 0028 decides per-medium defaults (in-app on, email and
push off) with per-channel overrides, beside the per-channel bell (`follows.notify`).

## You own (write only these)

- `services/api/src/routes/notifications/inbox.ts` (stub: `unreadCount`) and
  `services/api/src/routes/notifications/preferences.ts` (stub: `get`, `set`),
  `services/api/src/notifications/preferences/**` (new)
- `apps/web/src/components/notifications/**` (the `bell.tsx` stub and everything new: list, item
  renderers, settings sections), `apps/web/src/routes/_app/settings.notifications.index.tsx`
  (placeholder), `apps/web/src/lib/notifications.ts` (new)
- i18n: `apps/web/src/i18n/locales/en/n1-inbox.json` (keys `notifications.*`, `notifySettings.*`)
  and `keys/n1-inbox.gen.ts`
- Tests: `services/api/tests/notification-prefs*.test.ts`, `services/api/tests/notification-unread*.test.ts`,
  `apps/web/tests/notifications*.test.ts(x)`
- Harness: `harness/src/n1/inbox.ts` (step 5), `harness/tests/n1/inbox.test.ts`

Read-only, in particular: `packages/contracts/**`, `packages/db/**`, `services/api/src/routes/me.ts`
(the list and mark-read you call), `services/api/src/routes/channels.ts` (`channels.follow` with
`notify`, the bell per channel), `services/api/src/lib/**`, `apps/web/src/components/site-chrome.tsx`
(mounts your bell), `apps/web/src/components/pwa/**` (N1-pwa's `PushToggle`, which you mount),
the route tree, `harness/src/n1/{run,selectors}.ts`. Anything else is a **contract request**
with the exact diff.

## Contracts you must honor (read-only for you)

- `me.notifications({ cursor, limit, unreadOnly })` (keyset page, newest first) and
  `me.markNotificationsRead({ ids? })` (`router.ts:158-187`); `notifications.unreadCount` →
  `{ count, capped }` (count up to `NOTIFY_RULES.unreadCountCap`, `capped` when there are more;
  use `notifications_user_unread_idx` with `limit cap + 1`).
- `notifications.preferences.get({ type })` / `set({ type, medium, channel, enabled })` →
  `NotificationPreferences`: `defaults` resolved per medium (row, else `NOTIFY_DEFAULTS`),
  `builtIn` true where no row exists, `channels` = the override rows (only channels the member
  still follows; join `channels` for id, slug, display name), `emailVerified`. `set` with
  `channel: null` upserts the default row; with a slug, the override row (unknown slug →
  `NOT_FOUND`; a channel the member does not follow → `BAD_REQUEST`); `enabled: null` deletes the
  override (with `channel: null` → `BAD_REQUEST`). Upsert on `notification_prefs_uq`
  (`nulls not distinct`). `write` bucket.
- `notifications.payload` for `go_live` is `GoLiveNotificationPayload`; other types keep the
  payloads their writers use (moderation, leaks, governance, statements of reasons; read
  `services/api/src/moderation/notify.ts`, `services/worker/src/moderation/records.ts`,
  `services/worker/src/moderation/sor-deliver.ts`, `services/api/src/lib/leaks.ts`,
  `packages/governance/src/lifecycle.ts` to learn their `kind` fields).
- Selectors (`docs/testing/n1-selectors.md`): the bell ids and the settings ids; the push toggle
  ids are N1-pwa's (you only mount `<PushToggle />`).

## What is there today (verified at `a43aa6b`; recheck against your base)

- The header's signed-in slot gets `<NotificationBell />` from the contract step
  (`apps/web/src/components/site-chrome.tsx`, `AppHeader` `user`).
- UI pieces: `@commonair/ui/components/{popover,switch,select,badge,scroll-area}`, `<EmptyState>`,
  `<RelativeTime>`, `<ChannelAvatar>`, `<IconButton tooltip>`, `toast` from `@commonair/ui/toast`,
  `<Skeleton*>`; a settings page pattern: `apps/web/src/routes/_app/settings.subscriptions.tsx`.
- Follow list with the per-channel bell: `me.follows` returns `notify` (`me.ts:154-201`);
  toggling it is `channels.follow({ channel, notify })` (`channels.ts:164-205`).

## Build

1. **API**: `unreadCount` and the two preference procedures as above; a pure resolver
   (`notifications/preferences/resolve.ts`) shared by `get` and `set`'s response, unit-tested.
2. **Bell** (`components/notifications/bell.tsx`): an `IconButton` with tooltip and a badge
   (`notification-bell`, `data-unread`, `data-capped`; `notification-bell-badge` absent at 0, "99+"
   when capped); polls `unreadCount` every 60 s while the tab is visible and on focus (no polling
   in a hidden tab; stop on sign-out). Opening it shows a `Popover` (`notification-list`) with
   the newest 20 (`me.notifications`), `notification-load-more` for the next page, an
   `EmptyState` (`notification-empty`), `notification-mark-all-read`, and
   `notification-settings-link` to `/settings/notifications`. Opening does not mark read; clicking
   an item marks that one read and navigates.
3. **Items** (`notification-item`, `data-type`, `data-state`): `go_live` → channel avatar, "{channel}
   went live" and the title (an empty title shows nothing), `RelativeTime`, link `/<slug>`
   (`notification-item-link`). Every other type → a generic label per type (`notifications.type.<type>`
   keys: a `Record<Type, MessageKey>` of literal keys) and a link where its payload names a known
   page (statement of reasons → `/settings/appeals`; export ready → `/settings/privacy`; proposal
   and vote → the proposal; `system` with `payload.kind === "discord_webhook_removed"` (written by
   N1-discord in wave 3, contract: `{ kind, channelId }`) → its own label key and `/dashboard`;
   otherwise no link). Never render payload text as HTML.
4. **Settings page** (`settings.notifications.index.tsx`): session guard (already in the
   placeholder); sections: go-live defaults (three switches `notify-default-in_app|email|push`
   with `data-builtin`; email shows `notify-email-unverified` when `emailVerified` is false and
   stays usable: the server simply sends nothing until the address is verified), the push toggle
   (`<PushToggle />`, N1-pwa's; it renders nothing until N1-pwa merges), and followed channels
   (`me.follows` pages): each `notify-channel` row has the bell switch (`notify-channel-bell`,
   `channels.follow({ notify })`) and email and push selects (`notify-channel-email|push`, options
   `default|on|off` → `preferences.set` with `enabled` `null|true|false`). Optimistic updates
   with rollback and `toast` on failure (`notify-save-error`). Logical CSS, keyboard reachable,
   visible focus, 320 px without horizontal scroll.
5. **Strings** in `n1-inbox.json` only, ICU plurals where counting.

## Tests you must add

- API (`createTestDatabase()`): unread count (0, 3, capped at 99 with 120 rows, another user's
  rows ignored); preferences defaults with no rows (built-in), after setting a default, a
  channel override, removing it, refusing `enabled: null` without a channel, refusing an
  unfollowed channel, `NOT_FOUND` for an unknown slug; unfollowing hides the override from `get`.
- Web (render tests with fixtures): the bell's states (0, 5, capped), the popover list (go-live
  item link, generic item, empty), mark all read; the settings page (built-in markers, unverified
  notice, a select change calls the API with the right `enabled`, rollback on error).
- Harness step 5 (`harness/src/n1/inbox.ts`) per §8 of the contract step.

## Done means

`.claude/briefs/_done-means.md`, plus: `services/api` tests (unit and `test:int`), `apps/web`
tests including `i18n.test.ts` and `logical-css.test.ts`, `bun run i18n:check`, `vp build`;
`tsc`; lint and format on your paths. Final message: what you built, test counts, branch and
sha, contract requests, the proposed n1 selectors check for `apps/web/tests/selectors.test.ts`,
and the live commands (`bun harness/src/cli.ts run notifications --set steps=1,5`; the user's
visual check of the bell and the settings page in dark and light, at 320 px).
