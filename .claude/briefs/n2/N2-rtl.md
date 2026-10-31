<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N2-rtl: logical layout in `packages/ui`, RTL tests

You are implementing N2-rtl for CommonAir (repo: this checkout). Read AGENTS.md, PLAN.md,
docs/architecture.md, [ADR 0029](../../../docs/decisions/0029-i18n.md) decision 5,
[`batch5/README.md`](../batch5/README.md) (decision (b)) and `apps/web/src/i18n/README.md`
("Layout is logical"). Do not look outside the repository. Wave 2 (after N2-ui merged), branch `n2/rtl`.

## You own (write only these)

- every `packages/ui/src/**` file listed in `apps/web/tests/logical-css.baseline.json` at the
  wave-2 base sha — **class names and inline style direction only** (no behaviour, string or
  formatting change)
- `apps/web/tests/logical-css.baseline.json` (delete it), `apps/web/tests/logical-css.test.ts`
- new `packages/ui/tests/rtl*.test.tsx`, new `apps/web/tests/i18n-rtl.test.ts`

## Contracts you must honor (read-only for you)

- `localeDirection` from `@commonair/i18n`; `LocaleProvider`; `createLocaleRegistry` in
  `apps/web/src/i18n/catalogs.ts` (inject a fixture `ar` catalog in tests; do not add an `ar`
  directory to the repo — decision (b)).
- shadcn components stay upgradeable: change classes the way upstream shadcn's RTL-ready
  versions do (`ms-`/`me-`, `ps-`/`pe-`, `start-`/`end-`, `border-s`/`border-e`,
  `rounded-s-*`/`rounded-e-*`, `text-start`/`text-end`, `float-start`, `scroll-ms-*`); for
  directional icons (chevrons, arrows meaning "next/back") add `rtl:rotate-180` or `rtl:-scale-x-100`.
- Physically directional cases keep physical classes with a same-line `rtl-physical: <reason>`
  comment (progress and goal-bar fills, media timelines and scrubbers, charts' axes, centring with
  `left-1/2 -translate-x-1/2`, sheet/drawer sides only if the component takes an explicit `side`
  prop — prefer mapping `side="left"` to the inline start).

## Build

1. Convert all ~143 matches in the ~36 baseline files. Radix/Base UI positioning props
   (`side="left"`) are props, not classes: map them to start/end only where the component already
   supports it; otherwise leave and comment.
2. Change `logical-css.test.ts` so `packages/ui/src` is held to zero like `apps/web/src` (drop the
   baseline logic and file; keep the allowlist comment mechanism and the scanner's patterns).
3. RTL tests:
   - `packages/ui/tests/rtl.test.tsx`: render a representative set (sidebar, sheet, pagination,
     breadcrumb, dropdown menu, toast, stream card, chat row, form field with icon, tabs) inside
     `<div dir="rtl">` and assert no rendered class is physical except commented ones (reuse the
     scanner as a function if it is exported; otherwise a local copy of its regex), and that
     directional icons carry the RTL flip class.
   - `apps/web/tests/i18n-rtl.test.ts`: a registry with an injected `ar` fixture (`{ "nav.home": "…" }`):
     `localeDirection("ar") === "rtl"`, `applyLocale("ar")` (or the SSR path) sets
     `<html lang="ar" dir="rtl">`, `en`/`es` stay `ltr`, `ar-EG` falls back to `ar`.

## Done means

Per `.claude/briefs/_done-means.md`: `packages/ui` and `apps/web` tests (logical-css, i18n-*),
`tsc`, `vp lint --deny-warnings`, `vp fmt` on changed paths, `vp build` for `apps/web`, the UI
Storybook build, `reuse lint`. `git status` shows only your paths. Commit with `git commit -s`.
Final message: files converted and count, every `rtl-physical` exception with its reason,
test counts, branch + sha, contract requests (e.g. physical classes outside your files),
and the visual checks for the user (Storybook with `dir="rtl"`, the app under the injected
locale is not possible without `ar`, so list the components to eyeball in LTR for regressions).
