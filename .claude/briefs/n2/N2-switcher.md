<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N2-switcher: language switchers in settings and the footer

You are implementing N2-switcher for CommonAir (repo: this checkout). Read AGENTS.md, PLAN.md,
docs/architecture.md, [ADR 0029](../../../docs/decisions/0029-i18n.md) decision 3,
[`batch5/README.md`](../batch5/README.md) (decisions (e), (f), (g), (m), the Spanish glossary),
`apps/web/src/i18n/README.md` ("Locales", "How to add a namespace") and
`docs/testing/n2-selectors.md`. Do not look outside the repository. Wave 1, branch `n2/switcher`.

## You own (write only these)

- `apps/web/src/routes/_app/settings.preferences.tsx` (content; the route path, guard and head
  stay as the contract step wrote them)
- `apps/web/src/components/locale/**` (the contract step's stubs `preferences-page.tsx` and
  `footer-locale-switcher.tsx`, plus anything new)
- `apps/web/src/i18n/locales/{en,es}/n2-switcher.json`, `apps/web/src/i18n/keys/n2-switcher.gen.ts`
- new `apps/web/tests/locale-switcher*.test.tsx`

## Contracts you must honor (read-only for you)

- `apps/web/src/i18n/client.ts`: `applyLocale(tag)`, `rememberLocale(tag, { preferencesAllowed })`,
  `forgetLocaleCookie()`, `tabLocale()`, `forgetTabLocale()`; `apps/web/src/i18n/index.ts`:
  `SUPPORTED_LOCALES`, `activeLocale()`, `PSEUDO_LOCALE` from `@commonair/i18n`.
- `apps/web/src/lib/consent.ts`: `preferencesAllowed()`, `useConsent()`.
- `me.update({ locale })` (`LocaleTag | null`), `me.get` (`locale` nullable) through `api()`;
  `useBootstrap()` for `me`.
- `formatLanguageName(tag, displayLocale)` from `@commonair/ui` (contract step).
- House primitives (AGENTS.md): shadcn `Select`/`DropdownMenu` from `@commonair/ui`, `toast.*`
  from `@commonair/ui/toast`, no `title=`, logical CSS, `buttonVariants` per the web source policy.
- Test ids exactly as in `docs/testing/n2-selectors.md` "Language switchers (batch 5)".

## Build

1. **Preferences page** (`/settings/preferences`, members only): a Language section with a
   `Select` (`locale-select`) listing "Automatic" (`locale-option-auto`, explained: "Uses your
   browser's language") and each supported locale except `en-XA` (`locale-option-<tag>`), each
   shown in its own language (`formatLanguageName(tag, tag)`) with the current UI language's name
   beside it when different ("Español — Spanish"). Current value from `me.locale` (null → auto).
   Choosing saves at once with `me.update({ locale })` (null for auto), then `applyLocale` with
   the saved tag, or for auto the locale the server would negotiate (cookie, then `navigator.languages`
   matched against `SUPPORTED_LOCALES`, then the instance default from bootstrap) — or simply reload
   the root loader if that is how `__root.tsx` already re-negotiates (read it; prefer the existing path).
   A polite live region (`locale-save-status`) announces "Saved" in the new language; errors show a toast
   and restore the previous value. Because `applyLocale` remounts the tree, keep no unsaved state.
2. **Footer switcher** (`footer-locale-switcher`, every page, signed in or out): a compact
   `DropdownMenu` button showing a language icon (Hugeicons) and the current language's name;
   items `footer-locale-option-<tag>` (no `en-XA`, no "Automatic"). On choose: signed out →
   `rememberLocale(tag, { preferencesAllowed: preferencesAllowed() })` then `applyLocale(tag)`;
   signed in → also `me.update({ locale: tag })` first (on failure: toast, no switch). Keyboard
   reachable, visible focus, `lang` attribute on each item's label, works at 320 px.
3. **Strings** in `n2-switcher` (`preferences.*`, `localeSwitcher.*`), English and Spanish at 100%;
   `bun run i18n:gen`.
4. Do not change negotiation, cookies or consent; if you need a helper in `client.ts` (for
   example "what would the server negotiate"), write it in `components/locale/` or send a contract request.

## Tests you must add

- Preferences: renders the options (no `en-XA`), the current value from `me` (null → auto),
  choosing calls `me.update` with the tag or null and then `applyLocale`; an API error restores
  the value and toasts.
- Footer: signed out with and without Preferences consent (cookie vs tab only, via the
  `rememberLocale` argument); signed in calls `me.update` first and does not switch on failure.
- Accessible names and test ids from the selectors doc; option labels carry `lang`.
- `bun run i18n:check` and `tests/i18n.test.ts` pass (every `n2-switcher` key used, es complete).

## Done means

Per `.claude/briefs/_done-means.md`: `apps/web` tests, `tsc`, `vp lint --deny-warnings`, `vp fmt`
on changed paths, `vp build`, `reuse lint`, `tests/{i18n,logical-css,selectors,source-policy}.test.ts`.
`git status` shows only your paths. Commit with `git commit -s`. Final message: what you built,
test counts, branch + sha, contract requests, glossary terms added, anything left undone, and the
browser checks for the user (switch signed out with and without cookie consent, signed in, 320 px).
