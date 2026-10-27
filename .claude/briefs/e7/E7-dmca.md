<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E7-dmca: notice, takedown, counter-notice, restore, repeat infringers

You are implementing unit E7-dmca for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/E7-platform-debts.md`,
`.claude/briefs/e7/contract-step.md` (all of it, especially §1-§3 and §9 "Shared-file rules"),
`docs/testing/e7-selectors.md`, `docs/testing/e4c-selectors.md` (the NCII flow you mirror),
`docs/decisions/0004-governance-enforcement.md`, `docs/decisions/0006-automated-moderation.md`,
`docs/operators/trust-safety.md` and the seeded policy `packages/db/src/legal/dmca_policy.md`. Do
not look outside the repository. Work in your own git worktree on a branch named `e7/dmca`,
created from the E7 contract-step commit the orchestrator gives you (run `git merge main` first if
main moved).

**This is a legal process.** The flow follows 17 U.S.C. § 512 as summarised below and the
instance's own policy text (`dmca_policy.md`). No lawyer has reviewed the flow, the policy text or
the constants in `DMCA_RULES`: say so in `docs/operators/dmca.md`, in the module comments, and in
your final message. If the statute summary below and the policy text disagree, follow the
statute summary and report the disagreement.

## Why

`safety.dmca.*` answers 501 (`services/api/src/routes/safety.ts:428-435` after the contract step), yet the footer, the
DMCA policy and `docs/operators/trust-safety.md:158` ("The copyright notice and counter-notice flow
is already built") promise it. Without a working notice-and-takedown flow, a designated agent and
a repeat-infringer policy, an instance has no § 512(c) safe harbor for its users' VODs and clips.

## The law, as this unit implements it

- **Notice, § 512(c)(3)(A):** (i) physical or electronic signature of the owner or an authorised
  agent; (ii) identification of the copyrighted work; (iii) identification of the infringing
  material and information to locate it (URLs); (iv) contact information (address, telephone
  number, email); (v) a good-faith statement that the use is not authorised; (vi) a statement that
  the notice is accurate and, under penalty of perjury, that the complainant is authorised to act.
  Fields: `submit` input + `claimantPhone` (contract step). An incomplete notice is `rejected` with
  a note saying what is missing; the `dmcaNoticeDecided` email to the claimant is the "reasonable
  steps to contact the complaining party" of § 512(c)(3)(B)(ii) for a notice that has the work, the
  URLs and the contact details but lacks another element.
- **Takedown, § 512(c)(1)(C):** on a complete notice, remove or disable access "expeditiously".
  Here: a platform moderator actions it; access is disabled at once (listing) and the objects move
  to a private prefix (so a known media URL stops working too).
- **Notify the uploader, § 512(g)(2)(A):** "take reasonable steps promptly to notify the
  subscriber": the `dmcaNoticeReceived` email and `/settings/copyright`.
- **Counter-notice, § 512(g)(3):** (A) signature; (B) identification of the removed material and
  where it was (the items); (C) statement under penalty of perjury of a good-faith belief it was
  removed by mistake or misidentification; (D) name, address, telephone number, consent to the
  federal district court's jurisdiction (or, outside the US, any district where the provider is
  found) and to accept service of process from the claimant.
- **Forward and restore, § 512(g)(2)(B)-(C):** promptly send the claimant a copy of the
  counter-notice and say the material comes back in 10 business days; restore it **not less than
  10 nor more than 14 business days** after receiving the counter-notice, unless the claimant first
  tells the designated agent they filed a court action. Here: `restoreAfter` = receipt + 12
  weekdays (`DMCA_RULES.restoreWeekdays`, always inside 10-14 business days even with two federal
  holidays in the window), restored by the `dmca-restore` job (every 15 min), blocked by
  `suitFiled`.
- **Repeat infringers, § 512(i)(1)(A):** a reasonably implemented policy to terminate repeat
  infringers. Here: each actioned notice gives each item owner one `dmca_strike` account action
  (one per notice per owner, not per URL); a strike is reversed when the counter-notice restores
  the content or an account appeal overturns it; `DMCA_RULES.repeatInfringerStrikes` unreversed
  strikes within `strikeWindowDays` suspend the account (`dmca_termination`, user suspension with
  reason `dmca_repeat_infringer`), notify platform moderators, and are appealable (E7-appeals
  wires the appeal). With `repeatInfringerStrikes = 0` only the notification happens.
- **Designated agent, § 512(c)(2):** the operator must register an agent with the US Copyright
  Office (online directory, renewed every three years) and publish it; the instance's
  `DMCA_EMAIL` contact (`{{contacts.dmca}}` in the policy) is where notices also arrive by mail.
  This is operator paperwork: document it in `docs/operators/dmca.md`.

## You own (write only these)

- `services/api/src/routes/safety.ts`: only the `dmca:` block (:428-435 at `3bacecb`, including the two stubs
  the contract step added) and the header comment (:4-7). Put logic in `services/api/src/dmca/**`.
- `services/api/src/dmca/**` (new): notice intake and URL resolution, decisions, counter-notices,
  strikes and the repeat-infringer hook, `restoreAfter` business-day maths, DTOs, emails.
- `services/api/src/media/visibility.ts`: only the removed-reason handling (:26-28, :67, :78,
  :93, :107) so `removed_reason = 'dmca'` hides a VOD or clip from everyone, the owner included,
  and hides clips of a DMCA-removed VOD (like `owner`/`creator`, but the objects are kept).
- `services/api/src/moderation/hooks.ts` (the `dmca-tick` hook) and
  `services/api/src/moderation/queue.ts` (`dmcaDisable(job)` and `dmcaRestoreTick(asOf)` on
  `ModerationQueue`, and in `recordingQueue`).
- `services/worker/src/dmca/**` (new) and `services/worker/src/jobs/dmca-disable.ts`,
  `services/worker/src/jobs/dmca-restore.ts` (stubs from the contract step).
- `services/worker/src/exports/collectors.ts`: add the user's DMCA counter-notices and their
  `account_actions` to the data export (and its tests).
- `packages/email/src/templates/trust.tsx`, `packages/email/src/messages/en.ts` (the `dmca*` and
  new keys only), `packages/email/src/registry.ts`, `packages/email/src/samples.ts`, and the email
  package's tests/snapshots for them.
- Web: `apps/web/src/routes/_app/dmca.tsx`, `apps/web/src/routes/_app/settings.copyright.tsx`,
  `apps/web/src/routes/_admin/admin.dmca.tsx` (fill the placeholders; never add/rename route
  files), `apps/web/src/components/dmca/**` (new), `apps/web/src/i18n/e7-dmca.ts` (keys prefixed
  `dmca.`, `copyright.`, `dmcaq.`), `apps/web/tests/e7-dmca*.test.ts(x)` (new).
- Harness: `harness/src/e7/dmca.ts` (the `stepDmca(run)` stub from the contract step: trust-safety
  step 8), `harness/tests/e7/dmca.test.ts` (new).
- Docs: `docs/operators/dmca.md` (new), and the DMCA bullet in `docs/operators/trust-safety.md`
  (:158) only.
- Tests: `services/api/tests/dmca*.test.ts`, `services/worker/tests/dmca*.test.ts` (new).

Read-only, in particular: `packages/contracts/**`, `packages/db/**` (including the 0024/0025
migrations), `services/api/src/moderation/suspension.ts` (use `setSuspension(..., "dmca_repeat_infringer")`),
`packages/db/src/account-actions.ts` (contract step §3: `lockAccountActions`, `activeDmcaStrikes`,
`activeAccountAction`, `reverseAccountActionInTx`, `liftDmcaSuspensionInTx`,
`reconcileDmcaTerminationInTx`; use them in the API and the worker, never your own copies),
`harness/src/safety-io.ts` (`run.hooks.dmcaTick(asOf)` exists from the contract step),
`services/api/src/moderation/{ncii-urls,notify,live}.ts`, `services/api/src/routes/ncii.ts`
(`instanceHosts`), `services/worker/src/moderation/**` (E7-appeals'; import `moveObject` and
`vodPrefix` from `objects.ts`), `services/api/src/routes/appeals.ts` (E7-appeals'),
`harness/scenarios/trust-safety.ts`, `harness/src/safety*.ts`, `harness/src/e7/selectors.ts`,
`packages/db/src/legal/*.md`, every i18n file but yours. Anything else you need is a **contract
request** with the exact diff.

## Contracts you must honor (read-only for you)

- `packages/contracts/src/api/router.ts` `safety.dmca` (:2373-… after the contract step):
  `submit` (public, `write` bucket, ALTCHA; input with `claimantPhone?`), `counter` (user, `write`;
  `phone`, `itemIds`, `goodFaithStatement`, `consentToJurisdiction`, `signature`, `fullName`,
  `address`, `statement`; output `{ restoreAfter }`), `queue`, `action` (`actioned`/`rejected` +
  `note`), `mine`, `suitFiled`. DTOs `DmcaNotice`, `DmcaNoticeItem`, `DmcaCounterNotice`,
  `DmcaNoticeForOwner`, `AccountAction` in `api/entities.ts`.
- `enums.ts`: `DMCA_STATUSES` (`received`, `actioned`, `rejected`, `countered`, `restored`),
  `DMCA_ITEM_SUBJECTS`, `ACCOUNT_ACTIONS`, `ACCOUNT_ACTION_REVERSALS`, `DMCA_RULES`.
- `events.ts`: `dmca.notice.received`, `dmca.notice.decided`, `dmca.counter.received`,
  `dmca.counter.suit_filed`, `dmca.content.restored`, `account.action.recorded`,
  `account.action.reversed` (write them in the same transaction as the change, through
  `services/api/src/events/outbox.ts` `emit` / the worker's equivalent).
- `internal.ts`: `INTERNAL_ROUTES.dmcaTick`, `DmcaTickBody`, `MODERATION_JOBS.dmcaDisable` /
  `dmcaRestore`, `DmcaDisableJob`, `DmcaRestoreJob`, `DmcaRestoreResult`.
- Tables: `dmca_notices`, `dmca_counter_notices`, `dmca_notice_items`, `account_actions`
  (`packages/db/src/schema/safety.ts`) and their guards (0025): item `removed_at`,
  `objects_hidden_at`, `restored_at` are set once each; account actions are reversed once; no
  DELETE on any of the four.
- `docs/testing/e7-selectors.md`: "DMCA notice", "Your content", "DMCA queue", the `dmca-tick`
  hook rule and the `trust-safety` step 8 description.

## What is there today (verified at `9c51c93`)

- `safety.ts:428-435` (line numbers in this file are at `9c51c93` unless noted; these two are at
  `3bacecb`): the six `dmca` handlers are `notImplemented`; the header (:6-7) says DMCA
  is not part of E4c. `safety.suspend` (:437-…) shows the platform-suspension pattern (mod row +
  audit + `afterBroadcastEnded` + `publishUserControl` after commit).
- The NCII flow is your template: `services/api/src/routes/ncii.ts` (public submit with
  `verifyAltcha` :180, URL resolution with `resolveContentUrl` from
  `services/api/src/moderation/ncii-urls.ts:101` (`vod`, `clip`, live channel → `broadcast`,
  `upload`), decisions that hide content :115-160, `instanceHosts` :35), the worker's NCII
  auto-hide that moves objects to a private prefix (`services/worker/src/moderation/ncii-clock.ts:190-…`,
  `objects.ts:39-47` `NCII_HIDDEN_PREFIX`, `moveObject`, `vodPrefix`), and the `ncii-tick` hook
  (`services/api/src/moderation/hooks.ts`, `queue.ts:68-72`).
- Visibility: every removal so far deletes (`status = 'deleted'`) except owner/creator removal
  (`removed_reason` `owner`/`creator`, objects purged later by the worker,
  `services/worker/src/housekeeping.ts:95,206`). A DMCA removal must be **reversible**: keep
  `status`, set `removed_reason = 'dmca'`, keep the objects (move them, never delete them).
  `media/visibility.ts:27-28,67,78,93,107` lists the hidden reasons. The origin's `/media` route
  serves any key under `vods/`, `clips/`, `thumbnails/`, `channels/` (`services/origin/src/media.ts:17`),
  which is why the objects must move.
- Email templates exist: `dmcaNoticeReceived` (uploader) and `contentRestored`
  (`packages/email/src/templates/trust.tsx:9-60`, messages `en.ts:173-192`, samples
  `samples.ts:90-96` with `noticeUrl` `/settings/copyright/notices/…`). Nothing sends them.
- `DMCA_EMAIL` is an instance contact (`docs/self-hosting/configuration.md:195`); the policy text
  is `packages/db/src/legal/dmca_policy.md` (seeded, versioned; do not edit it).
- There is no DMCA operator template in `docs/operators/`; `trust-safety.md:158` wrongly says the
  flow is built.

## Build

1. **Submit (`safety.dmca.submit`).** ALTCHA like NCII. Normalise and de-duplicate URLs; resolve
   each with `resolveContentUrl` into `dmca_notice_items` (`vod`, `clip`, `broadcast`; an `upload`
   or unknown URL stays an unresolved item with null subject: staff handle it by hand); fill
   `owner_id` (the channel owner) and `channel_id`. One transaction: notice + items + audit
   `dmca.notice.submit` (`actorType: "system"`, details: notice id and item counts only) + event
   `dmca.notice.received`. Notify platform moderators (`notifyRoles(["moderator", "admin"], …)`,
   ids only). Never log the claimant's details. Output `{ id }`.
2. **Queue (`queue`) and decision (`action`).** Queue: oldest first for `received`, newest first
   otherwise, keyset paging like `appeals.queue`; full staff DTO with items, counters,
   `ownerStrikes`. Action `rejected`: status, `handled_by_id`, `actioned_at`, audit
   `dmca.notice.reject`, event, and the claimant gets `dmcaNoticeDecided` (new template) with the
   note. Action `actioned`, one transaction under a per-notice advisory lock: every unremoved,
   resolved item is disabled (VOD/clip: `removed_reason = 'dmca'` where `removed_reason is null` and
   `status <> 'deleted'`; broadcast: end it if live with `endBroadcastInTx`, then its VODs and its
   clips by `broadcast_id`), `removed_at` set; mod action rows are not used (this is not chat or
   platform moderation); per distinct owner, under `lockAccountActions(tx, ownerId)`, a
   `dmca_strike` `account_actions` row (source `dmca_notice`/notice id, actor the moderator) +
   `account.action.recorded`; then the repeat-infringer check per owner (`activeDmcaStrikes`; at or
   over the threshold and no `activeAccountAction(…, "dmca_termination")`: insert one, `setSuspension(tx, …, "user", true, now,
   undefined, "dmca_repeat_infringer")`, which itself refuses to take over a user suspension still
   in force (an existing moderation or T0 suspension is left as it is, so that a later reversal of
   the termination never lifts it): `changed: false` means "already suspended for another reason",
   record the termination anyway; the partial unique index `account_actions_active_termination_uq`
   (0026) allows one unreversed termination per user, so check `activeAccountAction` under the lock
   first rather than relying on the unique violation), event, audit `account.dmca_termination`, notify moderators);
   audit `dmca.notice.action`; event `dmca.notice.decided`. After commit: enqueue `dmca-disable`,
   `afterBroadcastEnded`, `publishUserControl` for a suspension, and email each owner
   `dmcaNoticeReceived` (`noticeUrl` `/settings/copyright?notice=<id>`, the content title, the
   reference). Re-actioning or deciding a decided notice → `CONFLICT`.
3. **Disable job (`dmca-disable`, worker).** For each removed item without `objects_hidden_at`:
   move every object (VOD prefix, clip file and thumbnail) to `moderation/dmca/<original key>`
   (new constant in `services/worker/src/dmca/`), then set `objects_hidden_at`. Idempotent (a
   missing source means it already moved). Object keys never reach a log.
4. **Owner view (`mine`) and counter-notice (`counter`).** `mine`: notices with at least one item
   owned by the caller, only their items, claimant **name** only, their counter if any.
   `counter`: the notice must be `actioned` or `countered`; `itemIds` must all be the caller's
   removed, unrestored items of that notice (else `BAD_REQUEST`); one counter per notice per user
   (`CONFLICT`). `restoreAfter = addWeekdays(now, DMCA_RULES.restoreWeekdays)` in UTC, with
   exhaustive unit tests (weekends, a Friday filing, year end, DST irrelevance). One transaction:
   counter row, notice `countered`, audit `dmca.counter.receive` (actor the user, ids only), event
   `dmca.counter.received`. After commit: email the claimant `dmcaCounterNoticeForwarded` (new
   template: the counter-notice's name, address, phone, statement, the items, the restore date,
   and how to tell the agent about a court action: `DMCA_EMAIL`). That email is the one place the
   uploader's contact details leave the instance, as § 512(g)(2)(B) requires; say so in a comment.
5. **Suit filed (`suitFiled`).** Sets `suit_filed_at`/`suit_recorded_by_id` once (`CONFLICT` if
   set or already restored) and `suit_note` (the note stays on the mutable counter row, never in
   the audit), audit `dmca.counter.suit_filed` (ids only), event. The `action` note likewise goes
   to `dmca_notices.decision_note` only.
6. **Restore job (`dmca-restore`, worker) and the hook.** Due counters: `restore_after <= asOf`,
   not restored, no suit. Per counter, in this order: move the objects back (if they were hidden),
   then in one transaction clear `removed_reason` where it is still `'dmca'` (a VOD deleted since,
   by retention or its owner, stays deleted: mark the item restored with `restorable: false` in
   the audit details), set item and counter `restored_at`, reverse that notice's `dmca_strike` for
   the user (`counter_notice_restored`, `reverseAccountActionInTx` under `lockAccountActions`),
   then `reconcileDmcaTerminationInTx` (reverses an active `dmca_termination` now under the
   threshold with `strikes_below_threshold` and lifts only a `dmca_repeat_infringer` suspension;
   never `setSuspension(…, false, …)`, which would also lift a moderation suspension; publish
   `BUS.userControl` invalidate after commit as `services/worker/src/moderation/t0.ts:380` does), notice
   `restored` when every removed item is restored, audit `dmca.content.restore` (actor `system`),
   events `dmca.content.restored` and `account.action.reversed`. After commit: email the owner
   `contentRestored`. The API's `dmca-tick` hook (only with `MODERATION_TEST_HOOKS`, else 404,
   exactly like `ncii-tick`) enqueues the job with `asOf`, waits 30 s, returns `DmcaRestoreResult`.
   This is the only way to shorten the wait.
7. **Web.** `/dmca`: the notice form with the policy summary and a link to the full policy, every
   statutory statement as its own labelled checkbox, ALTCHA, receipt. `/settings/copyright`:
   notices about your content, items with state, the counter-notice dialog (all statutory fields;
   the penalty-of-perjury and jurisdiction statements spelled out next to their checkboxes; a
   `ConfirmDialog` that says the claimant will receive your name, address and phone), the receipt
   with the restore date (`<RelativeTime>`). `/admin/dmca`: queue with status filter, detail with
   items, owners' strikes, decision (`ChoiceToggle` + note + `ConfirmDialog` for actioned),
   counters with suit-filed. Every selector from `e7-selectors.md`; `<EmptyState>`, `<Skeleton*>`,
   error state with retry; 320 px; keyboard; no native tooltips.
8. **Data export and deletion.** Add the user's counter-notices (their own text) and their account
   actions to the export (`services/worker/src/exports/collectors.ts`). Do not scrub counter-notices
   on account deletion: they are records of a legal process; say so in `docs/operators/dmca.md`
   and propose privacy-policy wording in your final message (the seeded text is not yours).
9. **Harness step 8** (`harness/src/e7/dmca.ts`, `stepDmca(run: Run)` with `Run` from
   `harness/src/safety-run.ts`): exactly the `trust-safety` step 8 in `e7-selectors.md`, web and
   `--set via=api`, the restore through `run.hooks.dmcaTick(asOf)` (contract step). Step 8 is in
   `PENDING_SAFETY_STEPS` (`harness/src/safety.ts`), so `all` skips it until your unit merges; run
   it with `--set steps=8`, and the orchestrator removes it from that list at integration. emails read
   from Mailpit (`harness/src/mailpit.ts`), the claimant's email added
   to `run.emails` (log needles). Never print claimant details in the report.
10. **Docs.** `docs/operators/dmca.md`: the designated agent and its registration, what the
    instance does at each step and when, the constants and what changing them means, the
    retention of DMCA records, how to record a court action, that no lawyer has reviewed any of
    it. Fix `trust-safety.md:158` to link it.

## Tests you must add

- Unit: `addWeekdays`/`restoreAfter` (every weekday start, holidays argument documented as not
  modelled), URL de-duplication, strike counting and threshold edges (threshold 0, exactly at,
  window boundary), DTO mapping (owner view never carries claimant contact fields).
- API integration (`createTestDatabase()`, recording queue): submit (unknown URL kept unresolved,
  ALTCHA refused), queue paging, action hides VOD and clip for owner and public (and clips of a
  removed VOD), strikes recorded once per owner per notice, repeat-infringer suspension at the
  threshold (and a user already suspended by a moderator keeps that suspension when the
  termination is reversed), reject path, counter validation (someone else's item, unremoved item, twice),
  suit filed blocks restore, the hook is 404 without test hooks, audit and outbox rows in the same
  transaction, no claimant field in any audit `details` or event payload.
- Worker integration: disable moves objects to the private prefix and is idempotent; restore
  moves them back before un-hiding, skips suit-filed and not-yet-due counters, reverses the strike
  and an under-threshold termination, leaves a retention-deleted VOD deleted.
- Email: render tests for the two new templates and the samples.
- Web: form validation and receipt, counter dialog fields, queue decision flow, selector ids.
- Harness: pure helpers in `harness/tests/e7/dmca.test.ts`.

## Done means

Follow `.claude/briefs/_done-means.md`, except that the orchestrator runs the gate this batch:
run only targeted checks (`bun --bun vp test run` and `test:int` in `services/api`,
`services/worker`, `packages/email`; `apps/web` and `harness` tests; `bunx tsc -p` for each;
`vp lint --deny-warnings` and `vp fmt` on your paths; `vp build` in `apps/web` and confirm `git
diff apps/web/src/routeTree.gen.ts` is empty). Never run `bun run verify`, `podman`,
`scripts/infra.ts` or a harness scenario; give the user the exact
`bun harness/src/cli.ts run trust-safety --set steps=8` commands (web and `--set via=api`).
`git status` shows only your paths. Commit in your worktree (`git commit -s`, Conventional
Commits, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Final message:
what you built, test counts per package, branch and sha, contract requests (exact diffs), the
proposed `services/api/README.md` and privacy/DMCA policy wording, the statement that no lawyer
reviewed the flow, and anything left undone.

## Contract step as landed (`66e95da`)

Your base is `66e95da` (`feat(e7): contract step` + review fixes), not `9c51c93`; recheck line numbers against it.

- DMCA suspensions go through `setSuspension(…, "dmca_repeat_infringer")` (`services/api/src/moderation/suspension.ts`) and are lifted only through `liftDmcaSuspensionInTx` or `reconcileDmcaTerminationInTx` (`packages/db/src/account-actions.ts`), which takes the account-actions lock itself.
- `setSuspension` with the DMCA reason does not take over a user suspension still in force; `changed: false` means record the termination anyway. One unreversed `dmca_termination` per user (migration 0026): check `activeAccountAction(…, "dmca_termination")` under `lockAccountActions` before inserting.
- trust-safety step 8 is in `PENDING_SAFETY_STEPS` (`harness/src/safety.ts`); run it with `--set steps=8`. The orchestrator takes it off that list at merge.
