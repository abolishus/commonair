<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N2: internationalization and community translation

**Goal.** The web app, the design system and email render in the viewer's language, with
correct plurals, dates and money; translators contribute through Hosted Weblate (libre plan)
that opens PRs; adding a language is a catalog file, not a code change.

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

## Decisions: [ADR 0029](../../../docs/decisions/0029-i18n.md) (accepted 2026-10-27)

- **Message format:** ICU MessageFormat for plurals and selects through a small in-repo
  formatter over `Intl.PluralRules` (decided; no new dependency), keeping `{name}` placeholders
  so existing strings need no rewrite.
- **Storage:** catalogs move to JSON (`apps/web/src/i18n/locales/<lang>/<namespace>.json`)
  because Weblate edits JSON; a generated `.d.ts` keeps `MessageKey` typed. English stays the
  source of truth.
- **Negotiation:** signed-in `users.locale`, else a signed-out visitor's footer choice (a
  first-party preference cookie), else `Accept-Language`, else the instance default
  (`INSTANCE_DEFAULT_LOCALE`, new in `env.ts` and `.env.example`). Locale switcher in settings
  and the footer. Lazy-load non-English catalogs.
  - The cookie is in the cookie policy's Preferences category: it is set only with that consent.
    Without it, a signed-out visitor's choice lasts for the current tab only.
    `packages/db/src/legal/cookies.md` lists it under Preferences.
  - `users.locale` becomes nullable with no default (null means "not chosen"). Every reader of
    it (email language in `me.ts`, `lib/leaks.ts`, `sor-deliver.ts` and others) treats null as
    `INSTANCE_DEFAULT_LOCALE`, not English; the contract step updates them with the column.
- **Formatting:** `<RelativeTime>`, `<MoneyAmount>` and `<ViewerCount>` take the active locale;
  no other component formats.
- **RTL:** supported from the first RTL language: logical CSS properties, enforced by a
  repository check N2-core adds beside `i18n.test.ts` (Oxlint has no rule for it).
- **Weblate:** Hosted Weblate's libre-project plan (GPL-3.0-or-later software run by the
  Weblate project), not a server we host; self-hosting for the project (not for instances) is
  the fallback if the plan is refused or withdrawn. Translations arrive as PRs from the Weblate
  bot, with a `Signed-off-by` for the translator from the commit template and the DCO accepted
  through the component's contributor agreement; CC-BY-SA-4.0 for docs strings, AGPL for UI
  catalogs as today.
- **Second locale:** Spanish (`es`), one catalog for all regions; Arabic (`ar`) is next, to prove
  RTL. The pseudo-locale `en-XA` ships regardless, for testing truncation and missing keys.

## Units

| Unit        | Owns                                                                            | Builds                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| N2-core     | `packages/i18n/**` (new), `apps/web/src/i18n/**`, `apps/web/tests/i18n.test.ts` | formatter, plurals, JSON catalogs with typed keys, negotiation, lazy load, pseudo-locale                                       |
| N2-ui       | `packages/ui/src/lib/messages.ts`, house primitives' formatting                 | `UiMessages` per locale, locale-aware primitives                                                                               |
| N2-email    | `packages/email/src/messages/**`                                                | email catalogs in the same JSON format; `users.locale` picks them                                                              |
| N2-switcher | settings and footer components                                                  | locale switcher, `me.update` locale                                                                                            |
| N2-weblate  | `docs/maintainers/translations.md`                                              | Weblate component config notes, PR flow; the maintainer applies for the libre plan and installs the Weblate GitHub integration |

N2-core runs alone first (every other unit reads its format). It can run in batch 3 beside E8
and E9 because it touches only `apps/web/src/i18n/**`; strings E8/E9 add land in the English
catalog either way.

## Done means

`e2e-basic` passes under `en-XA` (every visible string is pseudo-localized, so a missed literal
shows); plural and RTL unit tests; one real second locale at 100%; verify green.
