<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Batch 5: the rest of N2

Batch 5 of [`.claude/briefs/next/README.md`](../next/README.md): the rest of milestone N2
([`next/N2-i18n-weblate.md`](../next/N2-i18n-weblate.md), [ADR 0029](../../../docs/decisions/0029-i18n.md)).
Already on `main` from batch 3: the N2 contract step, N2-core (`@commonair/i18n`, JSON catalogs,
negotiation, lazy load, `en-XA`, the logical-CSS check) and N2-consent. This batch adds the
Spanish catalogs, locale-aware design-system strings and formatting, email catalogs in JSON, the
language switchers, the RTL conversion of `packages/ui`, the Weblate setup and the pseudo-locale
harness run. Briefs: [`n2/`](../n2/) (the batch 3 files `contract-step.md`, `N2-core.md` and
`N2-consent.md` are history). Planned at `c80f9f6` (2026-10-31).

## Decisions (2026-10-31)

"User" rows are the user's answers of 2026-10-31; "orchestrator" rows are defaults recorded as
decided (the user may reopen any of them).

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                  | Where                                           | By           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------ |
| a   | Spanish is drafted by agents now, against the glossary below, so `es` is at 100% this batch. When Weblate is set up, every `es` string is uploaded as **needs editing**, so human translators review all of them                                                                                                                                                                          | N2-es, N2-ui, N2-email, N2-switcher, N2-weblate | user         |
| b   | Arabic (`ar`) is not in this batch (ADR 0029 decision 5: next). Batch 5 still makes `packages/ui` logical (N2-rtl) and adds RTL unit tests with an injected `ar` fixture, so `ar` later is only a catalog                                                                                                                                                                                 | N2-rtl                                          | user         |
| c   | `UiMessages` live in `packages/ui/src/locales/<lang>/ui.json` (flat keys, the ICU subset) and are built into `UiMessages` by `packages/ui` through `@commonair/i18n`; `packages/ui` gains that workspace dependency in the contract step                                                                                                                                                  | contract step, N2-ui                            | orchestrator |
| d   | Email catalogs live in `packages/email/src/messages/locales/<lang>/<group>.json` (flat `block.field` keys, the ICU subset), every locale bundled (email renders on the server only); `packages/email` gains the `@commonair/i18n` dependency in the contract step                                                                                                                         | contract step, N2-email                         | orchestrator |
| e   | The settings switcher lives on a new **`/settings/preferences`** page (a Language section; theme can move there later). Members can pick "Automatic" (`users.locale` = null, so the cookie, `Accept-Language` and the instance default apply)                                                                                                                                             | contract step, N2-switcher                      | orchestrator |
| f   | The footer switcher is in every footer (`InstanceFooter`). Signed out, it calls `rememberLocale` (cookie only with Preferences consent, else this tab); signed in, it also saves `users.locale` through `me.update`                                                                                                                                                                       | N2-switcher                                     | orchestrator |
| g   | `en-XA` never appears in a switcher (reach it with the cookie or `me.update`, as today)                                                                                                                                                                                                                                                                                                   | N2-switcher                                     | orchestrator |
| h   | Legal documents (`packages/db/src/legal/*.md`) stay English in N2 (counsel); the UI around them is translated. The DMCA and counter-notice **sworn statements** in `e7-dmca` keep their English text in `es` (copied verbatim) because they are statutory attestations; N2-weblate marks them read-only                                                                                   | N2-es (es-a), N2-weblate                        | orchestrator |
| i   | Discord go-live posts stay in English (they go to a public server, not a person, and have no locale); a follow-up, not scheduled                                                                                                                                                                                                                                                          | none                                            | orchestrator |
| j   | The contract step adds an **argument-parity check** (a translation uses exactly English's argument names, with the same plural/select/selectordinal kinds) and a **coverage** function to `@commonair/i18n/catalog`; `apps/web/tests/i18n.test.ts` runs parity on every locale now and requires 100% coverage for the locales in `REQUIRED_LOCALES`, which the milestone sets to `["es"]` | contract step, milestone                        | orchestrator |
| k   | `e2e-basic` takes `--set locale=<tag>`. Under `en-XA` a page-text scanner fails on visible text that is not pseudo-localized (outside known user content); an `es` smoke step checks `<html lang="es">` and one translated string. CI runs `e2e-basic --set locale=en-XA` in the shard that runs `e2e-basic`                                                                              | N2-pseudo, milestone                            | orchestrator |
| l   | No new third-party dependency in this batch. Language names come from `Intl.DisplayNames` through `formatLanguageName` in `packages/ui/src/lib/format.ts` (added by the contract step)                                                                                                                                                                                                    | contract step                                   | orchestrator |
| m   | Any unit that adds an English key adds its `es` translation in the same change (N2-switcher's `n2-switcher`, N2-ui's `ui.json`, N2-email's catalogs); the three N2-es units cover every web namespace that exists at the contract step's sha                                                                                                                                              | all units                                       | orchestrator |

## Contract step

One commit on `main`, pushed, CI green before wave 1: [`n2/batch5-contract-step.md`](../n2/batch5-contract-step.md).
No migration, no env var, no API contract change (`me.update` already takes `locale`, nullable).
It adds the `@commonair/i18n` dependency to `packages/ui` and `packages/email`, the parity and
coverage checks, `formatLanguageName`, the `/settings/preferences` placeholder page with its nav
entry, the `n2-switcher` namespace, the footer switcher mount, and `docs/testing/n2-selectors.md`
rows for the switchers.

## Waves

At most six units at a time; two agents never write the same file at the same time.

| Wave | Units (parallel)                                            | Starts from                | Why this order                                                                                                                                                                                                            |
| ---- | ----------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | N2-ui, N2-email, N2-switcher, N2-es-a, N2-es-b, N2-es-c (6) | the contract step's sha    | disjoint paths; the three es units only write `locales/es/**` of the namespaces they own; N2-ui changes the design system's strings and formatting before N2-rtl touches the same files' classes                          |
| 2    | N2-rtl, N2-weblate, N2-pseudo (3)                           | `main` after wave 1 merged | N2-rtl converts the 36 baseline files in `packages/ui`, several of which N2-ui edits in wave 1; N2-weblate documents components that exist only after wave 1 (ui and email JSON); N2-pseudo runs on the finished catalogs |

Between waves the orchestrator merges each unit, applies contract requests and pushes `main`.

## Path ownership

| Unit        | Owns (write only these)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N2-ui       | `packages/ui/src/lib/{messages.ts,locale.tsx,format.ts}`, `packages/ui/src/locales/**` (new), `packages/ui/src/blocks/forms/{amount-field,date-of-birth-field}.tsx`, `packages/ui/src/blocks/coop/{statement,tally-table}.tsx`, `packages/ui/src/blocks/data/{progress-row,breakdown}.tsx`, `packages/ui/src/components/chart.tsx`, `packages/ui/src/index.ts` (exports only), new `packages/ui/tests/{ui-messages,intl-policy}*.test.ts(x)`, `packages/ui/tests/format*.test.ts`, `apps/web/src/lib/relays.ts`, `apps/web/src/i18n/{index,catalogs}.ts`, `apps/web/tests/i18n-runtime.test.ts`, new `apps/web/tests/{intl-policy,ui-messages}*.test.ts` |
| N2-email    | `packages/email/src/**` (templates only where they read strings or need a plural argument), `packages/email/tests/**`, `packages/email/scripts/**`, `packages/email/README.md`, `packages/email/package.json` (`scripts` only)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| N2-switcher | `apps/web/src/routes/_app/settings.preferences.tsx` (content), `apps/web/src/components/locale/**`, `apps/web/src/i18n/locales/{en,es}/n2-switcher.json`, `apps/web/src/i18n/keys/n2-switcher.gen.ts`, new `apps/web/tests/locale-switcher*.test.tsx`                                                                                                                                                                                                                                                                                                                                                                                                    |
| N2-es-a     | `apps/web/src/i18n/locales/es/{coop,safety,ops,e7-dmca}.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| N2-es-b     | `apps/web/src/i18n/locales/es/{core,money,e8-studio,e8-viewer,support}.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| N2-es-c     | `apps/web/src/i18n/locales/es/{e9-console,e9-consent,e7-admin,w1-fraud,w1-breakdown,n1-inbox,w1-watch-gate,w1-calm-chat,e7-appeals,n1-discord,w1-data-mode,n2-consent,p2p,n1-pwa,n1-email,e7-chat,e7-legal}.json`                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| N2-rtl      | every `packages/ui/src/**` file listed in `apps/web/tests/logical-css.baseline.json` (class names only), `apps/web/tests/logical-css.baseline.json` (deleted), `apps/web/tests/logical-css.test.ts`, new `packages/ui/tests/rtl*.test.tsx`, new `apps/web/tests/i18n-rtl.test.ts`                                                                                                                                                                                                                                                                                                                                                                        |
| N2-weblate  | `docs/maintainers/translations.md` (new), `docs/translators/**` (new), `docs/maintainers/translation-glossary-es.csv` (new)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| N2-pseudo   | `harness/scenarios/e2e-basic.ts`, `harness/src/n2/**` (new) and their tests, one additive `locale?` option in `harness/src/web/session.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Orchestrator only: `packages/i18n/**` (after the contract step), `apps/web/tests/{i18n,nav,selectors}.test.ts`,
`keys/index.gen.ts`, `core.json` (en), `nav.ts`, `site-chrome.tsx`, `__root.tsx`, the route tree,
`package.json` files and `bun.lock`, `REUSE.toml`, `docs/testing/*`, `docs/README.md`, CONTRIBUTING,
`harness/src/{shards,registry,kit,platform}.ts`, CI, PROGRESS, ADRs, READMEs (N2-ui may update
`apps/web/src/i18n/README.md`'s `UiMessages` line; N2-email writes `packages/email/README.md` if one
exists).

Conflicts checked: N2-ui's seven block files are in the logical-CSS baseline, so N2-rtl waits for
wave 2; no es unit writes `en/`; N2-switcher's new keys go to its own namespace, so the es units
never see them; `i18n:gen` regenerates only `keys/n2-switcher.gen.ts` for N2-switcher and nothing
for the es units (keys come from English).

## Spanish style and glossary (binds every unit that writes `es`)

- **One `es` for all regions**: neutral Latin American Spanish, understandable in Spain. No
  `vosotros`, no regional slang. Address the reader as **tú**. Sentence case, like the English.
- **Inclusive without symbols**: prefer neutral constructions ("el equipo de moderación",
  "quien modera", "las personas que ven"); never `@`, `x` or `-e` endings.
- **Keep** every `{placeholder}` and ICU construct exactly as in English (argument names, plural
  categories; write `one` and `other` and keep any `=0`/`=1`; Spanish's `many` (exact millions)
  falls back to `other`, which is correct, so never write it). Do not translate brand
  names (`CommonAir` comes from `{instance}`, `Hosted Weblate`, `Stripe`, `Discord`, `Twitch`, `OBS`).
- **Length**: Spanish runs ~20–30% longer; prefer the shorter natural phrasing for buttons and labels.
- **Glossary** (English → Spanish; N2-weblate publishes it as the Weblate glossary):

| English                        | Spanish                                      | English               | Spanish                                 |
| ------------------------------ | -------------------------------------------- | --------------------- | --------------------------------------- |
| stream (noun) / broadcast      | transmisión                                  | go live / live        | transmitir en vivo / en vivo            |
| streamer                       | streamer                                     | channel               | canal                                   |
| viewer(s)                      | espectador / espectadores                    | verified viewers      | espectadores verificados                |
| follow / follower              | seguir / seguidor                            | chat                  | chat                                    |
| clip                           | clip                                         | VOD / recording       | video bajo demanda (VOD) / grabación    |
| stream key                     | clave de transmisión                         | relay                 | relay (nodo de retransmisión)           |
| co-op / cooperative            | cooperativa                                  | member (co-op)        | miembro                                 |
| patronage / patronage dividend | retorno cooperativo                          | council               | consejo                                 |
| proposal / vote / election     | propuesta / voto / elección                  | treasury / treasurer  | tesorería / tesorero (rol: tesorería)   |
| subscription / subscribe       | suscripción / suscribirse                    | support (pay)         | apoyar                                  |
| payout                         | liquidación                                  | ledger                | libro contable                          |
| fee                            | comisión                                     | refund                | reembolso                               |
| moderator / moderation         | moderador / moderación                       | ban / timeout         | bloqueo permanente / expulsión temporal |
| block (a user)                 | bloquear                                     | report (noun / verb)  | denuncia / denunciar                    |
| appeal                         | apelación                                    | takedown              | retirada                                |
| statement of reasons           | declaración de motivos                       | integrity             | integridad                              |
| poll / prediction              | encuesta / predicción                        | raid                  | raid                                    |
| goal                           | meta                                         | channel points        | puntos del canal                        |
| bot / command / timer          | bot / comando / temporizador                 | overlay               | overlay (superposición)                 |
| sign in / sign up / sign out   | iniciar sesión / registrarse / cerrar sesión | settings              | configuración                           |
| notification(s)                | notificación / notificaciones                | instance              | instancia                               |
| studio                         | estudio                                      | dashboard             | panel                                   |
| developer console / app        | consola de desarrolladores / aplicación      | token / scope         | token / permiso                         |
| webhook                        | webhook                                      | Calm Chat             | Chat en calma                           |
| data mode                      | modo de ahorro de datos                      | watch gate (verified) | filtro de visualización verificada      |
| mature (18+)                   | para adultos (18+)                           | cookie preferences    | preferencias de cookies                 |

A unit that needs a recurring term not in the table picks one, uses it consistently, and lists it
in its final message; the orchestrator adds it here and N2-weblate's CSV takes the merged table.

## Shared rules

- Units are told "read and implement `<brief>`", one git worktree each, branch `n2/<unit>`
  (`n2/ui`, `n2/email`, `n2/switcher`, `n2/es-a`, `n2/es-b`, `n2/es-c`, `n2/rtl`, `n2/weblate`,
  `n2/pseudo`). `git commit -s`, Conventional Commits, the `Co-Authored-By` trailer. Copy `.env`
  into the worktree root (`bun scripts/init-env.ts --merge` there if VAPID keys are missing) and
  `bun install` if needed.
- Pipeline per unit: implement → independent reviewer (diff vs AGENTS.md, this README and the
  brief; for es units a reviewer fluent in Spanish who checks a sample of at least 150 strings
  per unit against the glossary, every ICU message and every placeholder) → the implementer's fix pass.
- Targeted checks only (`.claude/briefs/_done-means.md` and each brief): package tests, `tsc`,
  `vp lint --deny-warnings` and `vp fmt` on changed paths, `vp build` for web units, `reuse lint`,
  and for web catalog changes `cd apps/web && bun run i18n:check && bun --bun vp test run tests/i18n.test.ts`.
  Never `bun run verify`, `verify:full`, `podman compose`, `scripts/infra.ts` or a harness scenario.
  **CI on `main` is the gate.** The user runs every browser and visual check.
- Contract requests (exact diffs) go to the orchestrator. No unit creates a namespace, edits
  `keys/index.gen.ts`, an English catalog it does not own, or a shared contract file.

## Milestone checks (N2 done means)

- `REQUIRED_LOCALES = ["es"]` in `apps/web/tests/i18n.test.ts`; web, `ui.json` and email `es` at
  100% with argument parity; `bun run i18n:check` clean.
- `apps/web/tests/logical-css.baseline.json` gone; the check covers all of `packages/ui/src` at zero.
- Plural tests (`packages/i18n`, email and `ui.json` plurals) and RTL tests (N2-rtl) pass.
- `e2e-basic --set locale=en-XA` passes in CI with the literal scanner, including the `es` smoke step.
- n2 selectors check covers the switcher ids; `docs/README.md` rows for the new docs; PROGRESS.
- **End of batch**: CI green on `main` with every job, including the full harness shards.

## Open items

For the orchestrator: land the contract step; after wave 1, merge the glossary additions the
units report into the table above before N2-weblate starts; at the milestone, register the
`locale=en-XA` run in `harness/src/shards.ts` and add `REQUIRED_LOCALES`.

For the user (none blocks the waves):

- Apply for the Hosted Weblate libre plan and install its GitHub integration once N2-weblate's
  `docs/maintainers/translations.md` lands (it lists every setting).
- Visual checks under `es` and `en-XA` (truncation, 320 px, dark and light) and a quick read of
  the Spanish by a fluent speaker before announcing it.
- Counsel, later: whether translated legal documents are wanted (decision (h)).

## After batch 5: W2

Plan W2 ([`next/W2-feature-wave.md`](../next/W2-feature-wave.md), including the deferred chat
replay UI) as batch 6 the same way. No W2 unit starts before batch 5 is merged and green.
