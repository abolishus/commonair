<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N2-email: email catalogs in JSON, plurals, Spanish

You are implementing N2-email for CommonAir (repo: this checkout). Read AGENTS.md, PLAN.md,
docs/architecture.md, [ADR 0029](../../../docs/decisions/0029-i18n.md) (decisions 1, 2, 3),
[`batch5/README.md`](../batch5/README.md) (decisions (d), (m), the Spanish glossary),
`apps/web/src/i18n/README.md` (the message format) and `packages/email/README.md`. Do not look
outside the repository. Wave 1, branch `n2/email`.

## You own (write only these)

- `packages/email/src/**` (catalogs, `messages/**`, `format.ts`, `render.tsx`, `template.tsx`,
  `samples.ts`, `registry.ts`; templates under `templates/**` only where they read strings or
  need a plural argument)
- `packages/email/tests/**` (snapshots included), `packages/email/scripts/**`,
  `packages/email/README.md`, `packages/email/package.json` (`scripts` only)

## Contracts you must honor (read-only for you)

- The public API of `@commonair/email` used by `services/api/src/{mail,overlay/alerts,routes/me-enforcement}.ts`,
  `services/worker/src/{main,context,worker}.ts`, `notify/email/digest.ts`,
  `moderation/sor-deliver.ts`: template names, their props, `renderEmail`/mailer options
  (`locale`, `catalogs?`), `resolveCatalog`, `mergeCatalog`, `EmailCatalog`. Keep every export;
  if a template's props must change (a count for a plural), make the new prop optional with the
  old behaviour, and list each caller that should pass it as a contract request.
- `@commonair/i18n` (`parseMessage`, `formatMessage`, the AST types; `@commonair/i18n/catalog`
  `parseFlatJson`, `checkCatalog`, `coverage`). `packages/email` depends on it since the contract step.
- Callers already map `users.locale` = null to `instanceSite().defaultLocale` (batch 3).

## Build

1. **JSON catalogs.** Move `messages/en.ts` to `packages/email/src/messages/locales/en/<group>.json`,
   one file per template group (`layout`, `account`, `security`, `governance`, `payments`,
   `privacy`, `trust`, `notify`, matching `templates/*.tsx`; put any block that fits none in the
   closest group), flat keys `<block>.<field>` (`verifyEmail.subject`). Keep the translator notes
   that are now JSDoc as a `messages/NOTES.md` table (key → note) so N2-weblate can paste them as
   Weblate explanations. `layout.dir` goes away: direction comes from `localeDirection(locale)`.
2. **Typed.** `EmailCatalog` stays a typed nested object derived from the English JSON
   (`import en from "./locales/en/account.json" with { type: "json" }` and a type that maps the
   flat keys back to blocks, or a generated `.gen.ts` with a staleness test, as the web does).
   `t("missing.key")`-style mistakes stay type errors in templates.
3. **Formatter.** Strings use the ICU subset through `@commonair/i18n`. `interpolate` and
   `interpolateNodes` keep their signatures but parse ICU (plural, select, `#` formatted for the
   email's locale); node values (links) still work inside plural branches. A message that does
   not parse renders its English source and the test suite fails.
4. **Plurals where English had to avoid counts**: the `goLiveDigest` strings (a count of channels,
   "and {count} more"), and any other block whose English dodges a number (grep for "one or more",
   "(s)", "channels" without counts). Add the count prop as optional (contract requests for callers).
5. **Bundled locales.** `resolveCatalog(locale, catalogs = BUNDLED)`: `BUNDLED` is every
   `locales/<lang>/` directory, built from the JSON (statically imported; add a test that it lists
   every directory). Exact tag, then language, then English, per string fallback as today.
   Callers that pass `catalogs` explicitly still work.
6. **Spanish.** `locales/es/*.json` at 100% with argument parity, per the glossary and style
   rules. Subjects stay short (under ~70 characters where the English is).

## Tests you must add

- Every template renders in `en` and `es` with no English fallback in `es` (spy on the fallback or
  compare against `en`), with the right `<html lang>` and `dir`; snapshot updates for `en` are
  textually identical except whitespace (state any intended difference).
- `checkCatalog` + `coverage` over `messages/locales` (es = 100%, parity clean); `BUNDLED` matches
  the directories; `es-MX` → `es`; unknown → English; a broken translation falls back to English.
- Plural cases for 0/1/2/many in `en` and `es` for every new plural; node values inside a plural.
- The existing mailer unit and integration tests still pass (`test:int` with the data services up).

## Done means

Per `.claude/briefs/_done-means.md`: `packages/email` `test` and `test:int`, `tsc`, `vp lint
--deny-warnings`, `vp fmt` on changed paths, `reuse lint`; typecheck `services/api` and
`services/worker` (they import you) without editing them. `git status` shows only your paths.
Commit with `git commit -s`. Final message: what you built, test counts, branch + sha, contract
requests (callers that should pass new counts, with exact diffs), glossary terms added, anything
left undone.
