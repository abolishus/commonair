<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N2-consent: the cookie consent banner, the footer cookie settings and consent-gated preference cookies

You are implementing unit N2-consent for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md
(Design rules, house primitives), PLAN.md and docs/architecture.md first, then
`packages/db/src/legal/cookies.md` (the cookie policy this unit makes true; after the N2 contract
step its Preferences paragraph names language and the tab-only rule), `docs/decisions/0029-i18n.md`
(decision 3: the locale cookie is a Preferences cookie), `.claude/briefs/n2/contract-step.md` (§6,
§6.1, §6.2), `docs/testing/n2-selectors.md` (the contract step wrote it; you build against it),
`.claude/briefs/n2/N2-core.md` ("Negotiation" and "How to add a namespace") and the i18n format
N2-core landed in wave 1 (`apps/web/src/i18n/README.md`, `packages/i18n`), and
`.claude/briefs/_done-means.md`. Do not look outside the repository. Work in your own git
worktree on a branch named `n2/consent`, created from `main` after wave 2 merged (the
orchestrator gives you the sha). Wave 3, beside E9-sdk, E9-consent and E9-console. Added to the
batch on 2026-10-29 (user decision).

## Why

The cookie policy promises that optional storage is "off until you turn it on" and that a
"cookie settings link in the site footer" changes the choice. Neither exists: nothing in
`apps/web` calls `legal.consent`, there is no footer link, and the theme cookie is written on
every toggle without consent (`apps/web/src/lib/theme.ts:18-20`). N2-core's locale cookie is
written only with consent (`rememberLocale(tag, { preferencesAllowed })`), but nobody can give
consent yet, so a signed-out language choice is tab-only. You build the consent UI and make every
Preferences cookie respect it.

## You own (write only these)

- `apps/web/src/lib/consent.ts` (new): cookie names and format, parse/serialize, the consent
  store, `preferencesAllowed()`, saving, the grant/withdraw side effects.
- `apps/web/src/components/consent/**` (new): `ConsentRoot` (banner plus dialog, mounted once),
  `ConsentBanner`, `CookieSettingsDialog`, `CookieSettingsButton` (the footer entry).
- `apps/web/src/lib/theme.ts`: consent-gated `storeTheme`, a tab-only fallback, expiring the
  cookie. Keep `THEME_COOKIE` and `themeFromCookie` as they are.
- `apps/web/src/routes/__root.tsx`: only the theme setter (`setTheme` in `themeValue`), applying a
  tab-only theme after hydration, and mounting `<ConsentRoot />` (N2-core's i18n parts stay as
  they are).
- `apps/web/src/server/bootstrap.ts` and `apps/web/src/lib/bootstrap-types.ts`: `Bootstrap` gains
  `consent` (the stored choice parsed from the request's cookie, or `null`), so the server renders
  the banner exactly when the client will. Nothing else in them (N2-core's locale fields stay).
- `apps/web/src/components/site-chrome.tsx`: only `InstanceFooter` (and its imports), to add the
  cookie settings entry. The header, account menu and `AccountLink` parts belong to the E9
  contract step and stay as they are.
- `packages/ui/src/components/sidebar.tsx`: only the `document.cookie` write in `setOpen` (:81-82)
  and the two `SIDEBAR_COOKIE_*` constants it uses, which you delete (below); and the
  `src/components/sidebar.tsx` row of `packages/ui/DEVIATIONS.md`. A test in
  `packages/ui/tests/sidebar-storage.test.tsx` (new).
- Your i18n namespace **`n2-consent`** (created empty by N2-core): `apps/web/src/i18n/locales/en/n2-consent.json`
  and the regenerated `apps/web/src/i18n/keys/n2-consent.gen.ts` (`cd apps/web && bun run i18n:gen`),
  keys under the `consent.` prefix, following "How to add a namespace" in
  `.claude/briefs/n2/N2-core.md`: **only this namespace**; never `en.ts`, `index.ts`,
  `keys/index.gen.ts`, another namespace, or N2-core's files and tests. If the namespace does not
  exist, stop and send a contract request.
- `apps/web/tests/n2-consent*.test.ts(x)` (new). In other `apps/web/tests/*` files, only what your
  change breaks: the `Bootstrap` fixtures that need the new `consent` field (`e6-routes`,
  `e7-legal`, `coop-e7`, `selectors-render`, `coop-routes`, `p2p-indicator` `.test.tsx`, as N2-core
  found them) and the theme assertions of `apps/web/tests/env.test.ts`, if `storeTheme` changes
  break them.

Read-only, in particular: `packages/contracts/**`, `packages/db/**` (the legal documents and
`CONSENT_CATEGORIES`), `services/**`, `apps/web/src/i18n/**` (N2-core's: use
`rememberLocale`, `forgetLocaleCookie`, `LOCALE_COOKIE`, `LOCALE_SESSION_KEY` from
`apps/web/src/i18n/client.ts`), `apps/web/src/lib/{nav,guard,api,overlay-page}.ts`,
`apps/web/src/routeTree.gen.ts`, `apps/web/tests/{selectors,i18n,logical-css}.test.ts`,
`docs/testing/**`, every E9 web file (`routes/_app/{oauth2.authorize,activate,settings.connections}.tsx`,
`routes/_studio/developer.*`, `routes/_admin/admin.apps.tsx`, `components/{oauth,developer}/**`:
E9-consent and E9-console write them beside you), `harness/**`. Anything else is a **contract
request** with the exact diff.

No new route, no new dependency, no change to the API.

## Contracts you must honor (read-only for you)

- **`legal.consent`** (`packages/contracts/src/api/router.ts:2571-2587`, `POST /api/consent`):
  public, `rateLimit: "write"`; input `{ anonymousId?: string (16-64), choices: Record<string,
  boolean> (≤ 16 keys), policyVersion: string (≤ 64) }`; output `{ ok: true }`. The handler
  (`services/api/src/routes/legal.ts:52-70`) refuses a signed-out call without `anonymousId`
  (`BAD_REQUEST`), a `policyVersion` that is not the current cookie policy's (`BAD_REQUEST`), and
  unknown categories (`BAD_REQUEST`, `services/api/src/lib/legal.ts` `normalizeConsentChoices`);
  it stores `essential: true` whatever is sent. A signed-in record stores the user id and **never**
  the anonymous id ("keeping both would link a visitor's pre-sign-in browsing identity to their
  account"). It is **write-only**: no procedure reads a stored choice back, so the browser keeps
  its own copy (the policy's essential "Consent record").
- **Rate limit**: the `write` bucket is 30 requests a minute per subject
  (`services/api/src/lib/ratelimit.ts:20`); a signed-out caller's subject is its address
  (`ip:<hmac>`, `services/api/src/lib/orpc.ts:137`), shared behind NAT. So call it once per save
  and at most one silent retry per tab, never on every page load. `RATE_LIMITED` carries
  `retryAfterSeconds`.
- **Retention**: signed-out records are deleted after 395 days
  (`ANONYMOUS_CONSENT_RETENTION_DAYS`, `services/worker/src/legal/consent-retention.ts:21`);
  signed-in records go with the account. Your cookies must expire before that: 365 days.
- **Categories**: `CONSENT_CATEGORIES = ["essential", "preferences"]`
  (`packages/db/src/legal/index.ts`; web code must not import `@commonair/db`: mirror the two
  names in `lib/consent.ts` with a test that they equal the server's list, reading the constant
  in the test only). `essential` is always on and cannot be switched off.
- **The cookie policy** (`legal.get({ kind: "cookies" })` → `LegalDocument` with `version`,
  `title`, `body`, `isDraft`): the version you record, and the text the dialog links to through
  `LegalDocumentLink` (`apps/web/src/components/legal-document-link.tsx`; there is no `/legal`
  route). Essential per the policy: the session and security cookies, the consent record (your
  cookies), the playback device id (`sessionStorage` `commonair-device`,
  `apps/web/src/player/stats.ts:83-95`) and the P2P choice (`localStorage`,
  `apps/web/src/player/p2p/preference.ts`). Preferences: theme, language, player volume and
  quality, chat display options and similar.
- **N2-core** (`apps/web/src/i18n/client.ts`): `rememberLocale(tag, { preferencesAllowed })`
  (cookie with consent, else `sessionStorage`), `forgetLocaleCookie()`, `LOCALE_COOKIE`
  (`commonair-locale`), `LOCALE_SESSION_KEY`. N2-core already applies a tab-only locale after
  hydration; you do not. Negotiation reads the cookie for any visitor whose `Me.locale` is null.
- **Selectors**: every id in `docs/testing/n2-selectors.md` "Test ids" (`consent-banner`,
  `consent-accept-all`, `consent-reject`, `consent-customize`, `consent-dialog`,
  `consent-category`, `consent-toggle-preferences`, `consent-save`, `consent-policy-link`,
  `consent-error`, `footer-cookie-settings`) with the attributes it lists.
- **Design rules** (AGENTS.md): shadcn/ui on Base UI (`Dialog` from
  `@commonair/ui/components/dialog`, `Switch` from `@commonair/ui/components/switch`, `Button`), Hugeicons, tokens only (no hex), `toast.*` from `@commonair/ui/toast`, no
  `alert/confirm/prompt` or native `title`, keyboard and screen-reader complete, visible focus,
  WCAG AA, `prefers-reduced-motion`, 320 px wide with a 16 px gutter and no horizontal scroll,
  dark first with a full light theme, logical CSS only (`apps/web/tests/logical-css.test.ts`).
  Every string through `t()` in your namespace.

## What is there today (verified at `c0c16fd`; recheck against your base)

- `apps/web/src/lib/theme.ts:7-21`: `THEME_COOKIE = "commonair-theme"`, `themeFromCookie`
  (default `"dark"`), `storeTheme` writes the cookie for a year with no consent check. Callers:
  `routes/__root.tsx:50` (the `setTheme` of `ThemeContext`, used by the header's `ThemeToggle`,
  `components/site-chrome.tsx:165-187`) and `server/bootstrap.ts:7,36` (reads it for SSR).
- `components/site-chrome.tsx:258-270` `InstanceFooter` builds `SiteFooter`
  (`packages/ui/src/layouts/site-footer.tsx`) from `footerNav()` (`lib/nav.ts:161-167`:
  transparency, takedown, dmca) through `footerLink`. `SiteFooter` renders each link's `render`
  element with `React.cloneElement(link.render, {}, link.label)`, so a `<button>` works as an entry
  with no `packages/ui` change. `AppFooter` is used by `_app.tsx`, `_admin.tsx` and `_studio.tsx`;
  `/overlay/*` (`lib/overlay-page.ts`) and `/embed/$channel` have no footer.
- `packages/ui/src/components/sidebar.tsx:81-82` writes `sidebar_state` on every desktop toggle
  (shadcn's default). Nothing reads it (`git grep sidebar_state` finds only this file and its
  upstream snapshot), so it is a Preferences cookie with no use. `packages/ui/DEVIATIONS.md` already
  has a `sidebar.tsx` row; `packages/ui/tests/deviations.test.ts` requires one for any change.
- Nothing in `apps/web` calls `legal.consent`.

## Build

1. **Stored consent (`lib/consent.ts`).**
   - Cookie `commonair-consent` (essential: it is the policy's "consent record"): the policy
     version the choice was made for, `preferences` (`true`/`false`), and how it was recorded on
     the server (`user`, `anonymous`, or `pending` when the request failed). Your format, URL-safe,
     with `parseConsent(cookieHeader | document.cookie): StoredConsent | null` (anything malformed
     → `null`) and `serializeConsent`. Attributes: `path=/; max-age=31536000; samesite=lax`, plus
     `secure` on `https:`; not HttpOnly (the client writes it).
   - Cookie `commonair-consent-id` (essential, the policy's "random identifier in a first-party
     cookie" for signed-out visitors): 32 lowercase hex characters from `crypto.getRandomValues`,
     created the first time a signed-out visitor saves, same attributes. Never sent when signed in.
   - `preferencesAllowed(): boolean`: true only when a stored consent exists, is for the current
     policy version as far as this tab knows, and has `preferences: true`. Exported for N2-switcher
     (later), which passes it to `rememberLocale`.
   - A small external store (`useSyncExternalStore`) holding the stored consent, the current
     policy version once known, and whether the dialog is open, with `openCookieSettings()`.
   - Wrap every `document.cookie`, `sessionStorage` and `localStorage` access in try/catch; a
     browser that blocks storage still renders, the banner simply shows again next time.
2. **Saving.** `saveConsent({ preferences })`: take the current policy version (fetch
   `legal.get({ kind: "cookies" })` once per tab and cache it); write the cookie first, so the
   choice applies at once whatever the network does; apply the side effects (item 4); then call
   `legal.consent` with `choices: { essential: true, preferences }`, the version, and
   `anonymousId` only when signed out (bootstrap `me` is null). On success set the recorded marker
   to `user` or `anonymous`. On `RATE_LIMITED` or a network error set `pending`, show
   `consent-error` (`data-code` `rate_limited` or `network`) saying the choice applies on this
   device and will be recorded later, and retry once on a later page load in this tab (a
   `sessionStorage` flag). On `BAD_REQUEST` because the version is no longer current
   (`data-code="policy_changed"`): refetch the version and show the banner again with
   `data-reason="policy-changed"`. When a signed-in visitor has a stored consent recorded as
   `anonymous` or `pending`, record it once as the user (no `anonymousId`) and mark it `user`.
3. **When to ask.** The server parses the consent cookie into `Bootstrap.consent`, so SSR and the
   first client render agree. The banner shows when there is no stored consent
   (`data-reason="none"`). After hydration, when a stored consent exists, compare its version
   with the current cookie policy version (the once-per-tab fetch); if they differ, show the
   banner with `data-reason="policy-changed"` and treat preferences as not allowed until the
   visitor answers (the policy: "If this policy changes in a way that affects optional storage, we
   ask again"; every version bump asks, which is the conservative reading). Never on
   `/overlay/*` (`isOverlayPath`) or `/embed/*`: OBS sources and third-party embeds show no
   banner and write no preference.
4. **Side effects of a choice.**
   - **Grant** (preferences true): move this tab's choices into cookies: a tab-only theme
     (`sessionStorage`, item 5) becomes the theme cookie, and a tab-only locale
     (`LOCALE_SESSION_KEY`) goes through `rememberLocale(tag, { preferencesAllowed: true })`.
   - **Decline or withdraw** (preferences false), and on load when the stored consent says
     false: keep the current theme and locale for this tab (`sessionStorage`), then expire the
     `commonair-theme`, `commonair-locale` (`forgetLocaleCookie()`) and `sidebar_state` cookies.
     The page keeps looking the same for this tab; the next visit uses defaults, as the policy
     says.
5. **Theme (`lib/theme.ts`, `__root.tsx`).** `storeTheme(theme)` writes the cookie only when
   `preferencesAllowed()`; otherwise it writes `sessionStorage` (`commonair-theme`) and expires
   any theme cookie. In `__root.tsx`, after hydration, a tab-only theme that differs from the
   server's applies once (`setThemeState` and `applyTheme`), the same rule N2-core uses for the
   locale. `themeFromCookie` and SSR are unchanged.
6. **Banner (`consent-banner`).** A labelled region (`role="region"`, `aria-labelledby` its
   heading) in the normal page flow at the top of the page, **never fixed or floating over
   content and never modal**: it does not trap or take focus on load, and pages, harness
   scenarios and screen readers work around it. One short sentence (first-party only, nothing for
   marketing, Preferences off until you allow them) and three buttons of **equal visual weight**:
   `consent-accept-all` ("Allow preferences"), `consent-reject` ("Essential only"),
   `consent-customize` ("Settings"). Rejecting is as easy as accepting: no pre-ticked boxes, no
   hidden reject. After a choice the banner leaves and a `toast.success` confirms. Entrance
   animation only under `motion-safe:`. Wraps at 320 px.
7. **Dialog (`consent-dialog`).** The Base UI `Dialog` (`@commonair/ui/components/dialog`), opened by
   `consent-customize` or `footer-cookie-settings`: title, one row per category
   (`consent-category`, `data-category`, `data-checked`, `data-locked`) with a plain description
   from your namespace (Essential: always on, lists what it covers; Preferences: what it remembers
   and that declining keeps choices for the tab only), the Preferences `Switch`
   (`consent-toggle-preferences`, reflecting the stored choice, off when there is none), the
   policy link (`consent-policy-link` wrapping `LegalDocumentLink` for the cookies document) and
   `consent-save`. Escape and the close button dismiss without saving; focus returns to the
   control that opened it. `data-policy-version` carries the version it will record.
8. **Footer (`footer-cookie-settings`).** In `InstanceFooter`, append one entry after the
   `footerNav()` links: label `t("consent.footer.settings")`, `render` = a `<button type="button">`
   with the testid that calls `openCookieSettings()` (styled like the other footer links). No
   change to `lib/nav.ts` (`FooterEntry` stays route-only) or `packages/ui`.
9. **Mount.** `<ConsentRoot />` once in `__root.tsx`, inside the providers, rendering the banner
   in flow before `<Outlet />` (or wherever keeps it in flow at the top of every shell; say which in
   your final message) and the dialog; nothing on overlay or embed paths.
10. **`sidebar_state`.** Delete the cookie write in `SidebarProvider.setOpen` and the two
    `SIDEBAR_COOKIE_*` constants (nothing reads the cookie; the open state still works in
    memory), and extend the `sidebar.tsx` row of `packages/ui/DEVIATIONS.md`: "no `sidebar_state`
    cookie: a Preferences cookie nothing reads (N2-consent)". Item 4 still expires an old one.
11. **Strings** in `locales/en/n2-consent.json` under `consent.` (`consent.banner.*`,
    `consent.dialog.*`, `consent.category.essential.*`, `consent.category.preferences.*`,
    `consent.error.*`, `consent.toast.saved`, `consent.footer.settings`). Plain words, consistent
    with the cookie policy text; no number or date formatting inside messages.

## Tests you must add

- Unit (`apps/web/tests/n2-consent-storage.test.ts`): `parseConsent`/`serializeConsent` round
  trip and malformed input; cookie attributes (365 days, `samesite=lax`, `secure` only on
  https); `preferencesAllowed` with none, false, true and a stale version; the anonymous id
  (32 hex, within the contract's 16-64) is created only when signed out and saving; the category
  list equals `CONSENT_CATEGORIES`; **the consent-gated writers**: `storeTheme` with consent
  writes the cookie, without consent writes `sessionStorage` and expires the cookie; grant moves a
  tab-only theme into the cookie and calls `rememberLocale(…, { preferencesAllowed: true })` for a
  tab-only locale; withdraw expires the theme, locale and `sidebar_state` cookies and keeps the
  tab's values; storage that throws breaks nothing.
- Saving (same file or `n2-consent-save.test.ts`, with a fake API client): the request body for
  signed out (with `anonymousId`) and signed in (without); `essential: true` always; the cookie is
  written before the request resolves; `RATE_LIMITED` and a network error leave `pending`, show
  `consent-error`, and one retry happens on the next load in the tab, not more; a stale policy
  version refetches and re-asks; a signed-in visitor with an `anonymous` record is recorded once as
  the user.
- Component (`apps/web/tests/n2-consent.test.tsx`, Testing Library as other web tests): the
  banner renders from `Bootstrap.consent: null` on the server render and after hydration (no
  flash), is absent with a current consent, shows `data-reason="policy-changed"` for an older
  version; it is absent on `/overlay/alerts` and `/embed/<channel>`; the three buttons, keyboard
  only (Tab order, Enter/Space); the dialog's essential row is locked, Escape closes without
  saving and returns focus to `footer-cookie-settings`; the footer button opens the dialog; every
  id in `docs/testing/n2-selectors.md` "Test ids" renders with its attributes; the banner is not
  `position: fixed`/`sticky` and has no animation class outside `motion-safe:`.
- `__root.tsx`: `setTheme` without consent writes no cookie; a tab-only theme applies after
  hydration.
- `packages/ui/tests/sidebar-storage.test.tsx`: toggling the sidebar writes no cookie; the
  deviations test still passes.
- Run `apps/web/tests/i18n.test.ts` and `logical-css.test.ts` (N2-core's) unchanged: your keys are
  all used and your files have no physical-direction classes.

## Shared files and wave 3

- No overlap with E9-sdk (`packages/sdk/**`, harness SDK files, `sdk-publish.yml`,
  `docs/developers/sdk.md`), E9-consent (`routes/_app/{oauth2.authorize,activate,settings.connections}.tsx`,
  `components/oauth/**`, namespace `e9-consent`, `harness/src/e9/consent.ts`) or E9-console
  (`routes/_studio/developer.*`, `routes/_admin/admin.apps.tsx`, `components/developer/**`,
  namespace `e9-console`, `docs/developers/**`). Both E9 web units only read `site-chrome.tsx`,
  `__root.tsx`, `bootstrap.ts` and `theme.ts`; in wave 3 those files are yours (only the parts
  listed under "You own"). Nobody else writes `packages/ui` in wave 3.
- The orchestrator adds the n2 check to `apps/web/tests/selectors.test.ts` after you merge
  (propose the exact diff in your final message: `n2-selectors.md` in the `describe.each` list of
  docs whose ids must be rendered).
- No harness change: the banner is in flow, so existing scenarios keep clicking what they click.
  If a harness step you can read (`harness/src/web/**`) would still be blocked by it, say which and
  propose the fix as a contract request.

## Done means

Follow `.claude/briefs/_done-means.md`. Targeted checks only: `bun --bun vp test run` in
`apps/web` and `packages/ui`; `bunx tsc -p apps/web --noEmit` and `bunx tsc -p packages/ui
--noEmit`; `cd apps/web && bun run i18n:check`; `vp lint --deny-warnings` and `vp fmt` on your
paths; `vp build` in `apps/web` (then `git diff apps/web/src/routeTree.gen.ts` is empty). Never
run `bun run verify`, `verify:full`, `podman compose`, `scripts/infra.ts` or a harness scenario;
CI on `main` is the gate. `git status` shows only your paths. Commit in your worktree
(`git commit -s`, Conventional Commits, e.g. `feat(web): cookie consent banner and settings`,
message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Final message:
what you built, test counts per package, branch and sha, contract requests (exact diffs: the
selectors check, anything else), proposed README/PROGRESS text (the cookie policy's footer
promise is now true; PROGRESS "Legal seed follow-ups"), anything left undone, and the exact
commands for the user to check it live: on the running stack, open the site in a private window
(banner shows, no `commonair-theme` cookie after toggling the theme), choose "Essential only"
(theme still changes for the tab, gone in a new tab; `consent_records` has an anonymous row with
`preferences: false`), then "Cookie settings" in the footer and allow preferences (the theme
cookie appears), at 320 px, dark and light, keyboard only and with reduced motion on.
