<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# account-admin: viewer account, settings, notifications, admin and moderation consoles

Scope: `_app/settings.*`, `oauth2.authorize.tsx`, `m.$channel.$nonce.tsx`, the bell/inbox, `_admin.tsx`
and `_admin/*`. Reviewed mostly from source (HEAD `97156a86`, 2026-11-06), plus signed-out HTTP checks
against staging and the 2026-11-03 signed-in screenshots (`docs/design/2026-11-review/signed-in/031-056`).
After the orchestrator signed the pane in as `demo_streamer1`, I walked `/settings/subscriptions`,
`/settings/notifications`, `/settings/privacy` and the bell popover live in my own tab: 1440 dark and 375. I toggled, saved and submitted nothing, and the tab is closed. Admin consoles are reviewed from
source only.

## 1. What exists now

Since the 2026-11-03 review, D5-settings (`46f9ca55`, `a4ca20b0`, `51dfb62f`) and D5-studio (`a001fbf9`) landed:

| Route                                                                              | Now                                                                                                                                                                       | Notes                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/settings` (layout)                                                               | `PageContainer default` + `SettingsNav`: a `PageTabs` link row at sm and up, a `Select` below sm (`components/settings/settings-nav.tsx`)                                 | F27 is fixed. Bare `/settings` redirects to **Subscriptions** (`settings.index.tsx:13`). Each page repeats its tab name as an h1 ("Notifications" tab, then a "Notifications" h1).                                             |
| `/settings/subscriptions`                                                          | Subscription list + "Your payments" `Section`                                                                                                                             | It is the landing tab, but most viewers have no subscriptions, so their first settings screen is empty.                                                                                                                        |
| `/settings/notifications`                                                          | Go-live defaults (in-app/email/push), push enrolment, a per-channel list (paged now, `list-window.tsx`), `PortabilityGrants` (moved from privacy, F37)                    | Only `go_live` is configurable (`PREFERENCE_TYPES = ["go_live"]`, `contracts/enums.ts:312`). Email defaults to off (`notify.ts:38`). Sections are raw `<h2 className="text-base">` (`notifications/settings.tsx:129,201,445`). |
| `/settings/appeals`                                                                | `EnforcementSection` (statements of reasons) + `MyAppeals`                                                                                                                | Uses `Section`.                                                                                                                                                                                                                |
| `/settings/copyright`                                                              | DMCA notices about your content, each a `Card`; `?notice=` deep link                                                                                                      |                                                                                                                                                                                                                                |
| `/settings/privacy`                                                                | "Your data and your account" `Section` first (export + deletion side by side at lg), then the P2P `Card` and the Blocked users `Card`                                     | F37 is fixed. The deletion copy follows ADR 0004 well ("Payments, the ledger, votes and audit history stay, with your name and email removed"), but never says how long the grace period is.                                   |
| `/settings/connections`                                                            | OAuth grants; the component renders its own `PageHeader`                                                                                                                  |                                                                                                                                                                                                                                |
| `/settings/preferences`                                                            | Language only                                                                                                                                                             | Theme lives in the account menu, Data saver in the player, P2P under Privacy.                                                                                                                                                  |
| `/settings/notifications/unsubscribe`                                              | Public token confirm page (no tab)                                                                                                                                        | Staging, no token: h1 "This unsubscribe link does not work". Fine.                                                                                                                                                             |
| Bell / inbox                                                                       | Popover: newest 20, load more, mark all read, settings link (`notifications/inbox.tsx`)                                                                                   | No full-page inbox. Go-live rows show the **slug**, not the display name (`item.tsx:84`, `goLive {channel}`). Every non-go-live type shares one generic bell glyph.                                                            |
| `oauth2.authorize`                                                                 | Consent page (E9)                                                                                                                                                         | It sets a title; fine.                                                                                                                                                                                                         |
| `/m/$channel/$nonce`                                                               | Move landing, `narrow`                                                                                                                                                    | Growth-funnels owns the CTA.                                                                                                                                                                                                   |
| `_admin` layout                                                                    | Grouped sidebar (Safety, Money, Co-op, Platform), filtered by role (`_admin.tsx`)                                                                                         | F22 is fixed for admin.                                                                                                                                                                                                        |
| `/admin/moderation`                                                                | `PageTabs` (Cases, Labels, Reports, NCII); each list is an `ItemGroup` of rows with an Open button; the **detail renders below the whole list** (`mod-queue.tsx:223-271`) | `?tab=&case=` deep links work. No filters, even though the API takes tier, status and category; no tab counts, keyboard shortcuts or bulk actions.                                                                             |
| `/admin/appeals`                                                                   | Rows that open a detail (F36 fix), with an inline decision Select + Textarea                                                                                              |                                                                                                                                                                                                                                |
| `/admin/{dmca,legal,integrity,egress,incidents,apps,federation,coop}`, `/treasury` | Each is bespoke                                                                                                                                                           | Admin widths still disagree (see AA-9).                                                                                                                                                                                        |

Signed-out HTTP checks (curl, staging): `/settings` returns 307 to `/settings/subscriptions`;
`/settings/privacy` returns 307 to `/signin`; **`/settings/security` returns 404**; `/following` and
`/notifications` return **500** (but `/zz` returns 404). I passed the 500s to watch and discovery.

## 2. Findings

**AA-1 (high): the security email links to a page that does not exist, and there is no security UI at all.**

- The server turns on better-auth `twoFactor`, `passkey` and `magicLink` (`services/api/src/auth/index.ts:195-204`).
  It sends `twoFactorEnabled` / `twoFactorDisabled` / `newSignIn` mail, and the 2FA mail links to
  `appUrl(site, "/settings/security")` (`auth/index.ts:294`).
- That route 404s on staging. The web app has no 2FA enrolment, no backup codes, no passkey
  management, no password change, no session list, no email change and no magic-link sign-in
  (grep of `apps/web/src` for twoFactor, passkey and totp finds nothing).
- `Me.twoFactorEnabled` exists (`api/entities.ts:42`), and PLAN.md:44 lists passkey and TOTP as built.
- The result: a security feature you cannot reach, plus a dead link inside a security email. That
  dead link also teaches people to distrust our mail.

**AA-2 (high): there is no Account page.**

- `me.update` accepts `displayName` (`router.ts:150`), and the web never calls it. A viewer without
  a channel cannot change their display name.
- `shareEmailWithFollowedChannels` (`router.ts:151`, `Me`) has no UI anywhere, so a privacy choice
  exists only in the API.
- `matureConfirmed` cannot be reviewed or revoked.
- The email address and its verification state are shown nowhere.

**AA-3 (med): settings land on Subscriptions.**

- A viewer with no subscriptions meets an empty list first (`settings.index.tsx:13`).
- The account menu lists all seven settings pages as separate items (`lib/nav.ts:230-236`), on top
  of dashboard, relays and co-op. The menu is long, and its order is not the order people need.

**AA-4 (med): three section patterns inside settings.**

- `Section` block: enforcement, appeals, payments, privacy account.
- `Card`: blocked users, portability grants, P2P, copyright notices.
- Raw `h2.text-base`: notifications.
- Help text mixes `text-xs` and `text-sm`. Connections and Preferences render `PageHeader` inside
  the component, the rest in the route.
- Each page's h1 repeats the selected tab label.

**AA-5 (med): the tab row cannot grow.**

- Seven tabs already need a `Select` below sm, and adding Account, Security and Following makes ten.
- `packages/ui/src/layouts/section-nav.tsx` (`SectionNav`, a sidebar at md and up, a scroll row
  below) already exists and settings do not use it.

**AA-6 (high, retention): notifications cover go-live only, and email is off by default.**

- `PREFERENCE_TYPES = ["go_live"]`, while `NOTIFICATION_TYPES` also has raid, proposal, vote_open,
  export_ready, payout, moderation and system.
- Members cannot choose, say, "email me when a co-op vote opens" except through the `governance`
  unsubscribe list.
- Go-live email is `false` by default (`contracts/notify.ts:38`) and nothing asks after a follow,
  so most followers never hear that a channel went live (agreed with growth-funnels).

**AA-7 (med, retention): no inbox page, no "following" page, no "what you missed".**

- The popover caps at a 384 px scroll (`inbox.tsx:117`), with no filters or grouping.
- Followed channels are visible only as rows inside Notifications (bells) and portability grants.
  There is no unfollow or "live now" list in settings.
- The only digest is `goLiveDigest` (`packages/email/src/templates/notify.tsx`). Nothing brings
  back a viewer who missed a stream: no new VODs or clips from follows, no open votes.

**AA-8 (med): the admin moderation queue is a stacked list, with the detail under it.**

- Choosing a case renders `CaseDetail` after the tab panels (`mod-queue.tsx:231`). On a long queue
  the moderator scrolls past every row to reach the case, then back up for the next.
- No filters (category, tier, priority, SLA due), no counts in the tabs, no j/k keyboard navigation.
- No bulk action (for example "dismiss these 12 duplicate reports"), and no assignment or claim, so
  two moderators can open the same case.
- The appeals and DMCA queues each use their own row and detail patterns.
- `DataTable` already supports `selectable` and `selectionToolbar` (`packages/ui/src/blocks/data/data-table.tsx:39-44`),
  and the admin queues do not use it.

**AA-9 (med): admin widths still differ (the admin half of F26).**

- `wide`: moderation, egress, legal. `default`: appeals, DMCA, integrity, incidents, apps, treasury.
  `narrow`: federation. None (bespoke): co-op (`routes/_admin/*.tsx`).

**AA-10 (med): audit visibility is missing in the console.**

- `safety.auditLog` (`router.ts:3611`, filters by subject and actor) has no UI. AGENTS.md requires
  an `audit_log` row for every staff action, yet staff cannot see them except inside a single case's
  history (`CaseHistory`).
- There is no user or channel lookup page for staff, even though `safety.suspend` works by username
  and `users.lookup` exists.

**AA-11 (med): there is no admin home.**

- Staff land on the first page their role allows, and nothing summarises open work: T1 cases near
  their SLA, open appeals, DMCA notices awaiting counter-notice windows, integrity flags, live incidents.

**AA-12 (low): account deletion does not say what deleting means for this person.**

- The deletion copy does not name the grace period.
- It does not tell a channel owner what happens to their subscribers (are subscriptions cancelled?),
  their pending payouts, their co-op share redemption or their channel slug.
- The ExportSection does not suggest "Download your data first" in the delete dialog.
- ADR 0004 is honoured in the copy, but this is the moment to show it.

**AA-13 (low): notification rows show the slug and a generic icon.**

- Go-live rows show "demo_streamer1 went live" with a `ChannelAvatar` built from the slug.
  `ChannelAvatar` takes its initial from the slug, the same F38 two-names issue as before.
- Other types share one bell glyph and have no context line (which proposal, which payout amount).

**AA-14 (low, corrected): the 500s were rate limits, not slugs.**

- The `/following` and `/notifications` 500s were the shared staging IP hitting the anon rate
  limit. SSR turns a 429 into "Something went wrong" with HTTP 500. Watch confirmed it: those paths
  404 now. Watch owns "rate-limited SSR becomes a 500".

**AA-15 (high, seen live): a rate-limited session check signs the member out of the page.**

- Signed in as streamer1, `/settings/notifications` sent me to `/signin`, while `fetch('/api/me')` returned 200 a moment later.
- Cause: `apps/web/src/server/bootstrap.ts:80`, `fetchMe(cookie).catch(() => null)`. Any 429, 5xx
  or network error becomes "no session", and `requireSession` (`lib/guard.ts`) redirects.
- responsive-a11y found the same at 320 px.
- Fix (agreed with responsive-a11y): only a 401 means signed out. Otherwise keep the route and render
  `EmptyState` "We couldn't check your session" with Retry.

**AA-16 (med, seen live): failed loads have no Retry.**

- On streamer1's notifications page, "Your notification settings could not be loaded." (the
  defaults) and "Your channels could not be loaded." (the move notices) are bare text with no
  Retry, while the rest of the page rendered.
- The bell popover says "Your notifications could not be loaded." with no Retry either, and still
  offers "Mark all as read".
- Privacy's `LoadError` has a Retry (`privacy-panels.tsx:64`); use that one pattern everywhere.

**AA-17 (med, seen live): the inbox floods and goes stale.**

- streamer1 has 58 unread. Nineteen of the newest twenty are `vote_open` items created within one
  minute, several with `votingEndsAt` already past.
- The payload has no proposal title, so the row cannot say which vote it is, and a closed vote
  still reads as open and unread.
- There is one `system` item: `discord_webhook_removed`.
- Proposal (P4): collapse same-type bursts ("12 co-op votes opened · see all"). Mark a vote row
  "Closed" (muted, no unread dot) once `votingEndsAt` has passed. Add the proposal title to the
  `vote_open` payload (**contract request**).

**AA-18 (low, seen live): layout slips on notifications and privacy.**

- "Push in this browser": three `text-xs` paragraphs on the left, and its switch about 800 px away
  at the far right at 1440. Keep the control beside the label (the `SettingsRow` max width 768).
- Privacy repeats its intro: the h1 description "Download your data or delete your account." is
  directly above the section description "Download a copy of what we hold about you, or delete your account."
- At 1440 the short Delete card sits beside a tall Export card.
- At 375 the export hints truncate ("payments, chat, co-op…"), which hides what the export contains.
- The landing tab (Subscriptions) showed streamer1 two empty states in a row, confirming AA-3.

## 3. Proposals

### P1. The settings shell: section nav, Account landing, one row pattern (AA-3, AA-4, AA-5; S-M, high)

```
lg+ (≥1024)                                         <lg
┌───────────────┬───────────────────────────────┐   ┌──────────────────────────┐
│ ACCOUNT       │ Account                        │   │ [Section ▾  Account    ] │ (existing Select)
│ › Account     │ Your name, email and sign-in…  │   │ Account                  │
│   Security    │ ┌ Profile ──────────────────┐  │   │ ┌ Profile ─────────────┐ │
│   Preferences │ │ Display name   [Aurora  ] │  │   │ │ Display name         │ │
│ ACTIVITY      │ │ Username  @demo_viewer1   │  │   │ │ [Aurora            ] │ │
│   Notifications│ │ Email   v***@… Verified ✓│  │   │ └──────────────────────┘ │
│   Following   │ └───────────────────────────┘  │   │ …                        │
│   Subscriptions│ ┌ Privacy ─────────────────┐  │   └──────────────────────────┘
│ SAFETY        │ │ Share my email with …  [○]│  │
│   Privacy & data│└───────────────────────────┘  │
│   Appeals     │                                │
│   Copyright   │                                │
│ APPS          │                                │
│   Connected apps│                              │
└───────────────┴───────────────────────────────┘
 sunken 240px    content max 768 (forms), 1120 for tables
```

- **Nav:**
  - The existing `SectionNav` / `NavGroups` on `--surface-sunken` at lg, and the existing `Select` below lg. Drop the tab row.
  - Groups (agreed with art-director):
    - Account: Account, Security, Preferences.
    - Activity: Notifications, Following, Subscriptions.
    - Safety: Privacy & data, Appeals, Copyright.
    - Apps: Connected apps.
  - Appeals and Copyright show a count `Badge` when something is open (data: `appeals.mine`,
    `enforcement.list`, DMCA mine, which already exist).
- **Landing:** bare `/settings` goes to `/settings/account`.
- **Account menu:** it shrinks to: Your channel, Creator studio (shown to everyone: every signup gets a
  channel, `services/api/src/auth/index.ts` `ensureChannel`; renamed from Dashboard, agreed with creator-studio), Following, Settings, Co-op membership, theme, Sign out. The
  seven settings links go, and Relays moves into the studio's "Co-op & tools" group.
- **One pattern for every page:**
  - `PageHeader` v2 in the route, the h1 = the nav label.
  - Then `SettingsSection` blocks (variants of `blocks/headers/section.tsx` and
    `blocks/forms/form-section.tsx`), each holding `SettingsRow`s: label + `text-sm` hint on the
    left, the control on the right, stacking below sm.
  - Toggles and selects autosave with `toast.success` ("Saved"). Multi-field forms (display name,
    password) get an explicit Save and show errors after blur or submit (F32's rule).
  - A destructive section is last, as `DangerZone`: `AlertCallout` gets a destructive tone, ring
    and title only, no fill, no brand.
  - Migrate the `Card` and raw-h2 sections.
- **Copy direction:** the page title is a noun, and each section intro says what changes for you
  ("Channels see this name in chat and on your profile").
- **Tests:** a source-policy test that every `/settings/*` route renders `PageHeader` in the route
  and only `SettingsSection` children.

### P2. `/settings/account` (AA-2; S, high)

- **Profile:** display name (`me.update`), username read-only with "Your username is also your
  channel address and never changes" (the `immutableUsername` rule), and the avatar.
  - The avatar upload today is channel-scoped (`channels.uploadUrl`, purpose `avatar`). A
    channel-less viewer would need `me.uploadUrl` or the channel upload opened to them: **contract
    request**.
- **Email:** the masked address, a `StatusBadge` ("Verified" or "Not verified"), and "Resend link"
  (`AUTH_ROUTES.sendVerificationEmail`).
  - Change email uses better-auth `changeEmail`; it needs `changeEmail.enabled` on the server plus
    a verify mail (**server request**).
- **Privacy rows:** "Share my email with channels I follow" (`shareEmailWithFollowedChannels`), and
  "Mature content: confirmed 18+ on {date}" with a revoke option (needs a `me.update` field: **contract request**).
- **DangerZone:** "Delete account" links to Privacy & data, so it has one home.

### P3. `/settings/security` (AA-1; M, high: it closes a dead link in live mail)

Sections, top to bottom:

1. **Password:** "Change password", in a `Dialog` with current and new fields (better-auth
   `changePassword`, `revokeOtherSessions: true` ticked).
2. **Two-step verification:**
   - Off: a `SettingsRow` with an "Set up" button. The `Dialog` stepper runs: re-enter password →
     QR (rendered locally; check that a FOSS QR lib is already in the tree or vet one) + manual key
     shown in `CopyField` with Reveal → 6-digit code → backup codes (10×12) with Download .txt and
     "I saved these". Only then is it on.
   - On: "On since {RelativeTime}", "Regenerate backup codes", and "Turn off" in a `ConfirmDialog`.
3. **Passkeys:** a list (name, created, last used) with "Add a passkey" (WebAuthn, needs no remote
   script) and remove per row.
4. **Sessions:**
   - A `DataTable` (stacked below sm) with a device/browser summary, approximate time
     (`RelativeTime`) and "This device".
   - "Sign out" per row, and "Sign out everywhere else".
   - Show no IP addresses (no-PII rule). Show a coarse user agent only.
   - The `newSignIn` mail's `sessionsUrl` should point to `/settings/security#sessions`. It is not
     wired today; that is a **server request**.
5. **Sign-in by email link:** explanatory only; the sign-in page owns the magic-link option. Tell
   growth-funnels.

Data: better-auth client endpoints, already mounted under `/api/auth`. Needs: `AUTH_ROUTES` entries in
`packages/contracts/src/auth.ts` (**contract request**, orchestrator), i18n namespace `settings-security`,
and a harness scenario that enables 2FA with a test secret.

### P4. Notifications: every type, one matrix (AA-6, AA-13; M, high for retention)

```
Notifications
 How you hear from us                       In app   Email   Push
 ────────────────────────────────────────────────────────────────
 A channel you follow goes live              [✓]     [ ]     [ ]
 A raid lands in a channel you're watching   [✓]      –       –
 A co-op vote opens / a result is published  [✓]     [✓]     [ ]
 Your export is ready                        [✓]     always   –
 Payouts (streamers)                         [✓]     [✓]      –
 Moderation decisions about you              always  always   –   (legal notices: not optional)
 Weekly "What you missed" digest              –      [ ]      –   (opt-in, unticked)
 ────────────────────────────────────────────────────────────────
 Browser push on this device: [Turn on]  (push status card)
 Quiet hours (later)
 Per-channel go-live → link to Following
```

- **The matrix:** a `DataTable`-style grid, stacked below sm into one card per row with three
  labelled switches. "always" cells are disabled switches with a `Tooltip` explaining that the law
  or safety requires them.
- **Contract request:**
  - Widen `PREFERENCE_TYPES` to `go_live`, `governance`, `payout`, `digest_weekly`. Each needs a
    `NOTIFY_DEFAULTS` entry and an `UNSUBSCRIBE_LISTS` entry, `weekly` for the digest.
  - `governance` already exists as an unsubscribe list, so this moves an existing list into the UI.
- **Per-channel list:** it leaves Notifications for `/settings/following` (P5). This removes the
  remaining "100+ rows" on this page.
- **Inbox row fixes:** use the display name ("Aurora Pixel went live") with the real avatar.
  - The go-live payload needs `displayName` and `avatarUrl` (**contract request** on the
    `notifications` payload in `contracts/notify.ts`).
  - Each type gets its own Hugeicons glyph and a context line (proposal title, payout amount via
    `MoneyAmount`).

### P5. Retention surfaces (AA-7; M, high)

- **`/following`** is owned by discovery; settings' "Following" nav item links to it. It lists every follow, live first.
  - Each row: `ChannelAvatar`, display name + @username, `LiveBadge` and `ViewerCount` if live,
    "Followed {RelativeTime}", a bell `Switch` labelled "Go-live alerts", and an overflow menu with
    Email/Push per channel and Unfollow (in a `ConfirmDialog`).
  - Above the list: a `FilterBar` (search, Live now / All) and bulk "Alerts on for all / off for all".
  - Data: `me.follows` (it already returns `live` and `notify`).
- **`/inbox`:** a full page behind the popover's new "See all".
  - Grouped Today / This week / Earlier, filter chips All / Live / Co-op / Account, mark all read,
    `EmptyState` with action "Find channels to follow" (to `/directory`).
  - Data: `me.notifications` (paged, `unreadOnly`). Needs a `types` filter input: **contract request**.
- **Weekly "What you missed" email,** a new `packages/email` template beside `goLiveDigest`, sent
  by the worker on the member's local Monday morning.
  - Content: up to 6 new VODs and clips from follows (thumbnail via our own storage URLs, title,
    channel), streams scheduled this week if schedules exist, and open co-op votes with their deadlines.
  - It is skipped when empty. Opt-in only: an unticked checkbox on the first-landing screen, consent
    recorded in `consent_records` (growth-funnels).
  - RFC 8058 list `weekly`. No tracking pixel. Links carry `?src=digest` (a fixed enum), which the
    server counts in aggregate, then strips with `replaceState`.
- **First-follow alert prompt:** after a member's first follow, a one-time inline `Callout` under
  the Follow button: "Want to know when {channel} goes live?" with [Email me] [Browser alerts]
  [Not now]. It writes `notifications.preferences.set`. Watch owns placement.

### P6. Privacy & data: lifecycle that explains itself (AA-12; S, med)

- **Order:**
  1. "Download your data" (account / channel / portability bundle, shown as three `SettingsRow`s,
     each with a status and its last export).
  2. "Who can see you": blocked users, and P2P moves to Preferences > Playback.
  3. `DangerZone` "Delete your account".
- **Delete dialog, three steps** in one `AlertDialog`:
  1. Impact list, built from data: "{n} active subscriptions will be cancelled at period end", "Pending
     payout of `MoneyAmount` is still paid", "Your co-op share is redeemed per the bylaws",
     "@username is released after {n} days" (only if the policy says so; check with coop-trust and
     the deletion job).
  2. A checkbox, "I downloaded my data or don't need it", with an inline "Download now" button.
  3. Type the username.
  - Copy keeps ADR 0004's line: records that must stay (payments, ledger, votes, audit) stay,
    without your name or email.
- **Scheduled state:** a persistent `Alert` at the top of every settings page while a deletion is
  scheduled: "Your account will be deleted on {date}. [Cancel deletion]".
- **Data:** the grace length and impact counts need `me.deletion.preview` (**contract request**,
  read-only: subscription count, pending payout cents + currency, membership class, grace days).

### P7. Preferences = how the site behaves (S, med)

- Language (it exists), Theme (a mirror of the account menu, a radio group), and Playback: Data
  saver default, Share bandwidth (P2P, moved from Privacy), autoplay previews (off is the
  reduced-motion default), and chat timestamps and density if the chat team wants it.
- Purely web state may stay client-side with try/catch. Synced preferences need `me.update`
  fields: **contract request**, per item.

### P8. Admin console: one shell, home, queues, audit (AA-8 to AA-11; L, high for staff speed)

- **Shell:**
  - The grouped sidebar is already there. Add an **Overview** item at the top of every role's nav.
  - Width rule (matches creator-studio): queues and tables 1120 or full-bleed `wide`, forms 768.
    Apply it to all eleven pages, and add a source-policy test.
- **`/admin` home:** `StatTile`s per queue the role can open, for example:
  - "T1 cases: 4 open, 1 due in <1 h" (red `DeadlineCountdown`)
  - "Appeals: 7 open, oldest 3 d"
  - "DMCA: 2 awaiting counter-notice window"
  - "Integrity flags: 5"
  - "Incidents: 1 investigating"

  Each tile links to its filtered queue. Below them: "Recent staff actions" (the last 20 audit
  entries). Data: counts per queue (a new `admin.overview` aggregate, **contract request**) plus `safety.auditLog`.

- **`QueueLayout`** (new in `packages/ui/layouts`, agreed with art-director):

```
┌ PageHeader: Moderation · 23 open ───────────────────── [Assign to me] ┐
│ Tabs: Cases 12 | Labels 3 | Reports 6 | NCII 2                        │
├────────────── list 384px sunken ─┬──── detail (card) ──────────────────┤
│ [Search] [Category▾][Tier▾][Due▾]│ Case · Graphic violence · T1       │
│ 23 results            ☐ select   │ Due in 42 min  ·  Assigned: you    │
│ ☐ ● Sexual · Aurora   due 12m  › │ Frames (blurred until revealed)    │
│ ☐   Weapons · @foo    3h        │ Flags · Evidence · Reporter (by id)│
│ ☐   …                            │ AuditTrail (actor, action, time)   │
│ [Load more]                      │ Decision: clause ▾  note  [Decide] │
├─ bulk bar (raised): 3 selected  [Dismiss as duplicate] [Assign] [×] ─┤
└──────────────────────────────────────────────────────────────────────┘
```

- Below lg the list shows alone, and a row opens `/admin/moderation/$caseId` with Back, so the
  case is never under the list.
- Keyboard: j/k move, Enter opens, `e` focuses decision, `?` shows shortcuts. A `Dialog` lists
  them; no single-key shortcuts while a text field has focus.
- `?tab&case&filters` stay in the URL (the deep-link contract in `docs/testing/b8-selectors.md`
  is kept).
- Bulk actions only where policy allows a batch: dismiss reports, assign. Never bulk T0, legal or
  appeal decisions; each of those needs its own reasoned resolution.
- **Same layout everywhere:** appeals, DMCA, legal, integrity, apps review and the creator-studio
  `/mod/$channel` held queue (agreed with creator-studio pending; message sent).
- **Claiming:** "Assign to me" or "Unassigned" on each case, so two moderators don't decide the same
  case. This needs `moderation.assign` and an `assignee` field: **contract request**, with audit rows.
- **`/admin/audit`:** a `DataTable` of `safety.auditLog`.
  - Columns: time (`RelativeTime`), actor (display name, from `users.lookup`), action (catalogued
    label, raw code `text-xs tabular-nums` under it, never mono), subject (link to its queue item).
  - `FilterBar`: actor, subject type, subject id, date range (the shared date field from `3483c1d3`).
  - CSV export of the filtered page for admins (client-side, from loaded rows).
  - Each case detail embeds the `AuditTrail` (a `timeline.tsx` variant).
- **`/admin/users/$username` lookup:** account standing, enforcement statements, suspensions with
  suspend/unsuspend (`safety.suspend`), open reports and cases by subject, audit entries for the
  subject, and legal holds. Show the email only to admins, behind a "Reveal" that writes an audit
  row (**server request**). This is where staff go from a report to a person.

### P9. Small fixes (S, low-med)

- AA-13 display names (part of P4).
- Drop the duplicate h1/tab text by making the nav label the h1 (P1).
- The unsubscribe page links on to "Manage all notifications" (sign-in returnTo).

## 4. Funnel and conversion notes (retention: the end of the funnel)

| Step                | Entry                                   | CTA                                                                    | Drop-off risk                                 | First-party counter (growth-funnels scheme: surface, action, step, day) |
| ------------------- | --------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| 1. First follow     | channel Follow                          | Follow (channel accent)                                                | n/a                                           | `follow.click` (watch)                                                  |
| 2. Opt in to alerts | first-follow `Callout` (P5)             | "Email me" / "Browser alerts" (outline; no brand on settings surfaces) | email off by default, so silent churn today   | `notify.optin` (medium as the step), `notify.prompt.dismiss`            |
| 3. Come back        | go-live mail/push, weekly digest, inbox | links `?src=golive\|digest\|coop`                                      | mail never opened; dead links (AA-1)          | `digest.sent`, `digest.click`, `golive.click`, `inbox.open`             |
| 4. Return watch     | channel / VOD                           | Follow, then Support                                                   | n/a                                           | `follow.from_notification`, watch-session start with `src`              |
| 5. Stay in control  | settings, unsubscribe                   | Unsubscribe one list, not all                                          | all-or-nothing unsubscribe means lost members | `unsubscribe.list` (per list), `settings.notify.change`                 |
| 6. Leave well       | delete / export                         | Download first, then schedule                                          | regret; deletion with no export               | `export.request`, `deletion.schedule`, `deletion.cancel` (counts only)  |

- Every counter is an aggregate, with no user id, IP or cookie, and is shown in the `/admin` home's
  growth card (growth-funnels' decision).
- A `?src` value is a fixed enum, never an id, stripped after the server counts it.
- No pixels in mail, and no link-redirect tracking per member.

## 5. Cross-team decisions

- Settings nav: a sunken left `SectionNav` at lg, the `Select` below lg, the tab row dropped; groups
  as in P1; bare `/settings` goes to Account. **Agreed: art-director.**
- Components extend existing blocks: `SettingsSection` / `SettingsRow` (variants of Section and
  FormSection), `DangerZone` (AlertCallout destructive), `QueueLayout` (new), `DataTable` stacked
  mode + bulk bar, `FilterBar` count slot, `AuditTrail` (Timeline variant), codes in tabular-nums,
  never mono. **Agreed: art-director.**
- Retention: `/inbox`, an opt-in weekly digest (unticked, `consent_records`, RFC 8058), `/following`,
  the first-follow alert prompt, `?src` as a fixed enum, counter ids as in section 4. **Agreed: growth-funnels.**
- No brand fill on settings or admin. **From:** the art-director and growth-funnels logs.
- `SettingsSection` / `SettingsRow` on `/dashboard/settings` too, with two exceptions there: the
  stream key and server URL use `CopyField` with Reveal, and key rotation is that section's
  `DangerZone`. `QueueLayout` gains a `compact` mode that creator-studio embeds in `/mod/$channel`
  (chat | held list | case drawer). Admin widths: tables 1120, forms 768. Reuse
  `studio/stacked-rows.tsx`, `studio/empty-action.tsx`, `studio/date-time-field.tsx` and
  `nav.ts` `adminNavGroups`. **Agreed: creator-studio.**
- `/following` is **discovery's** page: Live now `StreamCard`s, then Offline `ChannelChip` rows,
  linked from the rail "See all", the account menu and the mobile sheet. I sent the row-control spec
  (a "Go-live alerts" switch, then an overflow menu with Email/Push Default-On-Off, "Tell me if they
  move" and Unfollow in a `ConfirmDialog`; bulk all on/off; display name first). Settings links to
  it rather than duplicating it, so P5's `/settings/following` becomes a link to `/following`.
  **Agreed: discovery.**
- The session guard treats only a 401 as signed out (AA-15). **Agreed: responsive-a11y.**
- The 500s were rate-limited SSR, not slugs. Watch owns it. **Confirmed by watch.**

## 6. References

All are general product knowledge, not crawled this session. No assets or copy were taken.

- **GitHub settings:** a grouped left settings nav (Access / Security / Integrations), and a
  "Danger Zone" section style. I borrowed the grouping and the destructive-section idea, not the visuals.
- **Google Account / GitHub "Sessions":** a device list with "This device" and per-row sign out,
  and a 2FA stepper that ends on backup codes. I borrowed the step order.
- **YouTube notifications settings / Twitch notification matrix:** per-type rows × per-medium
  switches. I borrowed the matrix layout.
- **Linear triage / Zendesk views:** a list pane plus a detail pane, j/k keyboard, assign to me,
  counts per view. I borrowed the master-detail and claim pattern for `QueueLayout`.
- **Stripe dashboard:** a home with "needs attention" tiles that deep-link to filtered lists, and an
  events log filterable by object. I borrowed the admin home tiles and the audit-log filters.
- **Mastodon (FOSS) admin:** account lookup with moderation history and reports by subject. I
  borrowed the user page contents.

## 7. Top 5 (ranked)

0. **AA-15 guard fix:** a 429 on `/me` must not send a signed-in member to Sign in. S, and it
   blocks reliable use of every guarded page.
1. **P3 `/settings/security`** (AA-1): a 404 behind a live security email, and 2FA/passkeys built
   but unreachable. M.
2. **P8 admin `QueueLayout` + home + audit log** (AA-8, AA-10, AA-11): faster, safer staff decisions
   and visible accountability. L (can ship in parts: QueueLayout for moderation first).
3. **P4 + P5 retention** (AA-6, AA-7): the notification matrix, the first-follow alert prompt,
   `/following`, `/inbox`, the weekly digest. M, highest growth impact.
4. **P1 + P2 settings shell and Account page** (AA-2 to AA-5): one pattern, a grouped nav, display
   name and the email-sharing toggle given a UI. S-M.
5. **P6 lifecycle** (AA-12): a deletion impact preview, a scheduled-deletion banner, export-first. S.

### Contract and server requests (orchestrator)

- `AUTH_ROUTES` for 2FA, passkeys, sessions, password and email change.
- Wire `newSignIn.sessionsUrl` to `/settings/security#sessions`.
- Enable better-auth `changeEmail`.
- `me.update` gains `matureConfirmed: false` (revoke) and synced preference fields.
- A viewer avatar upload.
- Widen `PREFERENCE_TYPES`, `NOTIFY_DEFAULTS` and `UNSUBSCRIBE_LISTS` (`governance`, `payout`, `weekly`).
- `displayName` and `avatarUrl` in the go-live notification payload.
- A `types` filter on `me.notifications`.
- `me.deletion.preview`.
- `admin.overview` counts.
- `moderation.assign` and `assignee`.
- An audited admin email reveal.
