<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N2-pseudo: `e2e-basic` under `en-XA` with a literal scanner, and an `es` smoke step

You are implementing N2-pseudo for CommonAir (repo: this checkout). Read AGENTS.md, PLAN.md,
docs/architecture.md, [ADR 0029](../../../docs/decisions/0029-i18n.md) decision 6,
[`batch5/README.md`](../batch5/README.md) decision (k), `apps/web/src/i18n/README.md` ("Locales":
`en-XA`, the `commonair-locale` cookie), `packages/i18n/src/pseudo.ts` (the exact pseudo format),
`harness/README.md` and `harness/scenarios/e2e-basic.ts`. Do not look outside the repository.
Wave 2, branch `n2/pseudo`.

## You own (write only these)

- `harness/scenarios/e2e-basic.ts`
- `harness/src/n2/**` (new) and their tests (`harness/src/n2/*.test.ts`)
- `harness/src/web/session.ts`: **one additive option only** — `locale?: string` on whatever
  creates the browser context, which sets the `commonair-locale` cookie for the web origin (and
  `Accept-Language` when asked). Every other scenario's behaviour stays identical when it is absent.

## Contracts you must honor (read-only for you)

- `ctx.param(name, default)` (`--set locale=en-XA`), `ctx.step`, `ctx.assert`, `ctx.data`
  (`harness/src/scenario.ts`); selectors only by test id (`docs/testing/e1-selectors.md`).
- The pseudo format from `pseudoLocalize` (`@commonair/i18n`); import it rather than re-deriving it.
- Not yours: `harness/src/{shards,registry,kit,platform}.ts`, CI. The orchestrator registers the
  `locale=en-XA` run at the milestone.

## Build

1. **`--set locale=<tag>`** (default: none, today's behaviour). Every browser session the scenario
   opens (streamer, fan, anon in WebKit) gets the cookie. The API-only steps are unchanged. Steps
   that read visible text (the nav username, any `toHaveText`) keep working: compare against values
   the scenario created, not English strings; fix any step that would only pass in English.
2. **Literal scanner** (`harness/src/n2/literals.ts`, pure function + a Playwright wrapper):
   collect visible text nodes and the accessible names/placeholders/`aria-label`s of interactive
   elements; drop text inside known user content (values the scenario created: usernames, channel
   names, chat messages, stream titles, the instance name from bootstrap, URLs, stream keys, numbers,
   dates and times); flag any remaining run of 3+ unaccented ASCII letters that is not inside a
   pseudo-localized segment. Under `locale=en-XA`, run it on each page the scenario visits (sign-up,
   dashboard, channel page signed in and anonymous, offline state) as a step
   (`"<who>: no untranslated text on <page>"`), asserting zero hits and attaching the hits
   (text, selector path) to the report via `ctx.data` on failure. A short allowlist with a reason per
   entry (e.g. `OBS`, `RTMP`, `HLS` if they appear as product names).
3. **`es` smoke step** (always runs under `locale=en-XA`, cheap): a fresh anonymous context with
   `Accept-Language: es` and no cookie loads `/`, asserts `<html lang="es" dir="ltr">` and that the
   footer license text equals the `es` catalog's `footer.license` (read the JSON from
   `apps/web/src/i18n/locales/es/core.json`), and that a `en-XA` cookie wins over the header.
4. Report: `ctx.data("locale", tag)` and the scanner's page count.

## Tests you must add

- `literals.test.ts`: a pseudo-localized string passes; an English literal is flagged; user content
  and allowlisted terms are ignored; mixed nodes (`[Ŝéţţîñĝš] Settings`) flag only the English;
  numbers/dates/URLs ignored. Fixtures built with the real `pseudoLocalize`.
- A unit test that the session option sets the cookie for the web origin only (mock context).

## Done means

Per `.claude/briefs/_done-means.md` — **do not run the scenario** (no stack): harness unit tests
(`cd harness && bun run test`), `tsc -p harness`, `vp lint --deny-warnings`, `vp fmt` on changed
paths, `reuse lint`. `git status` shows only your paths. Commit with `git commit -s`. Final message:
what you built, test counts, branch + sha, contract requests (shard registration line, anything in
`kit.ts`/`platform.ts`), anything left undone, and the exact command for a live run:
`bun harness/src/cli.ts run e2e-basic --set locale=en-XA`.
