<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N2-core: ICU formatter, JSON catalogs with typed keys, negotiation, lazy load, en-XA, RTL check

You are implementing unit N2-core for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/N2-i18n-weblate.md`,
`docs/decisions/0029-i18n.md` (all of it: it is accepted and binding),
`.claude/briefs/n2/contract-step.md` (what is already done for you, and §9 "Shared-file rules")
and `.claude/briefs/_done-means.md`. Do not look outside the repository. Work in your own git
worktree on a branch named `n2/core`, created from the N2 contract-step commit the orchestrator
gives you (it sits on top of the E8 and E9 contract steps; run `git merge main` first if main
moved). You run in **wave 1**, beside the five E8 API units (E8-polls, E8-raids-goals,
E8-points, E8-bot-engine, E8-bot-api; no E9 unit runs in wave 1): no other unit writes in
`apps/web` until you merge, and every wave-2 and wave-3 web unit builds on your format.

## Why

Every web string already goes through `t()`, but `t()` is English-only `{name}` replacement over
TypeScript objects (`apps/web/src/i18n/index.ts:13-22`), so nothing can be translated, plurals
are faked with `…One`/`…Other` key pairs, and Weblate cannot edit the catalogs. ADR 0029 moves
catalogs to JSON with typed keys, adds an ICU plural/select formatter over `Intl.PluralRules`,
negotiates the viewer's language and ships the `en-XA` pseudo-locale. You build that
infrastructure; Spanish content, `UiMessages` per locale, email catalogs, the switcher UI and
Weblate are later N2 units (N2-es, N2-ui, N2-email, N2-switcher, N2-weblate), not you.

## You own (write only these)

- `packages/i18n/**` (scaffolded by the contract step; you fill it). No dependency of any kind.
- `apps/web/src/i18n/**`: everything in it, including the new `locales/`, `keys/`, the
  server/client negotiation modules and `README.md`. You delete the TypeScript catalogs.
- `apps/web/tests/i18n.test.ts` (rewrite), new `apps/web/tests/i18n-*.test.ts(x)`, new
  `apps/web/tests/logical-css.test.ts` and `apps/web/tests/logical-css.baseline.json`.
- `apps/web/src/routes/__root.tsx` (the i18n import :9, `<html lang>` :56, `LocaleProvider`
  :61, plus the locale state and remount described below; nothing else in it).
- `apps/web/src/server/bootstrap.ts` and `apps/web/src/lib/bootstrap-types.ts` (`Bootstrap`
  gains `locale` and `dir`; `loadBootstrap` reuses the request's negotiated locale and session).
- New `apps/web/src/start.ts` (TanStack Start `createStart` with the request middleware) and new
  `apps/web/src/client.tsx` (client entry that loads the catalog before hydrating), if the
  approach below holds; otherwise the equivalent files, named in your final message.
- `apps/web/src/components/altcha-field.tsx`: only the `locale` import (:10) and its use (:87).
- The two physical-direction classes in `apps/web/src`: `components/legal-document-link.tsx:57`
  (`pr-3`) and `components/dmca/dmca-queue.tsx:140` (`text-left`). Nothing else in those files.
- `apps/web/package.json`: the `scripts` block only (the contract step added the dependency).
- `apps/web/src/components/channel-follow.tsx:46` and `apps/web/src/chat/events.ts:94-95`: only
  the plural conversion in Build §2. In `apps/web/tests/chat-events.test.ts`, only the two new
  gift cases of Build §2 (no-total and 1,000+); the existing cases (:59-68) must pass unchanged.
- In other `apps/web/tests/*` files, only what your change breaks: the catalog import at
  `apps/web/tests/e7-chat.test.tsx:13` (`e7ChatMessages` from `../src/i18n/e7-chat.ts`, used at
  :163, :248, :254) and any `Bootstrap` fixture that needs the two new fields (fixtures live in
  `e6-routes`, `e7-legal`, `coop-e7`, `selectors-render`, `coop-routes` and `p2p-indicator`
  `.test.tsx`). The 18 other test files that import `{ en } from "../src/i18n/en.ts"` must keep
  compiling **without** edits (keep `en.ts`, below), and so must the 18 test files that import
  `locale` and/or `uiMessages` from `../src/i18n/index.ts` (e.g. `e6-overlay-root.test.tsx:24`,
  `safety.test.tsx:30`, `p2p-indicator.test.tsx:16`; `grep -rln "locale, \|uiMessages" apps/web/tests`):
  keep both exports (Build §3).

Read-only: `packages/contracts/**`, `packages/db/**`, `packages/config/**`, `packages/email/**`,
`packages/ui/**` (N2-ui's later), `apps/web/src/routeTree.gen.ts`, nav, every other component,
`REUSE.toml`, `bun.lock`. Anything else is a **contract request** with the exact diff.

## Contracts you must honor (read-only for you)

- **ADR 0029** decisions 1-6 (7 is N2-weblate's): the ICU subset, JSON under
  `apps/web/src/i18n/locales/<lang>/<namespace>.json`, English the source of truth with per-key
  fallback, negotiation order, the Preferences cookie, lazy loading, `<html lang dir>`, logical
  properties checked by a repository test, `en-XA` in every build.
- From the contract step: `INSTANCE_DEFAULT_LOCALE` (in `coreEnv`, so `loadWebEnv()` has it;
  default `en`), `InstanceSite.defaultLocale`, `Me.locale: string | null` (null = not chosen),
  `me.update({ locale: string | null })`, `LocaleTag` (`packages/contracts/src/api/entities.ts`),
  `users.locale` nullable, with a `users_locale_format` `CHECK` of the same pattern as `LocaleTag`. The cookie policy's Preferences paragraph now names language and says a
  declined visitor's choice lives in the tab's own storage only.
- `packages/ui/src/lib/locale.tsx:30` `LocaleProvider({ locale, timeZone, messages })` and the
  primitives that read it (`useLocale`, `useResolvedLocale`). You pass it the active locale; you do
  not edit `packages/ui`.
- `apps/web/src/server/http.ts:77`: rendered pages are `private, no-store`, so per-visitor
  language needs no `Vary`.
- `harness/src/web/session.ts:44`: harness browsers send `locale: "en-US"`, so every scenario
  must still render English.

## What is there today (verified at `c0c16fd`)

- `apps/web/src/i18n/index.ts:13` `export const locale = "en"`; `:15` `catalog = en`; `:18-22`
  `t(key, vars)` replaces `{name}` and keeps unknown placeholders; `:24` `uiMessages = enMessages`.
- `apps/web/src/i18n/en.ts:17-339` spreads eleven unit catalogs (`support`, `money`, `safety`,
  `coop`, `ops`, `e7-chat`, `e7-dmca`, `e7-admin`, `e7-appeals`, `e7-legal`, `p2p`; each
  `export const <x>Messages = { … } as const`) and adds the inline keys; `:341`
  `MessageKey = keyof typeof en`. About 1,800 keys in all (check the count after E8/E9's
  contract steps, which may add inline `nav.*` keys).
- 114 files in `apps/web/src` import from the i18n index (`t` in 113, `type MessageKey` in 12,
  `locale` in 2: `routes/__root.tsx:9` and `components/altcha-field.tsx:10`; `uiMessages` in 1,
  `__root.tsx`), plus 22 test files (18 of them import `locale`/`uiMessages` to wrap renders in
  `LocaleProvider`).
- `apps/web/tests/i18n.test.ts` (159 lines): used keys exist (:33-39), dynamic keys banned
  outside a 13-file allowlist (:41-62), per-catalog disjointness and "every key used" checks
  (:64-148; only `coop`, `ops` and the five `e7-*` catalogs are checked for unused keys today),
  form-error mapping (:150-153), placeholder behaviour (:155-159).
- Keys: 1,873 at `c0c16fd`, no duplicates. 34 of them have `_` in a segment that mirrors an enum
  value (`safety.reason.self_harm`, `coop.basis.board_appointment`, `support.status.past_due`,
  `appeals.account.action.dmca_strike`, …); none has `-`.
- Plural pairs: `follow.countOne/Other`, `chat.event.giftOne/Other`,
  `chat.event.giftAnonymousOne/Other`, and three `…One` keys whose plural sibling is a different
  key (`p2p.indicator.sharingOne`, `p2p.dialog.activeOne`, `support.submit.giftOne`).
- Apostrophes: about 30 messages contain `'` (e.g. `"Allow {name}'s message"`, e7-chat); none
  has `'{`, `'}`, `''` or `#`, so under ICU's rule they stay literal. No message has a brace
  that is not a `{word}` placeholder; verify both facts with your converter.
- `__root.tsx:16-31` root loader `getBootstrap()` (`lib/bootstrap.ts:11`, a server function that
  reads the cookie header) → `server/bootstrap.ts:16-37` returns config, instance, `me`, `theme`,
  `now`; `loadSessionUser` (:40-48) calls `me.get` with the visitor's cookie. `Me` now carries
  `locale`.
- Theme is a first-party cookie read on the server (`lib/theme.ts:7-21`), the model for the
  locale cookie, except that the locale cookie is written only with Preferences consent.
- There is no consent UI in `apps/web` yet; N2-consent builds it in wave 3 (contract step §6).
- Physical-direction classes: 2 in `apps/web/src` (listed above), 133 in 36 files of
  `packages/ui/src` (mostly shadcn components; N2-ui's decision whether to convert them).
- The image build runs `vp build` directly (`infra/containers/service.Containerfile:61`), not
  `bun run build`: generated files must be committed.

## Build

### 1. `packages/i18n` (framework-neutral; N2-email and N2-ui will reuse it)

Public API (`src/index.ts`), exactly these names so later units can cite them:

```ts
export type MessageArgs = Readonly<Record<string, string | number>>;
export class I18nSyntaxError extends Error {
  readonly offset: number;
}
/** Parse once; throws I18nSyntaxError with the offset. */
export function parseMessage(source: string): MessageAst;
/** Format with `locale`'s plural rules; unknown `{name}` placeholders are kept verbatim. */
export function formatMessage(message: string | MessageAst, args: MessageArgs | undefined, locale: string): string;
/** Translator over a catalog with per-key English fallback and a parse cache. */
export function createTranslator<K extends string>(opts: {
  locale: string;
  messages: Partial<Record<K, string>>;
  fallback: Record<K, string>;
  onMissing?: (key: K) => void;
}): (key: K, args?: MessageArgs) => string;
/** Accept-Language → tags by descending q (stable), `*` and q=0 dropped, at most 20, malformed parts skipped. */
export function parseAcceptLanguage(header: string | null | undefined): string[];
/** First candidate that matches `supported`: exact tag (case-insensitive), then its language subtag. */
export function negotiateLocale(candidates: readonly string[], supported: readonly string[]): string | undefined;
/** ADR 0029 order: user choice, stored choice, Accept-Language, instance default, then `en`. */
export function pickLocale(input: {
  userLocale?: string | null;
  stored?: string | null;
  acceptLanguage?: string | null;
  instanceDefault: string;
  supported: readonly string[];
}): string;
export function localeDirection(tag: string): "ltr" | "rtl";
export const PSEUDO_LOCALE = "en-XA";
/** Accent ASCII letters, pad by ~35%, wrap in [ ]; placeholders, plural/select syntax and `#` untouched. */
export function pseudoLocalize(source: string): string;
```

Plus the catalog tooling the web uses (`src/catalog.ts`, exported too):
`readNamespaces(dir)`, `checkCatalog(namespaces)` (duplicate keys across namespaces, key and
namespace name syntax, every message parses, every non-English key exists in English) and
`renderKeyModules(namespaces)` (the generated files, below), and a CLI `src/cli.ts`:

```
bun packages/i18n/src/cli.ts gen --catalogs <dir containing en/> --out <keys dir> [--check]
```

`gen` writes the key modules (deterministic: sorted namespaces, keys in file order); `--check`
writes nothing and exits 1 listing what is stale or invalid.

Formatter rules (ADR 0029 decision 1): `{name}`; `{n, plural, [offset:k] =0 {…} one {…} … other {…}}`
with `#` (the number minus offset, formatted with `Intl.NumberFormat(locale)`); `{x, select, a {…} other {…}}`;
`{n, selectordinal, one {…} two {…} few {…} other {…}}`; nesting. `other` is required in plural,
selectordinal and select. Exact `=N` matches win over categories. No number/date/time argument
types (`{n, number}` is a syntax error: formatting belongs to the primitives). Apostrophes are
literal unless they start a quote before `{`, `}`, `#` (inside plural) or another `'` (`''` → `'`).
Plural rules come from `Intl.PluralRules` (`type: "ordinal"` for selectordinal); `en-XA` uses
`en`'s. A plural argument that is not a finite number (including `""` and a missing argument) formats as
`other`, and `#` in that branch renders `String(arg)` (empty for a missing one), never `NaN`. At runtime a message
that fails to parse renders its raw source (and `onMissing`-style reporting in dev), never throws;
at generation time it is an error. Cache parsed messages per catalog. Keep it a few hundred lines.

`localeDirection`: `rtl` for the language subtags `ar, he, fa, ur, ps, yi, dv, ckb, sd, ug`
(the `-Arab`/`-Hebr` script subtags too), else `ltr`.

### 2. JSON catalogs, one namespace per old file

- Convert every catalog with a throwaway script (do not commit it): import the TS objects and
  write `apps/web/src/i18n/locales/en/<namespace>.json`, a flat object, keys in the original
  order, 2-space indent, trailing newline, run through `vp fmt`. Namespaces: `core` (the inline
  keys of `en.ts`), `support`, `money`, `safety`, `coop`, `ops`, `p2p`, `e7-chat`, `e7-dmca`,
  `e7-admin`, `e7-appeals`, `e7-legal`, plus any catalog file E8's or E9's contract step added
  (same name), plus an empty `{}` namespace for each later web unit of this batch. Those are,
  from the E8, E9 and N2 briefs: **`e8-studio`** (E8-studio, wave 2), **`e8-viewer`** (E8-viewer,
  wave 2), **`e9-consent`**, **`e9-console`** and **`n2-consent`** (N2-consent, wave 3). The orchestrator also lists them under
  "i18n namespaces" in `.claude/briefs/batch3/README.md` (that file does not exist at `c0c16fd`);
  if the README names more, create those too, and if it names fewer, ask before dropping one. Comments in the TS files are dropped; keep any that carry meaning as a sentence in
  `apps/web/src/i18n/README.md`.
- **Equivalence before deletion.** In the same throwaway script, for every key, fill each
  `{name}` with a sentinel and check `formatMessage(json, args, "en") === oldReplace(ts, args)`,
  and that `formatMessage(json, undefined, "en") === ts` for messages without placeholders. Put
  the result (keys checked, mismatches: must be 0) in your final message. Then delete the TS
  catalogs.
- **Plurals.** Convert the three true pairs into one ICU message each and update their call
  sites so English output is unchanged (`follow.count`, `chat.event.gift`,
  `chat.event.giftAnonymous`). The call sites are `apps/web/src/components/channel-follow.tsx:46`
  (pass the raw `count` as the plural argument; `#` formats it, so check the output equals
  today's `formatNumber(count, locale)`) and `apps/web/src/chat/events.ts:94-95`; edit only those
  lines there. `chatEventText` passes `total: view.total ?? ""`, so the gift plural argument can be
  `""` (no total): it must select `other` and `#` must render it as `String(arg)` (today's output
  for that case), and `#` adds grouping for totals of 1,000 or more (`1,000` where `{total}` gave
  `1000`): intended, say so in your final message, and add a `chat-events.test.ts` case for each
  (that test file is yours for these two cases only; E8-viewer adds its own later). Leave the other
  three `…One` keys alone. Do not convert anything else.
- **Typed keys (ADR 0029 decision 2).** `bun run i18n:gen` (in `apps/web`) generates
  `apps/web/src/i18n/keys/<namespace>.gen.ts` (one per namespace:
  `export type Key = "a.b" | "c.d";`, `never` when empty) and `apps/web/src/i18n/keys/index.gen.ts`
  (imports each namespace's `Key`, exports `MessageKey` as their union and
  `NAMESPACES = [...] as const`). Each file has the AGPL SPDX header and "Generated by
  `bun run i18n:gen`; do not edit." They are type-only modules: the ADR's "generated `.d.ts`",
  written as `.gen.ts` so imports use the repo's `.ts` suffix and the existing `*.gen.ts`
  exclusions apply. Committed. Per-namespace files mean a unit adding keys changes only its own
  generated file; `index.gen.ts` changes only when a namespace is added or removed.
- `apps/web/package.json` scripts: `"i18n:gen": "bun ../../packages/i18n/src/cli.ts gen --catalogs src/i18n/locales --out src/i18n/keys"`,
  `"i18n:check": "bun ../../packages/i18n/src/cli.ts gen --catalogs src/i18n/locales --out src/i18n/keys --check"`,
  and `build` becomes `bun run i18n:check && vp build && bun scripts/check-build.ts`. The unit
  test (below) is what CI relies on.

### 3. Runtime: `t()` keeps its signature and import path

- `apps/web/src/i18n/index.ts` keeps exporting `t(key: MessageKey, vars?: Record<string, string | number>): string`
  and `type MessageKey` (now from `keys/index.gen.ts`), so the 114 importing source files do not
  change. Add `activeLocale(): string` and `uiMessagesFor(locale): UiMessages` (English
  `enMessages`, pseudo-localized for `en-XA`: strings through `pseudoLocalize`, the `viewerCount`
  function's result too), and move the two source importers of `locale` (`__root.tsx`,
  `altcha-field.tsx`) and the one of `uiMessages` to them. **Keep** `export const locale = "en"`
  and `export const uiMessages = enMessages`, documented as "the source (English) locale and its
  `UiMessages`, for tests that render outside a request; app code uses `activeLocale()` /
  `uiMessagesFor()`": 18 test files you do not own import them. Back that with a check in
  `i18n.test.ts`: no file under `apps/web/src` outside `src/i18n/` imports `locale` or
  `uiMessages` from the i18n index.
- `altcha-field.tsx:87` passes `language: activeLocale()` mapped to the language subtag, and
  `en` for `en-XA` (the widget has no pseudo-locale); do not import any altcha language pack
  (later N2 units decide which ship).
- `apps/web/src/i18n/en.ts` stays as a thin module: `export const en: Record<MessageKey, string>`
  (all English namespaces merged) and `export type { MessageKey }`, so the 19 tests importing it
  keep working. Nobody adds keys there any more.
- English is bundled: `import.meta.glob("./locales/en/*.json", { eager: true, import: "default" })`.
  Other locales load lazily: `import.meta.glob("./locales/*/*.json", { import: "default" })`
  minus `en`; `loadLocale(tag)` imports a locale's namespaces once, merges them over English
  (per-key fallback, ADR decision 2) and caches the translator. `en-XA` has no files: its catalog
  is `pseudoLocalize` over English, built on first use. `SUPPORTED_LOCALES` = the directories
  under `locales/` plus `en-XA`. Adding `locales/es/*.json` later must make `es` negotiable with no
  code change (test it with an injected glob map, since no `es` files exist yet).
- **Per-request locale on the server, no leakage.** `t()` is a plain function called outside
  React (lib files, route `head`), so it reads the active translator from a store: on the server
  an `AsyncLocalStorage` set for the whole request by a TanStack Start request middleware
  (`createMiddleware({ type: "request" })`, registered with `createStart(() => ({ requestMiddleware: [...] }))`
  in `src/start.ts`; check the exact API in the installed `@tanstack/react-start` 1.168.60 under
  `node_modules`), and on the client a module variable. Outside a request (tests, scripts) it is
  English. The middleware negotiates once per document request (below) and stores the locale, the
  translator and the session lookup (a memoized promise of `me.get`), so both `loadBootstrap` and
  `loadSessionUser` (`server/bootstrap.ts:40-48`, which the route guards call through
  `getSessionUser` in `beforeLoad`, e.g. `routes/_admin.tsx:43`, `routes/_studio/dashboard.tsx:27`)
  reuse it. A guarded page makes two `me.get` calls today (bootstrap and guard); after your change a
  document request makes exactly one. `SessionUser` keeps its fields (no `locale` in it).
- **Hydration.** `src/client.tsx` reads `document.documentElement.lang`, awaits
  `loadLocale(lang)`, sets the client store, then hydrates (`hydrateRoot(document, <StartClient />)`),
  so the first client render uses the same catalog as the server. If a custom client entry is not
  possible in this TanStack Start version, put the non-English catalog in the bootstrap payload
  instead and say why in your final message.
- **`__root.tsx`.** `<html lang={locale} dir={dir}>` and `<LocaleProvider locale={locale} messages={uiMessagesFor(locale)}>`
  from bootstrap data (the default `timeZone` stays). Switching in the client: export
  `applyLocale(tag): Promise<void>` from `apps/web/src/i18n/client.ts` that loads the catalog,
  sets the store, updates `<html lang dir>` and remounts the tree under `LocaleProvider` (a root
  `key` bump: `t()` is not reactive, so a remount is the honest way to re-render every string;
  local component state is lost, which is acceptable for a language switch).

### 4. Negotiation (ADR 0029 decision 3)

- Order, in `pickLocale`: (1) the signed-in member's `Me.locale` when not null; (2) the
  `commonair-locale` cookie, for any visitor whose `users.locale` is null: the ADR names signed-out
  visitors, and **a signed-in member who never chose a language keeps a choice made earlier in the
  footer, which outranks Accept-Language** (decided 2026-10-29; test it); (3) `Accept-Language`; (4)
  `INSTANCE_DEFAULT_LOCALE`; (5) `en`. Each step matches against `SUPPORTED_LOCALES` (exact, then
  language: `es-MX` → `es`, `en-GB` → `en`); `en-XA` matches only exactly; an unsupported
  instance default falls through to `en`.
- The cookie: `commonair-locale=<tag>; path=/; max-age=31536000; samesite=lax` (not HttpOnly; the
  client writes it). **N2-core never writes it on its own initiative**: export
  `rememberLocale(tag, { preferencesAllowed: boolean })` from `apps/web/src/i18n/client.ts`, which
  writes the cookie only when `preferencesAllowed` is true, and otherwise stores the tag in
  `sessionStorage` (the tab-only choice the cookie policy now describes). The caller (N2-switcher,
  later) supplies consent from N2-consent's `preferencesAllowed()` (wave 3,
  `apps/web/src/lib/consent.ts`); until N2-consent merges a signed-out choice is tab-only. Export
  the names as constants from `apps/web/src/i18n/client.ts`, `LOCALE_COOKIE = "commonair-locale"`
  and `LOCALE_SESSION_KEY` (the `sessionStorage` key you choose), and a
  `forgetLocaleCookie(): void` that expires the cookie: N2-consent moves a tab-only choice into
  the cookie when Preferences are allowed and back out when they are withdrawn, without editing
  your files. On the client, after hydration, a supported tag in `sessionStorage` that differs from
  the server's choice is applied with `applyLocale` (one remount; document it). Wrap every
  `document.cookie`/`sessionStorage` access in try/catch.
- Signed-in members change language through `me.update({ locale })` (N2-switcher's UI); after a
  successful update the caller runs `applyLocale`. Provide nothing else for it.
- Only document requests negotiate with the session; server-function and asset requests use
  cookie/Accept-Language/default without calling the API.

### 5. `en-XA`

Ships in every build. Reachable by `me.update({ locale: "en-XA" })` or the cookie
`commonair-locale=en-XA` (how the milestone's `e2e-basic` run will set it); never by
Accept-Language language fallback. Every `t()` string and every `UiMessages` string is
pseudo-localized, so an unaccented visible string is a literal that bypasses `t()`. Do not hide it
behind `NODE_ENV`.

### 6. Repository checks

Rewrite `apps/web/tests/i18n.test.ts` around namespaces instead of hand-listed catalogs:

- the generated key modules are fresh (`renderKeyModules(readNamespaces(...))` equals the files);
- `checkCatalog` passes: no key in two namespaces, names and keys well formed
  (`^[a-z][a-z0-9]*(-[a-z0-9]+)*$` for namespaces; keys `^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9_]+)+$`:
  later segments may carry `_` because 34 keys end in an enum value such as `self_harm`),
  every message parses, no non-English key missing from English;
- every key used in source exists (the current regex over `t("…")`, now against `MessageKey`'s
  set);
- every key of every namespace is used somewhere outside `src/i18n/` (as the E5/E6/E7 checks do
  today), with an explicit allowlist of the keys that are unused today (find them; remove a key
  only if it is clearly dead, and list both in your final message);
- dynamic keys: replace the 13-file allowlist with a rule the compiler backs up. `t()` may take a
  non-literal argument (a `MessageKey`-typed map lookup such as `t(LABEL[code])` is fine, since
  the "every key used" check sees the literals in the map), but template literals, string
  concatenation and `as MessageKey` casts in a `t()` argument or a `MessageKey` value are banned
  outside `src/i18n/`;
- the form-error mapping and placeholder checks stay (`t("legal.version", {})` keeps
  `{version}`);
- `en.ts` defines no keys of its own.

New `apps/web/tests/logical-css.test.ts` (ADR 0029 decision 5): scans `apps/web/src/**/*.{ts,tsx,css}`
and `packages/ui/src/**/*.{ts,tsx,css}` for physical-direction Tailwind utilities (with any
variant prefix and `-`/`!` modifiers: `ml-/mr-/pl-/pr-`, `scroll-m{l,r}-/scroll-p{l,r}-`,
`left-/right-`, `border-{l,r}`, `rounded-{l,r,tl,tr,bl,br}`, `text-{left,right}`,
`float-{left,right}`, `clear-{left,right}`) and CSS properties (`margin-left/right`,
`padding-left/right`, `border-left/right`, `left:`/`right:`, `text-align: left/right`,
`float: left/right`; the CSS properties in `.css` files only: object keys such as recharts'
`margin={{ left: 0 }}` in `packages/ui/src/blocks/data/breakdown.tsx:122` are not CSS). A match
is allowed only with a same-line `rtl-physical: <reason>` comment
(a progress fill, a media timeline, centring with `left-1/2 -translate-x-1/2`). `apps/web/src`
must have zero unexplained matches (convert the two); `packages/ui/src` is held by
`logical-css.baseline.json` (count per file; a count may only go down, a new file must be zero),
so N2-ui can convert it later. Error messages name the file, the class and its logical form.
Wave-2 units add new files under `packages/ui/src` (E8-studio's `blocks/interact-studio/**`, E8-viewer's `blocks/interact-viewer/**`, including a
goal bar whose fill is physical), so the baseline rule "a new file must be zero" applies to them:
say so in the namespace recipe (below) so their briefs' authors and units know.

Also: audit for `t()` calls evaluated at module load (a top-level `const X = { a: t("…") }` is
English forever). Fix any you find by making them functions, in files you own or, if elsewhere,
as part of the permitted call-site edits listed in your final message. Add a check if it is
cheap; otherwise list what you audited.

### 7. `apps/web/src/i18n/README.md` (CC-BY-SA header)

The format, the ICU subset with examples, the namespace recipe below, how `en-XA` is reached,
and "do not add non-English files by hand: they come from Weblate (N2-weblate)".

## How to add a namespace (E8/E9 wave-2 and wave-3 units and N2-consent cite this section)

This is the interface you must implement; the E8-studio, E8-viewer, E9-consent, E9-console and
N2-consent briefs are written against it.

1. **Your namespace** is named in your brief (e.g. `e8-studio`): lowercase words joined by `-`.
   N2-core created it empty, so `apps/web/src/i18n/locales/en/<namespace>.json` (`{}`) and
   `apps/web/src/i18n/keys/<namespace>.gen.ts` already exist and are registered. If your brief's
   namespace does not exist, stop and send a contract request: never create one yourself
   (it would change the shared `keys/index.gen.ts`).
2. **Write English only**, in `locales/en/<namespace>.json`: one flat JSON object,
   `"prefix.area.name": "Message"`, keys under your unit's prefix (e.g. `polls.`), unique across
   all namespaces. Messages use the ICU subset: `{name}` placeholders,
   `"{count, plural, one {# vote} other {# votes}}"`, `{x, select, … other {…}}`. No number or date
   formatting inside messages: pass already-formatted strings from `formatNumber`/`<MoneyAmount>`
   etc., except the `#` of a plural, which takes the raw number.
3. **Regenerate types:** `cd apps/web && bun run i18n:gen`. Only `keys/<namespace>.gen.ts` may
   change; if `keys/index.gen.ts` changes, `git checkout` it and send a contract request.
4. **Use it** exactly as before: `import { t } from "../i18n/index.ts"` (relative path as in your
   file) and `t("polls.title")`, `t("polls.votes", { count })`. Literal keys, or a
   `Record<Code, MessageKey>` map of literal keys (`t(LABEL[code])`); never template literals,
   concatenation or `as MessageKey`.
5. **Never edit** another namespace, `en.ts`, `index.ts`, `keys/index.gen.ts`,
   `apps/web/tests/i18n.test.ts`, or any `locales/<lang>/` other than `en`. One exception: when
   your brief names exact keys to delete from another namespace because your change makes them
   unused (E8-viewer: `overlay.goalsLater` and `overlay.chatLater`, which N2-core puts in `ops`,
   from `ops.ts:129,131`), delete exactly those from `locales/en/<that namespace>.json`, rerun
   `bun run i18n:gen`, and commit that namespace's regenerated `keys/<that namespace>.gen.ts`
   too. Nothing else in it changes. If one of those keys is in the unused-keys allowlist, it is a
   contract request (the test is N2-core's).
6. **Layout is logical.** `apps/web/tests/logical-css.test.ts` fails on physical-direction
   classes (`ml-`, `pr-`, `left-`, `border-l`, `text-left`, …) in any file under `apps/web/src`
   and in any new file under `packages/ui/src`. Use `ms-`/`pe-`/`start-`/`border-s`/`text-start`;
   where direction is truly physical (a progress or goal-bar fill, a media timeline, centring with
   `left-1/2 -translate-x-1/2`), add a same-line `rtl-physical: <reason>` comment.
7. **Check:** `cd apps/web && bun run i18n:check && bun --bun vp test run tests/i18n.test.ts tests/logical-css.test.ts`
   (keys exist, unique, parse, types fresh, every key in your namespace is used, layout logical).

Design-system strings (`UiMessages`) and email strings are not namespaces: E8/E9 units do not
add `UiMessages`, and email strings follow their brief (N2-email is not in batch 3).

## Tests you must add

- `packages/i18n/tests/*.test.ts`, exhaustive: placeholders (present, missing, numeric, kept
  when unknown, `{}` args); plural for `en`, `fr` (0 is `one`), `ru` (one/few/many), `ar` (all six
  categories), `ja` (only `other`), `=0`/`=1` beating categories, `offset`, `#` nested inside a
  select inside a plural, `#` formatted per locale (`1,234` vs `1.234`), non-numeric plural arg
  (`""`, `"abc"`, missing: `other`, `#` as `String(arg)`);
  select with and without a match; selectordinal `en` (1st 2nd 3rd 4th 11th 12th 13th 21st 22nd
  101st); apostrophes (`{name}'s`, `''`, `'{literal}'`); syntax errors with offsets (unclosed
  brace, missing `other`, `{n, number}`, empty argument); `pseudoLocalize` keeps placeholders,
  plural keywords, `#` and quotes, is deterministic, is about 35% longer and bracketed;
  `parseAcceptLanguage` (q ordering, ties stable, `*`, `q=0`, malformed, 20-entry cap, case);
  `negotiateLocale` and `pickLocale` (each step of the order, language fallback, `en-XA` exact
  only, unsupported instance default → `en`, null user locale); `localeDirection`; `checkCatalog`
  and `renderKeyModules` on fixture directories (duplicate key across namespaces, bad names,
  unparsable message, non-English key missing in English, empty namespace → `never`); the CLI's
  `--check` exit code.
- `apps/web/tests/i18n.test.ts` as in §6, and new:
  - `i18n-runtime.test.ts`: `t()` outside a request is English; per-key fallback over a partial
    injected catalog; `en-XA` output for a few keys; `uiMessagesFor("en-XA")`; `activeLocale()`.
  - `i18n-ssr.test.tsx`: two concurrent server renders in different locales (one `en-XA`, one
    `en`) of a component with a `Suspense` boundary that resolves after a delay, interleaved,
    each output entirely in its own locale (the request store must not leak across requests or
    lose itself across the suspension).
  - `i18n-negotiation.test.ts`: the middleware/bootstrap path picks `Me.locale`, then the
    cookie (also for a signed-in member whose `locale` is null, over Accept-Language), then
    Accept-Language, then the instance default; one `me.get` per document request,
    including a guarded route whose `beforeLoad` calls `getSessionUser`.
  - `i18n-client.test.ts`: `rememberLocale` writes the cookie only with `preferencesAllowed`,
    else `sessionStorage`; `forgetLocaleCookie` expires it; storage that throws does not break the page; `applyLocale` sets
    `<html lang dir>`.
  - `logical-css.test.ts` as in §6, with a fixture proving it catches `md:ml-2`, `-left-1`,
    `!pr-3`, `border-l-2`, `rounded-tl-md`, `text-left`, `margin-left:` and honours a
    `rtl-physical:` comment.
- The plural call sites you changed: their existing tests still pass with identical English.

## Done means

Follow `.claude/briefs/_done-means.md`. Targeted checks only: `bun --bun vp test run` in
`packages/i18n` and `apps/web`; `bunx tsc -p packages/i18n --noEmit` and `bunx tsc -p apps/web --noEmit`;
`cd apps/web && bun run i18n:check`; `vp lint --deny-warnings` and `vp fmt` on your paths;
`vp build` in `apps/web`, then confirm `git diff apps/web/src/routeTree.gen.ts` is empty and that
the client output has English inline and no `en-XA` file (it is computed). Never run
`bun run verify`, `verify:full`, `podman compose`, `scripts/infra.ts` or a harness scenario; CI on
`main` is the gate and the orchestrator pushes. `git status` shows only your paths. Commit in your
worktree (`git commit -s`, Conventional Commits, e.g. `feat(i18n): …`, message ending with
`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`); the catalog conversion may be its own
commit. Final message: what you built; test counts per package; branch and sha; the equivalence
check result; unused keys allowlisted or removed; call-site edits outside your paths (plurals,
module-scope `t()`); the namespaces created empty; contract requests (exact diffs); proposed
README/PROGRESS text (including a replacement for `apps/web/README.md:71`, which still says keys
come from `src/i18n/en.ts`; that file is the orchestrator's); the `#` grouping change for gift
totals of 1,000 or more; and the exact commands for the user to see it live: sign in as a seeded
user and `me.update({ locale: "en-XA" })`, or set the cookie `commonair-locale=en-XA` in the
browser, reload, and every visible string is bracketed and accented; `bun harness/src/cli.ts run e2e-basic`
still passes in English.
