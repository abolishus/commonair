<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# N2 web ↔ test contract (cookie consent)

N2-consent (batch 3, wave 3) builds the cookie consent banner and the cookie settings dialog the
cookie policy promises (`packages/db/src/legal/cookies.md`; ADR 0029 decision 3: the signed-out
locale cookie is a Preferences cookie). The web app and its tests agree on these `data-testid`
values. Changing one is a contract change: update this file, the web app and its tests together.
After N2-consent merges, `apps/web/tests/selectors.test.ts` checks the ids below against the web
source.

## Rules

- Tests select by `data-testid`, never by visible text (which is translated). State is exposed in
  `data-*` attributes, never read from text or classes.
- No harness scenario uses these ids yet. The banner sits in the page flow, never over content, so
  existing scenarios need no change.
- No Preferences cookie (theme, locale, sidebar state) is written before the visitor allows
  preferences.

## Routes

None new. The banner and the dialog appear on every page except `/overlay/*` and `/embed/*`.

## Test ids

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

## Language switchers (batch 5)

N2-switcher fills the `/settings/preferences` page and the footer switcher the batch 5 contract
step mounted (`.claude/briefs/batch5/README.md` decisions (e)–(g)). `en-XA` never appears as an
option. Templated ids (`<tag>` is a supported locale tag such as `es`) are checked by the unit's
render tests; `apps/web/tests/selectors.test.ts` checks the literal ones and the template prefixes.

| Test id                      | Element and attributes                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `preferences-page`           | The page container of `/settings/preferences` (members only)                                                                |
| `locale-select`              | The Language `Select` trigger on the page; `data-value` = the saved choice (`auto` when `users.locale` is null, else a tag) |
| `locale-option-auto`         | The "Automatic" item (save `users.locale` = null)                                                                           |
| `locale-option-<tag>`        | One item per supported locale except `en-XA`; its label carries `lang="<tag>"`                                              |
| `locale-save-status`         | Polite live region announcing the save; `data-state` = `idle`, `saving`, `saved` or `error`                                 |
| `footer-locale-switcher`     | The footer's language menu trigger (every page); `data-locale` = the active locale                                          |
| `footer-locale-option-<tag>` | One menu item per supported locale except `en-XA`; its label carries `lang="<tag>"`                                         |
