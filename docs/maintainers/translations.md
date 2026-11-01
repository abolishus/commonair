<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# Translations on Hosted Weblate

How maintainers run CommonAir's translation workflow. The decision is
[ADR 0029](../decisions/0029-i18n.md) decision 7: the project translates on Hosted Weblate's gratis
plan for libre projects, and translations reach the repository only as pull requests that pass the
same CI gate as any other. Volunteers read [docs/translators/](../translators/README.md); this page
is the setup and the routine around it.

Setting names below are Weblate's own labels (docs.weblate.org, Weblate 5.x). Where a screen may
differ on Hosted Weblate on the day you do this, the step says so: check the label, keep the value.

## What gets translated

Every catalog is flat JSON (`"prefix.area.name": "Message"`) in a small ICU MessageFormat subset
([`apps/web/src/i18n/README.md`](../../apps/web/src/i18n/README.md)). English is the source; keys are
only ever added in English, in code.

| Tree          | Files                                                     | Components                   |
| ------------- | --------------------------------------------------------- | ---------------------------- |
| Web app       | `apps/web/src/i18n/locales/<lang>/<namespace>.json`       | one per namespace (27 today) |
| Design system | `packages/ui/src/locales/<lang>/ui.json`                  | one (`ui`)                   |
| Email         | `packages/email/src/messages/locales/<lang>/<group>.json` | one per group (8 today)      |
| Glossary      | `docs/maintainers/translation-glossary-<lang>.csv`        | one glossary component       |

About 3,300 source strings in all. Not in Weblate: the legal documents
(`packages/db/src/legal/*.md` stay English, batch 5 decision (h)), Discord go-live posts, and the
docs (no docs components yet; when they come, docs strings are CC-BY-SA-4.0, not AGPL).

All catalogs are licensed AGPL-3.0-or-later, like the code they ship in; `REUSE.toml` annotates
`**/*.json`. The glossary CSV is CC-BY-SA-4.0, like the rest of `docs/`.

## 1. Apply for the libre plan

Hosted Weblate's Libre plan is free for public libre projects and has the limits of its 160k plan
(hosted strings are source strings times languages, so about 45 languages at today's size).

1. Sign in at <https://hosted.weblate.org/> (create an account; use the maintainer identity that
   should own the project, with two-factor authentication on).
2. Open <https://hosted.weblate.org/hosting/> and choose the **Libre** plan. The form asks about the
   project; answer:
   - **Project name**: CommonAir. **Slug**: `commonair`.
   - **Website**: the project's site from `SITE` (`packages/config/src/site.ts`).
   - **Repository**: `https://github.com/abolishus/commonair` (public).
   - **License**: AGPL-3.0-or-later for the code and the translation catalogs; CC-BY-SA-4.0 for the
     documentation and the glossary.
   - **Description / why libre hosting**: a cooperative, community-owned live streaming platform;
     all code is AGPL-3.0-or-later, developed in public, contributions under the DCO; translations
     are open to any volunteer and reach the repository as reviewed pull requests.
   - **Contributors**: the maintainers listed in `GOVERNANCE.md`; translators are volunteers.
3. Wait for approval (the Weblate team reviews libre requests by hand). Until then the project runs
   on a trial; do the rest of this page during the trial, it carries over.

**If the libre plan is refused or withdrawn**: self-host Weblate for the project, not for
instances (ADR 0029). Every setting below is the same on a self-hosted Weblate; only the
GitHub connection differs (use the "GitHub pull request" backend with a bot token, step 2).
Record the change in an ADR amendment.

## 2. Connect GitHub

Use the **Hosted Weblate GitHub app**; it needs no SSH key, no `weblate` collaborator and no
webhook.

1. In Weblate, open the workspace (billing) that holds the project and use **Connect GitHub
   account**.
2. Install the [Hosted Weblate app](https://github.com/apps/hosted-weblate) on the `abolishus`
   organization with **Only select repositories** → `abolishus/commonair`. Nothing else.
3. Components imported through the app use the version control system **GitHub (via Weblate GitHub
   app)**; their repository URL is read-only.

Then, on the main component (step 3) under **Version control**:

| Setting                  | Value                                                                    |
| ------------------------ | ------------------------------------------------------------------------ |
| Repository branch        | `main`                                                                   |
| Push branch              | `weblate` (Weblate pushes there and opens one pull request from it)      |
| Push on commit           | on                                                                       |
| Age of changes to commit | `24` hours (batches a day's work into one PR update)                     |
| Merge style              | **Rebase** (the `weblate` branch stays a straight line on top of `main`) |
| Lock on error            | on                                                                       |

Check after the first push that the component's **Repository maintenance** page shows a pull request
(not a direct push to `main`). Without the app (self-hosted fallback): **Version control system** =
**GitHub pull requests**, **Push branch** = `weblate`, a bot token with contents and pull-request
write access in `GITHUB_CREDENTIALS`, and a repository webhook to `<weblate>/hooks/github/` (push
events only).

**The pull request** runs `ci.yml` like any other (it triggers on `pull_request`): format, lint,
typecheck, unit tests (catalog parse, argument parity, coverage), `reuse lint`, the rest of the gate.
A broken message cannot merge.

**Merging it**: use **Create a merge commit**, not squash (Weblate's own advice: squashing rewrites
its commits, and its next rebase conflicts). This is the one exception to CONTRIBUTING's
squash-merge rule; if the repository disallows merge commits or requires linear history, allow
merge commits first. Never install Weblate's **Squash Git commits** add-on: each translator's commit
carries their own sign-off.

**Release notes**: `scripts/release/changelog.ts` reads `git log --no-merges` over the whole range,
so a merged Weblate PR would add one "Chores" entry per translator commit. Until the script skips
them (a pending change: `--first-parent`, or dropping `chore(i18n)` commits it reaches only through
a merge), trim those lines from the generated notes by hand and keep one "Translations updated"
line.

## 3. Components

Create one component by hand, then let **Component discovery** create the rest.

### The main component: `web: core`

**Add new translation component**, import `abolishus/commonair` (branch `main`) through the connected
GitHub account, then:

| Setting                           | Value                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| Component name / slug             | `web: core` / `web-core`                                                                           |
| Source language                   | English                                                                                            |
| File format                       | **JSON file** (`json`). Not "JSON nested structure file": our keys contain dots and must stay flat |
| File mask                         | `apps/web/src/i18n/locales/*/core.json`                                                            |
| Monolingual base language file    | `apps/web/src/i18n/locales/en/core.json`                                                           |
| Edit base file                    | off (English changes only in code)                                                                 |
| Template for new translations     | empty (a new language starts as `{}`; copying English would count as translated)                   |
| Adding new translation            | **Create new language file**                                                                       |
| Language code style               | **BCP style using hyphen as a separator** (`pt-BR`, matching our tags)                             |
| Language filter                   | `^[^.]+$` (the default)                                                                            |
| Manage strings                    | off (keys come from code)                                                                          |
| Translation license               | AGPL-3.0-or-later                                                                                  |
| Contributor license agreement     | the DCO text (section 5)                                                                           |
| Translation flags                 | `icu-message-format` (section 4)                                                                   |
| Translation quality filter        | **Commit all translations regardless of quality** (section 6: required)                            |
| Commit and merge request messages | section 5                                                                                          |

File format parameters (in the component's file format settings; they replaced the old "Customize
JSON output" add-on): **JSON indentation** `2`, **JSON indentation style** Spaces, **Sort JSON keys**
Do not sort, **Avoid spaces after separators** off. Our files are formatted by Oxfmt; check the
first Weblate PR's `verify (static)` job. If it fails on format alone, adjust these parameters
until Weblate's output matches `vp fmt`, rather than reformatting the `weblate` branch by hand.

### Add-ons on the main component

1. **Cleanup translation files**: removes keys from translations when they leave the English base
   file. The catalog check fails on orphan translations, so this is required.
2. **Component discovery** (`weblate.discovery.discovery`), one regular expression for all three
   trees:

   **Regular expression to match translation files against**:

   ```text
   (?P<tree>apps/web/src/i18n|packages/ui/src|packages/email/src/messages)/locales/(?P<language>[^/.]+)/(?P<component>[^/.]+)\.json
   ```

   **Customize the component name**:

   ```text
   {{ tree|cut:"/src/i18n"|cut:"/src/messages"|cut:"/src"|cut:"apps/"|cut:"packages/" }}: {{ component }}
   ```

   | Setting                                                         | Value                                                    |
   | --------------------------------------------------------------- | -------------------------------------------------------- |
   | File format                                                     | JSON file                                                |
   | Define the monolingual base filename                            | `{{ tree }}/locales/en/{{ component }}.json`             |
   | Define the base file for new translations                       | empty                                                    |
   | Language filter                                                 | `^[^.]+$`                                                |
   | Clone add-ons from the main component to the newly created ones | on (each component gets Cleanup)                         |
   | Remove components for inexistent files                          | on (a namespace deleted in code disappears from Weblate) |

   The name template yields `web: e7-dmca`, `ui: ui`, `email: account` and so on; the slug follows
   (`web-e7-dmca`). The preview lists every match before you confirm: expect 27 `web:`, 1 `ui:` and
   8 `email:` components and no others. A namespace added later (by the orchestrator, in code)
   appears on the next repository update with no manual setup.

3. Open two discovered components (one `ui:`, one `email:`) and check that they inherited the
   license, agreement, flags, quality filter, commit messages and version control settings. Fix any
   that did not on the main component and re-run discovery.

### Per-tree differences

- **`ui: ui`**: a new language also needs one line in `UI_CATALOGS`
  (`packages/ui/src/lib/messages.ts`); until it is there the app uses English design-system strings
  for that language. The maintainer adds it in the Weblate PR or a follow-up.
- **`email: *`**: every directory under `packages/email/src/messages/locales/` must be listed in
  `BUNDLED` (`packages/email/src/messages/bundled.ts`) and must have all eight group files, or the
  email tests fail. Set **Adding new translation** on the eight email components to **Contact
  maintainers** (check the label on the day; it may read "Contact maintainers for new languages"),
  and add an email language in a maintainer PR (the eight files from **Start new translation**, then
  the `BUNDLED` line).

## 4. Checks and flags

- **ICU MessageFormat** on every component: **Translation flags** = `icu-message-format`. It parses
  each translation and compares it with the English: placeholders missing from or added to the
  translation (its `missing` and `extra` sub-checks are the placeholder check; do not add a
  separate `placeholders:` flag, whose regex would misfire on plural branches), placeholder types
  (`types`), sub-message selectors and the required `other`. Leave every `icu-flags:` sub-check on;
  we use no XML tags, so no `xml`.
- **Our subset is narrower than ICU**: no `number`, `date`, `time` or other typed arguments, only
  `{name}`, `plural` (with `offset:` and `#`), `select` and `selectordinal`. Weblate accepts typed
  arguments as valid ICU, but its `types` sub-check reports one that the English lacks, and CI's
  catalog check rejects it as a syntax error. Tell translators the rule; CI is the hard stop.
- **Plural categories**: a translation uses its own language's categories (Polish `one few many
  other`, Japanese only `other`). If Weblate reports a correct set of categories as a selector
  mismatch, dismiss it. CI checks argument names and kinds (`plural`, `select`, `selectordinal`),
  not categories. For this reason do not put the ICU checks under **Enforced checks**: an enforced
  check cannot be dismissed.
- **Read-only sworn statements** (batch 5 decision (h)). Four messages in `web: e7-dmca` are the
  statutory attestations of 17 U.S.C. § 512(c)(3)(A) and § 512(g)(3) that a person signs under
  penalty of perjury. They stay in English in every language (the `es` file holds the English text
  verbatim) because a translated attestation is a different statement nobody has reviewed:

  | Key                              | What it is                                                  |
  | -------------------------------- | ----------------------------------------------------------- |
  | `dmca.goodFaith`                 | notice: good-faith belief the use is unauthorised           |
  | `dmca.accuracy`                  | notice: accuracy and authority, under perjury               |
  | `copyright.counter.goodFaith`    | counter-notice: mistake or misidentification, under perjury |
  | `copyright.counter.jurisdiction` | counter-notice: consent to jurisdiction and service         |

  On `web: e7-dmca` install the **Bulk edit** add-on with **Query**
  `key:dmca.goodFaith OR key:dmca.accuracy OR key:copyright.counter.goodFaith OR key:copyright.counter.jurisdiction`
  and source **Add flags** `read-only`. A source flag applies to every language, present and future,
  and the add-on re-applies it on each component update. Also add an explanation on each of the four
  source strings (**Edit** next to the explanation): "Statutory attestation; stays in English
  (legal). Do not translate."
  A new language starts without these four; when it becomes a required locale, a maintainer copies
  the English text into its `e7-dmca.json` in a normal PR.

- **Explanations**: the email notes in
  [`packages/email/src/messages/NOTES.md`](../../packages/email/src/messages/NOTES.md) are written
  to be pasted as source string explanations (**Edit** next to the explanation). Bulk edit cannot
  set explanations, so add them string by string, starting with the `layout.*` and legal rows.

## 5. DCO: sign-offs and the agreement

Every commit in the repository is signed off under the
[Developer Certificate of Origin 1.1](https://developercertificate.org/) (CONTRIBUTING.md).
Weblate commits each author's changes separately with the translator as the Git author, so the
template adds the translator's own sign-off, and the agreement makes them accept the DCO first.

**Contributor license agreement** (project default and every component): this intro, then the DCO
1.1 text pasted verbatim from <https://developercertificate.org/> (its terms allow verbatim copies):

> CommonAir is free software (AGPL-3.0-or-later). Your translations are licensed under the same
> license, and you keep your copyright. Each translation you save is committed to the repository
> with a `Signed-off-by` line in your name and commit email, which certifies the Developer
> Certificate of Origin below.
>
> _(the full DCO 1.1 text)_

**Commit message** (component setting; `author` is "Name <email>" and exists only in this scope):

```text
chore(i18n): translate {{ component_name }} into {{ language_name }}

Currently translated at {{ stats.translated_percent }}% ({{ stats.translated }} of {{ stats.all }} strings)

Translation: {{ project_name }}/{{ component_name }}
Translate-URL: {{ url }}
Signed-off-by: {{ author }}
```

**Add message** (a new language file, also authored by the translator who started it):

```text
chore(i18n): add {{ language_name }} to {{ component_name }}

Signed-off-by: {{ author }}
```

**Delete message** (removing a language, done by a maintainer):

```text
chore(i18n): remove {{ language_name }} from {{ component_name }}

Signed-off-by: {{ author }}
```

If Weblate leaves `{{ author }}` empty in this template, delete commits are reviewed like add-on
commits (section 9, step 2).

**Add-on message**: `chore(i18n): {{ addon_name }} on {{ component_name }}` (mechanical commits by
Weblate itself, such as the cleanup add-on; they carry no authored content, and the maintainer who
merges the PR vouches for them). **Merge request message**: title
`chore(i18n): translations from Hosted Weblate`, body with the component list Weblate fills in.

**Commit author**: Weblate uses each translator's full name and commit email from their profile
(**Profile → Account → Commit e-mail**; translators may pick Weblate's private address). The
sign-off and the author always match.

## 6. Upload the agent draft for review

Batch 5 decision (a): the Spanish catalogs were drafted by agents against the glossary, so `es` is
at 100% in the repository. Every one of those strings must be reviewed by a person. Weblate reads
the `es` files from the repository when the components are created, as **Translated**; mark them
all **Needs editing** once, right after discovery and before announcing the project:

1. **Translation quality filter** must be **Commit all translations regardless of quality** on every
   component (section 3). With "Skip translations marked as needing editing", Weblate would drop
   every draft string from the `es` files on its next commit and CI's `es` coverage check would
   fail.
2. Project **CommonAir → Tools → Bulk edit** (project-wide; or per component if the project-level
   tool is not offered):
   - **Query**: `language:es AND state:translated AND NOT component:glossary AND NOT key:dmca.goodFaith AND NOT key:dmca.accuracy AND NOT key:copyright.counter.goodFaith AND NOT key:copyright.counter.jurisdiction`
     (`NOT component:glossary` keeps the Spanish glossary terms, which are maintained in the CSV and
     reviewed in its own PRs, out of the draft review and out of the count in step 4.)
   - **State to set**: **Needs editing**
   - **Add labels**: `agent draft` (create the label first under **Project → Labels**), so the draft
     stays findable after review.
3. Equivalent per file, if you prefer upload: **Files → Upload translation** on each `es`
   translation with the repository's own `es` file, **Import method** **Add as translation
   needing edit**, **Conflict handling** **Change translated strings**. (JSON has no fuzzy marker
   of its own, so **Strings needing edit** has no effect here.) Bulk edit does the same in one step.
4. Check: **Project → Languages → Spanish** shows about 3,300 strings needing editing and 0
   translated outside the glossary (besides the four read-only ones; the `glossary` component's
   roughly 150 Spanish terms stay translated). After the next repository update the count must
   not drop; if it did, Weblate re-read the files as translated and step 2 runs again.

**Following review**: the Spanish language page's **Needs editing** column, per component; the
search `language:es state:needs-editing` lists what is left, `label:"agent draft" AND NOT
state:needs-editing` what has been reviewed. A reviewer who saves a string (changed or not) makes
it Translated. Once the project has two or more trusted Spanish reviewers, turn on **Enable
reviews** (project) and give them the reviewer role, so reviewed strings become Approved.

Strings that arrive from code after this (decision (m): a unit that adds an English key adds its
`es` translation) come in as Translated. Until the orchestrator retires decision (m), run the bulk
edit again with `language:es AND state:translated AND changed:>=<date of the previous run>` after
each such merge, or review them in the code PR.

## 7. The glossary

The Spanish glossary is [`translation-glossary-es.csv`](translation-glossary-es.csv), a bilingual
CSV with the header `source,target,developer_comments` (the third column shows to translators as
the term's note). After this page lands, **the CSV is the source**: the term table in the batch 5
README is history, and new terms are added to the CSV (by PR, or in Weblate, which commits back to
it).

1. **Add new translation component** → same repository, then:
   - **Component name** `glossary`, **File format** **CSV file**, **File mask**
     `docs/maintainers/translation-glossary-*.csv`, no monolingual base file, source language
     English, **Use as a glossary** on, **Manage strings** on, **Translation license**
     CC-BY-SA-4.0, the same agreement, commit messages and quality filter.
   - **Adding new translation**: **Create new language file** (a translator can start a glossary for
     their language; Weblate writes `translation-glossary-<lang>.csv`).
2. Bulk edit on the glossary, **Query** `language:es`: source **Add flags** `terminology`, so every
   term exists in every glossary language.
3. Brand names that are never translated (Hosted Weblate, Stripe, Discord, Twitch, OBS): Bulk edit
   with `source:"Stripe" OR …`, source **Add flags** `read-only` ("untranslatable for all
   languages").
4. Weblate then highlights glossary terms in every component's editor for Spanish.

A new glossary file needs licensing for `reuse lint`: `REUSE.toml` annotates
`docs/maintainers/translation-glossary-*.csv` as CC-BY-SA-4.0 (a CSV cannot carry a header line that
Weblate would not read as a term).

## 8. Adding a language

1. A translator (or a maintainer) opens the project and uses **Start new translation** on a
   component; Weblate creates `<tree>/locales/<lang>/<file>.json` as `{}` and fills it as people
   translate. For the web app that is all: a directory of JSON files is a supported, negotiable
   locale with no code change.
2. `ui.json` needs its `UI_CATALOGS` line and email its `BUNDLED` line and all eight files (section
   3).
3. Right-to-left languages (Arabic, Hebrew, Persian): direction comes from the locale, not a
   string; the design system is logical-CSS (N2-rtl). Ask for a visual check under the new language
   before release.
4. Announce a language when it is complete and reviewed. Making it **required** (every key present)
   is adding it to `REQUIRED_LOCALES` in `apps/web/tests/i18n.test.ts` (orchestrator); only released
   locales go there, so a language in progress never blocks CI.

**What CI checks on a Weblate PR**:

- `cd apps/web && bun run i18n:check` (every message parses, keys unique, generated key types
  fresh; a translation never changes them, since keys come from English);
- `apps/web/tests/i18n.test.ts`: every locale's messages parse, no orphan keys, argument parity
  with English (same argument names, same `plural`/`select`/`selectordinal` kinds), 100% coverage
  for `REQUIRED_LOCALES`;
- the `packages/ui` and `packages/email` tests: the same parity, `es` at 100%, every email locale
  bundled and complete;
- format (`vp fmt --check`), `reuse lint`, and the rest of the gate.

## 9. Reviewing a Weblate pull request

1. CI green. A red catalog test names the key and locale: fix it in Weblate (the string's page),
   not on the branch, so Weblate does not conflict with itself; the PR updates on the next commit.
   Use **Repository maintenance → Commit** and **Push** to hurry it.
2. Every commit has a `Signed-off-by` matching its author (add-on commits, and delete commits whose
   sign-off came out empty, excepted; see section 5).
3. Only paths under the three `locales/` trees and the glossary CSVs change. Anything else is a
   configuration mistake: close the PR and fix the component.
4. Spot-check a few strings against the glossary and [docs/translators/](../translators/README.md),
   especially any that touch money, legal text or safety. Read-only keys must be unchanged.
5. **Create a merge commit** (section 2).

If `main` changed the same catalog (a developer added keys and their `es` text), Weblate rebases
its branch on its next update. On a conflict it locks the component and shows it under **Repository
maintenance**: merge the open Weblate PR first, then **Update** the component; as a last resort
**Reset** it (pending translations not yet committed are lost, so commit first).

## Checklist for the first setup

- [ ] Libre plan requested (section 1); project `commonair` created.
- [ ] Hosted Weblate app installed on `abolishus/commonair` only (section 2).
- [ ] `web: core` created with every setting in section 3; JSON parameters set.
- [ ] Cleanup and Component discovery add-ons; 36 components discovered and spot-checked.
- [ ] Agreement, commit templates, `icu-message-format`, quality filter on every component.
- [ ] Bulk edit add-on on `web: e7-dmca` for the four read-only keys; explanations added.
- [ ] Glossary component from the CSV; `terminology` and brand `read-only` flags.
- [ ] Bulk edit: `es` → Needs editing, label `agent draft`; counts checked.
- [ ] First Weblate PR: CI green (format included), merged with a merge commit.
- [ ] Translators page linked from the project's **Instructions** (`docs/translators/README.md`)
      and the engage page (`https://hosted.weblate.org/engage/commonair/`) shared.
