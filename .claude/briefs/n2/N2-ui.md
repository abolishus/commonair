<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N2-ui: design-system strings per locale, locale-aware formatting

You are implementing N2-ui for CommonAir (repo: this checkout). Read AGENTS.md, PLAN.md,
docs/architecture.md, [ADR 0029](../../../docs/decisions/0029-i18n.md) (decisions 2 and 4),
[`batch5/README.md`](../batch5/README.md) (decisions (c), (l), (m), the Spanish glossary) and
`apps/web/src/i18n/README.md`. Do not look outside the repository. Wave 1, branch `n2/ui`.

## You own (write only these)

- `packages/ui/src/lib/{messages.ts,locale.tsx,format.ts}`, `packages/ui/src/locales/**` (new)
- `packages/ui/src/blocks/forms/{amount-field,date-of-birth-field}.tsx`,
  `packages/ui/src/blocks/coop/{statement,tally-table}.tsx`,
  `packages/ui/src/blocks/data/{progress-row,breakdown}.tsx`, `packages/ui/src/components/chart.tsx`
  (formatting only: do not touch their class names; N2-rtl converts those in wave 2)
- `packages/ui/src/index.ts` (and the package's barrel files) — export lines only
- new `packages/ui/tests/{ui-messages,intl-policy}*.test.ts(x)`, `packages/ui/tests/format*.test.ts`
- `apps/web/src/lib/relays.ts`, `apps/web/src/i18n/{index,catalogs}.ts`,
  `apps/web/tests/i18n-runtime.test.ts`, new `apps/web/tests/{intl-policy,ui-messages}*.test.ts`
- the `UiMessages` line of `apps/web/src/i18n/README.md`

## Contracts you must honor (read-only for you)

- `@commonair/i18n` (`createTranslator`, `pseudoLocalize`, `PSEUDO_LOCALE`, `@commonair/i18n/catalog`
  `readNamespaces`/`checkCatalog`/`coverage`); `packages/ui` depends on it since the contract step.
- `LocaleProvider` and `useLocale`/`useResolvedLocale` keep their public shapes (other code and
  stories use them); `formatLanguageName` (contract step) stays as is.
- `apps/web/src/routes/__root.tsx` calls `uiMessagesFor(active.locale)` synchronously during
  render, after `loadLocale(tag)` resolved. Keep that call signature.

## Build

1. **`ui.json`.** Move `enMessages` to `packages/ui/src/locales/en/ui.json`, flat keys under
   `ui.` (`ui.close`, `ui.theme.dark`, `ui.discoveryReason.popular`, `ui.sidebar.toggle`, …), the
   ICU subset. `viewerCount` becomes
   `"ui.viewerCount": "{formatted} verified {count, plural, one {viewer} other {viewers}}"`.
   Write `packages/ui/src/locales/es/ui.json` at 100% (glossary; `espectador verificado` /
   `espectadores verificados`).
2. **`uiMessagesFromCatalog(locale, catalog, fallback = english): UiMessages`** in `messages.ts`:
   builds the typed `UiMessages` object (functions call the translator), falls back per key to
   English. `enMessages` stays exported (built from `en/ui.json`, so stories and tests do not change).
   A `UI_CATALOGS` map of bundled-lazy loaders (`import.meta.glob` is not available in the
   package's tests if they run outside Vite: use explicit dynamic `import()` of each JSON file
   via a small generated or hand-listed map, and a test that the map lists every `locales/*/ui.json`).
3. **Web wiring.** `apps/web/src/i18n/catalogs.ts`/`index.ts`: `loadLocale(tag)` also loads that
   locale's `ui.json` (language fallback `es-MX` → `es`, then English), and `uiMessagesFor(locale)`
   returns the loaded messages (`en-XA` pseudo-localizes English as today). Remove the legacy
   `export const locale = "en"` and `uiMessages` if nothing imports them (grep); otherwise list the
   importers as a contract request.
4. **Formatting moves to `format.ts`** (ADR 0029 decision 4). Add, with the locale passed in:
   `formatPercent(value, locale, { minimumFractionDigits?, maximumFractionDigits? })`,
   `formatInteger`/reuse `formatNumber`, `monthNames(locale)` (for the date-of-birth field),
   `numberSeparators(locale)` and the amount-field helpers (parse/format cents for input). Replace
   every `new Intl.*` and argument-less `toLocaleString()` in the seven block files and
   `apps/web/src/lib/relays.ts` with them, reading the locale from `useResolvedLocale` (blocks)
   or the caller's `activeLocale()` (relays). `toLocaleLowerCase` for search matching is fine.
5. **The check.** `packages/ui/tests/intl-policy.test.ts` and `apps/web/tests/intl-policy.test.ts`
   scan `packages/ui/src` and `apps/web/src` and fail on `new Intl.` or `Intl.<X>(` outside
   `packages/ui/src/lib/format.ts`, and on `.toLocaleString()`, `.toLocaleDateString(`,
   `.toLocaleTimeString(` with no locale argument anywhere. A small allowlist with a reason per
   entry (expect none). Print `file:line` per hit.

## Tests you must add

- `ui-messages`: every `UiMessages` field resolves in `en`, `es` and `en-XA`; `viewerCount` plural
  for 0/1/2/1000 in `en` and `es`; a missing `es` key falls back to English; `checkCatalog` and
  `coverage` over `packages/ui/src/locales` (es = 100%, parity clean).
- `format`: every new formatter in `en`, `es`, `de` (separators), edge cases (0, negatives,
  rounding at the fraction limit, huge numbers, `NaN` → em dash or the existing convention).
- Web: `uiMessagesFor("es")` after `loadLocale("es")`, `es-MX` fallback, unknown tag → English.
- The intl-policy tests pass on your branch and fail on a planted fixture string (test the scanner).

## Done means

Per `.claude/briefs/_done-means.md`: `packages/ui` and `apps/web` tests, `tsc` for both,
`vp lint --deny-warnings` and `vp fmt` on changed paths, `vp build` for `apps/web`, the UI
Storybook build (`bun run --filter @commonair/ui build-storybook` if it exists), `reuse lint`.
`git status` shows only your paths. Commit with `git commit -s`. Final message: what you built,
test counts, branch + sha, contract requests, glossary terms you added, anything left undone.
