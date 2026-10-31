<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N2-weblate: the translation workflow on Hosted Weblate

You are implementing N2-weblate for CommonAir (repo: this checkout). Read AGENTS.md, PLAN.md,
[ADR 0029](../../../docs/decisions/0029-i18n.md) decision 7, [`batch5/README.md`](../batch5/README.md)
(decisions (a), (h), the glossary), `apps/web/src/i18n/README.md`, `packages/email/README.md` and
`packages/email/src/messages/NOTES.md`, `packages/ui/src/locales/`, CONTRIBUTING.md and REUSE.toml.
You may read Weblate's public documentation (docs.weblate.org) for exact setting names; nothing
else outside the repository. Wave 2, branch `n2/weblate`. Docs only: CC-BY-SA-4.0 with SPDX headers.

## You own (write only these)

- `docs/maintainers/translations.md` (new), `docs/translators/**` (new),
  `docs/maintainers/translation-glossary-es.csv` (new; REUSE covers `*.csv` only if annotated —
  check, and if not, put an SPDX header line Weblate's CSV glossary format tolerates, or report a
  `REUSE.toml` contract request)

## Build

1. **`docs/maintainers/translations.md`** — the maintainer's runbook, exact enough to follow
   click by click:
   - Applying for the Hosted Weblate libre plan (what the application asks, the project's answers:
     AGPL-3.0-or-later, public repo, contributors), and the fallback (self-hosted Weblate for the
     project, not for instances; ADR 0029).
   - Installing the Weblate GitHub app / integration on `abolishus/commonair`, push branch
     (`weblate`), PR mode, merge style, and that PRs pass the same CI gate.
   - **Components**, one per file group, with file mask, monolingual base file, format (JSON
     nested-off / "JSON file"), new-translation template, and license: one component per web
     namespace (`apps/web/src/i18n/locales/*/<ns>.json`, base `en/<ns>.json`, AGPL-3.0-or-later),
     `ui` (`packages/ui/src/locales/*/ui.json`), one per email group
     (`packages/email/src/messages/locales/*/<group>.json`). Recommend component discovery
     (Weblate's "component discovery" addon) with the regex that matches all three trees so new
     namespaces appear without manual setup. Note: no docs components yet (docs strings are
     CC-BY-SA-4.0 when added).
   - **Checks and flags**: ICU MessageFormat check enabled on every component (`icu-message-format`
     flag) with the subset's limits (no `number`/`date` arguments); placeholders check; the e7-dmca
     sworn-statement keys marked `read-only` (list them — take the list from N2-es-a's report in
     the batch README or `git log`; if absent, find them in `en/e7-dmca.json`) with an explanation.
   - **DCO**: commit message template that adds `Signed-off-by: {{ author }}`; the contributor
     agreement text (the DCO 1.1 text, linked) that translators accept; Weblate's commit author
     settings.
   - **Uploading the agent draft (decision (a))**: upload each `es` file with "Processing of
     strings needing edit" → mark as needing edit (exact option names), so every draft string is
     reviewed; how to see review progress.
   - **Glossary**: a glossary component from `translation-glossary-es.csv`; how to keep it in sync
     with the batch README table (the CSV is the source after this unit).
   - Adding a language (it is a directory of JSON files; Weblate's "Start new translation"), what
     CI checks (`i18n:check`, parity, `REQUIRED_LOCALES` only for released locales), and how a
     maintainer reviews a Weblate PR.
2. **`docs/translators/README.md`** (+ one page per topic if it grows): for volunteers — where to
   translate, the message format with examples (placeholders, plurals with `#`, select, quoting
   apostrophes), style (the Spanish rules from the batch README, generalised with a per-language
   section), what not to translate (brand names, `{placeholders}`, read-only legal statements),
   screenshots-free.
3. **`translation-glossary-es.csv`** in Weblate's CSV glossary format (source,target[,explanation]),
   from the batch README table plus terms the wave-1 units reported.

## Tests you must add

None (docs). Run `reuse lint` and `vp fmt` on the markdown. The orchestrator adds the
`docs/README.md` rows and any CONTRIBUTING pointer.

## Done means

`git status` shows only your paths. Commit with `git commit -s`. Final message: what you wrote,
branch + sha, contract requests (`REUSE.toml`, `docs/README.md`, CONTRIBUTING lines), and the exact
steps the user must take (libre plan application, GitHub integration).
