<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E7 web ↔ harness contract (platform debts)

The E7 units (DMCA, held chat messages over HTTP, account-action appeals, the admin pages, co-op
gaps and pending legal documents) and their harness scenarios agree on these routes and
`data-testid` values. Changing one is a contract change: update this file, the web app and the
scenarios together. Tests select by `data-testid` (never by visible text, which is translated).
`harness/src/e7/selectors.ts` lists the ids and `harness/tests/e7/selectors.test.ts` checks them
against this file.

## Rules

- Tests select by `data-testid`, never visible text. Option items follow `<field>-<value>`.
- DMCA records (claimant name, email, address, phone, signatures, counter-notice text) live only
  on the mutable `dmca_*` rows: never in logs, audit `details`, events or `account_actions`.
  Audit and events carry ids, enums and counts.
- Test hooks: `POST /internal/moderation/dmca-tick` (`{ asOf }`, behind `INTERNAL_API_SECRET`, only
  while `MODERATION_TEST_HOOKS=true`, otherwise 404): the API enqueues `dmca-restore` with that
  `asOf`, waits (30 s) and returns `DmcaRestoreResult`. Nothing else shortens the waiting period.

## Routes

| Route                 | Purpose                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `/dmca`               | New, public: the DMCA notice form (§ 512(c)(3)(A)); linked from the footer and the DMCA policy         |
| `/settings/copyright` | New, signed in: notices about your content, their items, and the counter-notice form (§ 512(g)(3))     |
| `/admin/dmca`         | New, platform moderators: the DMCA queue, notice detail, action or reject, counter-notices, suit filed |
| `/admin/integrity`    | New, admins: integrity flags with filters, decide (excluded or allowed)                                |
| `/admin/egress`       | New, admins: egress by delivery source and by broadcast for a range                                    |
| `/admin/incidents`    | New, admins: open and update status-page incidents                                                     |
| `/$channel`           | Chat panel: the held-message queue for the broadcaster and channel moderators                          |
| `/settings/appeals`   | Account actions about you (DMCA strikes, termination) with an appeal button                            |
| `/coop/membership`    | Rejoin the viewer class after an exit, when a subscription qualifies                                   |
| `/coop/council`       | Board elections: nominate and vote (was read-only)                                                     |

## Test ids

### DMCA notice (`/dmca`)

| Test id            | Element / meaning                                                                                                                                                                                                                                                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dmca-form`        | The form; fields `dmca-name`, `dmca-email`, `dmca-address`, `dmca-phone` (optional), `dmca-work` (the copyrighted work), `dmca-urls` (one URL per line, 1–50), `dmca-good-faith` and `dmca-accuracy` (checkboxes; the second is "under penalty of perjury"), `dmca-signature`, the ALTCHA widget wrapper `dmca-altcha` (`data-state="verified"` once solved), `dmca-submit` |
| `dmca-receipt`     | Replaces the form on success: `data-notice-id`                                                                                                                                                                                                                                                                                                                              |
| `footer-dmca-link` | In the site footer, a link to `/dmca`                                                                                                                                                                                                                                                                                                                                       |

### Your content (`/settings/copyright`)

| Test id                  | Element / meaning                                                                                                                                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `account-copyright-link` | In the account menu, a link to `/settings/copyright`                                                                                                                                                                                                               |
| `copyright`              | Page wrapper; `copyright-empty` `<EmptyState>`                                                                                                                                                                                                                     |
| `copyright-notice`       | One notice: `data-notice-id`, `data-status`; contains `copyright-item` rows (`data-item-id`, `data-subject-type`, `data-subject-id`, `data-removed` and `data-restored` as `true`/`false`)                                                                         |
| `counter-open`           | Opens the counter-notice dialog (only while the notice has removed, unrestored items of yours and no counter-notice)                                                                                                                                               |
| `counter-form`           | The dialog: `counter-name`, `counter-address`, `counter-phone`, `counter-item-<itemId>` (checkbox per removed item, all checked by default), `counter-statement`, `counter-good-faith`, `counter-jurisdiction` (checkboxes), `counter-signature`, `counter-submit` |
| `counter-receipt`        | On the notice after filing: `data-counter-id`, `data-restore-after` (ISO), `data-restored` (`true`/`false`), `data-suit-filed` (`true`/`false`)                                                                                                                    |

### DMCA queue (`/admin/dmca`)

| Test id          | Element / meaning                                                                                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dmcaq`          | Page wrapper; status filter `dmcaq-status` with items `dmcaq-status-<status>` (`DMCA_STATUSES`); `dmcaq-empty`                                                                      |
| `dmcaq-item`     | One notice row (opens the detail): `data-notice-id`, `data-status`, `data-items`, `data-resolved-items`                                                                             |
| `dmcaq-detail`   | Detail: `data-notice-id`, `data-status`; `dmcaq-item-row` per item (`data-item-id`, `data-subject-type`, `data-subject-id`, `data-owner-id`, `data-removed-at`, `data-restored-at`) |
| `dmcaq-strikes`  | Per item owner: `data-user-id`, `data-strikes`, `data-repeat-infringer` (`true` at or over `DMCA_RULES.repeatInfringerStrikes`)                                                     |
| `dmcaq-decision` | `<ChoiceToggle>` items `dmcaq-decision-actioned`, `dmcaq-decision-rejected`; `dmcaq-note`; `dmcaq-submit` (a `ConfirmDialog` for `actioned`)                                        |
| `dmcaq-counter`  | One counter-notice: `data-counter-id`, `data-restore-after`, `data-restored-at`, `data-suit-filed-at` (empty when null); `dmcaq-suit-note`, `dmcaq-suit-filed` (`ConfirmDialog`)    |

### Held messages (`/$channel` chat panel; broadcaster and channel moderators only)

| Test id           | Element / meaning                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `held-queue-open` | Button in the chat header: `data-count` (held messages waiting); absent for everyone else                 |
| `held-queue`      | The panel; `held-queue-empty` `<EmptyState>`                                                              |
| `held-message`    | One held message: `data-id` (the chat message id), `data-username`; contains `held-allow` and `held-deny` |

An allowed message then appears to everyone as `chat-message` with the same `data-id`; a denied one
leaves the queue and is never shown to viewers.

### Account actions (`/settings/appeals`)

| Test id                      | Element / meaning                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `account-action`             | One action: `data-action-id`, `data-action` (`ACCOUNT_ACTIONS`), `data-reversed` (`true`/`false`) |
| `account-action-appeal-open` | Opens the appeal dialog (unreversed actions without an open appeal)                               |
| `account-appeal-dialog`      | `account-appeal-body` (10–5000), `account-appeal-submit`                                          |

`appeal-row` (e4c) gains `data-kind`.

### Integrity (`/admin/integrity`)

| Test id             | Element / meaning                                                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integrityq`        | Page wrapper; filters `integrityq-subject` (items `integrityq-subject-<type>`), `integrityq-decision` (items `integrityq-decision-<decision>`), `integrityq-channel` (slug input); `integrityq-empty` |
| `integrityq-item`   | One flag: `data-flag-id`, `data-subject-type`, `data-subject-id`, `data-signal`, `data-score`, `data-decision`                                                                                        |
| `integrityq-decide` | On a flag: items `integrityq-decide-excluded`, `integrityq-decide-allowed`; `integrityq-reason` (required); `integrityq-submit`                                                                       |

### Egress (`/admin/egress`)

| Test id        | Element / meaning                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `egress`       | Page wrapper; `egress-from`, `egress-to` (`<input type="datetime-local">`, UTC), `egress-load`; `egress-empty`; `egress-error` |
| `egress-total` | One per delivery source: `data-source` (`DELIVERY_SOURCES`), `data-bytes`                                                      |
| `egress-row`   | One broadcast: `data-broadcast-id`, `data-channel`, `data-origin`, `data-relay`, `data-p2p`, `data-cdn` (bytes)                |

### Incidents (`/admin/incidents`)

| Test id         | Element / meaning                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `incidents`     | Page wrapper (lists the open and recent incidents from `instance.status`); `incidents-empty`; `incident-new` opens `incident-form`               |
| `incident-row`  | `data-incident-id`, `data-status`; `incident-edit` opens `incident-form` filled                                                                  |
| `incident-form` | `incident-title`, `incident-status` (items `incident-status-<status>`), `incident-components` (one per line), `incident-body`, `incident-submit` |

### Co-op (`/coop/membership`, `/coop/council`)

| Test id                    | Element / meaning                                                                                                                                         |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `membership-rejoin-viewer` | Calls `coop.join({ class: "viewer" })`; shown only when there is no active viewer membership, the last one exited, and a subscription qualifies           |
| `coop-load-error`          | Any co-op page whose load failed (instead of a skeleton forever); contains `coop-retry`                                                                   |
| `election-nominate`        | On an `election-item` in `nominating` for a member of its class: opens `election-nominate-statement` + `election-nominate-submit`                         |
| `election-candidate`       | One candidate: `data-candidate-id`, `data-username`                                                                                                       |
| `election-ballot`          | On a `voting` election for an eligible member: `election-ballot-<candidateId>` checkboxes (≤ seats), `election-ballot-submit`; `election-voted` once cast |

### Legal

| Test id         | Element / meaning                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| `legal-pending` | Banner for a signed-in user with `me.pendingLegal`: `data-kinds` (comma-separated); `legal-pending-accept` |

## Scenarios

- **`trust-safety` step 8 (DMCA).** Streamer G makes a clip. An anonymous claimant files a notice
  for the clip URL on `/dmca` (`--set via=api`: `safety.dmca.submit`) → `dmca-receipt`. A platform
  moderator actions it on `/admin/dmca`. The clip is gone for owner and public, its media URL
  answers 404 once `dmca-disable` ran, G has an unreversed `dmca_strike` (`appeals.accountActions`),
  and G got the `dmcaNoticeReceived` email. G files a counter-notice on `/settings/copyright` →
  `counter-receipt` with `data-restore-after` = 12 weekdays after filing; the claimant got the
  `dmcaCounterNoticeForwarded` email. `dmca-tick` with `asOf` = restore-after − 1 min restores
  nothing; with restore-after + 1 min restores 1. The clip and its media URL are back, the strike
  is reversed (`counter_notice_restored`), G got `contentRestored`. The audit log (`safety.auditLog`
  by `subjectType=dmca_notice`) shows `dmca.notice.submit`, `dmca.notice.action`,
  `dmca.counter.receive`, `dmca.content.restore` in order. API only: a second notice, countered,
  then `suitFiled` → a tick past restore-after restores nothing.
- **`trust-safety` step 9 (appeal lifts the ban).** Streamer H bans viewer V in chat; V appeals the
  `mod_actions` row; a platform moderator who is not H overturns it on `/admin/appeals`; V's ban is
  lifted (V can send again), the audit log has `chat.unban` by that moderator with `details.appealId`.
  API only: an admin suspends user W (`safety.suspend`), W appeals, overturn → W unsuspended.
- **`e2e-social`.** The streamer adds a `hold` word filter; the troll sends a matching message over
  REST `chat.send` → `{ held: true }`; the fan never sees it; the streamer sees it in `held-queue`
  and presses `held-allow`; the fan sees `chat-message` with that `data-id`. REST
  `chat.deleteMessage` and `chat.clear` are exercised in `--set via=api`.
- **`e5-coop`.** A viewer member qualified by subscription only exits, then rejoins with
  `membership-rejoin-viewer`; `membership-row` for `viewer` is `active` with basis `subscription`.
- **`e7-admin`** (new, E7-admin): egress report for the scenario's own broadcast, an incident opened
  and resolved (seen on `instance.status`), a seeded `pending_review` integrity flag decided on
  `/admin/integrity`.
