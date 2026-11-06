<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Responsive, accessibility and PWA (responsive-a11y)

Finding prefix **RA**. Read-only pass on staging (https://staging-stream.abolish.us) plus source.
Method: an audit script run in my own tab via `javascript_tool` on each route. It reports document
title, `scrollWidth` vs viewport, elements overflowing the viewport (ignoring those clipped by a
scroll container), interactive targets under 24px, controls with no accessible name, sampled
text contrast (computed colour against the composited background, AA thresholds), visible heading
outline, landmarks and font-size distribution. I added keyboard Tab passes with
`:focus-visible` style reads, screenshots at 320/375 and reading of `apps/web/src/{pwa,sw,server/pwa.ts}`
and `packages/ui`.

**Caveats.** Staging rate-limited the shared IP (429) partway through. Some of my client-side
navigations rendered the error state instead of the page, so I discarded "missing h1" results for
channel, VOD, clip and category; the source confirms that those pages do render an h1. Once the pane
was signed in, the user's stored theme preference overrode `prefers-color-scheme`, so I verified the
light theme from tokens and earlier signed-out light screenshots rather than a full live light sweep.
The 768 width was spot-checked, not swept route by route.

## 1. What exists now

| Route                          | 1440                                                     | 320 / 375                                                                                                                                                                                           | Notes                                                                                                                    |
| ------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `/` home                       | Rail + Spotlight + Live now + Categories + Recently live | No horizontal scroll. The welcome strip takes the first screen. 42 targets under 24px (tag chips 20px tall, category link 17x16, title links 17px). 13 text nodes at 10px, 136 at 12px              | Title "Live channels · CommonAir"; one h1; landmarks header/nav(Main)/nav(Channels)/main/aside(Welcome)/footer           |
| `/directory`, `/directory/art` | Grid, Language filter                                    | No horizontal scroll. The Language filter button is 65x18                                                                                                                                           | The category page has an h1 (`components/discovery/category-page.tsx:130`); the title is per category                    |
| `/search?q=`                   | h1 "Results for …"                                       | Fine                                                                                                                                                                                                | Title "Search: pixel · CommonAir"                                                                                        |
| `/demo_streamer1` live         | Player + chat                                            | Player, then header, then tabs, then Recent videos; chat is far down. The "Quality and Data saver moved" coachmark covers most of the player at 320. The tab row shows a grey edge at its right end | First paint title is the slug ("demo_streamer1 · CommonAir"), later "Aurora Pixel (live) · CommonAir"                    |
| `/demo_s0098` offline          | Offline hero                                             | No horizontal scroll                                                                                                                                                                                |                                                                                                                          |
| VOD, clip                      | Player + meta                                            | Scrubber and volume `role=slider` thumbs are **10x10**                                                                                                                                              | VOD title is good ("<title> · <channel> · CommonAir"); clip is "Clip · demo_streamer1 · CommonAir" (slug, no clip title) |
| `/signin`, `/signup`           | Centred form                                             | Fine at 320                                                                                                                                                                                         | Signup uses Base UI hidden inputs (not a real defect)                                                                    |
| `/coop`                        | Overview                                                 | Fine                                                                                                                                                                                                |                                                                                                                          |
| `/transparency`                | Long report                                              | **55 targets under 24px** (inline 16px-tall list links); 3 Selects                                                                                                                                  |                                                                                                                          |
| `/dashboard` (signed in)       | —                                                        | No horizontal scroll at 375. The header wordmark truncates to "Common…" (5 controls: search, studio sidebar toggle, notifications, avatar, menu). The coachmark again covers the preview            | Title "Stream manager · CommonAir"                                                                                       |
| `/settings` (signed in)        | —                                                        | **Redirected to `/signin`** while the header still showed the signed-in avatar (`/api/me` was 429 at that moment)                                                                                   | See RA-3                                                                                                                 |

Fixed since the 2026-11-03 review: F15 per-route titles (mostly), F16 skip link first
(`packages/ui/src/layouts/app-shell.tsx:39-45`, now first in all three shell variants), F4 header
collapse at 375 (the header now wraps cleanly at 320). No route scrolls horizontally at 320 or 375.
A global `prefers-reduced-motion` rule exists (`packages/ui/src/styles/globals.css`, after `:450`).
A fallback `:focus-visible` outline exists for unstyled controls. Sampled text contrast found **no AA
failures** on any route in dark. In light, the tokens pass: `--muted-foreground` oklch(0.5) on white is
about 7:1.

PWA today: the manifest (`apps/web/src/server/pwa.ts:35-53`) has id, name, short_name, start_url,
scope, standalone display, colours and icons (including maskable). It has no `description`,
`shortcuts`, `screenshots` or `categories`. The service worker (`apps/web/src/sw/sw.ts`) caches the
shell only (`/assets/`, `/icons/`) and serves no navigations, so going offline shows the browser's
error page. There is an update prompt (`components/pwa/pwa-root.tsx`). Go-live push works, but the
opt-in lives only in settings (`components/notifications/settings.tsx:132`). There is no
`beforeinstallprompt` handling and no install entry point anywhere.

## 2. Findings

- **RA-1 (high)**: No mobile primary navigation. Below md, Browse and Co-op exist only inside the
  hamburger Sheet (header links measure 0x0 at 320). In a standalone PWA there is no browser chrome
  either, so the app has no persistent way to move between Home / Browse / Following. Evidence: the
  header controls at 320 are `CommonAir 94x24, Browse 0x0, Co-op 0x0, search 32, notifications 32,
  account 54x28, menu 32`.
- **RA-2 (high)**: Live watch at 320/375: chat starts about 1000px down (player > header > tabs >
  Recent videos > chat). The coachmark covers the player. Evidence: `/demo_streamer1` at 320 dark,
  and `/dashboard` at 375. (Owned by watch; conditions agreed, see section 5.)
- **RA-3 (high)**: Any `/api/me` failure counts as signed out. With a 429, `/settings` redirected to
  `/signin` while the header still showed the avatar. Root cause (found with account-admin):
  `apps/web/src/server/bootstrap.ts:80` `fetchMe(cookie).catch(() => null)` feeds `requireSession`
  (`lib/guard.ts`). Logged as AA-15.
- **RA-4 (med)**: Load failures (429/503) show bare text "The directory could not be loaded. Reload to
  try again." It has no heading, no Retry button and no automatic retry. Evidence: `/` at 320 after a 429. The same pattern appears in the inbox popover, notification defaults and the move-notice list
  (per account-admin).
- **RA-5 (med)**: Small tap targets. Media scrubber and volume thumbs are 10x10 (VOD, clip and the
  dashboard preview, at 320). Tag chips are 20px tall and the category link under a tile is 17x16 on
  home and category pages. On `/transparency` 55 inline list links are 16px tall. The header icon
  buttons are 32x32: they pass 2.5.8 but sit under the 44px touch guidance.
- **RA-6 (med)**: Focus rings are inconsistent. 9 primitives use `focus-visible:ring-1` (input,
  select, checkbox, switch, slider, textarea, accordion, navigation-menu); buttons use `ring-2`.
  A 1px grey ring on a switch or input is a weak indicator (WCAG 2.4.11 / 2.4.13). Evidence:
  `grep focus-visible:ring-1 packages/ui/src/components`, and a live read of the focused cookie
  switch: `box-shadow … 0 0 0 1px oklch(0.705…)`.
- **RA-7 (med)**: 10px text carries information on tiles. 13 nodes on home render at 10px (viewer
  pills, rail counts), and body text defaults to 12px (136 nodes on home, 59 on `/dashboard`).
- **RA-8 (med)**: The signed-in header overflows its wordmark at 375 ("Common…").
- **RA-9 (low)**: The first-paint title on channel pages uses the slug ("demo_streamer1 · CommonAir")
  before data loads, and clip titles never include the clip name. Screen-reader announcements and
  shared tabs show the slug.
- **RA-10 (low)**: The channel tab row's overflow shows a grey bar at its right edge at 320/375 rather
  than a scroll-fade cue (F31 is still partly open).
- **RA-11 (med)**: The PWA cannot be discovered or used offline: no install entry point, no offline
  fallback, no manifest shortcuts or screenshots (so Chrome's richer install UI is unavailable), and
  push is offered only deep in settings.
- **RA-12 (low)**: Live chat auto-scrolls with no pause (WCAG 2.2.2 for moving content). There is no
  "N new messages" affordance when the user scrolls up (source: `apps/web/src/chat/chat-panel.tsx`).
  Confirm in the watch rebuild.

## 3. Proposals

**P1. System responsive rules (agreed with art-director, logged).**

- Breakpoints: base <640 single column; `sm` 640 two-column media grids; `md` 768 inline header nav,
  no bottom bar; `lg` 1024 watch page in two columns (player | chat 340); `xl` 1280 left rail expanded;
  `2xl` 1536, content capped at 1600.
- Gutters 16 / 24 (md) / 32 (xl). Media grids `auto-fill minmax(248px,1fr)`, `gap-x-4 gap-y-6`.
- Every route has a 320px story or harness screenshot in both themes.

**P2. `BottomTabBar` (new, packages/ui; agreed with art-director).** Below md, on browse routes only
(`/`, `/directory*`, `/search`, `/following`, `/coop*`).

```
┌────────────────────────────────────┐
│ [mark]                 (🔍) [Sign up]│  header: mark + search + Sign up outline | avatar
│ … content …                         │
├──────┬────────┬───────────┬────────┤
│ Home │ Browse │ Following │  You   │  56px + env(safe-area-inset-bottom)
└──────┴────────┴───────────┴────────┘  (signed out: Co-op instead of Following)
```

`nav aria-label`, labels always visible, `aria-current="page"`, `--surface-raised`, Hugeicons at 20,
targets 56 tall. Hidden on watch, auth, studio, settings and admin routes, and while the virtual
keyboard is open (`visualViewport` height check). "You" opens the account Sheet, or Sign in when
signed out. Effort M, impact high (retention and PWA).

**P3. Header at small widths (agreed).** The mark only below 400px or whenever the signed-in cluster
shows (container query). Accessible name "CommonAir, home". Icon buttons get 40–44px hit areas below
md with the glyph at 20. Effort S.

**P4. One focus rule (agreed).** `ring-2 ring-ring ring-offset-2 ring-offset-background` on every
primitive. The 9 `ring-1` primitives move to it, and brand fills never carry the ring directly
(grey on marigold is about 1.9:1). Add a unit test that scans `packages/ui/src/components` for
`focus-visible:ring-1`. Effort S.

**P5. Target sizes.** Sliders get a ≥24px hit area (44px tall on touch) with a thin visual track.
Chips are `min-h-6` with `gap-2`. Inline link lists become block rows (`min-h-11` below md, chevron).
A Storybook/harness check fails on visible interactive elements under 24x24 unless they meet the
spacing exception. Effort S–M.

**P6. Resilient load and session states.** Only 401 means signed out. A 429/5xx/network failure keeps
the route and shows `<EmptyState>` "We couldn't check your session" with Retry. Every list load
failure shows `<EmptyState>` with an h2 and a Retry button, auto-retries at 1/3/9s on 429/503, and an
SSR 429 renders that state, never a 500 (agreed with discovery and account-admin). Effort S–M.

**P7. Watch on mobile (watch owns it; my conditions accepted).** Sticky 16:9 player. The site header
scrolls away on watch routes. A compact 48px channel row. A Tabs-based "Chat | About" switcher
(role=tablist, arrow keys). When the composer has focus, the switcher and compact row hide. Chat is
`role=log aria-live=polite aria-relevant=additions` with an "N new messages" pill and no auto-scroll
while scrolled up or focused (RA-12). No smooth scroll or slide animation under reduced motion. At
320 the name truncates, Follow is 44 tall, and Share/Support go into the overflow. The coachmark is
removed (watch replaces it with a "Data saver · Low" chip shown only when a budget is on).

**P8. Titles and headings.** `titleHead` uses the display name from SSR loader data (never the slug).
Clip titles are `"<clip title> · <channel> · CommonAir"`. Every error state renders an h1 when it
replaces the page. Extend the existing title test to error states. Effort S.

**P9. Type floor (agreed with art-director).** Body moves to `text-sm`. `text-2xs` is allowed only
over video with a scrim. Tile and rail counts move to 12px `tabular-nums`. Warning, destructive and
live always pair an icon with a word (orange and red merge for deuteranopes).

**P10. PWA as a product surface (agreed with growth-funnels).**

- Manifest: `description`, `categories ["entertainment","social"]`, `shortcuts` (Following, Browse,
  Go live for creators; i18n names from the instance locale), `screenshots` (narrow 750x1334 and wide
  1440x900, rendered by the harness like the icons, using our own seeded UI only).
- Offline: the service worker precaches `/offline` (a static page with the arcs motif, "You're offline",
  a Retry button and a link to downloads/settings). A `navigate` request that fails falls back to it.
  Still no personal data in caches.
- Install: capture `beforeinstallprompt`. "Install CommonAir" is always in the account menu and the
  mobile "You" sheet. It is offered contextually once, after a second visit with 3+ minutes watched;
  that check lives in localStorage only (try/catch) and is never sent. iOS gets a Dialog with Add to
  Home Screen steps.
- Push: merged into growth-funnels' single first-follow Popover on the Following button, offering
  [Push] [Email] [Not now]. Never on page load; after "Not now", re-offered at most once every 30 days.
- In standalone mode, `BottomTabBar` and safe-area padding apply; the update prompt sits above the tab bar.
  Effort M, impact med-high (return visits).

## 4. Funnel and conversion notes

- **Mobile entry:** a shared link lands on a channel page. The risk is that chat sits 1000px down and
  the only conversion moment is buried. With P7 the Follow button stays in the compact row, always
  visible.
- **Browse to watch:** the bottom bar gives repeat navigation without the hamburger (RA-1).
- **Return loop:** first follow, then the alert Popover (Push/Email), then go-live notification, then
  the notification click opens the channel (the service worker focuses an existing window). Install
  is a second return loop for engaged mobile viewers.
- **Drop-off risks:** a 429 session flap bouncing signed-in users to /signin (RA-3); bare load errors
  with no Retry (RA-4); keyboard-covered composer on phones.
- **Measurement** (first-party aggregate counters, growth-funnels' scheme): `pwa.install.offered|accepted|dismissed`
  (from `userChoice`), `pwa.push.offered|enabled|dismissed`, `pwa.standalone.session` (daily, from
  `matchMedia('(display-mode: standalone)')`), `nav.bottom.<tab>.click`, and `error.retry.<surface>`
  plus `error.autoRecovered.<surface>` to size the rate-limit problem. No ids, no IPs.

## 5. Cross-team decisions

- Breakpoints, the bottom tab bar, the mobile header, the single focus rule, the status icon+word
  rule, the text-2xs and 12px count rule (agreed with **art-director**; logged).
- Mobile watch layout conditions 1–7 (agreed with **watch**; logged by watch).
- Tile tag chips min-h-6, counts 12px, load-failure EmptyState + auto-retry (agreed with **discovery**, DS-16).
- 401-only sign-out and the session-check EmptyState (agreed with **account-admin**, AA-15).
- PWA manifest/offline/install/push plan and counters (agreed with **growth-funnels**; push merged
  into their first-follow Popover).
- Transparency, /coop and council lists become block-link rows (min-h-11 below md, chevron, status chip on the right), outcomes capped at 10 with "All decisions", and the Selects get visible labels in one wrapping row (agreed with **coop-trust**).
- I signed off the art-direction tokens: `--brand` #f7bd36 with zinc-950 text is 11.6:1; light
  `--brand-text` #8f5d00 on white is 5.6:1 (about 5.3 on zinc-50); `--warning` #fb923c on dark is about
  8:1; #9a3412 on white is about 7:1.

## 6. References

- WCAG 2.2: 2.4.1 Bypass Blocks, 2.4.2 Page Titled, 2.4.11/2.4.13 Focus Not Obscured / Appearance,
  2.5.8 Target Size (Minimum), 2.2.2 Pause, Stop, Hide, 1.4.11 Non-text Contrast. Borrowed: the
  thresholds and the 24px spacing exception.
- YouTube mobile web (m.youtube.com): a bottom tab bar on browse surfaces that is hidden on the watch
  page. Borrowed: the show/hide rule, not visuals.
- Twitch mobile web: a sticky player with chat below and the site header scrolling away. Borrowed: the
  height-budget idea for P7.
- web.dev "Patterns for promoting PWA installation" and the MDN Web App Manifest pages (`shortcuts`,
  `screenshots`). Borrowed: a contextual install offer after engagement, a permanent menu entry, and
  richer install UI via screenshots.
- Apple Human Interface Guidelines and Material 3: 44pt / 48dp touch targets. Borrowed: the touch
  target goal above the WCAG minimum.

## 7. Top 5

1. **Bottom tab bar + mobile header rules** (P2/P3): fixes mobile navigation and makes the PWA usable. M.
2. **Mobile watch layout with chat in reach** (P7, watch owns it): the core viewing and conversion
   surface on phones. L.
3. **Resilient session and load states** (P6): stops signed-in users being bounced to /signin, and adds
   Retry and auto-retry everywhere. S–M.
4. **One focus rule + target sizes** (P4/P5): ring-2 with offset everywhere; sliders, chips and list
   rows at 24px or more, with a lint/test guard. S.
5. **PWA as a return loop** (P10): offline page, manifest shortcuts and screenshots, contextual install,
   push in the first-follow Popover, first-party counters. M.
