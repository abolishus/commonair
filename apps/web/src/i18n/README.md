<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Web message catalogs

Every user-facing string in `apps/web` goes through `t()` from `src/i18n/index.ts`. The
catalogs are JSON, English is the source of truth, and the format is a small ICU MessageFormat
subset formatted by `@commonair/i18n` ([ADR 0029](../../../../docs/decisions/0029-i18n.md)).

**Do not add non-English files by hand: they come from Weblate (N2-weblate).** Keys are added in
English only; other locales may lag and fall back to English per key.

## Layout

| Path                              | What                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| `locales/<lang>/<namespace>.json` | One flat object per namespace: `"prefix.area.name": "Message"`, keys unique across all   |
| `keys/<namespace>.gen.ts`         | Generated `Key` union per namespace (`never` when empty); committed                      |
| `keys/index.gen.ts`               | Generated `MessageKey` (the union of all namespaces) and `NAMESPACES`                    |
| `index.ts`                        | `t()`, `activeLocale()`, `uiMessagesFor()`, `loadLocale()`, `SUPPORTED_LOCALES`          |
| `catalogs.ts`                     | The locale registry: English bundled, other locales lazy, `en-XA` computed               |
| `server.ts`                       | The per-request locale (`AsyncLocalStorage`), negotiation and the memoized `me.get`      |
| `client.ts`                       | Boot before hydration, `applyLocale`, `rememberLocale`, `forgetLocaleCookie`, tab choice |
| `en.ts`                           | All English messages merged, for tests; it defines no keys                               |

Regenerate the key modules after editing an English catalog with `bun run i18n:gen` (in
`apps/web`); `bun run i18n:check` (also run by `bun run build`) and `tests/i18n.test.ts` fail when
they are stale.

## The message format

| Form                                                    | Example                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------ |
| Placeholder                                             | `"Welcome to {name}"`                                                    |
| Plural (`zero one two few many other`, `=N` wins)       | `"{count, plural, =0 {No votes} one {# vote} other {# votes}}"`          |
| Plural with offset (`#` is the number minus the offset) | `"{n, plural, offset:1 =1 {{host}} other {{host} and # others}}"`        |
| Select (`other` required)                               | `"{role, select, admin {Admin} other {Member}}"`                         |
| Ordinal                                                 | `"{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}"`        |
| Apostrophes                                             | `"{name}'s"` stays literal; `''` is one `'`; `'{literal}'` quotes braces |

- `#` is the plural's number formatted for the locale (`1,234` in English, `1.234` in German).
  Pass the raw number: `t("follow.count", { count })`.
- No number, date or time arguments (`{n, number}` is a syntax error): pass strings formatted by
  the house primitives (`formatNumber`, `<MoneyAmount>`, `<RelativeTime>`).
- A placeholder with no argument is kept verbatim (`t("legal.version", {})` → `Version {version}`).
- A plural argument that is not a number (an empty string, a missing argument) takes `other`, and
  `#` shows what was given.
- A translation that does not parse renders its raw source at runtime (a warning in dev) and fails
  `i18n:check` and the tests.

## Locales

- **Negotiation** (`server.ts`, `@commonair/i18n` `pickLocale`): the signed-in member's own choice
  (`users.locale`); else the `commonair-locale` cookie, for signed-out visitors and for members who
  never chose; else `Accept-Language`; else `INSTANCE_DEFAULT_LOCALE`; else `en`. Each step matches
  exactly, then by language (`es-MX` finds `es`). Only document requests ask the API who is signed
  in, once; the root loader and the route guards share that lookup.
- **The cookie** is a Preferences cookie: `rememberLocale(tag, { preferencesAllowed })` writes it
  only with consent and otherwise keeps the choice in this tab's `sessionStorage`; after hydration a
  supported tab choice that differs from the server's is applied with one remount.
  `forgetLocaleCookie()` expires it. Members also save their choice with `me.update({ locale })`
  and then call `applyLocale(tag)`.
- **Switching** (`applyLocale`) loads the catalog, updates `<html lang dir>` and remounts the tree
  under `LocaleProvider`: `t()` is not reactive, so a remount re-renders every string (local
  component state is lost). The document title follows on the next navigation.
- **Adding a language** is adding `locales/<lang>/*.json` (from Weblate); it becomes supported and
  negotiable with no code change.
- **`en-XA`** is the pseudo-locale: every message accented, about 35% longer and bracketed, so a
  string that bypasses `t()` shows up unaccented. It ships in every build and has no files (it is
  computed from English). Reach it with the cookie `commonair-locale=en-XA` or, signed in, with
  `me.update({ locale: "en-XA" })`; never through `Accept-Language`.
- Design-system strings (`UiMessages`) come from `uiMessagesFor(locale)`: English for now (N2-ui),
  pseudo-localized for `en-XA`.

## How to add a namespace (E8/E9 wave-2 and wave-3 units and N2-consent)

1. **Your namespace** is named in your brief (e.g. `e8-studio`): lowercase words joined by `-`.
   N2-core created it empty, so `locales/en/<namespace>.json` (`{}`) and `keys/<namespace>.gen.ts`
   already exist and are registered. If your brief's namespace does not exist, stop and send a
   contract request: never create one yourself (it would change the shared `keys/index.gen.ts`).
2. **Write English only**, in `locales/en/<namespace>.json`: one flat JSON object,
   `"prefix.area.name": "Message"`, keys under your unit's prefix (e.g. `polls.`), unique across
   all namespaces. Messages use the ICU subset above: `{name}` placeholders,
   `"{count, plural, one {# vote} other {# votes}}"`, `{x, select, … other {…}}`. No number or date
   formatting inside messages: pass already-formatted strings from `formatNumber`/`<MoneyAmount>`
   etc., except the `#` of a plural, which takes the raw number.
3. **Regenerate types:** `cd apps/web && bun run i18n:gen`. Only `keys/<namespace>.gen.ts` may
   change; if `keys/index.gen.ts` changes, `git checkout` it and send a contract request.
4. **Use it** exactly as before: `import { t } from "../i18n/index.ts"` (relative path as in your
   file) and `t("polls.title")`, `t("polls.votes", { count })`. Literal keys, or a
   `Record<Code, MessageKey>` map of literal keys (`t(LABEL[code])`); never template literals,
   concatenation or `as MessageKey`. Call `t()` when rendering, never at module scope (a
   top-level `const X = { a: t("…") }` would be English forever).
5. **Never edit** another namespace, `en.ts`, `index.ts`, `keys/index.gen.ts`,
   `apps/web/tests/i18n.test.ts`, or any `locales/<lang>/` other than `en`. One exception: when
   your brief names exact keys to delete from another namespace because your change makes them
   unused (E8-viewer: `overlay.goalsLater` and `overlay.chatLater` in `ops`), delete exactly those
   from `locales/en/<that namespace>.json`, rerun `bun run i18n:gen`, and commit that namespace's
   regenerated `keys/<that namespace>.gen.ts` too. Nothing else in it changes. If one of those keys
   is in the unused-keys allowlist, it is a contract request (the test is N2-core's).
6. **Layout is logical.** `apps/web/tests/logical-css.test.ts` fails on physical-direction classes
   (`ml-`, `pr-`, `left-`, `border-l`, `text-left`, …) in any file under `apps/web/src` and in any
   **new file under `packages/ui/src`** (E8-studio's `blocks/interact-studio/**`, E8-viewer's
   `blocks/interact-viewer/**`: the baseline only holds files that existed before). Use
   `ms-`/`pe-`/`start-`/`border-s`/`text-start`; where direction is truly physical (a progress or
   goal-bar fill, a media timeline, centring with `left-1/2 -translate-x-1/2`), add a same-line
   `rtl-physical: <reason>` comment.
7. **Check:** `cd apps/web && bun run i18n:check && bun --bun vp test run tests/i18n.test.ts tests/logical-css.test.ts`
   (keys exist, unique, parse, types fresh, every key in your namespace is used, layout logical).

Design-system strings (`UiMessages`) and email strings are not namespaces: E8/E9 units do not add
`UiMessages`, and email strings follow their brief.

## Notes carried over from the TypeScript catalogs

- `e7-dmca`: the statutory statements follow 17 U.S.C. § 512(c)(3)(A) and § 512(g)(3); they have
  not been reviewed by a lawyer.
- `legal.pending.optional` is also the sign-up page's label before the documents that need no
  acceptance (cookies, DMCA).
- `safety.enforcement.*` (statements of reasons, ADR 0019): clause titles come from the API
  (`clauseTitle`), not the catalog.
