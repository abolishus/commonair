<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N2 batch 5 contract step (orchestrator)

One commit on `main` (`feat(n2): batch 5 contract step`), pushed, CI green before wave 1. Read
[`batch5/README.md`](../batch5/README.md) first. No migration, no env var, no API contract change.

## 1. `@commonair/i18n/catalog`: parity and coverage (decision (j))

- `messageArguments(message): Map<string, "simple" | "plural" | "select" | "selectordinal">`
  from the parsed AST (nested arguments included; `#` is not an argument).
- `checkTranslation(english, translated): string | undefined`: a problem when the argument
  names differ or an argument's kind differs; a plural must keep `other`; a select must keep
  every English case name it uses plus `other`. Wording, not exact sets of plural categories
  (`es` may drop `=0` only if English has none).
- `checkCatalog` calls it for every non-English key (`<lang>/<ns>.json: <key> arguments differ (…)`).
- `coverage(namespaces, lang): { total: number; translated: number; missing: string[] }` over
  English keys (an `es` value identical to English counts as translated; decision (h)).
- Unit tests in `packages/i18n/tests/` for both, including nested plurals inside selects.
- `apps/web/tests/i18n.test.ts`: `const REQUIRED_LOCALES: readonly string[] = []` and an `it`
  that requires `coverage(...).missing` empty for each (the milestone sets `["es"]`). Parity runs
  through `checkCatalog` already.

## 2. Dependencies (decisions (c), (d))

`"@commonair/i18n": "workspace:*"` in `packages/ui/package.json` and `packages/email/package.json`
dependencies; `bun install`; commit `bun.lock`. Add `packages/i18n` to those packages'
`tsconfig` references if the repo uses references (check `packages/ui/tsconfig.json`).

## 3. `formatLanguageName` (decision (l))

In `packages/ui/src/lib/format.ts`:
`formatLanguageName(tag: string, displayLocale = tag): string` via
`new Intl.DisplayNames([displayLocale], { type: "language" }).of(tag)`, falling back to the tag;
capitalize the first letter for the display locale (`español`→`Español`). Export from
`@commonair/ui` where the other formatters are exported. Unit test (`en`, `es`, `es-MX`, unknown tag).

## 4. `/settings/preferences` placeholder (decision (e))

- `apps/web/src/routes/_app/settings.preferences.tsx`: like `settings.connections.tsx`
  (`requireSession`, head title `t("preferences.pageTitle")`), rendering
  `<PreferencesPage/>` from `components/locale/preferences-page.tsx`, a stub that renders
  `<section data-testid="preferences-page">` with the page heading.
- `components/locale/footer-locale-switcher.tsx`: `export function FooterLocaleSwitcher(): React.JSX.Element | null { return null; }`
  (N2-switcher fills it). Mount it in `InstanceFooter` (`site-chrome.tsx`) as one more `links`
  entry, after the cookie settings button: `{ label: t("preferences.footerLanguage"), render: <FooterLocaleSwitcher/> }`
  — or, if `SiteFooter`'s `links` cannot take a `null` render, add an optional `extra?: React.ReactNode`
  slot to `SiteFooter` (`packages/ui/src/layouts/site-footer.tsx`) rendered after the links, and
  mount it there. Pick whichever keeps the footer's existing test ids and layout.
- `nav.ts`: `{ id: "preferences", to: "/settings/preferences" }` after `connections`; the route
  union gains `"/settings/preferences"`; `nav.preferences` = `"Preferences"` in `en/core.json`;
  `tests/nav.test.ts` updated; regenerate `routeTree.gen.ts`.
- New namespace `n2-switcher` (`locales/en/n2-switcher.json` = `{}`, `bun run i18n:gen`), with
  the two keys the stubs use moved into it: `preferences.pageTitle` = `"Preferences"`,
  `preferences.footerLanguage` = `"Language"` (they must be used, so the stubs use them).
  Prefix `preferences.` and `localeSwitcher.` belong to N2-switcher; check no existing key uses them.

## 5. Selectors

`docs/testing/n2-selectors.md`: a "Language switchers (batch 5)" section with
`preferences-page`, `locale-select` (settings `<Select>` trigger), `locale-option-<tag>` (each
item; `auto` for Automatic), `locale-save-status`, `footer-locale-switcher` (trigger),
`footer-locale-option-<tag>`. Extend the n2 selectors check in `apps/web/tests/selectors.test.ts`
so these ids must appear in source (templated ids count, as in w1).

## 6. Check and push

`cd apps/web && bun run i18n:check`, the i18n, nav, selectors and logical-css tests,
`packages/i18n` and `packages/ui` tests, `tsc` for the three packages, `vp lint --deny-warnings`
and `vp fmt` on changed paths, `vp build` for `apps/web`, `reuse lint`. Push; CI green; the
wave-1 base is this commit's sha.
