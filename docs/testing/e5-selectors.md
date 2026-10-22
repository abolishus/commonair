<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E5 web ↔ harness contract (co-op)

Milestone E5: the co-op runs on the platform. A viewer buys the refundable share and becomes a
member. A streamer qualifies by streaming hours. A worker is appointed by board decision. Members
draft, discuss and vote on proposals. The creator council reviews creator-affecting proposals
first. The tally is computed per class, and a protected decision that passes member-wide but
fails in the streamer class is rejected by the database. A treasurer computes a patronage run for
a closed period, a second person approves it, and each member's statement explains their
allocation line by line. The transparency page shows the outcome. Policy:
[ADR 0020](../decisions/0020-coop-policies.md). Enforcement model:
[ADR 0004](../decisions/0004-governance-enforcement.md). Rules for members:
[docs/governance/decision-process.md](../governance/decision-process.md). This file extends
[e1](e1-selectors.md), [e2](e2-selectors.md), [e3](e3-selectors.md), [e4b](e4b-selectors.md) and
[e4c](e4c-selectors.md), and everything in those still holds.

Changing anything here is a contract change: update this file, `packages/governance`,
`packages/patronage`, `services/api`, `services/worker`, `apps/web` and the `e5-coop` scenario
together. Tests select elements by `data-testid`, never by visible text. Every amount in a
`data-*` attribute is integer cents of the instance currency.

## Rules every unit honors (a reviewer marks any breach HIGH)

- **The database is the enforcement layer (ADR 0004).** Proposal transitions, the electorate,
  votes, tallies, settings changes, council responses, share transitions and patronage approval
  are refused by triggers (`0001`, `0002`, `0021_coop_protections.sql`) whatever the caller.
  Application checks come in addition, give clear errors and never replace a trigger. Never
  weaken a trigger; if one blocks a legitimate flow, stop and report a contract request.
- **One tally.** The TypeScript `tally()` (`@commonair/governance`) and the SQL
  `commonair_governance_tally` must agree. The worker decides a proposal with the TS tally, sets
  `passed`/`rejected` (the trigger re-tallies) and inserts the `tallies` row (the trigger checks
  `passed` against the SQL tally) in one transaction. A disagreement is a bug: the transaction
  fails, the worker logs `error` with the proposal id, and nothing is recorded.
- **Secret ballot.** A vote's choice is stored only in `votes`/`vote_history`. It never goes into
  `audit_log`, events, logs, notifications or any API response other than the voter's own
  `myVote`. Before a proposal is decided, the API exposes participation counts (`voted`,
  `eligible`) and never a running yes/no tally.
- **Every governance, membership, council, share and patronage action writes its `audit_log`
  row and its `events` row in the same transaction.** Audit `details` hold ids, enums and
  numbers only (never a choice, a comment, a minute reference or a name). Free text the actor
  wrote (a board minute reference, a refund note) goes to the audit `reason`.
- **Money.** Integer cents with an explicit currency (`payout.rules.currency`). Shares are a
  liability to the member (`liability:member-share:<user>`); patronage allocations move retained
  surplus into `liability:patronage-payable:<user>`. Every posting goes through `post` in the
  same transaction as the state change it records; ledger entries are append-only and balance per
  transaction (DB-enforced).
- **No personal data in append-only columns** (AGENTS.md). Reference users by id.
- **Lock order.** payment → share → membership; proposal row (`for update`) before votes;
  patronage period row before its inputs/allocations.

## Membership flows

| Flow            | Who                             | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buy share       | signed-in user, `coop.buyShare` | Manual provider only in E5 (with Stripe the call is `PRECONDITION_FAILED`, `requirement: "manual_shares"`; ADR 0020). Refused with `CONFLICT` while the user has a `pending`, `held` or `refund_pending` share or an active viewer membership with basis `share`. One transaction: `payments` (`kind = membership_share`, `channel_id` null, `pending`, `CA-…` reference, `expires_at` = now + `PAYMENT_PENDING_DAYS`), `membership_shares` (`pending`, `payment_id`, `amount_cents` = `membership.classes.viewer.shareCents`, currency `payout.rules.currency`), audit `coop.share.request`, event `coop.share.update`. Returns the manual instructions                                                                                                   |
| Confirm share   | treasurer, `treasurer.confirm`  | The existing confirm now accepts `membership_share` payments (`pending` only). One transaction: payment `succeeded`; `sharePurchase` posted (settlement `cash`); share `held`, `purchased_at = receivedAt`; a viewer membership with basis `share` inserted unless the user already has an active viewer membership; audit `payment.confirm` and `membership.activate` (details `{ class, basis }`); events `coop.share.update` and `coop.membership.update`                                                                                                                                                                                                                                                                                               |
| Share expiry    | worker                          | A `pending` share payment that expires (`money-expire-pending`) sets its share `cancelled` in the same transaction (audit `coop.share.cancel`, actor `system`; event `coop.share.update`). Nothing to reverse                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Streamer        | worker `membership-sync`        | Hourly (and on the test hook). `syncMemberships`: an active streamer membership (basis `streaming_hours`) for every user whose eligible streaming hours in the last `windowDays` reach `minStreamingHours`; lapses past `windowDays + lapseGraceDays`; viewers by subscription as before. **A voluntary exit is respected**: a streamer whose latest streamer membership is `exited` with `exited_at` inside `streamer.windowDays` is not re-activated by the job; a viewer who exited is never re-activated by the job (they rejoin by buying a new share once the old one is refunded). Lapsed members re-activate when they qualify again. Audit `membership.activate` / `membership.lapse` (actor `system`), event `coop.membership.update` per change |
| Worker          | admin, `coop.appointWorker`     | The user exists, is not banned or deleted and has no active worker membership (`CONFLICT`). Inserts a worker membership with basis `board_appointment`; audit `membership.appoint` with the board minute reference in `reason`; event `coop.membership.update`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Exit            | member, `coop.exit`             | The active membership in that class becomes `exited` (`exited_at` now); audit `membership.exit`; event `coop.membership.update`. Viewer with a `held` share and `shareRefundableOnExit`: the share becomes `refund_pending` in the same transaction (audit `coop.share.refund_request`, event `coop.share.update`). An exit while a proposal the member may vote on is in `voting` does not remove them from that frozen electorate (ADR 0004)                                                                                                                                                                                                                                                                                                             |
| Refund share    | treasurer, `coop.shares.refund` | `refund_pending` only (`CONFLICT` otherwise). One transaction: `shareRefund` posted (cash out, settlement `cash`), share `refunded`, `refunded_at = sentAt`; audit `coop.share.refund` with the treasurer's note in `reason`; event `coop.share.update`. `coop.shares.list` lists shares by status for the treasury                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Membership view | member, `coop.membership`       | Memberships, the share and per-class eligibility: `basis` (the basis the class would use now, or null) and `progress` (`{ have, need, unit }`: streamer `hours` in the window; viewer `cents` of the share; null for worker)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## Proposal flows

Periods come from the settings (`governance.ordinary`, `governance.protections`); the triggers
enforce them with the database clock, so nothing can fast-forward a window. Test instances
bootstrap short periods (see "Stack").

| Flow           | Who                                        | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Draft          | active member, `proposals.create`          | Non-members get `PRECONDITION_FAILED` `requirement: "membership"`. `classifyChanges` decides the kind: any protected key ⇒ `protected` and `affectsCreators` forced true; an unknown or duplicate key ⇒ `BAD_REQUEST`. Ordinary proposals may have no changes. Each change value is validated against the setting's full shape and applied wholesale, so a change sends the **whole** value (e.g. all of `discovery.ranking` with `spotlightSlots` replaced). Audit `proposal.create`; **no event** (`coop.proposal.update` is public and starts at submit). Drafts, and drafts withdrawn before submit, are visible only to their author (`get` → `NOT_FOUND` for others; `list` leaves them out)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Edit           | author, `proposals.update`                 | Title, body, changes and `affectsCreators` while `draft` or `discussion` (re-classified as for draft). An edit during discussion restarts the discussion clock (trigger). Audit `proposal.update`; event `coop.proposal.update` only once submitted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Submit         | author, `proposals.submit`                 | `draft → discussion` (`discussion_ends_at` set by the trigger). Audit `proposal.submit`; event                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Withdraw       | author, `proposals.withdraw`               | Before voting only. Audit `proposal.withdraw`; event only when it had been submitted (a draft withdrawn before submit stays private)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Comment        | active member, `proposals.comment`         | While `discussion`, `council_review` or `voting` (`CONFLICT` otherwise). Audit `proposal.comment` (details: proposal and comment ids); event `coop.proposal.comment`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Advance        | worker `proposals-advance`                 | Every 15 s (and on the test hook), one transaction per proposal step, each with audit (actor `system`) and event `coop.proposal.update`: `discussion` past `discussion_ends_at` → `council_review` when `affects_creators`, else `voting` (audit `proposal.council_review` / `proposal.open_vote`); `council_review` past `council_review_ends_at` → `voting` whether or not the council responded; `voting` past `voting_ends_at` → `passed`/`rejected` + `tallies` row (audit `proposal.decide`, details `{ passed, rule }` with `rule` the failing `TALLY_RULES` id or `passed`; `tallies.reason` is the tally's reason string, one of `TALLY_REASONS`, which the trigger checks against the SQL tally); `passed` → every change applied to `governance_settings` (`updated_by_proposal_id`) and the proposal `applied` in one transaction (audit `proposal.apply`). Opening a vote freezes `rules = rulesFor(kind, settings, { affectsCreators })` and sets `voting_ends_at` = now + `governance.ordinary.votingSeconds`, raised to `governance.protections.minVotingSeconds` for protected proposals; it notifies every electorate member (`vote_open`). A change superseded since the vote opened cannot apply: the proposal stays `passed`, audit `proposal.apply_refused` (no event: the status does not change), `warn` log with the id; transient errors are retried on the next run |
| Council review | council member, `proposals.councilRespond` | `council_review` only; the caller must be seated in the **current** council term. One response per proposal (`CONFLICT` on a second). Audit `council.respond` (details: stance); event `coop.council.response`. The response is shown on the ballot; if none was published in time, the proposal says so (`councilResponse: null` and `councilResponseMissed: true`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Vote           | electorate member, `proposals.vote`        | While `voting` and inside the window. Insert, or update the member's own row to change it. Errors: not in the frozen electorate → `FORBIDDEN` `data.reason = "not_in_electorate"`; window closed → `CONFLICT` `data.reason = "voting_closed"`. Audit `proposal.vote` (details: proposal id only); event `coop.vote.cast` (proposal id only). The response carries `myVote` and participation, never the choices of others                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Tally          | public, `proposals.get`                    | Decided proposals show the `tallies` row: member-wide and per-class counts (`breakdown.byClass` for streamer, viewer and worker) and every check with its threshold. Open proposals show participation only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## Council

| Flow      | Who                        | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recompute | worker `council-recompute` | Daily at 03:10 UTC (and on the test hook). A new term is seated (`seatCouncil` over active streamer members, `council.config`) when there is no current term, the UTC month changed, a seated member is no longer an active streamer member (a vacancy), or the term has fewer than `council.config.size` seats while an active streamer member is unseated (unfilled). The new term starts now and ends at the end of the UTC month; the **current term** is the latest term by `computed_at` whose window contains now. Terms and seats are append-only. Audit `council.recompute` (actor `system`); event `coop.council.recomputed` |
| View      | public, `coop.council`     | The current term, its seats (rank, score) and the method (weights, window, counts)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Board elections (`coop.elections.*`, worker `elections-advance`: `nominating → voting` at
`nominations_close_at`, `closeElection` at `voting_ends_at`) are built in E5 with audit and
events, but are not part of the `e5-coop` scenario; the web shows the board and the elections
read-only.

## Patronage

| Flow      | Who                                        | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Run       | treasurer, `patronage.run`                 | `periodEnd` ≤ now and `periodStart` < `periodEnd` (`BAD_REQUEST`). Closes the ledger for `[periodStart, periodEnd)` (`closePeriod`, idempotent; an overlap with another closed period → `CONFLICT`), then `computePeriod` with `computedById` = the caller and `surplusCents` (omitted = all available retained surplus; more than available → `PRECONDITION_FAILED` `requirement: "surplus"`). A `computed` period may be re-run (by anyone allowed); re-running resets `computed_by_id`. Audit `patronage.run` (details: period id, totals); event `coop.patronage.update` (`computed`) |
| Approve   | treasurer or admin, `patronage.approve`    | `computed` only. The approver must differ from `computed_by_id` (`FORBIDDEN` `data.reason = "second_approver"`; the trigger refuses it too). `approvePeriod` posts `patronageAllocation` (retained surplus → each member's patronage payable) and sets `approved` in one transaction; audit `patronage.approve`; event `coop.patronage.update` (`approved`). Paying payables out in cash is later work (ADR 0020)                                                                                                                                                                         |
| Periods   | treasurer or admin, `patronage.periods`    | Every period, newest first, with status, totals, member count and who ran/approved it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Statement | member, `patronage.statements`/`statement` | Only `approved`/`distributed` periods in which the caller has an allocation (or inputs). `lines` explain each component (`explainLine`), with the pool, the member's value, their share and the cap applied                                                                                                                                                                                                                                                                                                                                                                               |

## Transparency

`coop.transparency` keeps a month that has governance outcomes or member counts even when it has
no ledger postings. Each month's `governance` lists the proposals decided in it with `passed`,
`kind` and `reason`; `patronageDistributed` is the approved allocations posted in it.

## Routes

| Route                       | Change in E5                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `/coop`                     | New, public: overview (your membership card when signed in, open proposals, council, members by class). Linked from the site header |
| `/coop/membership`          | New, signed in: memberships, eligibility, buy share (manual instructions), exit                                                     |
| `/coop/proposals`           | New, public: proposals by status; members get "New proposal"                                                                        |
| `/coop/proposals/new`       | New, members: the proposal form (title, body, setting changes, affects creators)                                                    |
| `/coop/proposals/$id`       | New, public: the proposal, timeline, discussion, council response, vote, tally                                                      |
| `/coop/council`             | New, public: current council, method, board seats, elections (read-only)                                                            |
| `/coop/settings`            | New, public: governance settings with protected flags and the decision that last set each                                           |
| `/coop/patronage`           | New, signed in: your statements                                                                                                     |
| `/coop/patronage/$periodId` | New, signed in: one statement, explained line by line                                                                               |
| `/treasury`                 | New tabs: `shares` (refunds to send) and `patronage` (run, approve, periods)                                                        |
| `/admin/coop`               | New, admins only (others get the not-found page): appoint a worker member                                                           |
| `/transparency`             | Governance outcomes per month and patronage distributed                                                                             |

## Test ids

### Site chrome

| Test id                   | Element / meaning                               |
| ------------------------- | ----------------------------------------------- |
| `nav-coop`                | Site header link to `/coop`                     |
| `account-coop-link`       | Account menu link to `/coop/membership`         |
| `account-admin-coop-link` | Account menu link to `/admin/coop`, admins only |

### `/coop`

| Test id                 | Element / meaning                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `coop`                  | Page wrapper                                                                                                 |
| `coop-membership-card`  | Signed in: `data-classes` (comma-separated active classes, empty when none); contains `coop-membership-link` |
| `coop-open-proposal`    | One proposal in `discussion`, `council_review` or `voting`: `data-proposal-id`, `data-status`, `data-kind`   |
| `coop-council-member`   | One seat: `data-user-id`, `data-rank`                                                                        |
| `coop-members-by-class` | `data-streamer`, `data-viewer`, `data-worker` (counts)                                                       |

### `/coop/membership`

| Test id                         | Element / meaning                                                                                                                |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `membership`                    | Page wrapper                                                                                                                     |
| `membership-row`                | One membership: `data-membership-id`, `data-class`, `data-status`, `data-basis`                                                  |
| `membership-eligibility`        | One class: `data-class`, `data-eligible` (`true`/`false`), `data-basis` (empty when none), `data-have`, `data-need`, `data-unit` |
| `membership-share`              | The share: `data-status` (`none` when there is no share), `data-cents`                                                           |
| `membership-buy-share`          | Starts `coop.buyShare` (hidden while a share is pending/held or a viewer membership exists)                                      |
| `membership-share-instructions` | After buying: `data-reference`, `data-payment-id`, `data-cents`; the instructions text                                           |
| `membership-exit-<class>`       | Exit button per active class; opens a `ConfirmDialog` (`membership-exit-confirm`) that says whether the share will be refunded   |

### `/coop/proposals`, `/coop/proposals/new`

| Test id           | Element / meaning                                                                                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `proposals`       | List wrapper; `proposals-filter` status filter (items `proposals-filter-<status>`, `proposals-filter-all`); `proposals-empty` `<EmptyState>`                                                                         |
| `proposal-item`   | `ProposalCard`: `data-proposal-id`, `data-status`, `data-kind`                                                                                                                                                       |
| `proposals-new`   | Link to `/coop/proposals/new` (active members only)                                                                                                                                                                  |
| `proposal-form`   | The form: `proposal-title`, `proposal-body`, `proposal-affects-creators` (switch), `proposal-change-add`                                                                                                             |
| `proposal-change` | One change row: `proposal-change-key` (`<SelectField>` of setting keys, items `proposal-change-key-<key>`), `proposal-change-value` (JSON textarea), `proposal-change-remove`; `data-protected` once a key is chosen |
| `proposal-kind`   | Shows the derived kind: `data-kind` (`ordinary` / `protected`)                                                                                                                                                       |
| `proposal-save`   | Saves the draft (`create` or `update`) and navigates to the proposal                                                                                                                                                 |

### `/coop/proposals/$id`

| Test id                                            | Element / meaning                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `proposal`                                         | Page wrapper: `data-proposal-id`, `data-status`, `data-kind`, `data-affects-creators`                                                                                                                                                                                                                        |
| `proposal-change-summary`                          | One change: `data-key`, `data-protected`                                                                                                                                                                                                                                                                     |
| `proposal-timeline`                                | `Timeline`; steps `proposal-timeline-<status>` with `data-state` (`done` / `current` / `upcoming`) and `data-at` (ISO, empty when unknown)                                                                                                                                                                   |
| `proposal-submit`                                  | Author, `draft`: opens discussion (`ConfirmDialog`)                                                                                                                                                                                                                                                          |
| `proposal-edit`                                    | Author, `draft`/`discussion`: link to the form                                                                                                                                                                                                                                                               |
| `proposal-withdraw`                                | Author, before voting: `ConfirmDialog`                                                                                                                                                                                                                                                                       |
| `proposal-comment`                                 | One comment (`CommentItem`): `data-comment-id`, `data-author-id`                                                                                                                                                                                                                                             |
| `proposal-comment-body`, `proposal-comment-submit` | The composer (members, while comments are open)                                                                                                                                                                                                                                                              |
| `council-response`                                 | The published response: `data-stance`; or `council-response-missed` when review ended without one                                                                                                                                                                                                            |
| `council-respond`                                  | Council members, `council_review`, none yet: `council-respond-stance` (items `council-respond-stance-<stance>`), `council-respond-body`, `council-respond-submit`                                                                                                                                            |
| `vote-panel`                                       | While `voting`: `data-my-vote` (empty when none), `data-can-vote`; `vote-choice` (`OptionGroup`, items `vote-choice-yes`, `vote-choice-no`, `vote-choice-abstain`), `vote-submit`                                                                                                                            |
| `vote-participation`                               | While `voting`: `data-voted`, `data-eligible`                                                                                                                                                                                                                                                                |
| `tally`                                            | Decided: `data-passed`, `data-reason` (the `TALLY_REASONS` string, e.g. `streamer-class majority not met`); rows `tally-row` with `data-scope` (`member_wide`, `streamer`, `viewer`, `worker`), `data-yes`, `data-no`, `data-abstain`, `data-eligible`; checks `tally-check` with `data-rule`, `data-passed` |

### `/coop/council`, `/coop/settings`

| Test id          | Element / meaning                                                                |
| ---------------- | -------------------------------------------------------------------------------- |
| `council`        | Page wrapper: `data-term-id`, `data-starts-at`, `data-ends-at`                   |
| `council-member` | One seat: `data-user-id`, `data-rank`, `data-score`                              |
| `council-method` | The seating method (weights, window, counts)                                     |
| `board-seat`     | `data-user-id`, `data-class`                                                     |
| `election-item`  | `data-election-id`, `data-class`, `data-status`                                  |
| `settings`       | Page wrapper                                                                     |
| `setting-row`    | `data-key`, `data-protected`, `data-updated-by` (proposal id, empty when seeded) |

### `/coop/patronage`

| Test id            | Element / meaning                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `patronage`        | Statements list wrapper; `patronage-empty` `<EmptyState>`                                                                            |
| `patronage-item`   | `data-period-id`, `data-status`, `data-cents`                                                                                        |
| `statement`        | One statement: `data-period-id`, `data-status`, `data-cents` (the member's total), `data-formula-version`                            |
| `statement-line`   | One line: `data-component`, `data-cents`, `data-share`, `data-cap-applied`; its explanation text inside `statement-line-explanation` |
| `statement-inputs` | The member's inputs: `data-revenue-cents`, `data-hours`, `data-relay-bytes`, `data-viewer-hours`                                     |

### `/treasury` (new tabs)

| Test id                                         | Element / meaning                                                                                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `treasury-tab-shares`, `treasury-tab-patronage` | Tabs                                                                                                                                                       |
| `treasury-share-row`                            | `data-share-id`, `data-user-id`, `data-status`, `data-cents`                                                                                               |
| `treasury-share-refund`                         | In a `refund_pending` row: a dialog with `treasury-share-refund-note` and `treasury-share-refund-submit` (sent now)                                        |
| `patronage-run-form`                            | `patronage-run-start`, `patronage-run-end` (datetime inputs, UTC), `patronage-run-surplus` (currency units, empty = all available), `patronage-run-submit` |
| `patronage-run-result`                          | After a run: `data-period-id`, `data-members`, `data-cents`                                                                                                |
| `patronage-period-row`                          | `data-period-id`, `data-status`, `data-cents`, `data-computed-by`, `data-approved-by`                                                                      |
| `patronage-approve`                             | In a `computed` row: `ConfirmDialog`; disabled for the person who ran it, with the reason shown                                                            |

### `/admin/coop`

| Test id                                                                     | Element / meaning          |
| --------------------------------------------------------------------------- | -------------------------- |
| `admin-coop`                                                                | Page wrapper (admins only) |
| `appoint-worker-username`, `appoint-worker-minute`, `appoint-worker-submit` | The appointment form       |

### `/transparency` (additions)

| Test id                   | Element / meaning                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `transparency-governance` | One decided proposal: `data-proposal-id`, `data-status`, `data-kind`, `data-passed`, `data-month` |
| `transparency-patronage`  | One month's distribution: `data-month`, `data-cents`                                              |

## Stack and test hooks

The `e5-coop` stack uses `harness/compose.e5-coop.yaml` on a **freshly created database**
(governance periods are fixed at first migration; ADR 0020 records the one-time reset), with:

- `GOVERNANCE_BOOTSTRAP_JSON` (first-run only, shallow-merged per key):
  `governance.protections` `{ councilReviewSeconds: 30, minVotingSeconds: 45, quorum: 0.01, streamerClassQuorum: 0.01 }`;
  `governance.ordinary` `{ discussionSeconds: 30, minVotingSeconds: 45, votingSeconds: 45, quorum: 0.01 }`;
  `membership.classes` with streamer `minStreamingHours: 0.01` (36 s) and the other defaults;
  `council.config` `{ size: 50, minStreamingHours: 0.01 }` (other harness scenarios' streamers also qualify
  on a shared stack; 50 seats keep room for this run's S1 and S2).
- `COOP_TEST_HOOKS=true` (API and worker; off by default, logged as a warning at every start,
  reported by `/healthz`; never on a public instance). It enables
  `POST /internal/coop/tick` behind `INTERNAL_API_SECRET`: body `CoopTickBody`
  (`{ job: "membership-sync" | "proposals-advance" | "council-recompute" | "elections-advance" | "stream-hours" }`;
  `stream-hours` is tick-only: it runs the integrity stream-hours pass now, under that job's run lock);
  the API enqueues that `COOP_JOBS` job on `QUEUES.coop`, waits for it (30 s) and returns its
  result. A job whose run lock stayed busy returns `{ skipped: 1 }`; the harness ticks again. Without test hooks the route is `404`. The schedules keep running either way.

## Scenario `e5-coop`

Accounts are created fresh per run (`treasurer` ×2 and `admin` from the role CLI). `--set
via=api` drives everything through the API; the default also checks the web flows. The scenario
first checks that `governance.ordinary.discussionSeconds` ≤ 60 and stops with a hint about the
database reset if not.

1. **Membership.** Viewer V buys the share on `/coop/membership` (`membership-share-instructions`);
   treasurer T1 confirms it on `/treasury`; V's `membership-row` shows `viewer`/`share` and
   `membership-share` `data-status="held"`. Streamers S1 and S2 each stream (ffmpeg test pattern)
   with a verified harness viewer until `stream_hours` is eligible; a `membership-sync` tick makes
   both streamer members with basis `streaming_hours` (`membership-eligibility` for `streamer`
   `data-eligible="true"`). Admin appoints W on `/admin/coop`; W has a `worker` membership with
   basis `board_appointment`.
2. **Council.** A `council-recompute` tick seats S1 and S2; `/coop/council` lists both
   `council-member`s.
3. **Revenue.** V tips S1 (manual adapter); T1 confirms. (Patronage needs a surplus.)
4. **Governance vote.** S2 drafts an ordinary, creator-affecting proposal changing
   `discovery.ranking` (`spotlightSlots` alternating 4/5 per run) on `/coop/proposals/new`, and
   submits it. V and W comment during discussion. A `proposals-advance` tick after the discussion
   ends moves it to `council_review`; S1 publishes a `support` response; the next tick after the
   review ends opens voting. V (web), W, S1 and S2 vote yes. After the window, a tick decides it:
   `tally` `data-passed="true"`, `tally-row` per class (`streamer` 2 yes, `viewer` 1, `worker` 1),
   and the next tick applies it: `/coop/settings` shows `discovery.ranking` updated by it.
5. **Protected decision.** In parallel with step 4, W drafts a protected proposal changing
   `platform.cut` (`streamerShare` 0.85). It goes through council review (S2 responds `oppose`)
   and voting: V, W and S2 vote yes, S1 votes no (member-wide 3/4 ≥ 2/3; streamer class 1/2, not
   a majority). The tick rejects it: `data-passed="false"`, `data-reason="streamer-class majority not met"`. Through the harness DB helper as the app role: setting the proposal `passed`,
   inserting a `tallies` row with `passed = true`, and applying its change to `platform.cut` all
   fail; `platform.cut` is unchanged.
6. **Patronage.** T1 runs patronage on `/treasury` for `[scenario start, now − 1 s)`; T1's own
   `patronage-approve` is disabled and `coop.patronage.approve` as T1 is refused
   (`second_approver`); T2 approves. S1's `/coop/patronage/<period>` `statement` shows a positive
   `data-cents` with `statement-line`s and explanations. Every ledger transaction of the run
   balances (DB helper: sum of entries per transaction = 0).
7. **Transparency.** `/transparency` shows both proposals as `transparency-governance` rows
   (`data-passed` true / false) and a `transparency-patronage` row for this month with
   `data-cents` > 0.
8. **Audit and outbox.** For every action above, the DB helper finds the `audit_log` row (action
   and actor type) and the `events` row; no audit `details`, event payload or service log line
   contains a vote choice for a specific user, a comment body or an email.
9. **Exit and refund (cleanup).** V exits (share `refund_pending`); T1 refunds it on `/treasury`
   (`refunded`, a balanced `share_refund` posting). S1, S2 and W exit, so later runs start from an
   electorate without them.

Steps are individually selectable only as prefixes (`--set steps=1-3`), because each builds on
the previous one.
