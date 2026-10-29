<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N2 contract step (orchestrator)

Small, and for the two N2 units in batch 3: N2-core (wave 1) and N2-consent (wave 3; added
2026-10-29, its part is §6.1 and §6.2). The rest of N2 is a later batch. The orchestrator lands it on
`main` as one commit (`feat(n2): contract step`) **after the E8 and E9 contract steps** and
before wave 1, then gives that sha to N2-core as its base. Everything below was checked against
`c0c16fd` (2026-10-29); line numbers are from that commit, so recheck them on top of E8's and
E9's steps (both edit `router.ts`, `entities.ts`, `env.ts` and `.env.example`; this step only
appends). Plan: `.claude/briefs/next/N2-i18n-weblate.md`. ADR: `docs/decisions/0029-i18n.md`
(accepted 2026-10-27). Units: `.claude/briefs/n2/N2-core.md`, `.claude/briefs/n2/N2-consent.md`.

## 0. Placement and migration number

- **A separate step, landed third.** It touches the same shared files as E8 and E9
  (`packages/contracts/src/api/{router,entities}.ts`, `packages/config/src/env.ts`,
  `.env.example`), so it goes on top of E9's step, as E9's goes on top of E8's. It is not folded
  into either: it is a different milestone with its own review, and nothing in E8 or E9 depends
  on it. (Fallback if the orchestrator prefers fewer commits: append §1-§7 to the end of E9's
  step unchanged; the migration number rule below still holds.)
- **Migration number: the next free one after E9's.** E8's step takes `0033_e8_interactivity.sql`
  and `0034_e8_protections.sql` (e8/contract-step.md §2.4); E9's takes one,
  `0035_e9_developer_platform.sql` (e9/contract-step.md header). So N2 takes **`0036`**.
  Rule if either step changed its count: one more than the highest file in `packages/db/drizzle/`
  after E9's step lands. Generate
  it then (drizzle-kit chains snapshots, so it must be generated on top of E9's snapshot, never
  in parallel). Below it is written `00NN_n2_users_locale.sql`.
- **No protections migration.** No trigger reads `users.locale`
  (`0007_users_identity_immutable.sql:39` guards `birth_date, account_type, username`;
  `0016_trust_safety_protections.sql:246` `users_t0_guard` fires on every `UPDATE` but only
  refuses changes to the T0 suspension columns, so the migration's `UPDATE` passes it), and the
  column is not append-only. The tag format is enforced in the database by a `CHECK` in the
  generated schema migration (§3.1), like `ledger_accounts_currency_format`
  (`src/schema/ledger.ts:31`), so a client of the app role cannot store a malformed tag that the
  mail and web negotiation would then have to guard against (AGENTS.md rule 9 spirit: the
  lowest layer that can enforce it).

## 1. Config (`packages/config`, `.env.example`)

### 1.1 `src/env.ts`

Add to `coreShape` after `INSTANCE_IS_FLAGSHIP` (:39), so every service and the web server
(`webEnvSchema` extends `coreEnv`, `apps/web/src/server/env.ts:20`) get it:

```ts
  /**
   * Language for anyone who has not chosen one and whose browser asks for none we have (ADR 0029):
   * the web app's last fallback, and the language of mail to members with no `users.locale`.
   * A BCP 47 tag such as `en` or `es`; a tag the web has no catalog for falls back to English.
   */
  INSTANCE_DEFAULT_LOCALE: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$/, "a BCP 47 tag such as en or pt-BR")
    .default("en"),
```

`instanceSite()` (:575-594): add `defaultLocale: env.INSTANCE_DEFAULT_LOCALE,` after `isFlagship`.

### 1.2 `src/site.ts`

`InstanceSite` (:44-57): add after `isFlagship` (:56):

```ts
/** `INSTANCE_DEFAULT_LOCALE`: the language for users and visitors who have not chosen one. */
defaultLocale: string;
```

The only object literal of this type outside `instanceSite()` is
`services/api/tests/legal.test.ts:10-17`: add `defaultLocale: "en",`. (Other tests build sites
with `instanceSite()` via `packages/email/tests/fixtures.ts:7` `testSite` or `siteAt`, or cast:
`services/worker/tests/moderation-sor.test.ts:606`, which needs nothing.)

### 1.3 `.env.example`

After `INSTANCE_IS_FLAGSHIP=false` (:16):

```
INSTANCE_DEFAULT_LOCALE=en
```

`packages/config/tests/env.test.ts:35` (the sync test) then passes. Add to that file: the default
is `en`; `es`, `pt-BR` and `en-XA` parse; `english`, `EN`, `en_US` and `e` are refused;
`instanceSite(loadEnv(coreEnv, { INSTANCE_DEFAULT_LOCALE: "es" })).defaultLocale === "es"`.

### 1.4 Generated files

Run and commit the output of `bun scripts/selfhost/unit-env.ts` (every
`infra/selfhost/env/commonair-*.keys` gains `INSTANCE_DEFAULT_LOCALE`) and
`bun scripts/config-reference.ts` (the generated table in `docs/self-hosting/configuration.md`).
`selfhost.sh install` needs no flag: operators set it in `commonair.env` like `INSTANCE_NAME`.

## 2. Contracts (`packages/contracts/src/api`)

### 2.1 `entities.ts`

Next to `Me` (:32-44), before it:

```ts
/** A BCP 47 language tag as the platform stores it (`en`, `es`, `pt-BR`; `en-XA` is the pseudo-locale). */
export const LocaleTag = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$/);
```

In `Me`, after `shareEmailWithFollowedChannels` (:40):

```ts
  /** The language the member chose; null = not chosen, so the web negotiates (ADR 0029). */
  locale: LocaleTag.nullable(),
```

### 2.2 `router.ts`

`me.update` input (:113-118): replace `locale: z.string().max(10).optional(),` with

```ts
          /** A language tag, or null to clear the choice (back to browser and instance defaults). */
          locale: D.LocaleTag.nullable().optional(),
```

(`D` is how `router.ts` already imports entities, `router.ts:41` `import * as D from
"./entities.ts"`; use whatever alias the file has after E9.)
No new procedure, no event (a language choice is not a side effect for other systems), no rate
limit change, no scope change. No audit row either: it is the member's own preference, not a
moderator, admin, integrity or governance action.

### 2.3 Tests

`packages/contracts/tests/contract.test.ts`: `LocaleTag` accepts `en`, `es`, `pt-BR`, `en-XA`,
`zh-Hant` and refuses `english`, `EN`, `en_US`, `e`, `""`; `Me` parses with `locale: null` and
refuses a `Me` without `locale`.

## 3. Database (`packages/db`; follow `.claude/skills/schema-change/SKILL.md`)

### 3.1 Schema

`src/schema/auth.ts:41`: replace `locale: text().notNull().default("en"),` with

```ts
    /** Chosen language (BCP 47); null = never chosen: the web negotiates, mail uses INSTANCE_DEFAULT_LOCALE (ADR 0029). */
    locale: text(),
```

and in the table's extra config (`(t) => [ … ]`, :49-53 at `c0c16fd`), after
`index("users_bot_owner_idx")`, the same pattern as `LocaleTag` (keep the two in sync; a null
passes a `CHECK`):

```ts
    check("users_locale_format", sql`${t.locale} ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$'`),
```

(`check` joins the `drizzle-orm/pg-core` import at :10; `sql` is already imported.)

### 3.2 Migration

`cd packages/db && bunx drizzle-kit generate --name n2_users_locale` → `00NN_n2_users_locale.sql`
(number per §0). Check that drizzle wrote exactly the two `ALTER COLUMN` statements and the
`ADD CONSTRAINT`, then append the data change (before committing; the file is not yet
published). Existing rows hold only `'en'` (the old default; nothing else ever wrote the column
outside `me.update`, which already enforced this pattern), so the constraint validates:

```sql
ALTER TABLE "users" ALTER COLUMN "locale" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "locale" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_locale_format" CHECK ("users"."locale" ~ '^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$');--> statement-breakpoint
-- ADR 0029: null means "not chosen". No UI ever wrote this column and 'en' was only the default,
-- so every 'en' is a default, not a choice (no instance serves non-English users yet).
UPDATE "users" SET "locale" = NULL WHERE "locale" = 'en';
```

### 3.3 Tests

`packages/db/tests/n2.int.test.ts` (new, `createTestDatabase()`): a user inserted without
`locale` has `null`; `locale = 'es'` round-trips; the app role can set and clear it; the app
role's `UPDATE … SET locale = 'english'` (and `'EN'`, `'en_US'`) fails with the
`users_locale_format` check violation (SQLSTATE `23514`); a pre-existing `'en'` row becomes `null`
after the migration (insert it before migrating if the helper allows, else assert the `UPDATE`
statement is in the migration file). Existing
expectations to update: `services/api/tests/auth.int.test.ts:144` (`locale: "en"` →
`locale: null`; the attempt to set `{ locale: "de" }` through `/update-user` at :127 must still
leave it `null`).

## 4. Readers of `users.locale`: null means the instance default, not English

One rule, enforced in one place: **the email renderer resolves a missing locale to
`site.defaultLocale`**, so every sender passes the column as it is and none of them can fall back
to English by accident.

- `packages/email/src/render.tsx:14`: `locale?: string | null | undefined;` and its comment
  ("null or unset: the instance default, `site.defaultLocale`"); `:104`:
  `resolveCatalog(opts.locale ?? opts.site.defaultLocale, opts.catalogs)`.
- `packages/email/src/mailer.ts:20`: `SendProps` `{ locale?: string | null | undefined }`.
- `services/api/src/auth/index.ts:140`: drop `defaultValue: "en"` from the better-auth
  `locale` additional field (keep `required: false, input: false`), or sign-up would write `en`
  again. `localeOf` (:55) already maps a non-string to `undefined`: no change.
- `services/worker/src/deletion/account-deletion.ts:172-175`: `Notice.locale: string | null`.
- Type-only (they pass `u.locale` straight to `mailer.send`; confirm each compiles and leave a
  one-line test where the file already has mail tests): `services/api/src/routes/me.ts:87-94`,
  `services/api/src/lib/leaks.ts:66-79`, `services/api/src/routes/appeals.ts:560-573`,
  `services/api/src/dmca/mail.ts:57-72`, `services/worker/src/exports/build.ts:183-188`,
  `services/worker/src/dmca/restore.ts:329-341`,
  `services/worker/src/moderation/sor-deliver.ts:167-195`. The data export
  (`services/worker/src/exports/collectors.ts:67`) exports `null` as is (correct: "not chosen").
- Before committing, `grep -rn "users.locale\|\.locale\b" services packages --include=*.ts` and
  check no new reader appeared in E8's or E9's step.

Tests: `packages/email/tests/mailer.test.ts`: `locale: null` with `testSite({ INSTANCE_DEFAULT_LOCALE: "es" })`
and an `es` catalog renders Spanish (`outgoing.locale === "es"`); with no `es` catalog it renders
English (`"en"`); an explicit `locale: "en"` wins over the default. (`testSite` takes env
overrides, `packages/email/tests/fixtures.ts:7`.)

## 5. API (`services/api/src/routes/me.ts`)

- `loadMe` (:54-81): add `locale: u.locale,` after `shareEmailWithFollowedChannels`.
- `update` (:118-130): the contract validates the tag now; replace :124-127 with
  `if (input.locale !== undefined) set.locale = input.locale;` (null clears).
- `services/api/tests/me-locale.int.test.ts` (new): `me.get` returns `locale: null` for a new
  account; `me.update({ locale: "es" })` → `"es"`; `{ locale: null }` → `null`; `"english"` →
  400; `"en-XA"` is accepted (the pseudo-locale is a valid tag; the web decides what it serves).

## 6. Cookie policy (`packages/db/src/legal/cookies.md`, `packages/db/src/legal/index.ts`)

ADR 0029 decision 3: the signed-out locale cookie is a Preferences cookie. Replace the
Preferences paragraph (:37-40) with:

```md
If you allow preferences, we remember settings on your device so you do not have to set them
again: theme, language, player volume and quality, chat display options and similar. If you
decline, the site still works and uses defaults on each visit; a language you pick is then kept
only in this browser tab's own storage and is gone when you close the tab. Signed-in users'
account settings, including their language, are stored on the server as part of their account,
not in this category.
```

A published version is immutable and the seed never rewrites a row, so bump
`COOKIES_SEED_VERSION` to `"2026-10-29-i18n-draft"` (sorts after `"2026-10-27-p2p-draft"`; the
cookie policy needs no acceptance). **This step lands after E8's, and E8's §12 has already
changed this file**: it added `TERMS_SEED_VERSION = "2026-10-29-points-draft"` and bumped
`PRIVACY_SEED_VERSION` to `"2026-10-29-interact-draft"`, split the shared comment (:25-30 at
`c0c16fd`) so each constant has its own, and added `terms` to the seed test's `own` map. Leave
`TERMS_SEED_VERSION` and `PRIVACY_SEED_VERSION` exactly as E8 left them (no second bump: nothing
in N2 changes the terms or the privacy policy). Re-find `COOKIES_SEED_VERSION` by name, not by
`c0c16fd` line number, and give it its own comment saying the cookie policy took its own version
for the peer-to-peer section (ADR 0005 amendment 1) and moved again for the language line (ADR
0029); draft, counsel has not reviewed it. `packages/db/tests/seed.int.test.ts`: the version
table (:31-46 at `c0c16fd`, E8's `own` map with `terms`) follows the constants, the
`COOKIES_SEED_VERSION > LEGAL_SEED_VERSION` check stays, and add
`expect(body("cookies")).toMatch(/language/)`. Before committing, `git grep -n "SEED_VERSION"
-- packages services harness apps` and check nothing else pins the old cookies version.

The consent UI the policy promises (the footer cookie-settings link, a banner, and consent
gating of the theme and locale cookies, `apps/web/src/lib/theme.ts:19` sets the theme cookie
without consent today) is built in batch 3 wave 3 by **N2-consent**
(`.claude/briefs/n2/N2-consent.md`; decided 2026-10-29). `legal.consent` exists
(`router.ts:2571`) and nothing in `apps/web` calls it yet. N2-core still never writes the locale
cookie on its own (N2-core "Negotiation": `rememberLocale(tag, { preferencesAllowed })`);
N2-consent supplies `preferencesAllowed`. This step adds two things for it (§6.1, §6.2).

### 6.1 The `n2-consent` namespace

Add **`n2-consent`** (unit N2-consent, wave 3, key prefix `consent.`) to the "i18n namespaces"
list N2-core creates empty (§8; `.claude/briefs/batch3/README.md` already lists it). No existing
key uses the `consent.` prefix (checked at `c0c16fd`).

### 6.2 `docs/testing/n2-selectors.md` (write it; N2-consent builds against it)

CC-BY-SA-4.0 header, the same shape as `docs/testing/e9-selectors.md` (Rules, Routes, Test ids),
so the orchestrator can add an n2 check to `apps/web/tests/selectors.test.ts` after N2-consent
merges. Rules: select only by `data-testid`; state in `data-*`; no harness scenario uses these
yet (the banner is in the page flow, never over content, so existing scenarios need no change).
Routes: none new (the banner and dialog appear on every page except `/overlay/*` and
`/embed/*`). Test ids:

| Test id                      | Element and attributes                                                                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `consent-banner`             | The banner (a labelled `region`), shown while no current choice is stored; `data-reason` = `none` (no choice yet) or `policy-changed` (stored for an older cookie policy version) |
| `consent-accept-all`         | Banner button: allow preferences                                                                                                                                                  |
| `consent-reject`             | Banner button: essential only                                                                                                                                                     |
| `consent-customize`          | Banner button: opens `consent-dialog`                                                                                                                                             |
| `consent-dialog`             | The cookie settings dialog; `data-policy-version` = the cookie policy version it records                                                                                          |
| `consent-category`           | One row per category in `CONSENT_CATEGORIES`, `data-category` (`essential`, `preferences`), `data-checked` (`true`/`false`), `data-locked` (`true` for `essential`)               |
| `consent-toggle-preferences` | The Preferences switch                                                                                                                                                            |
| `consent-save`               | Dialog button: save the choices shown                                                                                                                                             |
| `consent-policy-link`        | Wrapper around the `LegalDocumentLink` of the `cookies` document (`legal.get({ kind: "cookies" })`), which opens the policy text in a nested dialog; there is no `/legal` route   |
| `consent-error`              | Inline notice when the record could not be saved to the server (the choice still applies on this device); `data-code` (`rate_limited`, `network`, `policy_changed`)               |
| `footer-cookie-settings`     | Footer button that opens `consent-dialog`                                                                                                                                         |

## 7. `packages/i18n` scaffold and the web dependency

The workspace must exist before N2-core so the lockfile change is the orchestrator's (AGENTS.md
"Shared lockfile"). No third-party dependency (ADR 0029 decision 1).

- `packages/i18n/package.json`:

```json
{
  "name": "@commonair/i18n",
  "version": "0.0.0",
  "private": true,
  "license": "AGPL-3.0-or-later",
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "bun --bun vp test run --exclude '**/*.int.test.ts' --passWithNoTests",
    "typecheck": "tsc -p ."
  },
  "devDependencies": {
    "@types/bun": "catalog:",
    "typescript": "catalog:",
    "vite-plus": "catalog:"
  }
}
```

- `packages/i18n/tsconfig.json`: as `packages/safe-regex/tsconfig.json` (`types: ["bun"]`,
  `lib: ["es2024", "dom"]`, `include: ["src", "tests"]`).
- `packages/i18n/src/index.ts`: SPDX header (AGPL) and
  `/** ICU subset formatter, plural rules, locale negotiation and catalog tooling (ADR 0029). N2-core fills this. */ export {};`
- `apps/web/package.json` `dependencies`: `"@commonair/i18n": "workspace:*"` (alphabetical, after
  `@commonair/contracts`). Then `bun install` and commit `bun.lock`. The web image picks it up
  through `infra/containers/closure.ts` (workspace closure); nothing else to change.
- `REUSE.toml` needs nothing: `**/*.json` (catalogs included) is already annotated AGPL, and
  N2-core's generated `.gen.ts` files carry their own header.

## 8. Coordination with the E8 and E9 contract steps

- E8's and E9's steps add inline keys to `apps/web/src/i18n/en.ts` as E7's did (E8 §8:
  `studio.interact`, `studio.bot`; E9 §7.4: `studio.developer`, `nav.connections`,
  `nav.adminApps`); N2-core moves them into the `core` namespace. Neither creates a per-unit
  TypeScript catalog: their web units get JSON namespaces, which N2-core creates empty (`{}`).
  The five names, from the E8, E9 and N2 briefs: `e8-studio`, `e8-viewer` (wave 2), `e9-consent`,
  `e9-console`, `n2-consent` (wave 3). `.claude/briefs/batch3/README.md` does not exist at
  `c0c16fd`; the orchestrator creates it with an "i18n namespaces" list holding these five before
  N2-core starts (E8's step §10 and §13 name the E8 two, E9's step §7.4 the E9 two, §6.1 here
  `n2-consent`; the batch README carries all five). If a TS placeholder catalog was created anyway, N2-core converts it into a namespace of
  the same name.
- E8-viewer also deletes `overlay.goalsLater` and `overlay.chatLater` from the namespace N2-core
  puts them in (`ops`, from `ops.ts:129,131`), so it rewrites `locales/en/ops.json` and
  `keys/ops.gen.ts` in wave 2. N2-core's recipe allows exactly that (rule 5's exception); no other
  unit touches `ops`.
- E8/E9 web units (waves 2 and 3) start from a base that contains N2-core and follow the
  namespace recipe in `.claude/briefs/n2/N2-core.md` ("How to add a namespace"), including its
  logical-CSS rule for new `packages/ui/src` files (E8-studio's `blocks/interact-studio/**`,
  E8-viewer's `blocks/interact-viewer/**`).

## 9. Shared-file rules for N2-core (repeated in its brief)

| Shared thing                                                                                         | Resolution                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/**`, `packages/db/**`, `packages/config/**`, `.env.example`, `packages/email/**` | This step only. N2-core reads them                                                                                                                                                                                                                            |
| `packages/i18n/**`                                                                                   | N2-core (the scaffold is here). It adds no dependency                                                                                                                                                                                                         |
| `apps/web/src/i18n/**`, `apps/web/tests/i18n*.test.ts`                                               | N2-core in wave 1. From wave 2 a unit writes only its own `locales/en/<namespace>.json` and `keys/<namespace>.gen.ts` (plus E8-viewer's two `ops` deletions, §8)                                                                                              |
| `apps/web/package.json`                                                                              | This step adds the dependency; N2-core may change only `scripts`                                                                                                                                                                                              |
| `bun.lock`                                                                                           | This step                                                                                                                                                                                                                                                     |
| `apps/web/src/routeTree.gen.ts`, nav, router                                                         | Nobody in N2-core (no route)                                                                                                                                                                                                                                  |
| `packages/ui/**`                                                                                     | Nobody in N2-core (N2-ui later): it passes the active locale to the existing `LocaleProvider`. In wave 2 E8-studio and E8-viewer add new block directories (`blocks/interact-studio/**`, `blocks/interact-viewer/**`; strings as props, no `UiMessages` keys) |
| `packages/db/src/legal/*.md`                                                                         | This step (§6) only                                                                                                                                                                                                                                           |
| Harness scenarios, `FULL_REQUIRED`, selectors docs                                                   | Nothing for N2-core: it has no scenario. `e2e-basic` under `en-XA` is the N2 milestone gate, after the other N2 units                                                                                                                                         |
| READMEs, PROGRESS.md, HANDOFF.md, ADR 0029                                                           | Orchestrator. N2-core proposes text in its final message                                                                                                                                                                                                      |

## 10. Done means for the contract step

CI is the gate (no local `verify`). Before pushing: `bun --bun vp test run` in `packages/config`,
`packages/contracts`, `packages/email`, `packages/db` (and `test:int`), `services/api` (and
`test:int`, not at the same time as another package's), `services/worker` (and `test:int`: the
deletion, export, DMCA-restore and statement-of-reasons mail paths read `users.locale`); `bunx tsc -p` for each
plus `apps/web` and `packages/i18n`; `bun scripts/selfhost/unit-env.ts --check`;
`bun scripts/config-reference.ts --check`; `vp fmt` and `vp lint --deny-warnings` on the changed
paths. Push, watch CI green, record N2-core under "In flight" in PROGRESS.md, make sure
`.claude/briefs/batch3/README.md` lists the five i18n namespaces (§8), `docs/testing/n2-selectors.md` exists (§6.2), and hand N2-core its brief
and this commit's sha.
