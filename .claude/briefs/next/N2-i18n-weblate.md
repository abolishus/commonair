<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N2: internationalization and community translation

**Goal.** The web app, the design system and email render in the viewer's language, with
correct plurals, dates and money; translators contribute through a self-hosted Weblate that
opens PRs; adding a language is a catalog file, not a code change.

## State

- Every user-facing string already goes through `t()`; `apps/web/tests/i18n.test.ts` enforces
  that keys exist, bans runtime-built keys outside an allowlist and keeps catalogs disjoint.
- Catalogs are typed TS objects with `{name}` placeholders in `apps/web/src/i18n/{en,coop,money,ops,safety,support}.ts`.
  `apps/web/src/i18n/index.ts:13` hardcodes `locale = "en"`; `t()` is plain replacement (no plurals).
- Design-system strings are `UiMessages` (`packages/ui/src/lib/messages.ts`), English fallback only.
- Email already resolves locales (`packages/email/src/messages/index.ts`: `resolveCatalog`,
  `mergeCatalog`); only `en.ts` exists.
- `users.locale` defaults to `"en"` (`schema/auth.ts:41`); `<html lang>` set in `__root.tsx:56`.
- There is no `@commonair/i18n` package, though PLAN.md names it.

## Decisions first: ADR 0028 (i18n)

- **Message format:** ICU MessageFormat for plurals and selects (recommended: a small in-repo
  formatter over `Intl.PluralRules`, no new dependency), keeping `{name}` placeholders so
  existing strings need no rewrite.
- **Storage:** catalogs move to JSON (`apps/web/src/i18n/locales/<lang>/<namespace>.json`)
  because Weblate edits JSON; a generated `.d.ts` keeps `MessageKey` typed. English stays the
  source of truth.
- **Negotiation:** signed-in `users.locale`, else `Accept-Language`, else the instance default
  (`INSTANCE_DEFAULT_LOCALE`). Locale switcher in settings and the footer. Lazy-load
  non-English catalogs.
- **Formatting:** `<RelativeTime>`, `<MoneyAmount>` and `<ViewerCount>` take the active locale;
  no other component formats.
- **RTL:** supported from the first RTL language: logical CSS properties checked by a lint rule.
- **Weblate:** self-hosted (GPL-3.0, an OSI license; it is a separate service, not linked code),
  run by the project, not part of a self-hosted instance. Translations arrive as PRs signed off
  under DCO by the Weblate bot account; CC-BY-SA-4.0 for docs strings, AGPL for UI catalogs as
  today.
- Which second locale ships first (user to pick; a pseudo-locale `en-XA` ships regardless, for
  testing truncation and missing keys).

## Units

| Unit        | Owns                                                                                     | Builds                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| N2-core     | `packages/i18n/**` (new), `apps/web/src/i18n/**`, `apps/web/tests/i18n.test.ts`          | formatter, plurals, JSON catalogs with typed keys, negotiation, lazy load, pseudo-locale |
| N2-ui       | `packages/ui/src/lib/messages.ts`, house primitives' formatting                          | `UiMessages` per locale, locale-aware primitives                                         |
| N2-email    | `packages/email/src/messages/**`                                                         | email catalogs in the same JSON format; `users.locale` picks them                        |
| N2-switcher | settings and footer components                                                           | locale switcher, `me.update` locale                                                      |
| N2-weblate  | `infra/weblate/**` (project infra, not the instance), `docs/maintainers/translations.md` | compose file for the project's Weblate, component config, PR flow                        |

N2-core runs alone first (every other unit reads its format). It can run in batch 3 beside E8
and E9 because it touches only `apps/web/src/i18n/**`; strings E8/E9 add land in the English
catalog either way.

## Done means

`e2e-basic` passes under `en-XA` (every visible string is pseudo-localized, so a missed literal
shows); plural and RTL unit tests; one real second locale at 100%; verify green.
