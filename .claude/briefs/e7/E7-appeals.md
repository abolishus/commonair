<!--
SPDX-FileCopyrightText: 2026 CommonAir contributors
SPDX-License-Identifier: CC-BY-SA-4.0
-->

# E7-appeals: overturns that act, account and DMCA appeals, NCII broadcast hashing

You are implementing unit E7-appeals for CommonAir (repo: /Users/joshe/Repos/bcon). Read AGENTS.md,
PLAN.md and docs/architecture.md first, then `.claude/briefs/next/E7-platform-debts.md`,
`.claude/briefs/e7/contract-step.md` (§1-§3 and §9 "Shared-file rules"),
`docs/testing/e7-selectors.md`, `docs/testing/e4c-selectors.md`, `docs/decisions/0004-governance-enforcement.md`
and `docs/decisions/0006-automated-moderation.md`. Do not look outside the repository. Work in
your own git worktree on a branch named `e7/appeals`, created from the E7 contract-step commit the
orchestrator gives you (run `git merge main` first if main moved).

Safety rules from E4c still apply to anything near `services/worker/src/moderation/**`: never
obtain, generate, describe or handle real CSAM/NCII; synthetic fixtures only; logs carry ids,
categories and counts only; losing evidence or skipping a hash is HIGH.

## Why

An overturned moderation appeal only records the decision: the ban or suspension it was about
stays (`services/api/src/routes/appeals.ts:11-13`), so a member who wins still cannot chat. Appeals
of kind `account` and `dmca` answer 501 (:20-21, :53, :228-229). And NCII removals of a live
broadcast end it and delete its VODs and clips but never hash them, so a re-upload is not blocked
(PROGRESS.md:986-989).

## You own (write only these)

- `services/api/src/routes/appeals.ts` (whole file, including the `accountActions` stub the
  contract step adds)
- `services/api/tests/appeals-e7.int.test.ts` (new) and the appeals expectations in
  `services/api/tests/round3.int.test.ts` (:300-340 area: the two "Not wired yet" 501 assertions
  at :323-329, `dmca` and `account`, change)
- `services/worker/src/moderation/**` and `services/worker/tests/moderation-ncii-hash.int.test.ts`
  (plus new `services/worker/tests/moderation-*.test.ts` files)
- Web: `apps/web/src/components/safety/appeals.tsx`, `appeal-queue.tsx`, `client.ts`, `labels.ts`,
  `apps/web/src/routes/_app/settings.appeals.tsx`, `apps/web/src/routes/_admin/admin.appeals.tsx`,
  `apps/web/src/i18n/e7-appeals.ts` (keys prefixed `appeals.account.`) and
  `apps/web/src/i18n/safety.ts` (existing `safety.appeals.*` keys only),
  `apps/web/tests/e7-appeals*.test.ts(x)` (new) and the appeals cases in `apps/web/tests/safety.test.tsx`
- Harness: `harness/src/e7/appeal-ban.ts` (the `stepAppealLiftsBan(run)` stub: trust-safety
  step 9), `harness/tests/e7/appeal-ban.test.ts` (new)

Read-only: `packages/**` (use `packages/db/src/account-actions.ts` from the contract step §3:
`lockAccountActions`, `reverseAccountActionInTx`, `liftDmcaSuspensionInTx`,
`reconcileDmcaTerminationInTx`; E7-dmca uses the same helpers, so the two units agree on the
rules), `services/api/src/moderation/**` (use `liftChatBanInTx` from
`chat-bans.ts` and `setSuspension` from `suspension.ts`, both added by the contract step),
`services/api/src/routes/{chat,safety}.ts` (E7-chat-http's and E7-dmca's), `services/api/src/dmca/**`,
`packages/email/**` (send the existing `appealDecided` template; a new one is a contract request),
`harness/scenarios/trust-safety.ts`, `harness/src/safety*.ts`, `harness/src/e7/selectors.ts`.
Anything else is a **contract request** with the exact diff.

**Sequencing with W0-sor (wave 2):** W0-sor builds on your merged `services/worker/src/moderation`
changes and adds `sor-*` files there. Keep your worker change small and in `ncii-hash.ts` (and a
helper file if needed) so it merges cleanly.

## Contracts you must honor (read-only for you)

- `packages/contracts/src/api/router.ts:2256-…` `appeals.create` (`write` bucket), `mine`,
  `queue`, `resolve`, and (contract step) `appeals.accountActions` → `AccountAction[]`.
- `enums.ts`: `APPEAL_KINDS`, `APPEAL_SUBJECTS` (:101-118), `ACCOUNT_ACTIONS`,
  `ACCOUNT_ACTION_REVERSALS`, `MOD_ACTIONS` (:139-162).
- Tables: `appeals` (`schema/safety.ts:133-157`), `account_actions` (contract step; reversal
  columns set once, guarded by trigger), `mod_actions` (:87-107), `chat_bans`, `users.banned`/
  `ban_reason`, `channels.suspended_at`, `ncii_request_items` (`hashed_at`), `local_hash_list`.
- `events.ts`: `channel.unban` (via `liftChatBanInTx`), `account.action.reversed`.
- `docs/testing/e7-selectors.md` "Account actions" and `trust-safety` step 9.

## What is there today (verified at `9c51c93`)

- `appeals.ts:46-53` `KIND_SUBJECTS` and `UNWIRED_SUBJECTS = ["dmca_notice", "account_action"]`;
  `subjectConcerns` (:70-145) returns `false` for both; `create` (:223-250) answers 501 for them.
- `resolve` (:287-342): CAS on `open`, nobody resolves their own appeal or an appeal of their own
  action/decision, overturned `content_label` → `removeLabel` (:149-197), overturned
  `moderation_case` → `overturnCase` (:200-218); an overturned `moderation_action` does nothing.
  No outbox row by decision (:337-338); the audit row carries ids and enums only.
- Chat ban lifting is `chat.bans.unban` (`services/api/src/routes/chat.ts:398-436`), extracted to
  `liftChatBanInTx` by the contract step. Platform suspension is `safety.suspend`
  (`safety.ts:437-…` at `3bacecb`) via `setSuspension` (moved to `moderation/suspension.ts`). A T0 suspension
  cannot be lifted (`pgCode 42501` → `FORBIDDEN`, the `users_t0_guard` trigger).
- `services/worker/src/moderation/ncii-hash.ts:132-…` hashes `vod`, `clip` and `upload` items and
  skips `broadcast` items (:146 "not hashed yet (broadcast): left unmarked for a later run"). The
  API's NCII decision ends the broadcast and deletes its VODs and clips
  (`services/api/src/routes/ncii.ts:150-160`); their objects remain.
- Web: `apps/web/src/components/safety/client.ts:102-104` only creates `content_label` appeals;
  `/settings/appeals` (`settings.appeals.tsx`) lists appeals and label notices.
- `packages/email` has `appealDecided` (`templates/trust.tsx:61-90`, data `AppealDecidedData`
  :61-67); nothing sends it.

## Build

1. **Overturned `moderation_action` lifts it** (inside `resolve`'s transaction). Load the
   `mod_actions` row: channel `ban`/`timeout` → `liftChatBanInTx` for that channel and target with
   the resolver as actor and `appealId` (a ban already lifted or expired: nothing to do, record
   that in the appeal audit details as `lifted: false`); platform `suspend_user`/`suspend_channel`
   → `setSuspension(…, false, …)` plus a `mod_actions` `unsuspend_*` row and the suspension audit
   row, as `safety.suspend` writes them (a T0 suspension refuses: answer `FORBIDDEN` with the
   existing message and roll back the whole resolve). For `suspend_user`, lift only while
   `users.ban_reason = 'moderation'`: a user now suspended as a repeat infringer
   (`dmca_repeat_infringer`) stays suspended (record `lifted: false`). Other actions (`delete_message`, `warn`,
   `end_stream`, mode changes, role changes) are recorded only; say so in the header comment.
   After commit: `publishControl(… invalidate user)` for a lifted chat ban,
   `publishUserControl(invalidate)` for a lifted user suspension. Rewrite the header comment
   (:4-25) to match.
2. **`account` appeals.** `subjectConcerns("account_action")`: the row exists and `user_id` is the
   caller. Overturn → under `lockAccountActions`, `reverseAccountActionInTx` (`reversed_at`,
   `reversed_by_id`, `reversed_reason = "appeal_overturned"`, `reversal_appeal_id`), event
   `account.action.reversed`, audit; reversing a `dmca_termination` also lifts the suspension with
   `liftDmcaSuspensionInTx` (only a `dmca_repeat_infringer` ban; a moderation suspension is not
   lifted); reversing a `dmca_strike` does not touch content (the counter-notice does that) but runs
   `reconcileDmcaTerminationInTx`, so a termination that is now under the threshold is reversed
   too (`strikes_below_threshold`, its own event and audit row). Publish `publishUserControl`
   invalidate after commit when a suspension was lifted. An already-reversed action
   → `CONFLICT` at create time. `appeals.accountActions`: the caller's actions newest first, at most 100.
3. **`dmca` appeals point to the counter-notice.** `subjectConcerns("dmca_notice")`: the notice
   has an item owned by the caller. `create` for a concerning notice answers `BAD_REQUEST` with a
   message that names `/settings/copyright` and the counter-notice (no appeal row); a strike from
   it is appealed as `account`. Remove both subjects from `UNWIRED_SUBJECTS` (delete the constant
   if it ends up empty).
4. **Email the appellant** on resolve with `appealDecided` (`AppealDecidedData`: `appealRef`, `kind`,
   `outcome`, `decidedAt`, `decisionUrl` `/settings/appeals`), after commit, failures logged with
   ids only.
5. **NCII broadcast items** (`ncii-hash.ts`). For a `broadcast` item: hash every VOD of the
   broadcast (`vods.broadcast_id`, index from 0022) and every clip (`clips.broadcast_id`, index
   added by the contract step), reusing `hashVod`/`hashClip`; commit all hashes before deleting
   any object; mark `hashed_at` once all are done; a broadcast with no VOD or clip objects is
   marked hashed with 0 hashes and an audit `ncii.hash_removed` saying so (`hashes: 0`). Update
   the comment at :146. Keep the same idempotency (a crash re-hashes).
6. **Web.** `/settings/appeals`: an "Account actions" section (`account-action` rows with
   `<RelativeTime>`, reversed state, `account-action-appeal-open` → `account-appeal-dialog`), and
   `appeal-row` gains `data-kind`. `/admin/appeals`: show the subject kind and, for
   `account_action`/`moderation_action`, what overturning will do ("lifts the chat ban", "lifts the
   suspension", "records only"). Selectors exactly as `e7-selectors.md`.
7. **Harness step 9** (`harness/src/e7/appeal-ban.ts`, `stepAppealLiftsBan(run: Run)` with `Run`
   from `harness/src/safety-run.ts`): exactly `trust-safety` step 9 in `e7-selectors.md`, web and
   `--set via=api`; the moderator who resolves is `run.staff.mod`, never the banning streamer. Step 9 is in
   `PENDING_SAFETY_STEPS` (`harness/src/safety.ts`), so `all` skips it until your unit merges; run
   it with `--set steps=9`, and the orchestrator removes it from that list at integration.

## Tests you must add

- API integration (`createTestDatabase()`): overturn a channel ban (ban lifted, `mod_actions`
  `unban`, audit `chat.unban` with `appealId`, `channel.unban` outbox row, control published), a
  timeout, an already-lifted ban, a platform user suspension, a T0 suspension (refused, nothing
  changed), an action that is recorded only; upheld changes nothing; `account` appeal create
  (someone else's action → 404, reversed → 409), overturn reverses once (a second reversal is
  refused by the trigger), termination overturn unsuspends, a strike overturn that drops the user
  under the threshold also reverses the termination, a moderation suspension survives both;
  overturning a `suspend_user` appeal leaves a `dmca_repeat_infringer` ban in place; `dmca` appeal → 400 for the owner,
  404 for anyone else; `accountActions` lists only the caller's.
- Worker integration: a removed NCII broadcast item with a VOD and a clip (synthetic geometric
  fixtures) adds hashes, deletes objects after the hashes commit, marks `hashed_at`; with no
  media it is marked with 0 hashes; re-running is a no-op.
- Web: account actions list and appeal dialog; selector ids present.
- Harness: pure helpers in `harness/tests/e7/appeal-ban.test.ts`.

## Done means

Follow `.claude/briefs/_done-means.md`, except that the orchestrator runs the gate this batch:
run only targeted checks (`bun --bun vp test run` and `test:int` in `services/api` and
`services/worker` (not at the same time), `apps/web` and `harness` tests; `bunx tsc -p` for each;
`vp lint --deny-warnings` and `vp fmt` on your paths; `vp build` in `apps/web` and confirm `git
diff apps/web/src/routeTree.gen.ts` is empty). Never run `bun run verify`, `podman`,
`scripts/infra.ts` or a harness scenario; give the user the exact
`bun harness/src/cli.ts run trust-safety --set steps=9` commands (web and `--set via=api`).
`git status` shows only your paths. Commit in your worktree (`git commit -s`, Conventional
Commits, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`). Final message:
what you built, test counts per package, branch and sha, contract requests (exact diffs), the
proposed `services/api/README.md` appeals text (:205-212 today) and PROGRESS wording for the
closed NCII gap, and anything left undone.
